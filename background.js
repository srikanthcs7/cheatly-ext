// ============================================================
// Answer Mate - Background Service Worker
// Handles AI API calls, state management, and message routing
// ============================================================

const AI_PROVIDERS = {
  openai: {
    name: 'OpenAI',
    models: [
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini (Fast)', default: true },
      { id: 'gpt-4o', name: 'GPT-4o (Powerful)' },
      { id: 'gpt-4-turbo', name: 'GPT-4 Turbo' }
    ],
    makeRequest: async (apiKey, model, prompt) => {
      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: prompt }
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
      return data.choices[0].message.content.trim();
    }
  },
  gemini: {
    name: 'Google Gemini',
    models: [
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash (Fast)', default: true },
      { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro (Powerful)' }
    ],
    makeRequest: async (apiKey, model, prompt) => {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{ text: SYSTEM_PROMPT + '\n\n' + prompt }]
          }],
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
      return data.candidates[0].content.parts[0].text.trim();
    }
  },
  anthropic: {
    name: 'Anthropic',
    models: [
      { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
      { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku (Fast)', default: true }
    ],
    makeRequest: async (apiKey, model, prompt) => {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
          model: model,
          max_tokens: 1024,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: prompt }]
        })
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error?.message || `Anthropic API error: ${resp.status}`);
      }
      const data = await resp.json();
      return data.content[0].text.trim();
    }
  }
};

const SYSTEM_PROMPT = `You are a precise answer-finding assistant. Analyze the question and provide ONLY the correct answer.

RESPONSE FORMAT (follow strictly based on question type):
- MULTIPLE_CHOICE: Reply with ONLY the option identifier (e.g., "B" or "2"). If options are labeled A/B/C/D use letters. If labeled 1/2/3/4 use numbers. Match the format shown.
- TRUE_FALSE: Reply with ONLY "True" or "False"
- FILL_BLANK: Reply with ONLY the answer word(s) that fill the blank
- MATCHING: Reply with pairs like "1→C, 2→A, 3→B, 4→D"
- MULTI_SELECT: Reply with ALL correct identifiers separated by commas (e.g., "A, C, D")
- SHORT_ANSWER: Reply with a concise factual answer (1-3 sentences max)
- ESSAY: Reply with a well-structured answer (3-6 sentences)

CRITICAL RULES:
- ALWAYS choose from the given options when options are provided
- Be factually accurate
- No preamble, no explanations, no extra formatting for objective questions
- Just the raw answer, nothing else
- For multiple choice, ONLY output the letter/number, never the full option text`;

// Extension state per tab
const tabStates = {};

function getTabState(tabId) {
  if (!tabStates[tabId]) {
    tabStates[tabId] = { active: false };
  }
  return tabStates[tabId];
}

// Build prompt from question data
function buildPrompt(questionData) {
  let prompt = `Question Type: ${questionData.type}\n\n`;
  prompt += `Question: ${questionData.questionText}\n`;

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

// Process a question through AI
async function processQuestion(questionData) {
  const settings = await chrome.storage.local.get([
    'provider', 'model', 'apiKey_openai', 'apiKey_gemini', 'apiKey_anthropic'
  ]);

  const provider = settings.provider || 'openai';
  const providerConfig = AI_PROVIDERS[provider];
  if (!providerConfig) throw new Error(`Unknown provider: ${provider}`);

  const apiKey = settings[`apiKey_${provider}`];
  if (!apiKey) throw new Error(`No API key set for ${providerConfig.name}. Open the extension popup to configure.`);

  const model = settings.model || providerConfig.models.find(m => m.default)?.id || providerConfig.models[0].id;
  const prompt = buildPrompt(questionData);

  return await providerConfig.makeRequest(apiKey, model, prompt);
}

// Handle keyboard shortcut
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-extension') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    const state = getTabState(tab.id);
    state.active = !state.active;

    // Update badge
    chrome.action.setBadgeText({
      text: state.active ? 'ON' : '',
      tabId: tab.id
    });
    chrome.action.setBadgeBackgroundColor({
      color: state.active ? '#4CAF50' : '#666',
      tabId: tab.id
    });

    // Notify content script
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'TOGGLE_STATE',
        active: state.active
      });
    } catch (e) {
      // Content script not ready, inject it
      if (state.active) {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js']
        });
        await chrome.scripting.insertCSS({
          target: { tabId: tab.id },
          files: ['content.css']
        });
        setTimeout(async () => {
          try {
            await chrome.tabs.sendMessage(tab.id, {
              type: 'TOGGLE_STATE',
              active: true
            });
          } catch (_) {}
        }, 200);
      }
    }
  }
});

// Handle messages from content script and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'PROCESS_QUESTION') {
    processQuestion(message.data)
      .then(answer => sendResponse({ success: true, answer }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // Keep channel open for async response
  }

  if (message.type === 'GET_STATE') {
    const tabId = message.tabId || sender.tab?.id;
    if (tabId) {
      const state = getTabState(tabId);
      sendResponse({ active: state.active });
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

// Clean up tab state when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabStates[tabId];
});

// Clean up badge when navigating
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    const state = getTabState(tabId);
    if (state.active) {
      chrome.action.setBadgeText({ text: 'ON', tabId });
      chrome.action.setBadgeBackgroundColor({ color: '#4CAF50', tabId });
    }
  }
});
