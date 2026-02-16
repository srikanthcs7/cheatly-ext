// ============================================================
// AI Quiz Solve - Background Service Worker
// Handles API calls via QuizSolve backend, state management,
// and message routing
// ============================================================

// ---- Dev Mode Detection ----
const IS_DEV = !('update_url' in chrome.runtime.getManifest());

function devLog(...args) {
  if (IS_DEV) console.log('[QuizSolve]', ...args);
}
function devWarn(...args) {
  if (IS_DEV) console.warn('[QuizSolve]', ...args);
}
function devError(...args) {
  if (IS_DEV) console.error('[QuizSolve]', ...args);
}

// ============================================================
// CONFIGURATION
// ============================================================

const QUIZSOLVE_API_URL = 'https://getquizsolve.com/api/get-answer';
const QUIZSOLVE_BASE_URL = 'https://getquizsolve.com';

const DEFAULT_RATE_CONFIG = {
  free: { daily: 20, hourly: 15, perMinute: 5 },
  pro: { daily: -1, hourly: -1, perMinute: 30 },
  banner: { show: false, message: '', type: 'info' }
};

const REPHRASE_PROMPT = `Rephrase the following text in a clear, concise way. Maintain the original meaning but improve clarity and readability. Output ONLY the rephrased text, nothing else.`;

// ============================================================
// SESSION ID MANAGEMENT
// ============================================================

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    const sessionId = crypto.randomUUID();
    await chrome.storage.local.set({
      sessionId,
      installDate: Date.now(),
      apiMode: 'quizsolve_free',
      plan: 'free',
      stats: { totalRequests: 0, requestsToday: 0, lastRequestDate: null },
      rateLimits: {
        remaining: { minute: DEFAULT_RATE_CONFIG.free.perMinute, hour: DEFAULT_RATE_CONFIG.free.hourly, day: DEFAULT_RATE_CONFIG.free.daily },
        resetAt: new Date().toISOString()
      },
      // Review prompt state
      hasRated: false,
      reviewDismissedAt: null,
      // Announcement banner state
      dismissedBanners: []
    });
    devLog('Extension installed. Session ID:', sessionId);
  }

  if (details.reason === 'update') {
    const data = await chrome.storage.local.get(['sessionId', 'apiMode', 'stats']);
    if (!data.sessionId) {
      await chrome.storage.local.set({ sessionId: crypto.randomUUID() });
    }
    // Backward compat: migrate old apiMode values
    if (!data.apiMode || data.apiMode === 'quizsolve' || data.apiMode === 'own_key') {
      await chrome.storage.local.set({ apiMode: 'quizsolve_free' });
    }
    if (!data.stats) {
      await chrome.storage.local.set({
        stats: { totalRequests: 0, requestsToday: 0, lastRequestDate: null }
      });
    }

    // Clean up legacy BYOK storage keys
    await chrome.storage.local.remove(['apiKey_openai', 'apiKey_gemini', 'apiKey_anthropic', 'provider', 'model', 'smartSwitch', 'visionModel']);
    if (chrome.storage.session) {
      try {
        await chrome.storage.session.remove(['apiKey_openai', 'apiKey_gemini', 'apiKey_anthropic']);
      } catch (_) {}
    }
  }
});

async function getSessionId() {
  const { sessionId } = await chrome.storage.local.get('sessionId');
  if (!sessionId) {
    const newId = crypto.randomUUID();
    await chrome.storage.local.set({ sessionId: newId });
    devLog('Session ID was missing, generated:', newId);
    return newId;
  }
  return sessionId;
}

// ============================================================
// DYNAMIC RATE LIMIT CONFIG
// ============================================================

async function fetchRateLimitConfig() {
  try {
    const { rateLimitConfig, rateLimitConfigFetchedAt } = await chrome.storage.local.get([
      'rateLimitConfig', 'rateLimitConfigFetchedAt'
    ]);

    // Cache for 1 hour
    const ONE_HOUR = 60 * 60 * 1000;
    if (rateLimitConfig && rateLimitConfigFetchedAt && (Date.now() - rateLimitConfigFetchedAt < ONE_HOUR)) {
      return rateLimitConfig;
    }

    const resp = await fetch(`${QUIZSOLVE_BASE_URL}/api/config/rate-limits`, {
      signal: AbortSignal.timeout(5000)
    });
    if (!resp.ok) throw new Error(`Config API error: ${resp.status}`);
    const config = await resp.json();

    await chrome.storage.local.set({
      rateLimitConfig: config,
      rateLimitConfigFetchedAt: Date.now()
    });
    devLog('Rate limit config fetched:', config);
    return config;
  } catch (e) {
    devWarn('Failed to fetch rate limit config, using cached/defaults:', e.message);
    const { rateLimitConfig } = await chrome.storage.local.get('rateLimitConfig');
    return rateLimitConfig || DEFAULT_RATE_CONFIG;
  }
}

async function getRateLimitConfig() {
  const { rateLimitConfig } = await chrome.storage.local.get('rateLimitConfig');
  return rateLimitConfig || DEFAULT_RATE_CONFIG;
}

// Fetch config on service worker startup
fetchRateLimitConfig();

// Refresh config periodically (every hour)
chrome.alarms.create('refreshRateLimitConfig', { periodInMinutes: 60 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'refreshRateLimitConfig') {
    fetchRateLimitConfig();
  }
});

// ============================================================
// PROCESS EXPLANATION — Concepts only, no answer revealed
// ============================================================

async function processExplanation(questionData) {
  const sessionId = await getSessionId();
  const { authToken } = await chrome.storage.local.get('authToken');
  const headers = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

  const type = questionData.type || 'MULTIPLE_CHOICE';
  const baseType = questionData.baseType || type;
  const isNegation = questionData.isNegation || type === 'MCQ_NEGATIVE' || type === 'MCQ_EXCEPT';

  const questionText = (questionData.questionText || '').trim();
  const options = (questionData.options || []).map(opt => ({
    identifier: opt.identifier || '',
    text: (opt.text || '').trim()
  })).filter(opt => opt.text.length > 0);

  const images = (questionData.images || []).map(img => ({
    data: img.data,
    mimeType: img.mimeType || 'image/png'
  }));

  // Validation: skip sending if question is empty
  if (!questionText && images.length === 0) {
    throw new Error('No question text or images detected. Try clicking directly on the question.');
  }

  const payload = {
    question: questionText,
    containerHTML: questionData.containerHTML || undefined,
    questionType: type,
    baseType: baseType !== type ? baseType : undefined,
    isNegation: isNegation === true ? true : undefined,
    options,
    instructions: questionData.instructions || undefined,
    images,
    context: questionText,
    sessionId,
    metadata: {
      extensionVersion: chrome.runtime.getManifest().version,
      platform: 'extension',
      type: 'explanation',
      timestamp: Date.now(),
      quizPlatform: questionData.platform || 'unknown',
      optionsCount: options.length,
      hasImage: images.length > 0,
      hasInstructions: !!(questionData.instructions),
    }
  };

  // Strip images if payload too large
  if (JSON.stringify(payload).length > 4 * 1024 * 1024) {
    payload.images = [];
    payload.metadata.hasImage = false;
  }

  const response = await fetchWithRetry(QUIZSOLVE_API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(45000)
  });
  if (!response.ok) await handleBackendError(response);
  const data = await response.json();
  const rawAnswer = data.answer;

  const planHeader = response.headers.get('X-Plan');
  if (planHeader && (planHeader === 'free' || planHeader === 'pro')) {
    await chrome.storage.local.set({ plan: planHeader });
  }

  // Parse response — explanation only, no answer
  const explanation = rawAnswer.trim();
  devLog('Explanation parsed:', explanation.substring(0, 80));

  await updateUsageStats();
  return { answer: '', explanation };
}

// ============================================================
// PROCESS SOLVE — Gets answer + explanation from backend
// ============================================================

async function processSolve(questionData) {
  const result = await processQuestionViaBackend(questionData, { includeExplanation: true });
  return { answer: result.answer, explanation: result.explanation || '' };
}

// ============================================================
// PROCESS REPHRASE — Returns rephrased text
// ============================================================

async function processRephrase(data) {
  const sessionId = await getSessionId();
  const { authToken } = await chrome.storage.local.get('authToken');
  const headers = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

  const prompt = REPHRASE_PROMPT + '\n\nText: ' + data.text;

  const payload = {
    question: prompt.substring(0, 2000),
    context: data.text.substring(0, 500),
    sessionId,
    metadata: {
      extensionVersion: chrome.runtime.getManifest().version,
      platform: 'extension',
      type: 'rephrase',
      timestamp: Date.now()
    }
  };
  const response = await fetchWithRetry(QUIZSOLVE_API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) await handleBackendError(response);
  const respData = await response.json();
  const result = respData.answer;

  await updateUsageStats();
  devLog('Rephrase result:', result?.substring(0, 80));
  return result;
}

// ============================================================
// EXTENSION STATE
// ============================================================

const tabStates = {};

function getTabState(tabId) {
  if (!tabStates[tabId]) {
    tabStates[tabId] = { active: false };
  }
  return tabStates[tabId];
}

// ============================================================
// PROCESS QUESTION — Backend API
// ============================================================

async function processQuestion(questionData) {
  return await processQuestionViaBackend(questionData);
}

// ---- Backend API call (QuizSolve API — free or pro) ----
async function processQuestionViaBackend(questionData, fetchOptions = {}) {
  const sessionId = await getSessionId();
  const { authToken } = await chrome.storage.local.get('authToken');

  const headers = { 'Content-Type': 'application/json' };
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  // Send structured data so backend doesn't need to re-classify
  const type = questionData.type || 'MULTIPLE_CHOICE';
  const baseType = questionData.baseType || type;
  const isNegation = questionData.isNegation || type === 'MCQ_NEGATIVE' || type === 'MCQ_EXCEPT';

  const questionText = (questionData.questionText || '').trim();
  const options = (questionData.options || []).map(opt => ({
    identifier: opt.identifier || '',
    text: (opt.text || '').trim()
  })).filter(opt => opt.text.length > 0);

  // Validation: skip sending if question is empty
  if (!questionText && !(questionData.images && questionData.images.length > 0)) {
    throw new Error('No question text or images detected. Try clicking directly on the question.');
  }

  const images = (questionData.images || []).map(img => ({
    data: img.data,
    mimeType: img.mimeType || 'image/png'
  }));

  const reasoning = !!questionData.reasoning;

  const payload = {
    question: questionText,
    containerHTML: questionData.containerHTML || undefined,
    questionType: type,
    baseType: baseType !== type ? baseType : undefined,
    isNegation: isNegation === true ? true : undefined,
    reasoning: reasoning || undefined,
    options,
    instructions: questionData.instructions || undefined,
    images,
    context: questionText,
    sessionId,
    metadata: {
      extensionVersion: chrome.runtime.getManifest().version,
      platform: 'extension',
      type: 'answer',
      timestamp: Date.now(),
      quizPlatform: questionData.platform || 'unknown',
      optionsCount: options.length,
      hasImage: images.length > 0,
      hasInstructions: !!(questionData.instructions),
    }
  };

  // Strip images from payload if too large (>4MB total)
  if (JSON.stringify(payload).length > 4 * 1024 * 1024) {
    devWarn('Payload too large with images, stripping images');
    payload.images = [];
    payload.metadata.hasImage = false;
  }

  devLog('Processing (Backend):', {
    question: payload.question.substring(0, 80) + '...',
    questionType: payload.questionType,
    baseType: payload.baseType,
    isNegation: payload.isNegation,
    optionCount: payload.options.length,
    options: payload.options.map(o => `${o.identifier}: ${o.text.substring(0, 25)}`),
    imageCount: payload.images.length,
    platform: payload.metadata.quizPlatform,
    sessionId: sessionId.substring(0, 8) + '...',
    hasAuth: !!authToken
  });

  const startTime = Date.now();

  const response = await fetchWithRetry(QUIZSOLVE_API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(reasoning ? 60000 : 30000)
  });

  if (!response.ok) {
    await handleBackendError(response);
  }

  const data = await response.json();
  devLog('Backend response in', Date.now() - startTime, 'ms:', data.answer,
    'meta:', data.metadata);

  // Update plan from response header
  const planHeader = response.headers.get('X-Plan');
  if (planHeader && (planHeader === 'free' || planHeader === 'pro')) {
    await chrome.storage.local.set({ plan: planHeader });
    devLog('Plan updated from header:', planHeader);
  }

  await updateRateLimits(response.headers);
  await updateUsageStats();

  if (fetchOptions.includeExplanation) {
    return { answer: data.answer, explanation: data.explanation };
  }
  return data.answer;
}

// ============================================================
// RETRY LOGIC (for backend API)
// ============================================================

async function fetchWithRetry(url, options, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);

      // Don't retry on client errors or rate limits
      if (response.status < 500 || response.status === 429) {
        return response;
      }

      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000;
        devLog(`Retry ${attempt + 1}/${maxRetries} after ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      return response;
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error('Request timed out. Please try again.');
      }
      if (attempt === maxRetries) {
        if (err.message.includes('Failed to fetch') || err.message.includes('NetworkError')) {
          throw new Error('Network error. Please check your internet connection.');
        }
        throw err;
      }
      const delay = Math.pow(2, attempt) * 1000;
      devLog(`Fetch error, retry ${attempt + 1}/${maxRetries} after ${delay}ms:`, err.message);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error('Max retries exceeded');
}

// ============================================================
// BACKEND ERROR HANDLING
// ============================================================

async function handleBackendError(response) {
  let errorData;
  try {
    errorData = await response.json();
  } catch {
    throw new Error(`Request failed with status ${response.status}`);
  }

  // 401 — Token expired/invalid: clear auth state
  if (response.status === 401) {
    await chrome.storage.local.remove(['authToken', 'authUser']);
    await chrome.storage.local.set({ plan: 'free' });
    devWarn('Auth token cleared due to 401');
    throw new Error('Session expired. Please log in again in the extension popup.');
  }

  // 402 — Daily limit reached (free tier)
  if (response.status === 402) {
    throw new Error('Daily question limit reached. Upgrade to Pro for unlimited access.');
  }

  // Store rate limit info from 429 responses
  if (response.status === 429 && errorData.limits) {
    await chrome.storage.local.set({
      rateLimits: {
        remaining: errorData.limits.remaining || { minute: 0, hour: 0, day: 0 },
        resetAt: errorData.limits.resetAt || new Date().toISOString()
      }
    });
  }

  const messages = {
    400: 'Invalid request format. Please try again.',
    403: 'Access denied. Your session may be blocked. Contact support@quizsolve.com',
    429: `Rate limit exceeded. Try again in ${errorData.retryAfter || 60} seconds.`,
    502: 'AI service temporarily unavailable. Please try again.',
    504: 'Request timed out. Please try again.',
    500: 'Server error. Please try again later.'
  };

  throw new Error(messages[response.status] || errorData.error || `Request failed: ${response.status}`);
}

// ============================================================
// RATE LIMIT TRACKING
// ============================================================

async function updateRateLimits(headers) {
  const minute = parseInt(headers.get('X-RateLimit-Remaining-Minute') || '-1', 10);
  const hour = parseInt(headers.get('X-RateLimit-Remaining-Hour') || '-1', 10);
  const day = parseInt(headers.get('X-RateLimit-Remaining-Day') || '-1', 10);

  // Only update if at least one header is present
  if (minute === -1 && hour === -1 && day === -1) return;

  const config = await getRateLimitConfig();
  const { plan } = await chrome.storage.local.get('plan');
  const tier = plan === 'pro' ? config.pro : config.free;

  const rateLimits = {
    remaining: {
      minute: minute >= 0 ? minute : tier.perMinute,
      hour: hour >= 0 ? hour : tier.hourly,
      day: day >= 0 ? day : tier.daily
    },
    resetAt: headers.get('X-RateLimit-Reset') || new Date().toISOString()
  };

  await chrome.storage.local.set({ rateLimits });
  devLog('Rate limits updated:', rateLimits);

  // Badge warning when daily limits are low
  if (rateLimits.remaining.day < 5) {
    chrome.action.setBadgeText({ text: String(rateLimits.remaining.day) });
    chrome.action.setBadgeBackgroundColor({ color: '#EF4444' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

// ============================================================
// USAGE STATS
// ============================================================

async function updateUsageStats() {
  const today = new Date().toISOString().split('T')[0];
  const { stats = {} } = await chrome.storage.local.get('stats');

  const isNewDay = stats.lastRequestDate !== today;

  await chrome.storage.local.set({
    stats: {
      totalRequests: (stats.totalRequests || 0) + 1,
      requestsToday: isNewDay ? 1 : (stats.requestsToday || 0) + 1,
      lastRequestDate: today
    }
  });
}

// ============================================================
// SSRF PROTECTION
// ============================================================

function isPrivateUrl(urlString) {
  try {
    const url = new URL(urlString);
    // Must be HTTPS (except for data: URIs which are handled separately)
    if (url.protocol !== 'https:') return true;
    const hostname = url.hostname.toLowerCase();
    // Block localhost
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]') return true;
    // Block private IP ranges
    const parts = hostname.split('.').map(Number);
    if (parts.length === 4 && parts.every(p => !isNaN(p))) {
      if (parts[0] === 10) return true; // 10.x.x.x
      if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true; // 172.16-31.x.x
      if (parts[0] === 192 && parts[1] === 168) return true; // 192.168.x.x
      if (parts[0] === 169 && parts[1] === 254) return true; // 169.254.x.x (link-local)
      if (parts[0] === 0) return true; // 0.x.x.x
    }
    return false;
  } catch {
    return true; // Invalid URL — block
  }
}

// ============================================================
// ERROR SANITIZATION
// ============================================================

function sanitizeErrorForClient(msg) {
  if (!msg || typeof msg !== 'string') return 'An error occurred. Please try again.';
  // Strip stack traces and file paths
  let clean = msg
    .replace(/\bat\s+.+:\d+:\d+/g, '')
    .replace(/\/(Users|home|var|tmp|etc|opt|usr)\/.+?\s/g, '')
    .replace(/[A-Z]:\\[\w\\]+/g, '')
    .replace(/\n/g, ' ')
    .trim();
  // Cap at 200 chars
  if (clean.length > 200) clean = clean.substring(0, 200) + '...';
  return clean || 'An error occurred. Please try again.';
}

// ============================================================
// IMAGE PROXY — Fetch cross-origin images for content script
// ============================================================

async function fetchImageAsBase64(url) {
  try {
    // SSRF check
    if (isPrivateUrl(url)) {
      devWarn('Blocked private/non-HTTPS image URL:', url);
      return null;
    }
    devLog('Fetching image via proxy:', url);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const blob = await resp.blob();
    const mimeType = blob.type || 'image/png';

    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const dataUrl = reader.result;
        const base64 = dataUrl.split(',')[1];
        resolve({ data: base64, mimeType });
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch (err) {
    devWarn('Image proxy fetch failed:', url, err.message);
    return null;
  }
}

// ============================================================
// KEYBOARD SHORTCUT
// ============================================================

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-extension') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    const state = getTabState(tab.id);
    state.active = !state.active;
    devLog('Toggle extension:', state.active ? 'ON' : 'OFF', 'tab:', tab.id);

    chrome.action.setBadgeText({
      text: state.active ? 'ON' : '',
      tabId: tab.id
    });
    chrome.action.setBadgeBackgroundColor({
      color: state.active ? '#2dd4bf' : '#666',
      tabId: tab.id
    });

    // Try sending message to existing content script first
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'TOGGLE_STATE',
        active: state.active
      });
    } catch (e) {
      // Content script not loaded — inject it, but only if activating
      if (state.active) {
        devLog('Content script not found, injecting...');
        try {
          await chrome.scripting.insertCSS({
            target: { tabId: tab.id },
            files: ['content.css']
          });
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content.js']
          });
          setTimeout(async () => {
            try {
              await chrome.tabs.sendMessage(tab.id, {
                type: 'TOGGLE_STATE',
                active: true
              });
            } catch (_) {
              devWarn('Failed to reach content script after injection');
            }
          }, 300);
        } catch (injErr) {
          devError('Script injection failed:', injErr.message);
        }
      }
    }
  }
});

// ============================================================
// MESSAGE HANDLER
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Sender validation — only accept messages from this extension
  if (sender.id !== chrome.runtime.id) return false;

  if (message.type === 'PROCESS_QUESTION') {
    processQuestion(message.data)
      .then(answer => sendResponse({ success: true, answer }))
      .catch(err => {
        devError('Process question error:', err.message);
        sendResponse({ success: false, error: sanitizeErrorForClient(err.message) });
      });
    return true;
  }

  if (message.type === 'CAPTURE_TAB') {
    chrome.tabs.captureVisibleTab(null, { format: 'png' })
      .then(dataUrl => sendResponse({ success: true, dataUrl }))
      .catch(err => {
        devError('Capture tab error:', err.message);
        sendResponse({ success: false, error: sanitizeErrorForClient(err.message) });
      });
    return true;
  }

  if (message.type === 'PROCESS_REPHRASE') {
    processRephrase(message.data)
      .then(result => sendResponse({ success: true, result }))
      .catch(err => {
        devError('Rephrase error:', err.message);
        sendResponse({ success: false, error: sanitizeErrorForClient(err.message) });
      });
    return true;
  }

  if (message.type === 'PROCESS_EXPLANATION') {
    processExplanation(message.data)
      .then(result => sendResponse({ success: true, ...result }))
      .catch(err => {
        devError('Process explanation error:', err.message);
        sendResponse({ success: false, error: sanitizeErrorForClient(err.message) });
      });
    return true;
  }

  if (message.type === 'PROCESS_SOLVE') {
    processSolve(message.data)
      .then(result => sendResponse({ success: true, ...result }))
      .catch(err => {
        devError('Process solve error:', err.message);
        sendResponse({ success: false, error: sanitizeErrorForClient(err.message) });
      });
    return true;
  }

  if (message.type === 'FETCH_IMAGE') {
    fetchImageAsBase64(message.url)
      .then(result => sendResponse({ success: !!result, ...result }))
      .catch(err => sendResponse({ success: false, error: sanitizeErrorForClient(err.message) }));
    return true;
  }

  if (message.type === 'GET_STATE') {
    const tabId = message.tabId || sender.tab?.id;
    if (tabId) {
      sendResponse({ active: getTabState(tabId).active });
    } else {
      sendResponse({ active: false });
    }
    return false;
  }

  if (message.type === 'SET_STATE') {
    const handleSetState = async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) return;

      const state = getTabState(tab.id);
      state.active = message.active;
      devLog('Set state:', state.active, 'tab:', tab.id);

      chrome.action.setBadgeText({
        text: state.active ? 'ON' : '',
        tabId: tab.id
      });
      chrome.action.setBadgeBackgroundColor({
        color: state.active ? '#2dd4bf' : '#666',
        tabId: tab.id
      });

      try {
        await chrome.tabs.sendMessage(tab.id, {
          type: 'TOGGLE_STATE',
          active: state.active
        });
      } catch (_) {}

      sendResponse({ success: true });
    };
    handleSetState();
    return true;
  }

  if (message.type === 'GET_RATE_CONFIG') {
    fetchRateLimitConfig()
      .then(config => sendResponse({ success: true, config }))
      .catch(err => sendResponse({ success: false, config: DEFAULT_RATE_CONFIG }));
    return true;
  }

});

// ============================================================
// CLEANUP
// ============================================================

chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabStates[tabId];
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    const state = getTabState(tabId);
    if (state.active) {
      chrome.action.setBadgeText({ text: 'ON', tabId });
      chrome.action.setBadgeBackgroundColor({ color: '#2dd4bf', tabId });
    }
  }
});

devLog('Service worker loaded. Dev mode:', IS_DEV);
