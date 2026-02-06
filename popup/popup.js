// ============================================================
// Answer Mate - Popup Script
// Settings UI, model selection, smart switching, state management
// ============================================================

const API_KEY_LINKS = {
  openai: 'https://platform.openai.com/api-keys',
  gemini: 'https://aistudio.google.com/app/apikey',
  anthropic: 'https://console.anthropic.com/settings/keys'
};

const MODEL_DESCRIPTIONS = {
  'gpt-4.1-nano':               { name: 'GPT-4.1 Nano',          desc: 'Fastest and cheapest OpenAI model. Great for text-only MCQs.', tier: 'fast' },
  'gpt-4.1-mini':               { name: 'GPT-4.1 Mini',          desc: 'Best quality-per-dollar. Strong vision support for image questions.', tier: 'balanced' },
  'gpt-4.1':                    { name: 'GPT-4.1',               desc: 'Most powerful OpenAI model. Best accuracy for complex problems.', tier: 'powerful' },
  'gemini-2.5-flash-lite':      { name: 'Gemini 2.5 Flash Lite', desc: 'Cheapest multimodal model. Free tier available from Google.', tier: 'fast' },
  'gemini-2.5-flash':           { name: 'Gemini 2.5 Flash',      desc: 'Balanced speed and capability. Excellent vision support.', tier: 'balanced' },
  'gemini-2.5-pro':             { name: 'Gemini 2.5 Pro',        desc: 'Google\'s most capable model. 1M token context window.', tier: 'powerful' },
  'claude-haiku-4-5-20251001':  { name: 'Claude Haiku 4.5',      desc: 'Fast Anthropic model. Near-Sonnet quality at lower cost.', tier: 'fast' },
  'claude-sonnet-4-20250514':   { name: 'Claude Sonnet 4',       desc: 'Strong reasoning and vision. Great all-around choice.', tier: 'balanced' },
  'claude-sonnet-4-5-20250929': { name: 'Claude Sonnet 4.5',     desc: 'Latest and most capable Claude. Best for complex questions.', tier: 'powerful' }
};

let providers = {};
let currentProvider = 'openai';
let currentModel = '';
let activeTabId = null;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const toggleActive = $('#toggleActive');
const statusDot = $('#statusDot');
const statusText = $('#statusText');
const apiKeyInput = $('#apiKey');
const toggleKeyVisibility = $('#toggleKeyVisibility');
const providerSelect = $('#providerSelect');
const modelSelect = $('#modelSelect');
const modelInfo = $('#modelInfo');
const getApiKeyLink = $('#getApiKeyLink');
const highlightDuration = $('#highlightDuration');
const highlightDurationValue = $('#highlightDurationValue');
const highlightDurationSection = $('#highlightDurationSection');
const apiKeyHelp = $('#apiKeyHelp');
const smartSwitch = $('#smartSwitch');
const visionModelSection = $('#visionModelSection');
const visionModelSelect = $('#visionModelSelect');

// ---- Initialization ----
async function init() {
  chrome.runtime.sendMessage({ type: 'GET_PROVIDERS' }, (resp) => {
    if (resp?.providers) {
      providers = resp.providers;
      // Re-render model lists once providers are loaded
      updateModelList();
      updateVisionModelList();
    }
  });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id;

  const settings = await chrome.storage.local.get([
    'provider', 'model', 'answerMode', 'highlightDuration',
    'apiKey_openai', 'apiKey_gemini', 'apiKey_anthropic',
    'smartSwitch', 'visionModel'
  ]);

  currentProvider = settings.provider || 'openai';
  currentModel = settings.model || '';

  providerSelect.value = currentProvider;
  updateModelList();
  updateApiKeyLink();

  const savedKey = settings[`apiKey_${currentProvider}`] || '';
  apiKeyInput.value = savedKey;
  updateApiKeyHelp();

  const mode = settings.answerMode || 'auto';
  const radio = document.querySelector(`input[name="answerMode"][value="${mode}"]`);
  if (radio) radio.checked = true;
  updateHighlightVisibility(mode);

  const duration = settings.highlightDuration || 4000;
  highlightDuration.value = duration;
  highlightDurationValue.textContent = (duration / 1000) + 's';

  // Smart switch
  smartSwitch.checked = !!settings.smartSwitch;
  updateSmartSwitchVisibility(smartSwitch.checked);
  updateVisionModelList();
  if (settings.visionModel && visionModelSelect.querySelector(`option[value="${settings.visionModel}"]`)) {
    visionModelSelect.value = settings.visionModel;
  }

  if (activeTabId) {
    chrome.runtime.sendMessage({ type: 'GET_STATE', tabId: activeTabId }, (resp) => {
      if (resp) updateActiveState(resp.active);
    });
  }

  setupEventListeners();
}

// ---- Event Listeners ----
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
    });
  });

  let apiKeySaveTimeout;
  apiKeyInput.addEventListener('input', () => {
    clearTimeout(apiKeySaveTimeout);
    apiKeySaveTimeout = setTimeout(() => {
      const key = apiKeyInput.value.trim();
      chrome.storage.local.set({ [`apiKey_${currentProvider}`]: key });
      showNotification(key ? 'API key saved' : 'API key cleared', 'success');
    }, 500);
  });

  toggleKeyVisibility.addEventListener('click', () => {
    apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
  });

  providerSelect.addEventListener('change', async () => {
    currentProvider = providerSelect.value;
    chrome.storage.local.set({ provider: currentProvider });
    updateModelList();
    updateVisionModelList();
    updateApiKeyLink();

    const settings = await chrome.storage.local.get([`apiKey_${currentProvider}`]);
    apiKeyInput.value = settings[`apiKey_${currentProvider}`] || '';
    updateApiKeyHelp();
  });

  modelSelect.addEventListener('change', () => {
    currentModel = modelSelect.value;
    chrome.storage.local.set({ model: currentModel });
    updateModelInfo();
  });

  // Smart switch toggle
  smartSwitch.addEventListener('change', () => {
    const enabled = smartSwitch.checked;
    chrome.storage.local.set({ smartSwitch: enabled });
    updateSmartSwitchVisibility(enabled);
  });

  // Vision model select
  visionModelSelect.addEventListener('change', () => {
    chrome.storage.local.set({ visionModel: visionModelSelect.value });
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
}

// ---- UI Updates ----
function updateActiveState(active) {
  toggleActive.checked = active;
  statusDot.classList.toggle('active', active);
  statusText.textContent = active ? 'Active — double-click any question' : 'Inactive';
}

function updateModelList() {
  const providerConfig = providers[currentProvider];
  modelSelect.innerHTML = '';

  if (providerConfig) {
    providerConfig.models.forEach(model => {
      const opt = document.createElement('option');
      opt.value = model.id;
      opt.textContent = model.name;
      if (model.default) opt.selected = true;
      modelSelect.appendChild(opt);
    });
  }

  if (currentModel && modelSelect.querySelector(`option[value="${currentModel}"]`)) {
    modelSelect.value = currentModel;
  } else {
    currentModel = modelSelect.value;
    chrome.storage.local.set({ model: currentModel });
  }

  updateModelInfo();
}

function updateVisionModelList() {
  const providerConfig = providers[currentProvider];
  visionModelSelect.innerHTML = '';

  if (providerConfig) {
    // Only show balanced and powerful tiers as vision model options
    providerConfig.models.forEach(model => {
      if (model.tier === 'balanced' || model.tier === 'powerful') {
        const opt = document.createElement('option');
        opt.value = model.id;
        opt.textContent = model.name;
        if (model.tier === 'balanced') opt.selected = true;
        visionModelSelect.appendChild(opt);
      }
    });
  }
}

function updateModelInfo() {
  const info = MODEL_DESCRIPTIONS[currentModel];
  if (info) {
    const tierBadge = info.tier === 'fast' ? ' ⚡' : info.tier === 'powerful' ? ' ★' : '';
    modelInfo.querySelector('.info-title').textContent = info.name + tierBadge;
    modelInfo.querySelector('.info-desc').textContent = info.desc;
  }
}

function updateApiKeyLink() {
  const link = API_KEY_LINKS[currentProvider];
  const providerName = providers[currentProvider]?.name || currentProvider;
  getApiKeyLink.href = link || '#';
  getApiKeyLink.textContent = `Get ${providerName} API Key →`;
}

function updateApiKeyHelp() {
  const providerName = providers[currentProvider]?.name || currentProvider;
  apiKeyHelp.textContent = `Required for ${providerName}`;
}

function updateHighlightVisibility(mode) {
  highlightDurationSection.style.display = mode === 'highlight' ? 'flex' : 'none';
}

function updateSmartSwitchVisibility(enabled) {
  visionModelSection.style.display = enabled ? 'flex' : 'none';
}

// ---- Notification ----
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

// ---- Start ----
init();
