// ============================================================
// QuizSolve - Content Script
// Detects questions, extracts context + images, applies answers
// Robust auto-answer engine with multi-strategy click simulation
// ============================================================

(function () {
  if (window.__quizSolveLoaded) return;
  window.__quizSolveLoaded = true;

  // ---- Dev Mode Detection ----
  const IS_DEV = !('update_url' in chrome.runtime.getManifest());
  function devLog(...args) {
    if (IS_DEV) console.log('[QuizSolve:Content]', ...args);
  }
  function devWarn(...args) {
    if (IS_DEV) console.warn('[QuizSolve:Content]', ...args);
  }
  function devError(...args) {
    if (IS_DEV) console.error('[QuizSolve:Content]', ...args);
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
  const MIN_IMAGE_SIZE = 80;
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

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' &&
           style.visibility !== 'hidden' &&
           parseFloat(style.opacity) > 0;
  }

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
    // Quizizz
    '[class*="QuestionSlide"]',
    '[class*="questionWrapper"]',
    // EdPuzzle
    '.question-container',
    // Edulastic
    '[class*="question-content"]',
    // Generic patterns
    '[class*="question-item"]',
    '[class*="questionItem"]',
    '[class*="quiz-item"]',
    '[class*="question-row"]',
    '[class*="question-block"]',
    '[class*="questionBlock"]',
    '[class*="question-card"]',
    '[class*="questionCard"]',
    '.question-wrapper',
    '.problem-body',
    '[data-question]',
    '[data-question-id]',
    '[data-qid]',
  ];

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
      } catch (_) {}
    }

    return found;
  }

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
      if (score > maxScore) {
        maxScore = score;
        bestContainer = current;
      }
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
      for (const c of allContainers) {
        if (c.contains(clickTarget)) {
          devLog('Container found via page-scan contains');
          return c;
        }
      }
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

    const radios = element.querySelectorAll('input[type="radio"]');
    const checkboxes = element.querySelectorAll('input[type="checkbox"]');
    const selects = element.querySelectorAll('select');
    const textInputs = element.querySelectorAll('input[type="text"], input:not([type]):not([role="combobox"]), textarea');
    const totalInputs = radios.length + checkboxes.length + selects.length + textInputs.length;

    const divOptions = element.querySelectorAll(
      '.opt_text, .questonnopt, [role="radio"], [role="checkbox"], [role="option"], ' +
      '.answers-list > li, [class*="answer-option"], [class*="choice-item"], [class*="option-text"]'
    );

    if (totalInputs > 0) score += 3;
    if (divOptions.length >= 2) score += 3;
    if (radios.length >= 2) score += 3;
    if (checkboxes.length >= 2) score += 2;

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
      '.qtext', '.formulation .qtext',
      '[class*="question-content"]', '[class*="questionContent"]',
      '.question-header', '[class*="questionText"]',
    ];

    for (const sel of questionSelectors) {
      const el = container.querySelector(sel);
      if (el && el.textContent.trim().length > 5) {
        return el.textContent.trim();
      }
    }

    const answerSection = container.querySelector(
      '.answers-list, .answer_list, [class*="answer"], [class*="option"], ' +
      '[class*="choice"], input[type="radio"], input[type="checkbox"]'
    );

    if (answerSection) {
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      let parts = [];
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (answerSection.contains(node) || answerSection === node.parentElement) break;
        const text = node.textContent.trim();
        if (text.length > 2) parts.push(text);
      }
      if (parts.length > 0) {
        const questionText = parts.join(' ').trim();
        if (questionText.length > 5) return questionText;
      }
    }

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

  // ============================================================
  // QUESTION SUBTYPE DETECTION — Accuracy Enhancement
  // ============================================================

  /**
   * Detect negative MCQ patterns: "which is NOT", "which is WRONG",
   * "which is INCORRECT", "which is FALSE", "choose the wrong"
   */
  function detectNegativeMCQ(text) {
    const negativePatterns = [
      /which\s+(?:of\s+the\s+following\s+)?(?:is|are)\s+(?:NOT|not)\b/i,
      /which\s+(?:of\s+the\s+following\s+)?(?:is|are)\s+(?:WRONG|wrong|INCORRECT|incorrect|FALSE|false)\b/i,
      /(?:choose|select|pick|identify|find)\s+(?:the\s+)?(?:WRONG|wrong|INCORRECT|incorrect|FALSE|false)\b/i,
      /(?:is|are)\s+(?:NOT|not)\s+(?:true|correct|right|accurate|valid)\b/i,
      /(?:NOT|not)\s+(?:a|an)\s+(?:feature|characteristic|property|example|type|method|function)\b/i,
      /(?:INCORRECT|incorrect|WRONG|wrong|FALSE|false)\s+(?:statement|answer|option|assertion)\b/i,
      /(?:cannot|can't|couldn't|does\s+not|doesn't|is\s+not|isn't)\s+be\s+(?:used|applied|considered)\b/i,
      /\bnot\s+(?:a\s+valid|an?\s+example|characteristic)\b/i,
      /\bexcept\b/i,
    ];
    for (const pattern of negativePatterns) {
      if (pattern.test(text)) return true;
    }
    return false;
  }

  /**
   * Detect "all EXCEPT" pattern: "all of the following are true EXCEPT",
   * "each of the following EXCEPT"
   */
  function detectExceptPattern(text) {
    const exceptPatterns = [
      /all\s+(?:of\s+the\s+following\s+)?(?:are|is|were|was)\s+.*?\bEXCEPT\b/i,
      /all\s+(?:of\s+the\s+following\s+)?\bEXCEPT\b/i,
      /each\s+(?:of\s+the\s+following\s+)?\bEXCEPT\b/i,
      /(?:true|correct|right|valid|accurate)\s+.*?\bEXCEPT\b/i,
      /\bEXCEPT\b\s+(?:which|that|for)/i,
      /which\s+(?:one\s+)?(?:of\s+the\s+following\s+)?(?:does|is|are|has|was|were)\s+NOT\b/i,
    ];
    for (const pattern of exceptPatterns) {
      if (pattern.test(text)) return true;
    }
    return false;
  }

  /**
   * Detect numerical/calculation questions
   */
  function detectNumerical(text) {
    const numericalPatterns = [
      /(?:calculate|compute|find\s+the\s+value|evaluate|solve|what\s+is\s+the\s+(?:value|result|sum|product|area|volume|distance|speed|rate|percentage|ratio))/i,
      /(?:how\s+(?:many|much|far|long|fast|often|old))\b/i,
      /\b(?:equals?|=)\s*\?/i,
      /\b(?:simplify|factor|derive|integrate|differentiate)\b/i,
      /\b\d+\s*[\+\-\*\/\^]\s*\d+/,
      /\b(?:x|y)\s*[\+\-]\s*\d+\s*=\s*\d+/i,
    ];
    for (const pattern of numericalPatterns) {
      if (pattern.test(text)) return true;
    }
    return false;
  }

  /**
   * Main subtype detector — refines base type into specialized subtypes.
   * Returns { refinedType, instructions } where instructions are hints
   * extracted from the question that help the AI answer correctly.
   */
  function detectQuestionSubtype(questionText, baseType) {
    const text = questionText || '';
    let refinedType = baseType;
    let instructions = '';

    if (baseType === 'MULTIPLE_CHOICE' || baseType === 'MULTI_SELECT') {
      if (detectExceptPattern(text)) {
        refinedType = 'MCQ_EXCEPT';
        instructions = extractInstructions(text, 'except');
      } else if (detectNegativeMCQ(text)) {
        refinedType = 'MCQ_NEGATIVE';
        instructions = extractInstructions(text, 'negative');
      } else if (detectNumerical(text)) {
        refinedType = 'NUMERICAL';
        instructions = extractInstructions(text, 'numerical');
      }
    } else if (baseType === 'FILL_BLANK' || baseType === 'SHORT_ANSWER') {
      if (detectNumerical(text)) {
        refinedType = 'NUMERICAL';
        instructions = extractInstructions(text, 'numerical');
      }
    }

    if (refinedType !== baseType) {
      devLog('Subtype detected:', baseType, '→', refinedType, 'instructions:', instructions.substring(0, 60));
    }

    return { refinedType, instructions };
  }

  /**
   * Extract special instructions from the question text that help
   * the AI understand what's being asked.
   */
  function extractInstructions(questionText, subtype) {
    const text = questionText || '';

    if (subtype === 'except') {
      // Extract the core assertion: "All of the following are properties of X EXCEPT"
      const exceptMatch = text.match(/(all\s+(?:of\s+the\s+following\s+)?(?:are|is|were|was)\s+.+?)\s*EXCEPT/i);
      if (exceptMatch) {
        return `INVERSION: ${exceptMatch[1].trim()} — find the one that does NOT fit.`;
      }
      return 'INVERSION: Find the option that does NOT belong / is the exception.';
    }

    if (subtype === 'negative') {
      // Extract what they're negating
      const negMatch = text.match(/(which\s+(?:of\s+the\s+following\s+)?(?:is|are)\s+(?:NOT|WRONG|INCORRECT|FALSE)\s+.{0,80}?)[?.!]/i);
      if (negMatch) {
        return `NEGATION: ${negMatch[1].trim()} — choose the WRONG/FALSE/INCORRECT option.`;
      }
      const chooseWrong = text.match(/((?:choose|select|pick|identify|find)\s+(?:the\s+)?(?:WRONG|INCORRECT|FALSE)\s+.{0,80}?)[?.!]/i);
      if (chooseWrong) {
        return `NEGATION: ${chooseWrong[1].trim()}`;
      }
      return 'NEGATION: This question asks for the WRONG/INCORRECT/FALSE option. Choose what is NOT true.';
    }

    if (subtype === 'numerical') {
      return 'CALCULATION: Show your work mentally. Verify the numerical answer before responding.';
    }

    return '';
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
      devLog('Options found via radio buttons:', options.length);
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
      devLog('Options found via checkboxes:', options.length);
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
      devLog('Options found via matching selects:', matchItems.length);
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
      if (options.length >= 2) {
        devLog('Options found via dropdown select:', options.length);
        return { type: 'MULTIPLE_CHOICE', options, isDropdown: true };
      }
    }

    // ---- Strategy 5: Text inputs ----
    const textInputs = container.querySelectorAll(
      'input[type="text"], input[type="number"], input:not([type]):not([role="combobox"]), textarea'
    );
    if (textInputs.length > 0) {
      const input = textInputs[0];
      devLog('Found text input/textarea for fill-in');
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
      devLog('Options found via ARIA roles:', options.length);
      return { type: isTrueFalse(options) ? 'TRUE_FALSE' : 'MULTIPLE_CHOICE', options };
    }

    // ---- Strategy 7: Div-based clickable options (ProProfs, etc.) ----
    const optionListSelectors = [
      '.answers-list > li',
      '.answer-list > li',
      '.options-list > li',
      '.choices > li',
      '[class*="answer-option"]',
      '[class*="choice-item"]',
      '.opt_text',
      // More generic patterns
      'ul.options > li',
      'ol.options > li',
      '.answer-choices > div',
      '[class*="answerOption"]',
      '[class*="choiceItem"]',
      '[class*="AnswerChoice"]',
      '[data-answer]',
      '[data-option]',
      // Button-based options
      'button[class*="option"]',
      'button[class*="answer"]',
      'button[class*="choice"]',
    ];
    for (const sel of optionListSelectors) {
      const items = container.querySelectorAll(sel);
      if (items.length >= 2) {
        const options = [];
        items.forEach((item, index) => {
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
          devLog('Options found via div-based selector:', sel, options.length);
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
      devLog('Options found via data-testid:', options.length);
      return { type: isTrueFalse(options) ? 'TRUE_FALSE' : 'MULTIPLE_CHOICE', options };
    }

    // ---- Strategy 9: Clickable list items with reasonable text ----
    // Generic fallback: find <li> children of any list within the container
    // that look like answer options (have text, roughly similar length, multiple items)
    const lists = container.querySelectorAll('ul, ol');
    for (const list of lists) {
      const items = list.querySelectorAll(':scope > li');
      if (items.length >= 2 && items.length <= 10) {
        const texts = [];
        items.forEach(item => texts.push(item.textContent.trim()));
        // Check that items look like options (not navigation, not empty)
        const nonEmpty = texts.filter(t => t.length > 0 && t.length < 500);
        if (nonEmpty.length >= 2) {
          const options = [];
          items.forEach((item, index) => {
            const text = item.textContent.trim();
            if (text.length > 0 && text.length < 500) {
              options.push({
                element: item, inputElement: item,
                text, value: text,
                identifier: String.fromCharCode(65 + index),
                isCustom: true
              });
            }
          });
          if (options.length >= 2) {
            devLog('Options found via generic list items:', options.length);
            return { type: isTrueFalse(options) ? 'TRUE_FALSE' : 'MULTIPLE_CHOICE', options };
          }
        }
      }
    }

    devLog('No options found — treating as SHORT_ANSWER');
    return { type: 'SHORT_ANSWER', options: [] };
  }

  async function extractQuestionContext(targetElement) {
    const container = findQuestionContainer(targetElement);
    if (!container) {
      devWarn('No question container found for target:', targetElement.tagName);
      return null;
    }

    devLog('Question container:', container.tagName, container.className?.toString()?.substring(0, 60),
           'textLen:', container.textContent.trim().length);

    const questionText = extractQuestionText(container);
    if (!questionText || questionText.length < 3) {
      devWarn('Question text too short or empty');
      return null;
    }

    const optionData = extractOptionsAndType(container);
    const images = await extractImages(container);

    // Detect question subtype for accuracy enhancement
    const { refinedType, instructions } = detectQuestionSubtype(questionText, optionData.type);

    devLog('Question extracted:', {
      type: optionData.type,
      refinedType,
      instructions: instructions ? instructions.substring(0, 50) : '(none)',
      textLength: questionText.length,
      options: optionData.options?.length || 0,
      matchItems: optionData.matchItems?.length || 0,
      images: images.length,
      questionPreview: questionText.substring(0, 80)
    });

    return {
      questionText,
      type: refinedType,
      baseType: optionData.type,
      instructions,
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
  // ROBUST CLICK SIMULATION ENGINE
  // Multi-strategy approach for maximum framework compatibility
  // ============================================================

  /**
   * Full pointer+mouse event sequence on an element.
   * Covers vanilla JS, React, Angular, Vue event delegation.
   */
  function dispatchFullClickSequence(element) {
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    const baseOpts = {
      bubbles: true, cancelable: true, view: window,
      clientX: x, clientY: y,
      screenX: x + window.screenX, screenY: y + window.screenY,
      button: 0, buttons: 1
    };

    // Hover first (some frameworks need this)
    element.dispatchEvent(new PointerEvent('pointerover', { ...baseOpts, buttons: 0 }));
    element.dispatchEvent(new MouseEvent('mouseover', { ...baseOpts, buttons: 0 }));
    element.dispatchEvent(new PointerEvent('pointerenter', { ...baseOpts, bubbles: false, buttons: 0 }));
    element.dispatchEvent(new MouseEvent('mouseenter', { ...baseOpts, bubbles: false, buttons: 0 }));

    // Press
    element.dispatchEvent(new PointerEvent('pointerdown', baseOpts));
    element.dispatchEvent(new MouseEvent('mousedown', baseOpts));

    // Release
    element.dispatchEvent(new PointerEvent('pointerup', { ...baseOpts, buttons: 0 }));
    element.dispatchEvent(new MouseEvent('mouseup', { ...baseOpts, buttons: 0 }));

    // Click
    element.dispatchEvent(new MouseEvent('click', { ...baseOpts, buttons: 0 }));
  }

  /**
   * Fire keyboard Space event (activates focused radios/checkboxes/buttons natively)
   */
  function dispatchKeyboardSpace(element) {
    const opts = { key: ' ', code: 'Space', keyCode: 32, which: 32, bubbles: true, cancelable: true };
    element.dispatchEvent(new KeyboardEvent('keydown', opts));
    element.dispatchEvent(new KeyboardEvent('keypress', opts));
    element.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  /**
   * Fire keyboard Enter event
   */
  function dispatchKeyboardEnter(element) {
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    element.dispatchEvent(new KeyboardEvent('keydown', opts));
    element.dispatchEvent(new KeyboardEvent('keypress', opts));
    element.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  /**
   * Find the <label> element associated with an input
   */
  function findLabelElement(input) {
    if (input.id) {
      const label = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
      if (label) return label;
    }
    return input.closest('label');
  }

  /**
   * Select a standard radio button or checkbox with maximum reliability.
   * Uses 5 strategies in sequence, then verifies and retries if needed.
   */
  function selectRadioOrCheckbox(input) {
    devLog('selectRadioOrCheckbox:', input.type, input.name, input.value?.substring(0, 30));

    // Ensure visible
    try { input.scrollIntoView({ block: 'nearest', behavior: 'instant' }); } catch (_) {}

    // Strategy 1: Focus + full event sequence on input
    try { input.focus(); } catch (_) {}
    dispatchFullClickSequence(input);

    // Strategy 2: Native .click() — handles jQuery, onclick attrs
    try { input.click(); } catch (_) {}

    // Strategy 3: Explicitly set checked + fire change/input events
    // This is the most reliable for React (uses native setter to trigger React's onChange)
    const nativeSetter = Object.getOwnPropertyDescriptor(
      input.type === 'checkbox' ? HTMLInputElement.prototype : HTMLInputElement.prototype, 'checked'
    )?.set;
    if (nativeSetter) {
      nativeSetter.call(input, true);
    } else {
      input.checked = true;
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));

    // Strategy 4: Click the associated label (triggers input via label-for association)
    const label = findLabelElement(input);
    if (label && label !== input) {
      devLog('Also clicking label for input');
      try { label.click(); } catch (_) {}
      dispatchFullClickSequence(label);
    }

    // Strategy 5: Keyboard Space on focused input (browser native radio/checkbox toggle)
    try {
      input.focus();
      dispatchKeyboardSpace(input);
    } catch (_) {}

    // Verify after a short delay
    setTimeout(() => {
      if (!input.checked) {
        devWarn('Click verification FAILED — force-setting checked');
        input.checked = true;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        try { input.click(); } catch (_) {}
        // Try the container too
        const container = input.closest('li, div, label, [class*="option"], [class*="answer"]');
        if (container) {
          try { container.click(); } catch (_) {}
        }
      } else {
        devLog('Click verification OK — input.checked = true');
      }
    }, 150);
  }

  /**
   * Click a custom/div-based option element with maximum reliability.
   * For ProProfs, Google Forms, Quizizz, custom React/Angular/Vue apps, etc.
   */
  function clickCustomOption(element) {
    devLog('clickCustomOption:', element.tagName, element.className?.toString()?.substring(0, 40),
           'text:', element.textContent?.substring(0, 30));

    // Ensure visible
    try { element.scrollIntoView({ block: 'nearest', behavior: 'instant' }); } catch (_) {}

    // Strategy 1: Focus + full event sequence
    try { element.focus(); } catch (_) {}
    dispatchFullClickSequence(element);

    // Strategy 2: Native .click()
    try { element.click(); } catch (_) {}

    // Strategy 3: Keyboard activation
    try {
      element.focus();
      dispatchKeyboardEnter(element);
      dispatchKeyboardSpace(element);
    } catch (_) {}

    // Strategy 4: Try touch events (mobile-optimized sites)
    try {
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const touchOpts = { bubbles: true, cancelable: true, clientX: x, clientY: y };
      element.dispatchEvent(new TouchEvent('touchstart', { ...touchOpts, touches: [new Touch({ identifier: 1, target: element, clientX: x, clientY: y })] }));
      element.dispatchEvent(new TouchEvent('touchend', { ...touchOpts, touches: [] }));
    } catch (_) {
      // TouchEvent not supported in all contexts
    }

    // Strategy 5: Click interactive children (some sites nest the actual handler)
    const childTargets = element.querySelectorAll(
      'a, button, [role="radio"], [role="checkbox"], [role="option"], ' +
      '[tabindex], span.opt_text, span[class*="text"], div[class*="text"], label'
    );
    for (const child of childTargets) {
      if (child !== element) {
        setTimeout(() => {
          try { child.click(); } catch (_) {}
          dispatchFullClickSequence(child);
        }, 30);
      }
    }

    // Strategy 6: Update ARIA attributes (for accessibility-driven UIs)
    if (element.hasAttribute('aria-checked')) {
      element.setAttribute('aria-checked', 'true');
      // Uncheck siblings
      const parent = element.parentElement;
      if (parent) {
        parent.querySelectorAll('[aria-checked="true"]').forEach(sib => {
          if (sib !== element) sib.setAttribute('aria-checked', 'false');
        });
      }
    }
    if (element.hasAttribute('aria-selected')) {
      element.setAttribute('aria-selected', 'true');
    }

    // Strategy 7: Try clicking the parent <li> or wrapper (some handlers are on parent)
    const parentLi = element.closest('li');
    if (parentLi && parentLi !== element) {
      setTimeout(() => {
        try { parentLi.click(); } catch (_) {}
        dispatchFullClickSequence(parentLi);
      }, 60);
    }
  }

  // ============================================================
  // ANSWER APPLICATION ENGINE
  // ============================================================

  function findMatchingOption(options, answer) {
    const cleanAnswer = answer.trim();
    const upperAnswer = cleanAnswer.toUpperCase();

    // Strip common AI response prefixes: "A)", "(A)", "A.", "Option A", "Answer: A"
    const stripped = cleanAnswer
      .replace(/^(option|answer|choice)\s*[:=]?\s*/i, '')
      .replace(/^[\(\[]?\s*([A-Za-z0-9])\s*[\)\]\.:\-]\s*/, '$1')
      .trim();
    const strippedUpper = stripped.toUpperCase();

    // Direct identifier match (A, B, C, D or 1, 2, 3, 4)
    for (const opt of options) {
      if (opt.identifier.toUpperCase() === upperAnswer) return opt;
      if (opt.identifier.toUpperCase() === strippedUpper) return opt;
    }

    // First non-whitespace char match
    const firstChar = strippedUpper.charAt(0);
    if (/^[A-Z0-9]$/.test(firstChar)) {
      for (const opt of options) {
        if (opt.identifier.toUpperCase() === firstChar) return opt;
      }
    }

    // Exact text match (case-insensitive)
    const lowerAnswer = cleanAnswer.toLowerCase();
    for (const opt of options) {
      if (opt.text.toLowerCase().trim() === lowerAnswer) return opt;
    }

    // Partial text match
    for (const opt of options) {
      const optLower = opt.text.toLowerCase().trim();
      if (optLower.includes(lowerAnswer) || lowerAnswer.includes(optLower)) {
        return opt;
      }
    }

    // True/False specific
    const tfLower = lowerAnswer.replace(/[^a-z]/g, '');
    if (tfLower === 'true' || tfLower === 'false') {
      for (const opt of options) {
        if (opt.text.toLowerCase().trim() === tfLower) return opt;
      }
    }

    return null;
  }

  function setInputValue(input, value) {
    // Use native setter for React/Angular/Vue compatibility
    const proto = input.tagName.toLowerCase() === 'textarea'
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
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
    devLog('Applying answer:', answer, 'mode:', answerMode, 'type:', type,
           'options:', options?.length || 0);

    if (answerMode === 'clipboard') {
      navigator.clipboard.writeText(answer).catch(() => {});
      devLog('Answer copied to clipboard');
      return;
    }

    switch (type) {
      case 'MULTIPLE_CHOICE':
      case 'TRUE_FALSE': {
        const matched = findMatchingOption(options, answer);
        if (!matched) {
          devWarn('No matching option found for answer:', answer,
                  'available:', options.map(o => `${o.identifier}="${o.text?.substring(0, 25)}"`));
          navigator.clipboard.writeText(answer).catch(() => {});
          return;
        }
        devLog('Matched option:', matched.identifier, '"' + matched.text?.substring(0, 40) + '"',
               'isCustom:', !!matched.isCustom, 'isDropdown:', !!isDropdown);

        if (answerMode === 'auto') {
          if (isDropdown && matched.isSelectOption) {
            // Dropdown: set selected index + change event
            matched.inputElement.selectedIndex = matched.optionIndex;
            matched.inputElement.dispatchEvent(new Event('change', { bubbles: true }));
            devLog('Dropdown selection applied');
          } else if (matched.isCustom) {
            // Custom div-based option
            clickCustomOption(matched.element);
          } else {
            // Standard radio/checkbox
            selectRadioOrCheckbox(matched.inputElement);
          }
        } else {
          highlightElement(matched.element, highlightDuration);
        }
        break;
      }

      case 'MULTI_SELECT': {
        // Parse multi-select answer: "A, C, D" or "A,C,D"
        const selectedIds = answer.split(/[,\s]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
        let anyMatched = false;
        devLog('Multi-select targets:', selectedIds);

        options.forEach(opt => {
          if (selectedIds.includes(opt.identifier)) {
            anyMatched = true;
            if (answerMode === 'auto') {
              if (opt.isCustom) {
                clickCustomOption(opt.element);
              } else if (!opt.inputElement.checked) {
                selectRadioOrCheckbox(opt.inputElement);
              }
            } else {
              highlightElement(opt.element, highlightDuration);
            }
          }
        });
        if (!anyMatched) {
          devWarn('No multi-select options matched:', selectedIds);
          navigator.clipboard.writeText(answer).catch(() => {});
        }
        break;
      }

      case 'MATCHING': {
        if (!matchItems || matchItems.length === 0) {
          devWarn('No match items for MATCHING type');
          navigator.clipboard.writeText(answer).catch(() => {});
          return;
        }
        const pairs = answer.split(',').map(s => s.trim());
        devLog('Matching pairs:', pairs);
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
                  devLog('Matching select applied:', itemIndex, '→', targetValue);
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
          devLog('Text input filled');
        } else if (answerMode === 'auto') {
          // Try to find any text input in the container
          const container = domRefs.container;
          if (container) {
            const anyInput = container.querySelector('input[type="text"], textarea, input:not([type]), [contenteditable="true"]');
            if (anyInput) {
              if (anyInput.getAttribute('contenteditable') === 'true') {
                anyInput.focus();
                anyInput.textContent = answer;
                anyInput.dispatchEvent(new Event('input', { bubbles: true }));
                devLog('Contenteditable filled');
              } else {
                anyInput.focus();
                setInputValue(anyInput, answer);
                devLog('Fallback text input filled');
              }
            } else {
              navigator.clipboard.writeText(answer).catch(() => {});
              devLog('No input found, copied to clipboard');
            }
          } else {
            navigator.clipboard.writeText(answer).catch(() => {});
          }
        } else {
          navigator.clipboard.writeText(answer).catch(() => {});
        }
        break;
      }

      default:
        devWarn('Unknown question type:', type);
        navigator.clipboard.writeText(answer).catch(() => {});
    }
  }

  // ============================================================
  // DOUBLE-CLICK HANDLER
  // ============================================================

  document.addEventListener('dblclick', async (e) => {
    if (!isActive || processing) return;

    devLog('--- DOUBLE-CLICK ---');
    devLog('Target:', e.target.tagName,
           'class:', e.target.className?.toString()?.substring(0, 60),
           'id:', e.target.id?.substring(0, 30),
           'at:', Math.round(e.clientX) + ',' + Math.round(e.clientY));

    processing = true;
    const startTime = Date.now();

    try {
      const context = await extractQuestionContext(e.target);
      if (!context) {
        devWarn('No question context found — took', Date.now() - startTime, 'ms');
        processing = false;
        return;
      }

      const domRefs = context._domRefs;
      delete context._domRefs;

      devLog('Sending to AI:', context.type,
             'options:', context.options?.length || 0,
             'images:', context.images?.length || 0,
             'question:', context.questionText?.substring(0, 80));

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

      devLog('AI answer:', response, '— total time:', Date.now() - startTime, 'ms');
      applyAnswer(domRefs, response);
    } catch (err) {
      devError('Error processing question:', err.message);
      devError('Stack:', err.stack);
    } finally {
      processing = false;
    }
  }, true);

  devLog('Content script loaded. Dev mode:', IS_DEV);

})();
