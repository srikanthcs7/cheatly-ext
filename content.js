// ============================================================
// Answer Mate - Content Script
// Detects questions, extracts context, applies answers stealthily
// ============================================================

(function () {
  // Prevent multiple injections
  if (window.__answerMateLoaded) return;
  window.__answerMateLoaded = true;

  let isActive = false;
  let answerMode = 'auto'; // 'auto' | 'highlight' | 'clipboard'
  let highlightDuration = 4000;
  let processing = false;

  // Load settings
  chrome.storage.local.get(['answerMode', 'highlightDuration'], (result) => {
    answerMode = result.answerMode || 'auto';
    highlightDuration = result.highlightDuration || 4000;
  });

  // Listen for settings changes
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.answerMode) answerMode = changes.answerMode.newValue;
    if (changes.highlightDuration) highlightDuration = changes.highlightDuration.newValue;
  });

  // ============================================================
  // STATE MANAGEMENT
  // ============================================================

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'TOGGLE_STATE') {
      isActive = message.active;
      sendResponse({ ok: true });
    }
    if (message.type === 'GET_CONTENT_STATE') {
      sendResponse({ active: isActive });
    }
  });

  // Check initial state
  chrome.runtime.sendMessage({ type: 'GET_STATE' }, (response) => {
    if (response) isActive = response.active;
  });

  // ============================================================
  // QUESTION DETECTION ENGINE
  // ============================================================

  /**
   * Find the label text associated with an input element
   */
  function findLabelForInput(input) {
    // Method 1: <label for="id">
    if (input.id) {
      const label = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
      if (label) return label.textContent.trim();
    }

    // Method 2: Parent <label>
    const parentLabel = input.closest('label');
    if (parentLabel) {
      const clone = parentLabel.cloneNode(true);
      clone.querySelectorAll('input, select, textarea, button').forEach(el => el.remove());
      const text = clone.textContent.trim();
      if (text) return text;
    }

    // Method 3: Adjacent text / sibling elements
    const parent = input.parentElement;
    if (parent) {
      const clone = parent.cloneNode(true);
      clone.querySelectorAll('input, select, textarea, button').forEach(el => el.remove());
      const text = clone.textContent.trim();
      if (text && text.length < 500) return text;
    }

    // Method 4: aria-label / aria-labelledby
    if (input.getAttribute('aria-label')) return input.getAttribute('aria-label');
    const labelledBy = input.getAttribute('aria-labelledby');
    if (labelledBy) {
      const labelEl = document.getElementById(labelledBy);
      if (labelEl) return labelEl.textContent.trim();
    }

    // Method 5: Next sibling text
    let sibling = input.nextSibling;
    while (sibling) {
      if (sibling.nodeType === Node.TEXT_NODE && sibling.textContent.trim()) {
        return sibling.textContent.trim();
      }
      if (sibling.nodeType === Node.ELEMENT_NODE && !sibling.querySelector('input')) {
        const text = sibling.textContent.trim();
        if (text && text.length < 500) return text;
      }
      sibling = sibling.nextSibling;
    }

    return null;
  }

  /**
   * Score an element as a potential question container
   */
  function scoreContainer(element) {
    let score = 0;
    const tag = element.tagName.toLowerCase();
    const cls = (element.className || '').toString().toLowerCase();
    const id = (element.id || '').toLowerCase();
    const role = (element.getAttribute('role') || '').toLowerCase();

    // Input elements present
    const radios = element.querySelectorAll('input[type="radio"]');
    const checkboxes = element.querySelectorAll('input[type="checkbox"]');
    const selects = element.querySelectorAll('select');
    const textInputs = element.querySelectorAll('input[type="text"], input:not([type]), textarea');
    const totalInputs = radios.length + checkboxes.length + selects.length + textInputs.length;

    if (totalInputs > 0) score += 3;
    if (radios.length >= 2) score += 3;
    if (checkboxes.length >= 2) score += 2;

    // Question-like class/id names
    const namePattern = /question|quiz|problem|item|prompt|assessment|mcq|answer-group|response/;
    if (namePattern.test(cls)) score += 5;
    if (namePattern.test(id)) score += 4;

    // Semantic roles
    if (role === 'radiogroup' || role === 'group') score += 4;
    if (tag === 'fieldset') score += 3;

    // Has question text + inputs (strong signal)
    const hasTextEl = element.querySelector('p, span, label, h1, h2, h3, h4, h5, h6, legend, .question-text');
    if (hasTextEl && totalInputs > 0) score += 3;

    // Text length scoring
    const textLen = element.textContent.trim().length;
    if (textLen >= 20 && textLen <= 3000) score += 2;
    if (textLen > 5000) score -= 3;
    if (textLen < 10) score -= 5;

    // Penalize body/html/main containers
    if (['body', 'html', 'main', 'header', 'footer', 'nav'].includes(tag)) score -= 10;

    // Penalize very broad containers
    const childQuestions = element.querySelectorAll('[class*="question"], [class*="quiz"], [class*="problem"]');
    if (childQuestions.length > 1) score -= 3;

    return score;
  }

  /**
   * Find the question container from a clicked element
   */
  function findQuestionContainer(element) {
    let current = element;
    let bestContainer = null;
    let maxScore = -Infinity;
    let depth = 0;

    while (current && current !== document.body && depth < 20) {
      const score = scoreContainer(current);
      if (score > maxScore) {
        maxScore = score;
        bestContainer = current;
      }
      // Stop if we found a very strong match
      if (score >= 10) break;
      current = current.parentElement;
      depth++;
    }

    // Fallback: use a reasonable ancestor
    if (!bestContainer || maxScore < 2) {
      bestContainer = element.closest('fieldset, [role="radiogroup"], [role="group"]') ||
        element.closest('[class*="question"]') ||
        element.closest('[class*="quiz"]') ||
        element.closest('[class*="problem"]') ||
        findReasonableAncestor(element);
    }

    return bestContainer;
  }

  /**
   * Find a reasonable ancestor element that could be a question
   */
  function findReasonableAncestor(element) {
    let current = element;
    let depth = 0;
    while (current && current !== document.body && depth < 15) {
      const inputs = current.querySelectorAll('input, select, textarea');
      const textLen = current.textContent.trim().length;
      if (inputs.length > 0 && textLen > 20 && textLen < 5000) {
        return current;
      }
      current = current.parentElement;
      depth++;
    }
    // Last resort: go up 3 levels from click target
    current = element;
    for (let i = 0; i < 5 && current && current !== document.body; i++) {
      current = current.parentElement;
    }
    return current || element;
  }

  /**
   * Extract the question text from a container
   */
  function extractQuestionText(container) {
    // Strategy 1: Look for explicit question text elements
    const questionSelectors = [
      '.question-text', '.question_text', '.questionText',
      '.question-title', '.question_title',
      '.prompt', '.stem', '.question-stem',
      '.quiz-question-text', '.assessment-question',
      'legend', '.display_question > .question_text',
      '[class*="questionBody"]', '[class*="question-body"]',
      '.text > .user_content', '.question_description'
    ];

    for (const sel of questionSelectors) {
      const el = container.querySelector(sel);
      if (el && el.textContent.trim().length > 5) {
        return el.textContent.trim();
      }
    }

    // Strategy 2: Find the longest text block before any inputs
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT);
    let questionParts = [];
    let foundInput = false;

    while (walker.nextNode()) {
      const node = walker.currentNode;
      const tag = node.tagName.toLowerCase();

      if (['input', 'select', 'textarea'].includes(tag)) {
        foundInput = true;
        continue;
      }

      if (!foundInput && ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'div', 'legend', 'label'].includes(tag)) {
        const directText = getDirectText(node);
        if (directText.length > 3) {
          questionParts.push(directText);
        }
      }
    }

    if (questionParts.length > 0) {
      return questionParts.join(' ').trim();
    }

    // Strategy 3: Get all text content excluding option texts
    const clone = container.cloneNode(true);
    // Remove elements that are likely options
    clone.querySelectorAll('label, [class*="answer"], [class*="option"], [class*="choice"]').forEach(el => {
      el.remove();
    });
    const remaining = clone.textContent.trim();
    if (remaining.length > 5) return remaining;

    // Fallback: full container text (truncated)
    return container.textContent.trim().substring(0, 2000);
  }

  /**
   * Get direct text content of an element (not children)
   */
  function getDirectText(element) {
    let text = '';
    for (const child of element.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        text += child.textContent;
      }
    }
    return text.trim();
  }

  /**
   * Detect if options represent True/False
   */
  function isTrueFalse(options) {
    if (options.length !== 2) return false;
    const texts = options.map(o => o.text.toLowerCase().trim());
    return (texts.includes('true') && texts.includes('false')) ||
      (texts.includes('yes') && texts.includes('no')) ||
      (texts.includes('correct') && texts.includes('incorrect'));
  }

  /**
   * Extract options and detect question type from a container
   */
  function extractOptionsAndType(container) {
    // Strategy 1: Radio buttons → MCQ or True/False
    const radios = container.querySelectorAll('input[type="radio"]');
    if (radios.length >= 2) {
      const options = [];
      const nameGroups = {};

      radios.forEach(radio => {
        const name = radio.name || '__default';
        if (!nameGroups[name]) nameGroups[name] = [];
        nameGroups[name].push(radio);
      });

      // Use the largest radio group
      const largestGroup = Object.values(nameGroups).sort((a, b) => b.length - a.length)[0];

      largestGroup.forEach((radio, index) => {
        const label = findLabelForInput(radio);
        const optionContainer = radio.closest('label, li, div.answer, [class*="option"], [class*="answer"], [class*="choice"]') || radio.parentElement;
        options.push({
          element: optionContainer,
          inputElement: radio,
          text: label || radio.value || `Option ${index + 1}`,
          value: radio.value,
          identifier: String.fromCharCode(65 + index)
        });
      });

      const type = isTrueFalse(options) ? 'TRUE_FALSE' : 'MULTIPLE_CHOICE';
      return { type, options };
    }

    // Strategy 2: Checkboxes → Multi-select
    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    if (checkboxes.length >= 2) {
      const options = [];
      checkboxes.forEach((cb, index) => {
        const label = findLabelForInput(cb);
        const optionContainer = cb.closest('label, li, div, [class*="option"], [class*="answer"], [class*="choice"]') || cb.parentElement;
        options.push({
          element: optionContainer,
          inputElement: cb,
          text: label || cb.value || `Option ${index + 1}`,
          value: cb.value,
          identifier: String.fromCharCode(65 + index)
        });
      });
      return { type: 'MULTI_SELECT', options };
    }

    // Strategy 3: Multiple selects → Matching
    const selects = container.querySelectorAll('select');
    if (selects.length >= 2) {
      const matchItems = [];
      selects.forEach((select, index) => {
        const label = findLabelForInput(select);
        const selectOptions = Array.from(select.options)
          .filter(o => o.value && o.value !== '')
          .map(o => o.text.trim());
        matchItems.push({
          element: select,
          inputElement: select,
          text: label || `Item ${index + 1}`,
          selectOptions,
          identifier: String(index + 1)
        });
      });
      return { type: 'MATCHING', options: [], matchItems };
    }

    // Strategy 4: Single select → could be MCQ in dropdown form
    if (selects.length === 1) {
      const select = selects[0];
      const options = Array.from(select.options)
        .filter(o => o.value && o.value !== '' && o.text.trim() !== '')
        .map((o, index) => ({
          element: select,
          inputElement: select,
          text: o.text.trim(),
          value: o.value,
          identifier: String.fromCharCode(65 + index),
          isSelectOption: true,
          optionIndex: o.index
        }));
      if (options.length >= 2) {
        return { type: 'MULTIPLE_CHOICE', options, isDropdown: true };
      }
    }

    // Strategy 5: Text inputs → Fill in the blank / Short answer
    const textInputs = container.querySelectorAll(
      'input[type="text"], input[type="number"], input:not([type]):not([role="combobox"]), textarea'
    );
    if (textInputs.length > 0) {
      const input = textInputs[0];
      const isTextarea = input.tagName.toLowerCase() === 'textarea';
      return {
        type: isTextarea ? 'ESSAY' : 'FILL_BLANK',
        options: [],
        inputElement: input
      };
    }

    // Strategy 6: Look for clickable div-based options (custom UI)
    const clickableOptions = container.querySelectorAll(
      '[role="radio"], [role="checkbox"], [role="option"], [data-testid*="answer"], [data-testid*="option"]'
    );
    if (clickableOptions.length >= 2) {
      const options = [];
      clickableOptions.forEach((opt, index) => {
        options.push({
          element: opt,
          inputElement: opt,
          text: opt.textContent.trim(),
          value: opt.getAttribute('data-value') || opt.textContent.trim(),
          identifier: String.fromCharCode(65 + index),
          isCustom: true
        });
      });
      const type = isTrueFalse(options) ? 'TRUE_FALSE' : 'MULTIPLE_CHOICE';
      return { type, options };
    }

    // Fallback: treat as short answer
    return { type: 'SHORT_ANSWER', options: [] };
  }

  /**
   * Extract full question context from a double-click target
   */
  function extractQuestionContext(targetElement) {
    const container = findQuestionContainer(targetElement);
    if (!container) return null;

    const questionText = extractQuestionText(container);
    if (!questionText || questionText.length < 3) return null;

    const optionData = extractOptionsAndType(container);

    return {
      questionText,
      type: optionData.type,
      options: optionData.options.map(o => ({
        text: o.text,
        identifier: o.identifier,
        value: o.value
      })),
      matchItems: optionData.matchItems?.map(m => ({
        text: m.text,
        identifier: m.identifier,
        selectOptions: m.selectOptions
      })),
      // Keep DOM references for answer application (not sent to background)
      _domRefs: {
        container,
        options: optionData.options,
        matchItems: optionData.matchItems,
        inputElement: optionData.inputElement,
        isDropdown: optionData.isDropdown,
        type: optionData.type
      }
    };
  }

  // ============================================================
  // ANSWER APPLICATION ENGINE
  // ============================================================

  /**
   * Find the best matching option for an AI answer
   */
  function findMatchingOption(options, answer) {
    const cleanAnswer = answer.trim().toUpperCase();

    // Direct identifier match (A, B, C, D or 1, 2, 3, 4)
    for (const opt of options) {
      if (opt.identifier.toUpperCase() === cleanAnswer) return opt;
    }

    // Match by first character
    const firstChar = cleanAnswer.charAt(0);
    for (const opt of options) {
      if (opt.identifier.toUpperCase() === firstChar) return opt;
    }

    // For True/False
    const lowerAnswer = answer.trim().toLowerCase();
    for (const opt of options) {
      if (opt.text.toLowerCase().trim() === lowerAnswer) return opt;
    }

    // Fuzzy text match
    for (const opt of options) {
      if (opt.text.toLowerCase().includes(lowerAnswer) || lowerAnswer.includes(opt.text.toLowerCase())) {
        return opt;
      }
    }

    return null;
  }

  /**
   * Simulate natural click on an element
   */
  function simulateClick(element) {
    const events = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    events.forEach(eventType => {
      const EventConstructor = eventType.startsWith('pointer') ? PointerEvent : MouseEvent;
      element.dispatchEvent(new EventConstructor(eventType, {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
        button: 0
      }));
    });
  }

  /**
   * Set input value with proper event dispatch (works with React/Angular/Vue)
   */
  function setInputValue(input, value) {
    // Use native setter to bypass framework wrappers
    const nativeSetter =
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set ||
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;

    if (nativeSetter) {
      nativeSetter.call(input, value);
    } else {
      input.value = value;
    }

    // Dispatch events frameworks listen for
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  }

  /**
   * Apply subtle highlight to an element (stealth mode)
   */
  function highlightElement(element, duration) {
    const originalOutline = element.style.outline;
    const originalOutlineOffset = element.style.outlineOffset;
    const originalTransition = element.style.transition;

    element.style.transition = 'outline-color 0.3s ease';
    element.style.outline = '2px solid rgba(76, 175, 80, 0.45)';
    element.style.outlineOffset = '2px';

    setTimeout(() => {
      element.style.transition = 'outline-color 0.5s ease';
      element.style.outline = originalOutline;
      element.style.outlineOffset = originalOutlineOffset;
      setTimeout(() => {
        element.style.transition = originalTransition;
      }, 600);
    }, duration);
  }

  /**
   * Apply the answer based on current mode
   */
  function applyAnswer(domRefs, answer) {
    const { type, options, matchItems, inputElement, isDropdown } = domRefs;

    if (answerMode === 'clipboard') {
      navigator.clipboard.writeText(answer).catch(() => {});
      return;
    }

    switch (type) {
      case 'MULTIPLE_CHOICE':
      case 'TRUE_FALSE': {
        const matched = findMatchingOption(options, answer);
        if (!matched) {
          // Fallback to clipboard
          navigator.clipboard.writeText(answer).catch(() => {});
          return;
        }

        if (answerMode === 'auto') {
          if (isDropdown && matched.isSelectOption) {
            matched.inputElement.selectedIndex = matched.optionIndex;
            matched.inputElement.dispatchEvent(new Event('change', { bubbles: true }));
          } else if (matched.isCustom) {
            simulateClick(matched.inputElement);
          } else {
            simulateClick(matched.inputElement);
            if (matched.inputElement.type === 'radio' || matched.inputElement.type === 'checkbox') {
              matched.inputElement.checked = true;
              matched.inputElement.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }
        } else {
          highlightElement(matched.element, highlightDuration);
        }
        break;
      }

      case 'MULTI_SELECT': {
        const selectedIds = answer.split(',').map(s => s.trim().toUpperCase());
        let anyMatched = false;

        options.forEach(opt => {
          if (selectedIds.includes(opt.identifier)) {
            anyMatched = true;
            if (answerMode === 'auto') {
              if (opt.isCustom) {
                simulateClick(opt.inputElement);
              } else if (!opt.inputElement.checked) {
                simulateClick(opt.inputElement);
                opt.inputElement.checked = true;
                opt.inputElement.dispatchEvent(new Event('change', { bubbles: true }));
              }
            } else {
              highlightElement(opt.element, highlightDuration);
            }
          }
        });

        if (!anyMatched) {
          navigator.clipboard.writeText(answer).catch(() => {});
        }
        break;
      }

      case 'MATCHING': {
        if (!matchItems || matchItems.length === 0) {
          navigator.clipboard.writeText(answer).catch(() => {});
          return;
        }

        // Parse "1→C, 2→A, 3→B" or "1-C, 2-A, 3-B"
        const pairs = answer.split(',').map(s => s.trim());
        pairs.forEach(pair => {
          const match = pair.match(/(\d+)\s*[→\-:]\s*(.+)/);
          if (!match) return;
          const itemIndex = parseInt(match[1]) - 1;
          const targetValue = match[2].trim();

          if (itemIndex >= 0 && itemIndex < matchItems.length) {
            const select = matchItems[itemIndex].inputElement;
            // Find matching option in dropdown
            for (let i = 0; i < select.options.length; i++) {
              if (select.options[i].text.trim().toLowerCase().includes(targetValue.toLowerCase()) ||
                targetValue.toLowerCase().includes(select.options[i].text.trim().toLowerCase())) {
                if (answerMode === 'auto') {
                  select.selectedIndex = i;
                  select.dispatchEvent(new Event('change', { bubbles: true }));
                } else {
                  highlightElement(select, highlightDuration);
                }
                break;
              }
            }
          }
        });
        break;
      }

      case 'FILL_BLANK':
      case 'SHORT_ANSWER':
      case 'ESSAY': {
        if (inputElement && answerMode === 'auto') {
          inputElement.focus();
          setInputValue(inputElement, answer);
        } else {
          navigator.clipboard.writeText(answer).catch(() => {});
        }
        break;
      }

      default:
        navigator.clipboard.writeText(answer).catch(() => {});
    }
  }

  // ============================================================
  // DOUBLE-CLICK HANDLER
  // ============================================================

  document.addEventListener('dblclick', async (e) => {
    if (!isActive || processing) return;

    // Don't prevent default - let normal double-click behavior happen
    const context = extractQuestionContext(e.target);
    if (!context) return;

    processing = true;

    // Store DOM refs locally (they can't be serialized for messaging)
    const domRefs = context._domRefs;
    delete context._domRefs;

    try {
      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          { type: 'PROCESS_QUESTION', data: context },
          (resp) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            if (resp.success) resolve(resp.answer);
            else reject(new Error(resp.error));
          }
        );
      });

      applyAnswer(domRefs, response);
    } catch (err) {
      console.debug('[AM]', err.message);
    } finally {
      processing = false;
    }
  }, true);

})();
