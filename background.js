// ============================================================
// QuizSolve - Background Service Worker
// Handles AI API calls, state management, and message routing
// Dual mode: QuizSolve Backend API + Bring Your Own Key (BYOK)
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

const QUIZSOLVE_API_URL = 'https://quizsolve.vercel.app/api/get-answer';

// ============================================================
// SESSION ID MANAGEMENT
// ============================================================

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    const sessionId = crypto.randomUUID();
    await chrome.storage.local.set({
      sessionId,
      installDate: Date.now(),
      apiMode: 'quizsolve',
      stats: { totalRequests: 0, requestsToday: 0, lastRequestDate: null },
      rateLimits: {
        remaining: { minute: 10, hour: 200, day: 1000 },
        resetAt: new Date().toISOString()
      }
    });
    devLog('Extension installed. Session ID:', sessionId);
  }

  if (details.reason === 'update') {
    // Ensure sessionId and apiMode exist after update
    const data = await chrome.storage.local.get(['sessionId', 'apiMode', 'stats']);
    if (!data.sessionId) {
      await chrome.storage.local.set({ sessionId: crypto.randomUUID() });
    }
    if (!data.apiMode) {
      await chrome.storage.local.set({ apiMode: 'quizsolve' });
    }
    if (!data.stats) {
      await chrome.storage.local.set({
        stats: { totalRequests: 0, requestsToday: 0, lastRequestDate: null }
      });
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
// AI PROVIDERS — Latest non-deprecated models (Feb 2026)
// All models support vision/image input
// ============================================================

const AI_PROVIDERS = {
  openai: {
    name: 'OpenAI',
    models: [
      { id: 'gpt-4.1-nano', name: 'GPT-4.1 Nano (Fastest)', tier: 'fast', default: true },
      { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini (Balanced)', tier: 'balanced' },
      { id: 'gpt-4.1', name: 'GPT-4.1 (Powerful)', tier: 'powerful' }
    ],
    makeRequest: async (apiKey, model, prompt, images, temperature = 0.1) => {
      const userContent = buildOpenAIContent(prompt, images);
      devLog('OpenAI request:', model, 'temp:', temperature, 'images:', images?.length || 0);

      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userContent }
          ],
          temperature,
          max_tokens: 1024
        }),
        signal: AbortSignal.timeout(30000)
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error?.message || `OpenAI API error: ${resp.status}`);
      }
      const data = await resp.json();
      devLog('OpenAI response tokens:', data.usage);
      return data.choices[0].message.content.trim();
    }
  },

  gemini: {
    name: 'Google Gemini',
    models: [
      { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite (Fastest)', tier: 'fast', default: true },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash (Balanced)', tier: 'balanced' },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro (Powerful)', tier: 'powerful' }
    ],
    makeRequest: async (apiKey, model, prompt, images, temperature = 0.1) => {
      const parts = buildGeminiParts(prompt, images);
      devLog('Gemini request:', model, 'temp:', temperature, 'images:', images?.length || 0);

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            temperature,
            maxOutputTokens: 1024
          }
        }),
        signal: AbortSignal.timeout(30000)
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error?.message || `Gemini API error: ${resp.status}`);
      }
      const data = await resp.json();
      devLog('Gemini response candidates:', data.candidates?.length);
      return data.candidates[0].content.parts[0].text.trim();
    }
  },

  anthropic: {
    name: 'Anthropic',
    models: [
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5 (Fast)', tier: 'fast', default: true },
      { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4 (Balanced)', tier: 'balanced' },
      { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5 (Powerful)', tier: 'powerful' }
    ],
    makeRequest: async (apiKey, model, prompt, images, temperature = 0.1) => {
      const userContent = buildAnthropicContent(prompt, images);
      devLog('Anthropic request:', model, 'temp:', temperature, 'images:', images?.length || 0);

      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          temperature,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userContent }]
        }),
        signal: AbortSignal.timeout(30000)
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error?.message || `Anthropic API error: ${resp.status}`);
      }
      const data = await resp.json();
      devLog('Anthropic usage:', data.usage);
      return data.content[0].text.trim();
    }
  }
};

// ============================================================
// VISION — Build multimodal content for each provider
// ============================================================

function buildOpenAIContent(prompt, images) {
  if (!images || images.length === 0) return prompt;

  const content = [];
  for (const img of images) {
    content.push({
      type: 'image_url',
      image_url: {
        url: `data:${img.mimeType};base64,${img.data}`,
        detail: 'high'
      }
    });
  }
  content.push({ type: 'text', text: prompt });
  return content;
}

function buildGeminiParts(prompt, images) {
  const parts = [];
  parts.push({ text: SYSTEM_PROMPT + '\n\n' + prompt });
  if (images && images.length > 0) {
    for (const img of images) {
      parts.push({
        inlineData: {
          mimeType: img.mimeType,
          data: img.data
        }
      });
    }
  }
  return parts;
}

function buildAnthropicContent(prompt, images) {
  if (!images || images.length === 0) return prompt;

  const content = [];
  for (const img of images) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: img.mimeType,
        data: img.data
      }
    });
  }
  content.push({ type: 'text', text: prompt });
  return content;
}

// ============================================================
// SYSTEM PROMPT
// ============================================================

const SYSTEM_PROMPT = `You are a precise answer-finding assistant. Analyze the question (and any attached images/diagrams) and provide ONLY the correct answer.

RESPONSE FORMAT (follow strictly based on question type):
- MULTIPLE_CHOICE: Reply with ONLY the option identifier (e.g., "B" or "2"). If options are labeled A/B/C/D use letters. If labeled 1/2/3/4 use numbers. Match the format shown.
- TRUE_FALSE: Reply with ONLY "True" or "False"
- FILL_BLANK: Reply with ONLY the answer word(s) that fill the blank
- MATCHING: Reply with pairs like "1→C, 2→A, 3→B, 4→D"
- MULTI_SELECT: Reply with ALL correct identifiers separated by commas (e.g., "A, C, D")
- SHORT_ANSWER: Reply with a concise factual answer (1-3 sentences max)
- ESSAY: Reply with a well-structured answer (3-6 sentences)

CRITICAL RULES:
- If images are provided, analyze them carefully — they may contain diagrams, charts, graphs, code snippets, or visual context essential to answering correctly
- ALWAYS choose from the given options when options are provided
- Be factually accurate
- No preamble, no explanations, no extra formatting for objective questions
- Just the raw answer, nothing else
- For multiple choice, ONLY output the letter/number, never the full option text`;

const EXPLANATION_PROMPT = `You are a helpful tutor. Analyze the question (and any attached images/diagrams) and provide both the correct answer AND a clear explanation.

FORMAT YOUR RESPONSE EXACTLY LIKE THIS:
ANSWER: [just the option identifier, e.g., "C"]
EXPLANATION: [clear, step-by-step explanation of why this answer is correct]

RULES:
- The ANSWER line must contain ONLY the option letter/identifier (A, B, C, D, etc.) or the direct answer
- The EXPLANATION should be concise but thorough (2-5 sentences)
- Use simple, clear language
- If it involves math/calculation, show the key steps
- If images are provided, reference what you see in them
- ALWAYS choose from the given options when options are provided`;

// ============================================================
// QUESTION TYPE CONFIGS — Per-type preambles and temperatures
// ============================================================

const QUESTION_TYPE_CONFIGS = {
  MCQ_NEGATIVE: {
    temperature: 0.0,
    preamble: `CRITICAL: This is a NEGATIVE question — it asks you to find the WRONG, INCORRECT, or FALSE option.
READ CAREFULLY: The question uses words like "NOT", "WRONG", "INCORRECT", or "FALSE".
STRATEGY: Evaluate each option. Most options will be TRUE/CORRECT. You must find the ONE that is FALSE/WRONG/INCORRECT.
Double-check your logic — students commonly get tricked by negation.`
  },

  MCQ_EXCEPT: {
    temperature: 0.0,
    preamble: `CRITICAL: This is an EXCEPT question — all options are true/valid EXCEPT one.
READ CAREFULLY: The question says "all of the following... EXCEPT" or similar.
STRATEGY: Check each option against the statement. Most will fit. Find the ONE that does NOT fit.
The correct answer is the EXCEPTION — the option that breaks the pattern or is false.`
  },

  MULTIPLE_CHOICE: {
    temperature: 0.1,
    preamble: null
  },

  MULTI_SELECT: {
    temperature: 0.1,
    preamble: `This is a MULTI-SELECT question — there may be MORE THAN ONE correct answer.
Evaluate EVERY option independently. Select ALL that are correct. Reply with all correct letters separated by commas.`
  },

  TRUE_FALSE: {
    temperature: 0.0,
    preamble: null
  },

  NUMERICAL: {
    temperature: 0.0,
    preamble: `This is a NUMERICAL/CALCULATION question.
Show your reasoning internally, then verify your calculation before answering.
Provide ONLY the final numerical answer (with units if specified in the question).
Double-check arithmetic and unit conversions.`
  },

  FILL_BLANK: {
    temperature: 0.1,
    preamble: null
  },

  SHORT_ANSWER: {
    temperature: 0.1,
    preamble: null
  },

  MATCHING: {
    temperature: 0.0,
    preamble: `Match each item carefully. Verify each pairing is correct before responding.`
  },

  ESSAY: {
    temperature: 0.3,
    preamble: null
  }
};

// ============================================================
// PROCESS EXPLANATION — Returns answer + explanation
// ============================================================

function buildExplanationPrompt(questionData) {
  let prompt = '';

  const type = questionData.type;
  const baseType = questionData.baseType || type;
  const displayType = (baseType && baseType !== type) ? `${baseType} (${type})` : type;

  prompt += `Question Type: ${displayType}\n\n`;
  prompt += `Question: ${questionData.questionText}\n`;

  if (questionData.images && questionData.images.length > 0) {
    prompt += `\n[${questionData.images.length} image(s) attached — analyze them carefully]\n`;
  }

  if (questionData.options && questionData.options.length > 0) {
    prompt += `\nOptions:\n`;
    questionData.options.forEach(opt => {
      prompt += `${opt.identifier}. ${opt.text}\n`;
    });
  }

  return prompt;
}

async function processExplanation(questionData) {
  const settings = await chrome.storage.local.get([
    'apiMode', 'provider', 'apiKey_openai', 'apiKey_gemini', 'apiKey_anthropic'
  ]);

  const apiMode = settings.apiMode || 'quizsolve';
  const userPrompt = buildExplanationPrompt(questionData);
  let rawAnswer;

  if (apiMode === 'own_key') {
    const provider = settings.provider || 'openai';
    const providerConfig = AI_PROVIDERS[provider];
    if (!providerConfig) throw new Error(`Unknown provider: ${provider}`);
    const apiKey = settings[`apiKey_${provider}`];
    if (!apiKey) throw new Error(`No API key set for ${providerConfig.name}.`);
    const images = questionData.images || [];
    const hasImages = images.length > 0;
    const model = await resolveModel(provider, hasImages);

    const fullPrompt = EXPLANATION_PROMPT + '\n\n' + userPrompt;
    rawAnswer = await providerConfig.makeRequest(apiKey, model, fullPrompt, hasImages ? images : null, 0.3);
  } else {
    const sessionId = await getSessionId();
    const fullPrompt = EXPLANATION_PROMPT + '\n\n' + userPrompt;
    const payload = {
      question: fullPrompt.substring(0, 3000),
      context: questionData.questionText?.substring(0, 1000),
      sessionId,
      metadata: {
        extensionVersion: chrome.runtime.getManifest().version,
        platform: 'extension',
        type: 'explanation',
        timestamp: Date.now()
      }
    };
    const response = await fetchWithRetry(QUIZSOLVE_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(45000)
    });
    if (!response.ok) await handleBackendError(response);
    const data = await response.json();
    rawAnswer = data.answer;
  }

  // Parse structured response: ANSWER: X\nEXPLANATION: ...
  const answerMatch = rawAnswer.match(/ANSWER:\s*(.+?)(?:\n|$)/i);
  const explanationMatch = rawAnswer.match(/EXPLANATION:\s*([\s\S]+)/i);

  const answer = answerMatch ? answerMatch[1].trim() : rawAnswer.split('\n')[0].trim();
  const explanation = explanationMatch ? explanationMatch[1].trim() : rawAnswer;

  devLog('Explanation parsed — answer:', answer, 'explanation:', explanation.substring(0, 80));

  await updateUsageStats();
  return { answer, explanation };
}

// ============================================================
// SMART MODEL SWITCHING
// ============================================================

async function resolveModel(provider, hasImages) {
  const settings = await chrome.storage.local.get(['model', 'smartSwitch', 'visionModel']);
  const providerConfig = AI_PROVIDERS[provider];
  const defaultModel = providerConfig.models.find(m => m.default)?.id || providerConfig.models[0].id;

  if (settings.smartSwitch && hasImages) {
    if (settings.visionModel) {
      const isValidForProvider = providerConfig.models.some(m => m.id === settings.visionModel);
      if (isValidForProvider) {
        devLog('Smart switch → vision model:', settings.visionModel);
        return settings.visionModel;
      }
    }
    const balanced = providerConfig.models.find(m => m.tier === 'balanced');
    if (balanced) {
      devLog('Smart switch → auto balanced:', balanced.id);
      return balanced.id;
    }
  }

  const model = settings.model || defaultModel;
  devLog('Using model:', model, hasImages ? '(with images)' : '(text only)');
  return model;
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
// BUILD PROMPT
// ============================================================

function buildPrompt(questionData) {
  const type = questionData.type;
  const baseType = questionData.baseType || type;
  const typeConfig = QUESTION_TYPE_CONFIGS[type] || QUESTION_TYPE_CONFIGS[baseType] || {};

  let prompt = '';

  // Add type-specific preamble if available
  if (typeConfig.preamble) {
    prompt += `[SPECIAL INSTRUCTIONS]\n${typeConfig.preamble}\n\n`;
  }

  // Add extracted instructions from content script (e.g., "INVERSION: ...")
  if (questionData.instructions) {
    prompt += `[CONTEXT]\n${questionData.instructions}\n\n`;
  }

  // Use baseType for response format (AI recognizes MULTIPLE_CHOICE, not MCQ_NEGATIVE)
  const displayType = (baseType && baseType !== type) ? `${baseType} (${type})` : type;
  prompt += `Question Type: ${displayType}\n\n`;
  prompt += `Question: ${questionData.questionText}\n`;

  if (questionData.images && questionData.images.length > 0) {
    prompt += `\n[${questionData.images.length} image(s) attached — analyze them for context]\n`;
  }

  if (questionData.options && questionData.options.length > 0) {
    prompt += `\nOptions:\n`;
    questionData.options.forEach(opt => {
      prompt += `${opt.identifier}. ${opt.text}\n`;
    });
  }

  const matchType = type === 'MATCHING' || baseType === 'MATCHING';
  if (matchType && questionData.matchItems) {
    prompt += `\nItems to match:\n`;
    questionData.matchItems.forEach(item => {
      prompt += `${item.identifier}. ${item.text} → Choose from: ${item.selectOptions.join(', ')}\n`;
    });
  }

  return prompt;
}

// ============================================================
// PROCESS QUESTION — Dual Mode (Backend API / Own Key)
// ============================================================

async function processQuestion(questionData) {
  const settings = await chrome.storage.local.get([
    'apiMode', 'provider', 'apiKey_openai', 'apiKey_gemini', 'apiKey_anthropic'
  ]);

  const apiMode = settings.apiMode || 'quizsolve';

  if (apiMode === 'own_key') {
    return await processQuestionDirect(questionData, settings);
  } else {
    return await processQuestionViaBackend(questionData);
  }
}

// ---- Direct API calls (BYOK mode) ----
async function processQuestionDirect(questionData, settings) {
  const provider = settings.provider || 'openai';
  const providerConfig = AI_PROVIDERS[provider];
  if (!providerConfig) throw new Error(`Unknown provider: ${provider}`);

  const apiKey = settings[`apiKey_${provider}`];
  if (!apiKey) throw new Error(`No API key set for ${providerConfig.name}. Open the extension popup to configure.`);

  const images = questionData.images || [];
  const hasImages = images.length > 0;
  const model = await resolveModel(provider, hasImages);
  const prompt = buildPrompt(questionData);

  // Resolve per-type temperature
  const type = questionData.type || 'MULTIPLE_CHOICE';
  const baseType = questionData.baseType || type;
  const typeConfig = QUESTION_TYPE_CONFIGS[type] || QUESTION_TYPE_CONFIGS[baseType] || {};
  const temperature = typeConfig.temperature !== undefined ? typeConfig.temperature : 0.1;

  devLog('Processing (BYOK):', {
    type: questionData.type,
    baseType: questionData.baseType,
    temperature,
    textLength: questionData.questionText?.length,
    optionCount: questionData.options?.length,
    imageCount: images.length,
    provider,
    model
  });

  const startTime = Date.now();
  const answer = await providerConfig.makeRequest(apiKey, model, prompt, hasImages ? images : null, temperature);
  devLog('Answer received in', Date.now() - startTime, 'ms:', answer);

  await updateUsageStats();
  return answer;
}

// ---- Backend API call (QuizSolve API mode) ----
async function processQuestionViaBackend(questionData) {
  const sessionId = await getSessionId();
  const prompt = buildPrompt(questionData);

  const payload = {
    question: prompt.substring(0, 2000),
    context: questionData.questionText?.substring(0, 1000),
    sessionId,
    metadata: {
      extensionVersion: chrome.runtime.getManifest().version,
      platform: 'extension',
      timestamp: Date.now()
    }
  };

  devLog('Processing (Backend):', {
    questionLength: payload.question.length,
    contextLength: payload.context?.length,
    sessionId: sessionId.substring(0, 8) + '...'
  });

  const startTime = Date.now();

  const response = await fetchWithRetry(QUIZSOLVE_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000)
  });

  if (!response.ok) {
    await handleBackendError(response);
  }

  const data = await response.json();
  devLog('Backend response in', Date.now() - startTime, 'ms:', data.answer,
    'meta:', data.metadata);

  await updateRateLimits(response.headers);
  await updateUsageStats();

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
    401: 'Session invalid. Please reinstall the extension.',
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

  const rateLimits = {
    remaining: {
      minute: minute >= 0 ? minute : 10,
      hour: hour >= 0 ? hour : 200,
      day: day >= 0 ? day : 1000
    },
    resetAt: headers.get('X-RateLimit-Reset') || new Date().toISOString()
  };

  await chrome.storage.local.set({ rateLimits });
  devLog('Rate limits updated:', rateLimits);

  // Badge warning when daily limits are low
  if (rateLimits.remaining.day < 100) {
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
// IMAGE PROXY — Fetch cross-origin images for content script
// ============================================================

async function fetchImageAsBase64(url) {
  try {
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
  if (message.type === 'PROCESS_QUESTION') {
    processQuestion(message.data)
      .then(answer => sendResponse({ success: true, answer }))
      .catch(err => {
        devError('Process question error:', err.message);
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  if (message.type === 'PROCESS_EXPLANATION') {
    processExplanation(message.data)
      .then(result => sendResponse({ success: true, ...result }))
      .catch(err => {
        devError('Process explanation error:', err.message);
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  if (message.type === 'FETCH_IMAGE') {
    fetchImageAsBase64(message.url)
      .then(result => sendResponse({ success: !!result, ...result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
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

  if (message.type === 'GET_PROVIDERS') {
    const providers = {};
    for (const [key, val] of Object.entries(AI_PROVIDERS)) {
      providers[key] = {
        name: val.name,
        models: val.models
      };
    }
    sendResponse({ providers });
    return false;
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
