// ============================================================
// Answer Mate - Popup Script
// Handles settings UI, model selection, and state management
// ============================================================

const API_KEY_LINKS = {
  openai: 'https://platform.openai.com/api-keys',
  gemini: 'https://aistudio.google.com/app/apikey',
  anthropic: 'https://console.anthropic.com/settings/keys'
};

const MODEL_DESCRIPTIONS = {
  'gpt-4o-mini': { name: 'GPT-4o Mini', desc: 'Fast and cost-effective. Great for most question types.' },
  'gpt-4o': { name: 'GPT-4o', desc: 'Most capable OpenAI model. Best accuracy for complex questions.' },
  'gpt-4-turbo': { name: 'GPT-4 Turbo', desc: 'High capability with longer context window.' },
  'gemini-2.0-flash': { name: 'Gemini 2.0 Flash', desc: 'Google\'s fastest model. Free tier available.' },
  'gemini-1.5-pro': { name: 'Gemini 1.5 Pro', desc: 'Powerful with massive context. Best for long passages.' },
  'claude-sonnet-4-20250514': { name: 'Claude Sonnet 4', desc: 'Anthropic\'s balanced model. Strong reasoning.' },
  'claude-3-5-haiku-20241022': { name: 'Claude 3.5 Haiku', desc: 'Fast and efficient. Good for quick answers.' }
};

let providers = {};
let currentProvider = 'openai';
let currentModel = '';
let activeTabId = null;

// ---- DOM Elements ----
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

// ---- Initialization ----
async function init() {
  // Get providers
  chrome.runtime.sendMessage({ type: 'GET_PROVIDERS' }, (resp) => {
    if (resp?.providers) {
      providers = resp.providers;
    }
  });

  // Get active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id;

  // Load saved settings
  const settings = await chrome.storage.local.get([
    'provider', 'model', 'answerMode', 'highlightDuration',
    'apiKey_openai', 'apiKey_gemini', 'apiKey_anthropic'
  ]);

  currentProvider = settings.provider || 'openai';
  currentModel = settings.model || '';

  providerSelect.value = currentProvider;
  updateModelList();
  updateApiKeyLink();

  // Load API key for current provider
  const savedKey = settings[`apiKey_${currentProvider}`] || '';
  apiKeyInput.value = savedKey;
  updateApiKeyHelp();

  // Answer mode
  const mode = settings.answerMode || 'auto';
  const radio = document.querySelector(`input[name="answerMode"][value="${mode}"]`);
  if (radio) radio.checked = true;
  updateHighlightVisibility(mode);

  // Highlight duration
  const duration = settings.highlightDuration || 4000;
  highlightDuration.value = duration;
  highlightDurationValue.textContent = (duration / 1000) + 's';

  // Get current state
  if (activeTabId) {
    chrome.runtime.sendMessage({ type: 'GET_STATE', tabId: activeTabId }, (resp) => {
      if (resp) {
        updateActiveState(resp.active);
      }
    });
  }

  setupEventListeners();
}

// ---- Event Listeners ----
function setupEventListeners() {
  // Toggle active
  toggleActive.addEventListener('change', () => {
    const active = toggleActive.checked;
    chrome.runtime.sendMessage({ type: 'SET_STATE', active });
    updateActiveState(active);
  });

  // Tabs
  $$('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach(t => t.classList.remove('active'));
      $$('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      $(`#tab-${tab.dataset.tab}`).classList.add('active');
    });
  });

  // API Key input
  let apiKeySaveTimeout;
  apiKeyInput.addEventListener('input', () => {
    clearTimeout(apiKeySaveTimeout);
    apiKeySaveTimeout = setTimeout(() => {
      const key = apiKeyInput.value.trim();
      chrome.storage.local.set({ [`apiKey_${currentProvider}`]: key });
      showNotification(key ? 'API key saved' : 'API key cleared', 'success');
    }, 500);
  });

  // Toggle key visibility
  toggleKeyVisibility.addEventListener('click', () => {
    apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
  });

  // Provider select
  providerSelect.addEventListener('change', async () => {
    currentProvider = providerSelect.value;
    chrome.storage.local.set({ provider: currentProvider });
    updateModelList();
    updateApiKeyLink();

    // Load API key for this provider
    const settings = await chrome.storage.local.get([`apiKey_${currentProvider}`]);
    apiKeyInput.value = settings[`apiKey_${currentProvider}`] || '';
    updateApiKeyHelp();
  });

  // Model select
  modelSelect.addEventListener('change', () => {
    currentModel = modelSelect.value;
    chrome.storage.local.set({ model: currentModel });
    updateModelInfo();
  });

  // Answer mode
  $$('input[name="answerMode"]').forEach(radio => {
    radio.addEventListener('change', () => {
      const mode = radio.value;
      chrome.storage.local.set({ answerMode: mode });
      updateHighlightVisibility(mode);
    });
  });

  // Highlight duration
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

  // Restore saved model if it belongs to this provider
  if (currentModel && modelSelect.querySelector(`option[value="${currentModel}"]`)) {
    modelSelect.value = currentModel;
  } else {
    currentModel = modelSelect.value;
    chrome.storage.local.set({ model: currentModel });
  }

  updateModelInfo();
}

function updateModelInfo() {
  const info = MODEL_DESCRIPTIONS[currentModel];
  if (info) {
    modelInfo.querySelector('.info-title').textContent = info.name;
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

// ---- Notification ----
function showNotification(message, type = 'success') {
  // Remove existing
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
