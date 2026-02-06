// ============================================================
// Answer Mate - Content Script
// Detects questions, extracts context + images, applies answers
// ============================================================

(function () {
  if (window.__answerMateLoaded) return;
  window.__answerMateLoaded = true;

  // ---- Dev Mode Detection ----
  const IS_DEV = !('update_url' in chrome.runtime.getManifest());
  function devLog(...args) {
    if (IS_DEV) console.log('[AnswerMate:Content]', ...args);
  }
  function devWarn(...args) {
    if (IS_DEV) console.warn('[AnswerMate:Content]', ...args);
  }

  let isActive = false;
  let answerMode = 'auto';
  let highlightDuration = 4000;
  let processing = false;

  chrome.storage.local.get(['answerMode', 'highlightDuration'], (result) => {
    answerMode = result.answerMode || 'auto';
    highlightDuration = result.highlightDuration || 4000;
  });

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
      devLog('State toggled:', isActive ? 'ACTIVE' : 'INACTIVE');
      sendResponse({ ok: true });
    }
    if (message.type === 'GET_CONTENT_STATE') {
      sendResponse({ active: isActive });
    }
  });

  chrome.runtime.sendMessage({ type: 'GET_STATE' }, (response) => {
    if (response) {
      isActive = response.active;
      devLog('Initial state:', isActive ? 'ACTIVE' : 'INACTIVE');
    }
  });

  // ============================================================
  // IMAGE EXTRACTION ENGINE
  // ============================================================

  const MAX_IMAGE_DIMENSION = 1568;
  const MIN_IMAGE_SIZE = 80; // Raised: skip small option-marker icons (was 30)
  const MAX_IMAGES_PER_QUESTION = 5;

  function imageElementToBase64(img) {
    try {
      const canvas = document.createElement('canvas');
      let width = img.naturalWidth || img.width;
      let height = img.naturalHeight || img.height;
      if (width === 0 || height === 0) return null;

      if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
        const ratio = Math.min(MAX_IMAGE_DIMENSION / width, MAX_IMAGE_DIMENSION / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }

      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);

      const isLikelyPhoto = width > 400 && height > 400;
      const format = isLikelyPhoto ? 'image/jpeg' : 'image/png';
      const quality = isLikelyPhoto ? 0.85 : undefined;

      const dataUrl = canvas.toDataURL(format, quality);
      const base64 = dataUrl.split(',')[1];
      const mimeType = dataUrl.split(';')[0].split(':')[1];

      devLog('Image converted:', width, 'x', height, mimeType, `(${Math.round(base64.length * 0.75 / 1024)}KB)`);
      return { data: base64, mimeType };
    } catch (e) {
      devWarn('Canvas CORS error for image, will proxy:', img.src?.substring(0, 80));
      return null;
    }
  }

  async function fetchImageViaProxy(url) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'FETCH_IMAGE', url }, (resp) => {
        if (chrome.runtime.lastError || !resp?.success) {
          resolve(null);
          return;
        }
        resolve({ data: resp.data, mimeType: resp.mimeType });
      });
    });
  }

  function canvasToBase64(canvas) {
    try {
      if (canvas.width < MIN_IMAGE_SIZE || canvas.height < MIN_IMAGE_SIZE) return null;
      const dataUrl = canvas.toDataURL('image/png');
      return { data: dataUrl.split(',')[1], mimeType: 'image/png' };
    } catch (e) {
      return null;
    }
  }

  function svgToBase64(svgElement) {
    try {
      const bbox = svgElement.getBoundingClientRect();
      if (bbox.width < MIN_IMAGE_SIZE || bbox.height < MIN_IMAGE_SIZE) return null;
      const serializer = new XMLSerializer();
      const svgString = serializer.serializeToString(svgElement);
      const base64 = btoa(unescape(encodeURIComponent(svgString)));
      return { data: base64, mimeType: 'image/svg+xml' };
    } catch (e) {
      return null;
    }
  }

  function isSignificantImage(img) {
    const width = img.naturalWidth || img.width || 0;
    const height = img.naturalHeight || img.height || 0;
    if (width < MIN_IMAGE_SIZE || height < MIN_IMAGE_SIZE) return false;

    const src = (img.src || '').toLowerCase();
    if (src.includes('spacer') || src.includes('pixel') || src.includes('blank') ||
        src.includes('icon') || src.includes('logo') || src.includes('avatar') ||
        src.includes('emoji') || src.includes('favicon') || src.includes('badge') ||
        src.includes('checkmark') || src.includes('bullet') || src.includes('arrow')) return false;

    if (img.getAttribute('role') === 'presentation') return false;
    if (img.alt === '' && (width < MIN_IMAGE_SIZE || height < MIN_IMAGE_SIZE)) return false;
    return true;
  }

  async function extractImages(container) {
    const images = [];

    const imgElements = container.querySelectorAll('img');
    for (const img of imgElements) {
      if (images.length >= MAX_IMAGES_PER_QUESTION) break;
      if (!isSignificantImage(img)) continue;

      let result = imageElementToBase64(img);
      if (!result && img.src && (img.src.startsWith('http://') || img.src.startsWith('https://'))) {
        result = await fetchImageViaProxy(img.src);
      }
      if (!result && img.src && img.src.startsWith('data:')) {
        const match = img.src.match(/^data:([^;]+);base64,(.+)$/);
        if (match) result = { data: match[2], mimeType: match[1] };
      }
      if (result) images.push(result);
    }

    const canvasElements = container.querySelectorAll('canvas');
    for (const canvas of canvasElements) {
      if (images.length >= MAX_IMAGES_PER_QUESTION) break;
      const result = canvasToBase64(canvas);
      if (result) images.push(result);
    }

    const svgElements = container.querySelectorAll('svg');
    for (const svg of svgElements) {
      if (images.length >= MAX_IMAGES_PER_QUESTION) break;
      const bbox = svg.getBoundingClientRect();
      if (bbox.width >= 80 && bbox.height >= 80) {
        const result = svgToBase64(svg);
        if (result) images.push(result);
      }
    }

    const allElements = container.querySelectorAll('*');
    for (const el of allElements) {
      if (images.length >= MAX_IMAGES_PER_QUESTION) break;
      const bg = getComputedStyle(el).backgroundImage;
      if (bg && bg !== 'none' && bg.startsWith('url(')) {
        const urlMatch = bg.match(/url\(["']?(https?:\/\/[^"')]+)["']?\)/);
        if (urlMatch) {
          const rect = el.getBoundingClientRect();
          if (rect.width >= 80 && rect.height >= 80) {
            const result = await fetchImageViaProxy(urlMatch[1]);
            if (result) images.push(result);
          }
        }
      }
    }

    devLog('Extracted', images.length, 'images from question container');
    return images;
  }

  // ============================================================
  // QUESTION DETECTION ENGINE (v2 — SPA-aware, platform-agnostic)
  // ============================================================

  /**
   * Check if an element is visible in the page
   */
  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' &&
           style.visibility !== 'hidden' &&
           parseFloat(style.opacity) > 0;
  }

  /**
   * Known per-question container selectors for popular quiz platforms.
   * Ordered most specific first. Each selector should match a SINGLE question.
   */
  const QUESTION_ITEM_SELECTORS = [
    // ProProfs
    '.ques_marg',
    '.question_area',
    // Canvas LMS
    '.question',
    '.quiz_sortable .question_holder',
    '.display_question',
    // Blackboard
    '.question-container',
    '.vtbegenerated',
    // Moodle
    '.que',
    '.formulation',
    // Google Forms
    '[data-params]',
    '.freebirdFormviewerViewNumberedItemContainer',
    // Schoology
    '.quiz-question',
    // D2L Brightspace
    '.d2l-question-container',
    '.dco_c',
    // Quizlet
    '.SetPageTerms-term',
    // Kahoot
    '.question-container',
    // Generic patterns
    '[class*="question-item"]',
    '[class*="questionItem"]',
    '[class*="quiz-item"]',
    '[class*="question-row"]',
    '[class*="question-block"]',
    '[class*="questionBlock"]',
    '.question-wrapper',
    '.problem-body',
  ];

  /**
   * Find all potential single-question containers on the page
   */
  function findAllQuestionContainers() {
    const found = [];
    const seenElements = new Set();

    for (const selector of QUESTION_ITEM_SELECTORS) {
      try {
        const elements = document.querySelectorAll(selector);
        for (const el of elements) {
          if (!seenElements.has(el) && isVisible(el)) {
            seenElements.add(el);
            found.push(el);
          }
        }
      } catch (_) {} // Invalid selector on some pages
    }

    return found;
  }

  /**
   * Check if element A contains element B
   */
  function contains(a, b) {
    return a !== b && a.contains(b);
  }

  /**
   * Find the best question container for a click target.
   * Strategy:
   * 1. Check if click target is inside a known question container → use it
   * 2. Walk up from click target scoring ancestors → use best match
   * 3. Fallback: find the currently visible question nearest to the click
   */
  function findQuestionContainer(clickTarget) {
    // ------ Strategy 1: Known platform selectors (most reliable) ------
    for (const selector of QUESTION_ITEM_SELECTORS) {
      try {
        const match = clickTarget.closest(selector);
        if (match && isVisible(match)) {
          devLog('Container found via selector:', selector);
          return match;
        }
      } catch (_) {}
    }

    // ------ Strategy 2: Score ancestors (generic detection) ------
    let current = clickTarget;
    let bestContainer = null;
    let maxScore = -Infinity;
    let depth = 0;

    while (current && current !== document.body && depth < 20) {
      const score = scoreContainer(current);
      // Prefer the SMALLEST high-scoring container (not the biggest)
      if (score > maxScore) {
        maxScore = score;
        bestContainer = current;
      }
      // Stop at very strong signal — don't go higher
      if (score >= 8) {
        devLog('Container found via scoring:', score, current.tagName, current.className?.toString()?.substring(0, 40));
        return bestContainer;
      }
      current = current.parentElement;
      depth++;
    }

    if (bestContainer && maxScore >= 3) {
      devLog('Container found via best score:', maxScore);
      return bestContainer;
    }

    // ------ Strategy 3: Find nearest VISIBLE question on the page ------
    const allContainers = findAllQuestionContainers();
    if (allContainers.length > 0) {
      // If click is inside one of them, use it
      for (const c of allContainers) {
        if (c.contains(clickTarget)) {
          devLog('Container found via page-scan contains');
          return c;
        }
      }
      // Otherwise find the one closest to the click target's position
      const clickRect = clickTarget.getBoundingClientRect();
      const clickY = clickRect.top + clickRect.height / 2;
      let closestDist = Infinity;
      let closestContainer = null;

      for (const c of allContainers) {
        const rect = c.getBoundingClientRect();
        const centerY = rect.top + rect.height / 2;
        const dist = Math.abs(centerY - clickY);
        if (dist < closestDist) {
          closestDist = dist;
          closestContainer = c;
        }
      }

      if (closestContainer) {
        devLog('Container found via nearest visible question, dist:', Math.round(closestDist));
        return closestContainer;
      }
    }

    // ------ Strategy 4: Last resort — reasonable ancestor ------
    devLog('Container found via last-resort ancestor walk');
    return findReasonableAncestor(clickTarget);
  }

  function scoreContainer(element) {
    let score = 0;
    const tag = element.tagName.toLowerCase();
    const cls = (element.className || '').toString().toLowerCase();
    const id = (element.id || '').toLowerCase();
    const role = (element.getAttribute('role') || '').toLowerCase();

    // Inputs present
    const radios = element.querySelectorAll('input[type="radio"]');
    const checkboxes = element.querySelectorAll('input[type="checkbox"]');
    const selects = element.querySelectorAll('select');
    const textInputs = element.querySelectorAll('input[type="text"], input:not([type]), textarea');
    const totalInputs = radios.length + checkboxes.length + selects.length + textInputs.length;

    // Also count div-based options (ProProfs, Google Forms, etc.)
    const divOptions = element.querySelectorAll(
      '.opt_text, .questonnopt, [role="radio"], [role="checkbox"], [role="option"], ' +
      '.answers-list > li, [class*="answer-option"], [class*="choice-item"], [class*="option-text"]'
    );

    if (totalInputs > 0) score += 3;
    if (divOptions.length >= 2) score += 3;
    if (radios.length >= 2) score += 3;
    if (checkboxes.length >= 2) score += 2;

    // Question-like class/id names
    const namePattern = /question|quiz|problem|item|prompt|assessment|mcq|answer-group|response|ques_marg/;
    if (namePattern.test(cls)) score += 5;
    if (namePattern.test(id)) score += 4;

    if (role === 'radiogroup' || role === 'group') score += 4;
    if (tag === 'fieldset') score += 3;

    const hasTextEl = element.querySelector('p, span, label, h1, h2, h3, h4, h5, h6, legend, .question-text, .question_text');
    if (hasTextEl && (totalInputs > 0 || divOptions.length >= 2)) score += 3;

    const textLen = element.textContent.trim().length;
    if (textLen >= 20 && textLen <= 3000) score += 1;
    if (textLen > 8000) score -= 5;
    if (textLen < 10) score -= 5;

    if (['body', 'html', 'main', 'header', 'footer', 'nav'].includes(tag)) score -= 10;

    // Penalize containers that hold MULTIPLE questions
    const childQuestions = element.querySelectorAll(
      '.ques_marg, .question, .que, [class*="question-item"], [class*="quiz-item"]'
    );
    if (childQuestions.length > 1) score -= 5;

    return score;
  }

  function findReasonableAncestor(element) {
    let current = element;
    let depth = 0;
    while (current && current !== document.body && depth < 15) {
      const inputs = current.querySelectorAll('input, select, textarea');
      const divOptions = current.querySelectorAll('.opt_text, [role="radio"], [role="option"], .answers-list > li');
      const textLen = current.textContent.trim().length;
      if ((inputs.length > 0 || divOptions.length >= 2) && textLen > 20 && textLen < 5000) {
        return current;
      }
      current = current.parentElement;
      depth++;
    }
    current = element;
    for (let i = 0; i < 5 && current && current !== document.body; i++) {
      current = current.parentElement;
    }
    return current || element;
  }

  // ============================================================
  // QUESTION TEXT + OPTIONS EXTRACTION
  // ============================================================

  function findLabelForInput(input) {
    if (input.id) {
      const label = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
      if (label) return label.textContent.trim();
    }
    const parentLabel = input.closest('label');
    if (parentLabel) {
      const clone = parentLabel.cloneNode(true);
      clone.querySelectorAll('input, select, textarea, button').forEach(el => el.remove());
      const text = clone.textContent.trim();
      if (text) return text;
    }
    const parent = input.parentElement;
    if (parent) {
      const clone = parent.cloneNode(true);
      clone.querySelectorAll('input, select, textarea, button').forEach(el => el.remove());
      const text = clone.textContent.trim();
      if (text && text.length < 500) return text;
    }
    if (input.getAttribute('aria-label')) return input.getAttribute('aria-label');
    const labelledBy = input.getAttribute('aria-labelledby');
    if (labelledBy) {
      const labelEl = document.getElementById(labelledBy);
      if (labelEl) return labelEl.textContent.trim();
    }
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

  function extractQuestionText(container) {
    const questionSelectors = [
      '.question-text', '.question_text', '.questionText',
      '.question-title', '.question_title',
      '.prompt', '.stem', '.question-stem',
      '.quiz-question-text', '.assessment-question',
      'legend', '.display_question > .question_text',
      '[class*="questionBody"]', '[class*="question-body"]',
      '.text > .user_content', '.question_description',
      '.qtext', '.formulation .qtext'
    ];

    for (const sel of questionSelectors) {
      const el = container.querySelector(sel);
      if (el && el.textContent.trim().length > 5) {
        return el.textContent.trim();
      }
    }

    // Gather text that appears BEFORE the answers/options section
    const answerSection = container.querySelector(
      '.answers-list, .answer_list, [class*="answer"], [class*="option"], ' +
      '[class*="choice"], input[type="radio"], input[type="checkbox"]'
    );

    if (answerSection) {
      // Collect all text nodes before the answer section
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      let parts = [];
      while (walker.nextNode()) {
        const node = walker.currentNode;
        // Stop when we hit the answer section
        if (answerSection.contains(node) || answerSection === node.parentElement) break;
        const text = node.textContent.trim();
        if (text.length > 2) parts.push(text);
      }
      if (parts.length > 0) {
        const questionText = parts.join(' ').trim();
        if (questionText.length > 5) return questionText;
      }
    }

    // Generic: find text blocks before inputs
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT);
    let questionParts = [];
    let foundInput = false;

    while (walker.nextNode()) {
      const node = walker.currentNode;
      const tag = node.tagName.toLowerCase();
      if (['input', 'select', 'textarea'].includes(tag)) { foundInput = true; continue; }
      if (!foundInput && ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'div', 'legend', 'label'].includes(tag)) {
        const directText = getDirectText(node);
        if (directText.length > 3) questionParts.push(directText);
      }
    }
    if (questionParts.length > 0) return questionParts.join(' ').trim();

    const clone = container.cloneNode(true);
    clone.querySelectorAll('label, [class*="answer"], [class*="option"], [class*="choice"]').forEach(el => el.remove());
    const remaining = clone.textContent.trim();
    if (remaining.length > 5) return remaining;

    return container.textContent.trim().substring(0, 2000);
  }

  function getDirectText(element) {
    let text = '';
    for (const child of element.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) text += child.textContent;
    }
    return text.trim();
  }

  function isTrueFalse(options) {
    if (options.length !== 2) return false;
    const texts = options.map(o => o.text.toLowerCase().trim());
    return (texts.includes('true') && texts.includes('false')) ||
      (texts.includes('yes') && texts.includes('no')) ||
      (texts.includes('correct') && texts.includes('incorrect'));
  }

  function extractOptionsAndType(container) {
    // ---- Strategy 1: Standard radio buttons ----
    const radios = container.querySelectorAll('input[type="radio"]');
    if (radios.length >= 2) {
      const options = [];
      const nameGroups = {};
      radios.forEach(radio => {
        const name = radio.name || '__default';
        if (!nameGroups[name]) nameGroups[name] = [];
        nameGroups[name].push(radio);
      });
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
      return { type: isTrueFalse(options) ? 'TRUE_FALSE' : 'MULTIPLE_CHOICE', options };
    }

    // ---- Strategy 2: Checkboxes ----
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

    // ---- Strategy 3: Multiple selects → Matching ----
    const selects = container.querySelectorAll('select');
    if (selects.length >= 2) {
      const matchItems = [];
      selects.forEach((select, index) => {
        const label = findLabelForInput(select);
        const selectOptions = Array.from(select.options).filter(o => o.value && o.value !== '').map(o => o.text.trim());
        matchItems.push({ element: select, inputElement: select, text: label || `Item ${index + 1}`, selectOptions, identifier: String(index + 1) });
      });
      return { type: 'MATCHING', options: [], matchItems };
    }

    // ---- Strategy 4: Single select → dropdown MCQ ----
    if (selects.length === 1) {
      const select = selects[0];
      const options = Array.from(select.options)
        .filter(o => o.value && o.value !== '' && o.text.trim() !== '')
        .map((o, index) => ({
          element: select, inputElement: select, text: o.text.trim(),
          value: o.value, identifier: String.fromCharCode(65 + index),
          isSelectOption: true, optionIndex: o.index
        }));
      if (options.length >= 2) return { type: 'MULTIPLE_CHOICE', options, isDropdown: true };
    }

    // ---- Strategy 5: Text inputs ----
    const textInputs = container.querySelectorAll(
      'input[type="text"], input[type="number"], input:not([type]):not([role="combobox"]), textarea'
    );
    if (textInputs.length > 0) {
      const input = textInputs[0];
      return { type: input.tagName.toLowerCase() === 'textarea' ? 'ESSAY' : 'FILL_BLANK', options: [], inputElement: input };
    }

    // ---- Strategy 6: ARIA role-based options ----
    const ariaOptions = container.querySelectorAll('[role="radio"], [role="checkbox"], [role="option"]');
    if (ariaOptions.length >= 2) {
      const options = [];
      ariaOptions.forEach((opt, index) => {
        options.push({
          element: opt, inputElement: opt,
          text: opt.textContent.trim(),
          value: opt.getAttribute('data-value') || opt.textContent.trim(),
          identifier: String.fromCharCode(65 + index),
          isCustom: true
        });
      });
      return { type: isTrueFalse(options) ? 'TRUE_FALSE' : 'MULTIPLE_CHOICE', options };
    }

    // ---- Strategy 7: Div-based clickable options (ProProfs, etc.) ----
    // Look for common option list patterns
    const optionListSelectors = [
      '.answers-list > li',
      '.answer-list > li',
      '.options-list > li',
      '.choices > li',
      '[class*="answer-option"]',
      '[class*="choice-item"]',
      '.opt_text',
    ];
    for (const sel of optionListSelectors) {
      const items = container.querySelectorAll(sel);
      if (items.length >= 2) {
        const options = [];
        items.forEach((item, index) => {
          // Get the option text (skip the label letter div)
          const optText = item.querySelector('.opt_text') || item;
          const text = optText.textContent.trim();
          if (text) {
            options.push({
              element: item,
              inputElement: item,
              text: text,
              value: text,
              identifier: String.fromCharCode(65 + index),
              isCustom: true
            });
          }
        });
        if (options.length >= 2) {
          devLog('Found div-based options via selector:', sel, options.length);
          return { type: isTrueFalse(options) ? 'TRUE_FALSE' : 'MULTIPLE_CHOICE', options };
        }
      }
    }

    // ---- Strategy 8: data-testid patterns ----
    const testIdOptions = container.querySelectorAll('[data-testid*="answer"], [data-testid*="option"]');
    if (testIdOptions.length >= 2) {
      const options = [];
      testIdOptions.forEach((opt, index) => {
        options.push({
          element: opt, inputElement: opt,
          text: opt.textContent.trim(),
          value: opt.getAttribute('data-value') || opt.textContent.trim(),
          identifier: String.fromCharCode(65 + index),
          isCustom: true
        });
      });
      return { type: isTrueFalse(options) ? 'TRUE_FALSE' : 'MULTIPLE_CHOICE', options };
    }

    return { type: 'SHORT_ANSWER', options: [] };
  }

  /**
   * Extract full question context including images
   */
  async function extractQuestionContext(targetElement) {
    const container = findQuestionContainer(targetElement);
    if (!container) return null;

    devLog('Question container:', container.tagName, container.className?.toString()?.substring(0, 60),
           'textLen:', container.textContent.trim().length);

    const questionText = extractQuestionText(container);
    if (!questionText || questionText.length < 3) return null;

    const optionData = extractOptionsAndType(container);
    const images = await extractImages(container);

    devLog('Question extracted:', {
      type: optionData.type,
      textLength: questionText.length,
      options: optionData.options?.length || 0,
      images: images.length,
      questionPreview: questionText.substring(0, 80)
    });

    return {
      questionText,
      type: optionData.type,
      options: optionData.options.map(o => ({ text: o.text, identifier: o.identifier, value: o.value })),
      matchItems: optionData.matchItems?.map(m => ({ text: m.text, identifier: m.identifier, selectOptions: m.selectOptions })),
      images,
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

  function findMatchingOption(options, answer) {
    const cleanAnswer = answer.trim().toUpperCase();

    // Direct identifier match (A, B, C, D)
    for (const opt of options) {
      if (opt.identifier.toUpperCase() === cleanAnswer) return opt;
    }
    // First char match
    const firstChar = cleanAnswer.charAt(0);
    for (const opt of options) {
      if (opt.identifier.toUpperCase() === firstChar) return opt;
    }
    // Exact text match
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
   * Simulate a full natural click sequence on an element.
   * Uses multiple strategies for maximum compatibility with frameworks.
   */
  function simulateClick(element) {
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    // Strategy 1: Full event sequence (works with vanilla JS listeners)
    const events = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
    events.forEach(eventType => {
      const Constructor = eventType.startsWith('pointer') ? PointerEvent : MouseEvent;
      element.dispatchEvent(new Constructor(eventType, {
        bubbles: true, cancelable: true, view: window,
        clientX: x, clientY: y, button: 0
      }));
    });

    // Strategy 2: Native .click() — triggers jQuery handlers + onclick attributes
    try { element.click(); } catch (_) {}
  }

  function setInputValue(input, value) {
    const nativeSetter =
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set ||
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (nativeSetter) nativeSetter.call(input, value);
    else input.value = value;

    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  }

  function highlightElement(element, duration) {
    const orig = {
      outline: element.style.outline,
      outlineOffset: element.style.outlineOffset,
      transition: element.style.transition
    };
    element.style.transition = 'outline-color 0.3s ease';
    element.style.outline = '2px solid rgba(76, 175, 80, 0.45)';
    element.style.outlineOffset = '2px';

    setTimeout(() => {
      element.style.transition = 'outline-color 0.5s ease';
      element.style.outline = orig.outline;
      element.style.outlineOffset = orig.outlineOffset;
      setTimeout(() => { element.style.transition = orig.transition; }, 600);
    }, duration);
  }

  function applyAnswer(domRefs, answer) {
    const { type, options, matchItems, inputElement, isDropdown } = domRefs;
    devLog('Applying answer:', answer, 'mode:', answerMode, 'type:', type);

    if (answerMode === 'clipboard') {
      navigator.clipboard.writeText(answer).catch(() => {});
      return;
    }

    switch (type) {
      case 'MULTIPLE_CHOICE':
      case 'TRUE_FALSE': {
        const matched = findMatchingOption(options, answer);
        if (!matched) {
          devWarn('No matching option found for answer:', answer);
          navigator.clipboard.writeText(answer).catch(() => {});
          return;
        }
        devLog('Matched option:', matched.identifier, matched.text?.substring(0, 40));

        if (answerMode === 'auto') {
          if (isDropdown && matched.isSelectOption) {
            matched.inputElement.selectedIndex = matched.optionIndex;
            matched.inputElement.dispatchEvent(new Event('change', { bubbles: true }));
          } else if (matched.isCustom) {
            // For div-based options: click the container element, then try children
            simulateClick(matched.element);
            // Some sites have the actual clickable deeper (e.g., a nested <a> or <span>)
            const inner = matched.element.querySelector('a, span, div, label');
            if (inner && inner !== matched.element) {
              setTimeout(() => simulateClick(inner), 50);
            }
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
              if (opt.isCustom) { simulateClick(opt.element); }
              else if (!opt.inputElement.checked) {
                simulateClick(opt.inputElement);
                opt.inputElement.checked = true;
                opt.inputElement.dispatchEvent(new Event('change', { bubbles: true }));
              }
            } else {
              highlightElement(opt.element, highlightDuration);
            }
          }
        });
        if (!anyMatched) navigator.clipboard.writeText(answer).catch(() => {});
        break;
      }

      case 'MATCHING': {
        if (!matchItems || matchItems.length === 0) {
          navigator.clipboard.writeText(answer).catch(() => {});
          return;
        }
        const pairs = answer.split(',').map(s => s.trim());
        pairs.forEach(pair => {
          const match = pair.match(/(\d+)\s*[→\-:]\s*(.+)/);
          if (!match) return;
          const itemIndex = parseInt(match[1]) - 1;
          const targetValue = match[2].trim();
          if (itemIndex >= 0 && itemIndex < matchItems.length) {
            const select = matchItems[itemIndex].inputElement;
            for (let i = 0; i < select.options.length; i++) {
              if (select.options[i].text.trim().toLowerCase().includes(targetValue.toLowerCase()) ||
                targetValue.toLowerCase().includes(select.options[i].text.trim().toLowerCase())) {
                if (answerMode === 'auto') {
                  select.selectedIndex = i;
                  select.dispatchEvent(new Event('change', { bubbles: true }));
                } else { highlightElement(select, highlightDuration); }
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

    devLog('Double-click on:', e.target.tagName,
           e.target.className?.toString()?.substring(0, 50),
           'at y:', Math.round(e.clientY));

    processing = true;
    try {
      const context = await extractQuestionContext(e.target);
      if (!context) {
        devLog('No question context found');
        processing = false;
        return;
      }

      const domRefs = context._domRefs;
      delete context._domRefs;

      devLog('Sending to AI:', context.type, 'images:', context.images?.length || 0,
             'question:', context.questionText?.substring(0, 60));

      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          { type: 'PROCESS_QUESTION', data: context },
          (resp) => {
            if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
            if (resp.success) resolve(resp.answer);
            else reject(new Error(resp.error));
          }
        );
      });

      devLog('AI answer:', response);
      applyAnswer(domRefs, response);
    } catch (err) {
      devWarn('Error:', err.message);
    } finally {
      processing = false;
    }
  }, true);

  devLog('Content script loaded. Dev mode:', IS_DEV);

})();
