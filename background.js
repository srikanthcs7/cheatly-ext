// ============================================================
// Answer Mate - Background Service Worker
// Handles AI API calls, state management, and message routing
// ============================================================

// ---- Dev Mode Detection ----
const IS_DEV = !('update_url' in chrome.runtime.getManifest());

function devLog(...args) {
  if (IS_DEV) console.log('[AnswerMate]', ...args);
}
function devWarn(...args) {
  if (IS_DEV) console.warn('[AnswerMate]', ...args);
}
function devError(...args) {
  if (IS_DEV) console.error('[AnswerMate]', ...args);
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
    makeRequest: async (apiKey, model, prompt, images) => {
      const userContent = buildOpenAIContent(prompt, images);
      devLog('OpenAI request:', model, 'images:', images?.length || 0);

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
          temperature: 0.1,
          max_tokens: 1024
        })
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
    makeRequest: async (apiKey, model, prompt, images) => {
      const parts = buildGeminiParts(prompt, images);
      devLog('Gemini request:', model, 'images:', images?.length || 0);

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 1024
          }
        })
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
    makeRequest: async (apiKey, model, prompt, images) => {
      const userContent = buildAnthropicContent(prompt, images);
      devLog('Anthropic request:', model, 'images:', images?.length || 0);

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
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userContent }]
        })
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
  // Images first for better understanding
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
  // Gemini: system prompt + user prompt combined as text
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
  // Anthropic recommends images before text
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

// ============================================================
// SMART MODEL SWITCHING
// ============================================================

async function resolveModel(provider, hasImages) {
  const settings = await chrome.storage.local.get(['model', 'smartSwitch', 'visionModel']);
  const providerConfig = AI_PROVIDERS[provider];
  const defaultModel = providerConfig.models.find(m => m.default)?.id || providerConfig.models[0].id;

  // If smart switch is ON and question has images, use the vision (balanced+) model
  if (settings.smartSwitch && hasImages) {
    // Use configured vision model if it belongs to the current provider
    if (settings.visionModel) {
      const isValidForProvider = providerConfig.models.some(m => m.id === settings.visionModel);
      if (isValidForProvider) {
        devLog('Smart switch → vision model:', settings.visionModel);
        return settings.visionModel;
      }
    }
    // Default: pick the "balanced" tier model
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
  let prompt = `Question Type: ${questionData.type}\n\n`;
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

  if (questionData.type === 'MATCHING' && questionData.matchItems) {
    prompt += `\nItems to match:\n`;
    questionData.matchItems.forEach(item => {
      prompt += `${item.identifier}. ${item.text} → Choose from: ${item.selectOptions.join(', ')}\n`;
    });
  }

  return prompt;
}

// ============================================================
// PROCESS QUESTION
// ============================================================

async function processQuestion(questionData) {
  const settings = await chrome.storage.local.get([
    'provider', 'apiKey_openai', 'apiKey_gemini', 'apiKey_anthropic'
  ]);

  const provider = settings.provider || 'openai';
  const providerConfig = AI_PROVIDERS[provider];
  if (!providerConfig) throw new Error(`Unknown provider: ${provider}`);

  const apiKey = settings[`apiKey_${provider}`];
  if (!apiKey) throw new Error(`No API key set for ${providerConfig.name}. Open the extension popup to configure.`);

  const images = questionData.images || [];
  const hasImages = images.length > 0;
  const model = await resolveModel(provider, hasImages);
  const prompt = buildPrompt(questionData);

  devLog('Processing question:', {
    type: questionData.type,
    textLength: questionData.questionText?.length,
    optionCount: questionData.options?.length,
    imageCount: images.length,
    provider,
    model
  });

  const startTime = Date.now();
  const answer = await providerConfig.makeRequest(apiKey, model, prompt, hasImages ? images : null);
  devLog('Answer received in', Date.now() - startTime, 'ms:', answer);

  return answer;
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
      color: state.active ? '#4CAF50' : '#666',
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
          // Wait for script to initialize, then send state
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
        color: state.active ? '#4CAF50' : '#666',
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

  if (message.type === 'GET_ACTIVE_TAB') {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      sendResponse({ tabId: tab?.id });
    });
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
      chrome.action.setBadgeBackgroundColor({ color: '#4CAF50', tabId });
    }
  }
});

devLog('Service worker loaded. Dev mode:', IS_DEV);
