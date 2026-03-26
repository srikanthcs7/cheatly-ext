// ============================================================
// QuizSolve - Popup Script
// Settings UI, usage stats, auth
// ============================================================

const QUIZSOLVE_BASE_URL = 'https://getquizsolve.com';

const BANNER_API = 'https://getquizsolve.com/api/banner';
const BANNER_CACHE_TTL = 60 * 60 * 1000; // 1 hour
const REVIEW_URL = `https://chromewebstore.google.com/detail/ai-quiz-solve/${chrome.runtime.id}/reviews`;

let currentApiMode = 'quizsolve_free';
let currentPlan = 'free';
let activeTabId = null;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const toggleActive = $('#toggleActive');
const statusDot = $('#statusDot');
const statusText = $('#statusText');
const highlightDuration = $('#highlightDuration');
const highlightDurationValue = $('#highlightDurationValue');
const highlightDurationSection = $('#highlightDurationSection');
const rateLimitsSection = $('#rateLimitsSection');
const featureDblClickSolveToggle = $('#featureDblClickSolve');
const featureHighlightToggle = $('#featureHighlight');
const featureScreenshotSolveToggle = $('#featureScreenshotSolve');
const featureNotificationsToggle = $('#featureNotifications');
const modalSizeSelect = $('#modalSize');

// Rate limit config (fetched dynamically)
let rateConfig = { free: { daily: 10, hourly: 15, perMinute: 5 }, pro: { daily: -1, hourly: -1, perMinute: 30 }, banner: { show: false, message: '', type: 'info' } };

// Account elements
const planBadge = $('#planBadge');
const btnUpgrade = $('#btnUpgrade');
const tokenInput = $('#tokenInput');
const btnLogin = $('#btnLogin');
const btnLogout = $('#btnLogout');
const btnManageSub = $('#btnManageSub');
const accountLoggedOut = $('#accountLoggedOut');
const accountLoggedIn = $('#accountLoggedIn');
const accountEmail = $('#accountEmail');

// ============================================================
// AUTH FUNCTIONS
// ============================================================

async function verifyToken(token) {
  const resp = await fetch(`${QUIZSOLVE_BASE_URL}/api/auth/verify-token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(10000)
  });

  if (!resp.ok) {
    if (resp.status === 401) throw new Error('Invalid or expired token');
    throw new Error(`Verification failed (${resp.status})`);
  }

  const data = await resp.json();
  if (!data.valid) throw new Error(data.error || 'Token invalid');
  return data.user;
}

async function loginWithToken(token) {
  if (!token || token.trim().length < 10) {
    showNotification('Please enter a valid token', 'error');
    return;
  }

  try {
    btnLogin.disabled = true;
    const user = await verifyToken(token.trim());
    await chrome.storage.local.set({
      authToken: token.trim(),
      authUser: user,
      plan: user.plan || 'free'
    });
    currentPlan = user.plan || 'free';
    updateAccountUI(user);
    updateUsageLimitText();

    // Auto-switch to matching API mode
    if (user.plan === 'pro') {
      currentApiMode = 'quizsolve_pro';
      await chrome.storage.local.set({ apiMode: 'quizsolve_pro' });
      const radio = document.querySelector('input[name="apiMode"][value="quizsolve_pro"]');
      if (radio) radio.checked = true;
    }

    showNotification('Logged in successfully', 'success');
  } catch (err) {
    showNotification(err.message || 'Login failed', 'error');
  } finally {
    btnLogin.disabled = false;
  }
}

async function logout() {
  await chrome.storage.local.remove(['authToken', 'authUser']);
  await chrome.storage.local.set({ plan: 'free' });
  currentPlan = 'free';
  updateAccountUI(null);
  updateUsageLimitText();

  // Switch to free mode if currently on pro
  if (currentApiMode === 'quizsolve_pro') {
    currentApiMode = 'quizsolve_free';
    await chrome.storage.local.set({ apiMode: 'quizsolve_free' });
    const radio = document.querySelector('input[name="apiMode"][value="quizsolve_free"]');
    if (radio) radio.checked = true;
  }

  showNotification('Logged out', 'success');
}

async function manageSubscription() {
  const { authToken } = await chrome.storage.local.get('authToken');
  if (!authToken) {
    showNotification('Please log in first', 'error');
    return;
  }
  // Open the manage page with token in hash — the page handles the API call and redirect
  chrome.tabs.create({ url: `${QUIZSOLVE_BASE_URL}/account/manage#token=${authToken}` });
}

function updateAccountUI(user) {
  if (user) {
    accountLoggedOut.style.display = 'none';
    accountLoggedIn.style.display = 'flex';
    accountEmail.textContent = user.email || user.displayName || 'Logged in';

    const isPro = (user.plan || currentPlan) === 'pro';
    planBadge.textContent = isPro ? 'Pro Plan' : 'Free Plan';
    planBadge.className = `plan-badge ${isPro ? 'plan-pro' : 'plan-free'}`;
    planBadge.style.display = '';
    btnUpgrade.style.display = isPro ? 'none' : '';
    btnManageSub.style.display = isPro ? '' : 'none';
  } else {
    accountLoggedOut.style.display = 'flex';
    accountLoggedIn.style.display = 'none';
    tokenInput.value = '';
    planBadge.style.display = 'none';
    btnUpgrade.style.display = '';
    btnManageSub.style.display = 'none';
  }
}

// ============================================================
// INITIALIZATION
// ============================================================

async function init() {
  // Fetch dynamic rate limit config
  chrome.runtime.sendMessage({ type: 'GET_RATE_CONFIG' }, (resp) => {
    if (chrome.runtime.lastError) return;
    if (resp?.config) {
      rateConfig = resp.config;
      chrome.storage.local.get(['stats', 'rateLimits'], (data) => {
        if (chrome.runtime.lastError) return;
        updateUsageDisplay(data.stats, data.rateLimits);
      });
      // Populate language dropdown from config (fallback to defaults)
      populateLanguageDropdown(resp.config.supportedLanguages || DEFAULT_LANGUAGES);
      // Restore stored language selection
      chrome.storage.sync.get('language', (result) => {
        if (chrome.runtime.lastError) return;
        if (result.language) {
          setLangValue(result.language);
        }
      });
    }
  });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id;

  const settings = await chrome.storage.local.get([
    'answerMode', 'highlightDuration', 'apiMode',
    'stats', 'rateLimits', 'sessionId',
    'featureDblClickSolve', 'featureHighlight',
    'featureScreenshotSolve', 'featureNotifications', 'modalSize',
    'authToken', 'authUser', 'plan'
  ]);

  // Backward compat: migrate 'quizsolve' → 'quizsolve_free'
  let apiMode = settings.apiMode || 'quizsolve_free';
  if (apiMode === 'quizsolve') {
    apiMode = 'quizsolve_free';
    await chrome.storage.local.set({ apiMode: 'quizsolve_free' });
  }
  currentApiMode = apiMode;

  // Plan / Auth
  currentPlan = settings.plan || 'free';
  if (settings.authUser) {
    updateAccountUI(settings.authUser);
  } else {
    updateAccountUI(null);
  }

  // Answer mode
  const mode = settings.answerMode || 'auto';
  const radio = document.querySelector(`input[name="answerMode"][value="${mode}"]`);
  if (radio) radio.checked = true;
  updateHighlightVisibility(mode);

  const duration = settings.highlightDuration || 4000;
  highlightDuration.value = duration;
  highlightDurationValue.textContent = (duration / 1000) + 's';

  // Feature toggles
  featureDblClickSolveToggle.checked = settings.featureDblClickSolve !== false;
  featureHighlightToggle.checked = !!settings.featureHighlight;
  featureScreenshotSolveToggle.checked = settings.featureScreenshotSolve !== false;
  featureNotificationsToggle.checked = settings.featureNotifications !== false;
  if (settings.modalSize) modalSizeSelect.value = settings.modalSize;

  // Usage stats
  updateUsageDisplay(settings.stats, settings.rateLimits);

  // Session ID
  if (settings.sessionId) {
    $('#sessionId').textContent = settings.sessionId.substring(0, 8) + '...';
    $('#sessionId').dataset.full = settings.sessionId;
  }

  // Active state
  if (activeTabId) {
    chrome.runtime.sendMessage({ type: 'GET_STATE', tabId: activeTabId }, (resp) => {
      if (chrome.runtime.lastError) return;
      if (resp) updateActiveState(resp.active);
    });
  }

  // Set version from manifest
  $('#version').textContent = 'v' + chrome.runtime.getManifest().version;

  // Show Cmd instead of Ctrl on Mac
  if (navigator.platform.indexOf('Mac') !== -1) {
    $$('kbd').forEach(kbd => {
      kbd.textContent = kbd.textContent.replace('Ctrl+', 'Cmd+');
    });
  }

  setupEventListeners();
}

// ============================================================
// LANGUAGE DROPDOWN
// ============================================================

const DEFAULT_LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
  { code: 'hi', name: 'Hindi' },
  { code: 'fr', name: 'French' },
  { code: 'ar', name: 'Arabic' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'zh', name: 'Chinese (Simplified)' },
  { code: 'zh-TW', name: 'Chinese (Traditional)' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'de', name: 'German' },
  { code: 'it', name: 'Italian' },
  { code: 'ru', name: 'Russian' },
  { code: 'tr', name: 'Turkish' },
  { code: 'vi', name: 'Vietnamese' },
  { code: 'th', name: 'Thai' },
  { code: 'id', name: 'Indonesian' },
  { code: 'ms', name: 'Malay' },
  { code: 'nl', name: 'Dutch' },
  { code: 'pl', name: 'Polish' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'tl', name: 'Filipino' },
  { code: 'bn', name: 'Bengali' },
  { code: 'ta', name: 'Tamil' },
  { code: 'te', name: 'Telugu' },
  { code: 'kn', name: 'Kannada' },
  { code: 'ml', name: 'Malayalam' },
  { code: 'mr', name: 'Marathi' },
  { code: 'gu', name: 'Gujarati' },
  { code: 'pa', name: 'Punjabi' },
  { code: 'ur', name: 'Urdu' },
  { code: 'fa', name: 'Persian' },
  { code: 'he', name: 'Hebrew' },
  { code: 'sv', name: 'Swedish' },
  { code: 'no', name: 'Norwegian' },
  { code: 'da', name: 'Danish' },
  { code: 'fi', name: 'Finnish' },
  { code: 'cs', name: 'Czech' },
  { code: 'ro', name: 'Romanian' },
  { code: 'hu', name: 'Hungarian' },
  { code: 'el', name: 'Greek' },
  { code: 'bg', name: 'Bulgarian' },
  { code: 'hr', name: 'Croatian' },
  { code: 'sr', name: 'Serbian' },
  { code: 'sk', name: 'Slovak' },
  { code: 'sl', name: 'Slovenian' },
  { code: 'lt', name: 'Lithuanian' },
  { code: 'lv', name: 'Latvian' },
  { code: 'et', name: 'Estonian' },
  { code: 'sw', name: 'Swahili' },
  { code: 'am', name: 'Amharic' },
  { code: 'ka', name: 'Georgian' },
  { code: 'kk', name: 'Kazakh' },
  { code: 'uz', name: 'Uzbek' },
  { code: 'ca', name: 'Catalan' },
  { code: 'eu', name: 'Basque' },
  { code: 'gl', name: 'Galician' },
  { code: 'ne', name: 'Nepali' },
  { code: 'si', name: 'Sinhala' },
  { code: 'my', name: 'Myanmar (Burmese)' },
  { code: 'km', name: 'Khmer' },
  { code: 'lo', name: 'Lao' },
  { code: 'mn', name: 'Mongolian' },
  { code: 'az', name: 'Azerbaijani' },
];

let langOptions = [];
let langSelectedCode = 'en';
let langFocusedIndex = -1;

function populateLanguageDropdown(languages) {
  if (!languages || !languages.length) return;
  langOptions = languages;
  renderLangList(languages);
}

function renderLangList(filtered) {
  const list = $('#langList');
  list.innerHTML = '';
  langFocusedIndex = -1;

  if (filtered.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'search-select-empty';
    empty.textContent = 'No languages found';
    list.appendChild(empty);
    return;
  }

  filtered.forEach((lang) => {
    const li = document.createElement('li');
    li.className = 'search-select-item';
    if (lang.code === langSelectedCode) li.classList.add('selected');
    li.textContent = lang.name;
    li.dataset.code = lang.code;
    li.addEventListener('click', () => selectLang(lang));
    list.appendChild(li);
  });
}

function selectLang(lang) {
  langSelectedCode = lang.code;
  $('#langValue').textContent = lang.name;
  chrome.storage.sync.set({ language: lang.code });
  closeLangDropdown();
}

function openLangDropdown() {
  const wrap = $('#languageSelect');
  if (wrap.classList.contains('open')) return;
  wrap.classList.add('open');
  const input = $('#langSearch');
  input.value = '';
  renderLangList(langOptions);
  setTimeout(() => input.focus(), 0);
}

function closeLangDropdown() {
  $('#languageSelect').classList.remove('open');
  $('#langSearch').value = '';
  langFocusedIndex = -1;
}

function updateLangFocus(items) {
  items.forEach((el, i) => {
    el.classList.toggle('focused', i === langFocusedIndex);
  });
  if (langFocusedIndex >= 0 && items[langFocusedIndex]) {
    items[langFocusedIndex].scrollIntoView({ block: 'nearest' });
  }
}

function setLangValue(code) {
  langSelectedCode = code;
  const match = langOptions.find(l => l.code === code);
  if (match) {
    $('#langValue').textContent = match.name;
  }
}

function setupLangDropdown() {
  const trigger = $('#langTrigger');
  const input = $('#langSearch');
  const wrap = $('#languageSelect');

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (wrap.classList.contains('open')) {
      closeLangDropdown();
    } else {
      openLangDropdown();
    }
  });

  input.addEventListener('input', () => {
    const q = input.value.toLowerCase().trim();
    const filtered = q
      ? langOptions.filter(l => l.name.toLowerCase().includes(q) || l.code.toLowerCase().includes(q))
      : langOptions;
    renderLangList(filtered);
  });

  input.addEventListener('keydown', (e) => {
    const items = $$('#langList .search-select-item');
    if (!items.length) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      langFocusedIndex = Math.min(langFocusedIndex + 1, items.length - 1);
      updateLangFocus(items);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      langFocusedIndex = Math.max(langFocusedIndex - 1, 0);
      updateLangFocus(items);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (langFocusedIndex >= 0 && items[langFocusedIndex]) {
        items[langFocusedIndex].click();
      }
    } else if (e.key === 'Escape') {
      closeLangDropdown();
      trigger.focus();
    }
  });

  // Close on outside click
  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target)) {
      closeLangDropdown();
    }
  });
}

// ============================================================
// EVENT LISTENERS
// ============================================================

function setupEventListeners() {
  toggleActive.addEventListener('change', () => {
    const active = toggleActive.checked;
    chrome.runtime.sendMessage({ type: 'SET_STATE', active });
    updateActiveState(active);
  });

  $$('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach(t => t.classList.remove('active'));
      $$('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      $(`#tab-${tab.dataset.tab}`).classList.add('active');

      if (tab.dataset.tab === 'usage') {
        refreshUsageStats();
      }
    });
  });

  $$('input[name="answerMode"]').forEach(radio => {
    radio.addEventListener('change', () => {
      const mode = radio.value;
      chrome.storage.local.set({ answerMode: mode });
      updateHighlightVisibility(mode);
    });
  });

  highlightDuration.addEventListener('input', () => {
    const val = parseInt(highlightDuration.value);
    highlightDurationValue.textContent = (val / 1000) + 's';
    chrome.storage.local.set({ highlightDuration: val });
  });

  // Feature toggles
  featureDblClickSolveToggle.addEventListener('change', () => {
    chrome.storage.local.set({ featureDblClickSolve: featureDblClickSolveToggle.checked });
    updateActiveState(toggleActive.checked);
    if (!featureDblClickSolveToggle.checked) {
      showNotification('Auto-answering disabled — other features still work', 'success');
    }
  });

  featureHighlightToggle.addEventListener('change', () => {
    chrome.storage.local.set({ featureHighlight: featureHighlightToggle.checked });
  });

  featureScreenshotSolveToggle.addEventListener('change', () => {
    chrome.storage.local.set({ featureScreenshotSolve: featureScreenshotSolveToggle.checked });
  });

  featureNotificationsToggle.addEventListener('change', () => {
    chrome.storage.local.set({ featureNotifications: featureNotificationsToggle.checked });
  });

  modalSizeSelect.addEventListener('change', () => {
    chrome.storage.local.set({ modalSize: modalSizeSelect.value });
  });

  // Searchable language dropdown
  setupLangDropdown();

  // Copy session ID
  $('#copySessionId').addEventListener('click', () => {
    const full = $('#sessionId').dataset.full;
    if (full) {
      navigator.clipboard.writeText(full).then(() => {
        showNotification('Session ID copied', 'success');
      }).catch(() => {});
    }
  });

  // Auth: login button
  btnLogin.addEventListener('click', () => {
    loginWithToken(tokenInput.value);
  });

  tokenInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loginWithToken(tokenInput.value);
  });

  btnLogout.addEventListener('click', () => {
    logout();
  });

  // Manage Subscription button
  btnManageSub.addEventListener('click', () => {
    manageSubscription();
  });

  // Upgrade button
  btnUpgrade.addEventListener('click', () => {
    chrome.tabs.create({ url: `${QUIZSOLVE_BASE_URL}/pricing` });
  });

  // Screenshot Solve button — triggers capture from popup
  $('#btnScreenshotSolve').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'TRIGGER_SCREENSHOT_SOLVE' });
    window.close();
  });
}

// ============================================================
// UI UPDATES
// ============================================================

function updateActiveState(active) {
  toggleActive.checked = active;
  statusDot.classList.toggle('active', active);
  if (!active) {
    statusText.textContent = 'Inactive';
  } else if (featureDblClickSolveToggle.checked) {
    statusText.textContent = 'Active — double-click any question';
  } else {
    statusText.textContent = 'Active';
  }
}

function updateHighlightVisibility(mode) {
  highlightDurationSection.style.display = mode === 'highlight' ? 'flex' : 'none';
}

function updateUsageLimitText() {
  const el = $('#usageLimitText');
  if (!el) return;
  if (currentPlan === 'pro') {
    el.textContent = 'Pro plan: Unlimited questions/day';
  } else {
    const screenshotLimit = rateConfig.free.screenshotDaily || 3;
    el.textContent = `Free plan: ${rateConfig.free.daily}/day (incl. ${screenshotLimit} Snap It)`;
  }
}

// ============================================================
// USAGE STATS
// ============================================================

function updateUsageDisplay(stats, rateLimits) {
  if (stats) {
    const today = new Date().toISOString().split('T')[0];
    const todayCount = stats.lastRequestDate === today ? (stats.requestsToday || 0) : 0;

    $('#usageToday').textContent = todayCount;
    $('#usageTotal').textContent = stats.totalRequests || 0;

    const tier = currentPlan === 'pro' ? rateConfig.pro : rateConfig.free;
    const dailyLimit = tier.daily === -1 ? 10000 : tier.daily;
    const percent = Math.min(100, (todayCount / dailyLimit) * 100);
    $('#usageProgressBar').style.width = percent + '%';

    if (percent > 80) {
      $('#usageProgressBar').style.background = 'var(--danger)';
    } else if (percent > 50) {
      $('#usageProgressBar').style.background = '#f59e0b';
    } else {
      $('#usageProgressBar').style.background = '';
    }
  }

  if (rateLimits?.remaining) {
    $('#rlMinute').textContent = rateLimits.remaining.minute;
    $('#rlHour').textContent = rateLimits.remaining.hour;
    $('#rlDay').textContent = rateLimits.remaining.day;

    $('#rlMinute').classList.toggle('low', rateLimits.remaining.minute === 0);
    $('#rlHour').classList.toggle('low', rateLimits.remaining.hour === 0);
    $('#rlDay').classList.toggle('low', rateLimits.remaining.day < 5);
  }

  updateUsageLimitText();
  updateRateBanner(stats, rateLimits);
}

async function refreshUsageStats() {
  const data = await chrome.storage.local.get(['stats', 'rateLimits', 'plan']);
  currentPlan = data.plan || 'free';
  updateUsageDisplay(data.stats, data.rateLimits);
}

// ============================================================
// NOTIFICATION
// ============================================================

function showNotification(message, type = 'success') {
  const existing = document.querySelector('.notification');
  if (existing) existing.remove();

  const el = document.createElement('div');
  el.className = `notification ${type}`;
  el.textContent = message;
  document.body.appendChild(el);

  requestAnimationFrame(() => {
    el.classList.add('show');
  });

  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 2000);
}

// ============================================================
// RATE LIMIT WARNING BANNER
// ============================================================

const rateBanner = $('#rateBanner');
const rateBannerMsg = $('#rateBannerMsg');
const rateBannerUpgrade = $('#rateBannerUpgrade');

function updateRateBanner(stats, rateLimits) {
  if (currentPlan === 'pro') {
    if (rateConfig.banner?.show && rateConfig.banner.message) {
      rateBannerMsg.textContent = rateConfig.banner.message;
      rateBanner.style.display = 'flex';
    } else {
      rateBanner.style.display = 'none';
    }
    return;
  }

  if (rateConfig.banner?.show && rateConfig.banner.message) {
    rateBannerMsg.textContent = rateConfig.banner.message;
    rateBanner.style.display = 'flex';
    return;
  }

  const today = new Date().toISOString().split('T')[0];
  const todayCount = stats?.lastRequestDate === today ? (stats?.requestsToday || 0) : 0;
  const tier = rateConfig.free;
  const dailyLimit = tier.daily;
  const dayRemaining = rateLimits?.remaining?.day;

  const minRemaining = rateLimits?.remaining?.minute;
  const hourRemaining = rateLimits?.remaining?.hour;

  if (todayCount >= dailyLimit || dayRemaining === 0) {
    rateBannerMsg.textContent = 'Daily limit reached — upgrade for unlimited access';
    rateBanner.style.display = 'flex';
  } else if (minRemaining === 0 || hourRemaining === 0) {
    rateBannerMsg.textContent = 'Rate limit reached — please wait a moment';
    rateBanner.style.display = 'flex';
  } else if (dayRemaining !== undefined && dayRemaining <= 3) {
    rateBannerMsg.textContent = `Only ${dayRemaining} questions left today`;
    rateBanner.style.display = 'flex';
  } else {
    rateBanner.style.display = 'none';
  }
}

rateBannerUpgrade.addEventListener('click', () => {
  chrome.tabs.create({ url: `${QUIZSOLVE_BASE_URL}/pricing` });
});

// Listen for storage changes to show banner in real-time
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (changes.stats || changes.rateLimits) {
    chrome.storage.local.get(['stats', 'rateLimits'], (data) => {
      if (chrome.runtime.lastError) return;
      updateRateBanner(data.stats, data.rateLimits);
    });
  }
});

// ============================================================
// ANNOUNCEMENT BANNER
// ============================================================

const announcementBanner = $('#announcementBanner');
const bannerEmoji = $('#bannerEmoji');
const bannerTitle = $('#bannerTitle');
const bannerCta = $('#bannerCta');
const bannerClose = $('#bannerClose');

function shouldShowBanner(banner, dismissedBanners) {
  if (!banner || !banner.active) return false;
  if (dismissedBanners && dismissedBanners.includes(banner.id)) return false;

  const now = new Date();
  if (banner.startDate && new Date(banner.startDate) > now) return false;
  if (banner.endDate && new Date(banner.endDate) < now) return false;

  if (banner.targetVersions && banner.targetVersions.length > 0) {
    const version = chrome.runtime.getManifest().version;
    if (!banner.targetVersions.includes(version)) return false;
  }

  return true;
}

function renderBanner(banner) {
  announcementBanner.className = `announcement-banner banner-${banner.type || 'info'}`;

  if (banner.emoji) {
    bannerEmoji.textContent = banner.emoji;
    bannerEmoji.style.display = '';
  } else {
    bannerEmoji.style.display = 'none';
  }

  bannerTitle.textContent = banner.title;

  if (banner.ctaText && banner.ctaUrl) {
    bannerCta.textContent = banner.ctaText;
    bannerCta.href = banner.ctaUrl;
    bannerCta.style.display = '';
  } else {
    bannerCta.style.display = 'none';
  }

  if (banner.dismissible === false) {
    bannerClose.style.display = 'none';
  } else {
    bannerClose.style.display = '';
  }

  announcementBanner.style.display = 'flex';
  announcementBanner.dataset.bannerId = banner.id;
}

async function fetchAnnouncementBanner() {
  try {
    const { cachedBanner, bannerLastFetchedAt, dismissedBanners = [] } =
      await chrome.storage.local.get(['cachedBanner', 'bannerLastFetchedAt', 'dismissedBanners']);

    const now = Date.now();

    // Use cache if fresh
    if (cachedBanner && bannerLastFetchedAt && (now - bannerLastFetchedAt < BANNER_CACHE_TTL)) {
      if (shouldShowBanner(cachedBanner, dismissedBanners)) {
        renderBanner(cachedBanner);
      }
      return;
    }

    // Fetch fresh
    const version = chrome.runtime.getManifest().version;
    const resp = await fetch(BANNER_API, {
      headers: { 'X-Extension-Version': version },
      signal: AbortSignal.timeout(5000)
    });

    if (!resp.ok) return;

    const data = await resp.json();
    await chrome.storage.local.set({
      cachedBanner: data,
      bannerLastFetchedAt: now
    });

    if (shouldShowBanner(data, dismissedBanners)) {
      renderBanner(data);
    }
  } catch (err) {
    // Silent fail — no banner shown
  }
}

bannerClose.addEventListener('click', async () => {
  const bannerId = announcementBanner.dataset.bannerId;
  if (!bannerId) return;

  const { dismissedBanners = [] } = await chrome.storage.local.get('dismissedBanners');
  await chrome.storage.local.set({
    dismissedBanners: [...dismissedBanners, bannerId]
  });
  announcementBanner.style.display = 'none';
});

// ============================================================
// REVIEW PROMPT
// ============================================================

const reviewPrompt = $('#reviewPrompt');
const btnRate = $('#btnRate');
const btnReviewDismiss = $('#btnReviewDismiss');

async function checkReviewPrompt() {
  try {
    const { installDate, stats, hasRated, reviewDismissedAt } =
      await chrome.storage.local.get(['installDate', 'stats', 'hasRated', 'reviewDismissedAt']);

    if (hasRated) return;

    const solveCount = stats?.totalRequests || 0;
    if (solveCount < 5) return;

    const daysSinceInstall = (Date.now() - (installDate || Date.now())) / (1000 * 60 * 60 * 24);
    if (daysSinceInstall < 3) return;

    if (reviewDismissedAt) {
      const daysSinceDismissed = (Date.now() - reviewDismissedAt) / (1000 * 60 * 60 * 24);
      if (daysSinceDismissed < 14) return;
    }

    reviewPrompt.style.display = '';
  } catch (err) {
    // Silent fail
  }
}

btnRate.addEventListener('click', async () => {
  await chrome.storage.local.set({ hasRated: true });
  chrome.tabs.create({ url: REVIEW_URL });
  reviewPrompt.style.display = 'none';
});

btnReviewDismiss.addEventListener('click', async () => {
  await chrome.storage.local.set({ reviewDismissedAt: Date.now() });
  reviewPrompt.style.display = 'none';
});

// ---- Start ----
init().then(() => {
  fetchAnnouncementBanner();
  checkReviewPrompt();
}).catch(() => {});
