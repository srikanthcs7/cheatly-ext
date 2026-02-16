// ============================================================
// QuizSolve - Content Script
// Detects questions, extracts context + images, applies answers
// Robust auto-answer engine with multi-strategy click simulation
// ============================================================

(function () {
  // Symbol guard — tamper-proof, non-enumerable, non-writable
  const _qs_loaded_key = Symbol.for('__qs_content_loaded_' + chrome.runtime.id);
  if (window[_qs_loaded_key]) return;
  Object.defineProperty(window, _qs_loaded_key, {
    value: true, writable: false, configurable: false, enumerable: false
  });

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

  // Feature flags (configurable, all off by default)
  let featureHighlight = false;
  let featureRephrase = false;
  let featureDrawRegion = false;
  let featureSnapIt = false;
  let featureNotifications = false; // off by default — stealth mode
  let featureDblClickSolve = true;
  let modalSize = 'small'; // 'small' | 'medium' | 'large'

  chrome.storage.local.get([
    'featureHighlight', 'featureRephrase', 'featureDrawRegion',
    'featureSnapIt', 'featureNotifications', 'featureDblClickSolve', 'modalSize'
  ], (result) => {
    featureHighlight = result.featureHighlight || false;
    featureRephrase = result.featureRephrase || false;
    featureDrawRegion = result.featureDrawRegion || false;
    featureSnapIt = result.featureSnapIt || false;
    featureNotifications = result.featureNotifications || false;
    featureDblClickSolve = result.featureDblClickSolve !== false;
    modalSize = result.modalSize || 'small';
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.answerMode) answerMode = changes.answerMode.newValue;
    if (changes.highlightDuration) highlightDuration = changes.highlightDuration.newValue;
    if (changes.featureHighlight) featureHighlight = changes.featureHighlight.newValue;
    if (changes.featureRephrase) featureRephrase = changes.featureRephrase.newValue;
    if (changes.featureDrawRegion) featureDrawRegion = changes.featureDrawRegion.newValue;
    if (changes.featureSnapIt) featureSnapIt = changes.featureSnapIt.newValue;
    if (changes.featureNotifications) featureNotifications = changes.featureNotifications.newValue;
    if (changes.featureDblClickSolve) featureDblClickSolve = changes.featureDblClickSolve.newValue !== false;
    if (changes.modalSize) modalSize = changes.modalSize.newValue;
  });

  // ============================================================
  // TOAST NOTIFICATION SYSTEM
  // ============================================================

  function injectToastStyles() {
    if (document.getElementById('qs-toast-styles')) return;
    const style = document.createElement('style');
    style.id = 'qs-toast-styles';
    style.textContent = `
      .qs-toast {
        position: fixed;
        bottom: 24px;
        right: 24px;
        z-index: 2147483647;
        padding: 10px 16px;
        border-radius: 8px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 13px;
        font-weight: 500;
        color: #fff;
        background: #1a1a2e;
        border: 1px solid rgba(255,255,255,0.08);
        box-shadow: 0 8px 24px rgba(0,0,0,0.3);
        opacity: 0;
        transform: translateY(12px);
        transition: opacity 0.2s ease, transform 0.2s ease;
        pointer-events: none;
        max-width: 320px;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .qs-toast.qs-toast-visible {
        opacity: 1;
        transform: translateY(0);
        pointer-events: auto;
      }
      .qs-toast-success { border-left: 3px solid #2dd4bf; }
      .qs-toast-error { border-left: 3px solid #f87171; }
      .qs-toast-info { border-left: 3px solid #60a5fa; }
      .qs-toast-loading { border-left: 3px solid #a78bfa; }
      .qs-toast-loading .qs-toast-dots {
        display: inline-flex;
        gap: 3px;
      }
      .qs-toast-loading .qs-toast-dots span {
        width: 5px; height: 5px;
        border-radius: 50%;
        background: #a78bfa;
        animation: qs-bounce 1.4s infinite ease-in-out both;
      }
      .qs-toast-loading .qs-toast-dots span:nth-child(1) { animation-delay: -0.32s; }
      .qs-toast-loading .qs-toast-dots span:nth-child(2) { animation-delay: -0.16s; }
      .qs-toast-loading .qs-toast-dots span:nth-child(3) { animation-delay: 0s; }
      .qs-processing {
        outline: 2px solid rgba(45, 212, 191, 0.4) !important;
        outline-offset: 2px !important;
        animation: qs-pulse-outline 1.5s ease-in-out infinite !important;
      }
      @keyframes qs-pulse-outline {
        0%, 100% { outline-color: rgba(45, 212, 191, 0.2); }
        50% { outline-color: rgba(45, 212, 191, 0.6); }
      }
    `;
    document.head.appendChild(style);
  }

  const _noop_dismiss = { dismiss() {} };

  function showToast(message, type = 'info', duration = 3000) {
    // Silent by default — only show when user enables notifications
    if (!featureNotifications) return _noop_dismiss;

    injectToastStyles();
    // Remove existing toasts
    document.querySelectorAll('.qs-toast').forEach(t => t.remove());

    const el = document.createElement('div');
    el.className = `qs-toast qs-toast-${type}`;
    if (type === 'loading') {
      el.innerHTML = `<span>${message}</span><span class="qs-toast-dots"><span></span><span></span><span></span></span>`;
    } else {
      el.textContent = message;
    }
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('qs-toast-visible'));

    const dismiss = () => {
      el.classList.remove('qs-toast-visible');
      setTimeout(() => el.remove(), 200);
    };

    if (type !== 'loading' && duration > 0) {
      setTimeout(dismiss, duration);
    }

    return { dismiss };
  }

  // ============================================================
  // TIMEOUT WRAPPER
  // ============================================================

  function withTimeout(promise, ms, message) {
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(message || 'Request timed out')), ms)
      )
    ]);
  }

  // ============================================================
  // DEBOUNCE STATE
  // ============================================================

  let lastDblClickTime = 0;

  // ============================================================
  // STATE MANAGEMENT
  // ============================================================

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'TOGGLE_STATE') {
      isActive = message.active;
      devLog('State toggled:', isActive ? 'ACTIVE' : 'INACTIVE');
      sendResponse({ ok: true });
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

  // ============================================================
  // PLATFORM DETECTION — Detect LMS/quiz platform from URL + DOM
  // ============================================================

  function detectPlatform() {
    const host = window.location.hostname.toLowerCase();
    const path = window.location.pathname.toLowerCase();

    if (host.includes('instructure.com') || host.includes('.canvas.') || host.endsWith('canvas.com')) return 'canvas';
    if (host.includes('blackboard.com') || host.includes('bblearn')) return 'blackboard';
    if (host.includes('.moodle.') || host.endsWith('moodle.org') || host.endsWith('moodle.com') || document.querySelector('.moodle-page, #page-mod-quiz')) return 'moodle';
    if (host.includes('google.com') && path.includes('/forms/')) return 'google_forms';
    if (host.includes('schoology.com')) return 'schoology';
    if (host.includes('brightspace') || host.includes('d2l.com')) return 'brightspace';
    if (host.includes('quizlet.com')) return 'quizlet';
    if (host.includes('kahoot')) return 'kahoot';
    if (host.includes('quizizz.com')) return 'quizizz';
    if (host.includes('edpuzzle.com')) return 'edpuzzle';
    if (host.includes('edulastic.com')) return 'edulastic';
    if (host.includes('indiabix.com')) return 'indiabix';
    if (host.includes('sawaal.com')) return 'sawaal';
    if (host.includes('testbook.com')) return 'testbook';
    if (host.includes('gradeup.co') || host.includes('byjusexamprep')) return 'gradeup';
    if (host.includes('chegg.com')) return 'chegg';
    if (host.includes('coursehero.com')) return 'coursehero';
    if (host.includes('khanacademy.org')) return 'khanacademy';
    if (host.includes('connect.mheducation.com')) return 'mcgrawhill';
    if (host.includes('cengage.com')) return 'cengage';
    if (host.includes('pearson.com') || host.includes('mastering')) return 'pearson';
    if (host.includes('wiley.com') || host.includes('wileyplus')) return 'wiley';
    if (host.includes('socrative.com')) return 'socrative';
    if (host.includes('proprofs.com')) return 'proprofs';
    if (host.includes('coursera.org')) return 'coursera';
    if (host.includes('udemy.com')) return 'udemy';
    if (host.includes('edx.org')) return 'edx';
    return 'unknown';
  }

  // ============================================================
  // UNIVERSAL QUESTION CONTAINER DETECTION
  // DOM-semantics-based: works on any quiz website without
  // site-specific CSS selectors.
  // ============================================================

  const STRUCTURAL_TAGS = new Set(['body', 'html', 'header', 'footer', 'nav', 'aside', 'main']);

  function hasFormInputsOrOptions(el) {
    if (el.querySelector('input[type="radio"], input[type="checkbox"], select, textarea')) return true;
    if (el.querySelector('[role="radio"], [role="checkbox"], [role="option"], [role="radiogroup"]')) return true;
    if (hasDivBasedOptionGroup(el)) return true;
    return false;
  }

  function hasDivBasedOptionGroup(container) {
    // Quick check for list-based or data-attribute options
    const candidates = container.querySelectorAll('ul > li, ol > li, [data-answer], [data-option], [data-testid*="answer"], [data-testid*="option"]');
    if (candidates.length >= 2 && candidates.length <= 10) return true;
    // Check for same-tag sibling groups that look like options
    for (const parent of container.querySelectorAll('div, ul, ol, section')) {
      const children = Array.from(parent.children).filter(c => {
        const text = c.textContent.trim();
        return text.length > 0 && text.length < 300 && isVisible(c);
      });
      if (children.length >= 2 && children.length <= 10) {
        const tags = children.map(c => c.tagName);
        if (tags.every(t => t === tags[0])) {
          const avgLen = children.reduce((sum, c) => sum + c.textContent.trim().length, 0) / children.length;
          if (avgLen < 300) return true;
        }
      }
    }
    return false;
  }

  function containsMultipleQuestionGroups(el) {
    // Count distinct radio groups by name
    const radios = el.querySelectorAll('input[type="radio"]');
    if (radios.length > 0) {
      const names = new Set();
      radios.forEach(r => { if (r.name) names.add(r.name); });
      if (names.size > 1) return true;
    }
    if (el.querySelectorAll('fieldset').length > 1) return true;
    if (el.querySelectorAll('[role="radiogroup"]').length > 1) return true;
    return false;
  }

  function findNarrowestInputContainer(broad, target) {
    // Try fieldset / radiogroup / group that contains the click target
    const candidates = broad.querySelectorAll('fieldset, [role="radiogroup"], [role="group"]');
    for (const c of candidates) {
      if (c.contains(target) && hasFormInputsOrOptions(c)) return c;
    }
    // Walk up from target to find narrowest ancestor with inputs
    let current = target;
    let depth = 0;
    while (current && current !== broad && depth < 10) {
      if (hasFormInputsOrOptions(current)) {
        const textLen = current.textContent.trim().length;
        if (textLen >= 20 && textLen <= 8000) return current;
      }
      current = current.parentElement;
      depth++;
    }
    return broad;
  }

  function findQuestionContainer(clickTarget) {
    // Phase 1: Walk up from click target — find smallest ancestor with inputs + text
    let current = clickTarget;
    let depth = 0;
    while (current && current !== document.body && depth < 20) {
      const tag = current.tagName.toLowerCase();
      if (STRUCTURAL_TAGS.has(tag)) {
        current = current.parentElement;
        depth++;
        continue;
      }
      const textLen = current.textContent.trim().length;
      if (textLen >= 20 && textLen <= 8000 && hasFormInputsOrOptions(current)) {
        if (containsMultipleQuestionGroups(current)) {
          const narrow = findNarrowestInputContainer(current, clickTarget);
          if (narrow !== current) {
            devLog('Container found via narrowing:', narrow.tagName, narrow.className?.toString()?.substring(0, 40));
            return narrow;
          }
        }
        devLog('Container found via ancestor walk (phase 1):', current.tagName,
          current.className?.toString()?.substring(0, 40), 'textLen:', textLen);
        return current;
      }
      current = current.parentElement;
      depth++;
    }

    // Phase 2: No inputs found — find nearest block ancestor with reasonable text
    current = clickTarget;
    depth = 0;
    while (current && current !== document.body && depth < 15) {
      const tag = current.tagName.toLowerCase();
      if (STRUCTURAL_TAGS.has(tag)) {
        current = current.parentElement;
        depth++;
        continue;
      }
      const textLen = current.textContent.trim().length;
      if (textLen >= 20 && textLen <= 5000) {
        const display = getComputedStyle(current).display;
        if (['block', 'flex', 'grid', 'table', 'list-item', 'table-row'].includes(display) ||
          ['div', 'section', 'article', 'td', 'tr', 'table', 'li', 'p', 'fieldset', 'form'].includes(tag)) {
          devLog('Container found via text ancestor (phase 2):', current.tagName, 'textLen:', textLen);
          return current;
        }
      }
      current = current.parentElement;
      depth++;
    }

    // Phase 3: Last resort — walk up 5 levels
    current = clickTarget;
    for (let i = 0; i < 5 && current && current !== document.body; i++) {
      current = current.parentElement;
    }
    devLog('Container found via last-resort walk (phase 3):', current?.tagName);
    return current || clickTarget;
  }

  // ============================================================
  // QUESTION TEXT + OPTIONS EXTRACTION
  // ============================================================

  // ============================================================
  // UNIVERSAL OPTION LABEL EXTRACTION
  // Single merged function replacing findLabelForInput,
  // findOptionText, and _tryOptionStrategy.
  // ============================================================

  function extractTextFromElement(el) {
    if (!el) return '';
    const clone = el.cloneNode(true);
    clone.querySelectorAll('input, select, textarea, button, script, style').forEach(n => n.remove());
    convertMathNotation(clone);
    return walkTextNodes(clone);
  }

  function stripOptionIdentifier(text) {
    if (!text) return '';
    // Strip leading identifiers like "A.", "B)", "1.", "2)" etc.
    // Require a delimiter after the letter/digit to avoid stripping fractions like "1/4" or "2/3"
    return text.replace(/^\s*[\(\[]?\s*[A-Da-d1-9]\s*[\)\]\.:\-]\s*/, '').trim();
  }

  function getOptionLabel(input) {
    // 1. <label for="id"> association
    if (input.id) {
      const label = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
      if (label) {
        const text = extractTextFromElement(label);
        if (text) return stripOptionIdentifier(text);
      }
    }

    // 2. Wrapping <label> element
    const parentLabel = input.closest('label');
    if (parentLabel) {
      const text = extractTextFromElement(parentLabel);
      if (text) return stripOptionIdentifier(text);
    }

    // 3. ARIA attributes
    if (input.getAttribute('aria-label')) {
      return stripOptionIdentifier(input.getAttribute('aria-label'));
    }
    const labelledBy = input.getAttribute('aria-labelledby');
    if (labelledBy) {
      const el = document.getElementById(labelledBy);
      if (el) {
        const text = el.textContent.trim();
        if (text) return stripOptionIdentifier(text);
      }
    }

    // 4. Table row — other cells' text (handles IndiaBix-style layouts)
    const td = input.closest('td, th');
    if (td) {
      const tr = td.closest('tr');
      if (tr) {
        const cells = tr.querySelectorAll('td, th');
        const textParts = [];
        for (const cell of cells) {
          if (cell.contains(input)) continue;
          const cellText = cell.textContent.trim();
          if (cellText && !(/^[A-Da-d1-9]\s*[\.\)\]:\-]?$/.test(cellText))) {
            textParts.push(cellText);
          }
        }
        if (textParts.length > 0) {
          return textParts.join(' ').replace(/\s+/g, ' ').trim() || null;
        }
      }
    }

    // 5. Adjacent sibling text/elements
    let sibling = input.nextSibling;
    while (sibling) {
      if (sibling.nodeType === Node.TEXT_NODE) {
        const text = sibling.textContent.trim();
        if (text.length > 0) return stripOptionIdentifier(text);
      }
      if (sibling.nodeType === Node.ELEMENT_NODE && !sibling.querySelector('input, select, textarea')) {
        const text = sibling.textContent.trim();
        if (text && text.length < 500) return stripOptionIdentifier(text);
      }
      sibling = sibling.nextSibling;
    }

    // Also check previous siblings
    sibling = input.previousSibling;
    while (sibling) {
      if (sibling.nodeType === Node.TEXT_NODE) {
        const text = sibling.textContent.trim();
        if (text.length > 0 && !(/^[A-Da-d1-9]\s*[\.\)\]:\-]?$/.test(text))) {
          return stripOptionIdentifier(text);
        }
      }
      if (sibling.nodeType === Node.ELEMENT_NODE && !sibling.querySelector('input, select, textarea')) {
        const text = sibling.textContent.trim();
        if (text && text.length < 500 && !(/^[A-Da-d1-9]\s*[\.\)\]:\-]?$/.test(text))) {
          return stripOptionIdentifier(text);
        }
      }
      sibling = sibling.previousSibling;
    }

    // 6. Parent text minus input text (climb up to 4 levels)
    let current = input.parentElement;
    let depth = 0;
    while (current && depth < 4 && current !== document.body) {
      const sameTypeInputs = current.querySelectorAll(`input[type="${input.type}"]`);
      const sameNameInputs = input.name
        ? current.querySelectorAll(`input[name="${CSS.escape(input.name)}"]`)
        : sameTypeInputs;
      if (sameNameInputs.length <= 1 || sameTypeInputs.length <= 1) {
        const text = extractTextFromElement(current);
        const stripped = stripOptionIdentifier(text);
        if (stripped && stripped.length > 0 && stripped.length < 500) {
          return stripped;
        }
      }
      current = current.parentElement;
      depth++;
    }

    return null;
  }

  function findFirstAnswerElement(container) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const tag = node.tagName.toLowerCase();
      if (['input', 'select', 'textarea'].includes(tag)) return node;
      const role = node.getAttribute('role');
      if (role === 'radio' || role === 'checkbox' || role === 'option' || role === 'radiogroup') return node;
      if (node.hasAttribute('data-answer') || node.hasAttribute('data-option')) return node;
    }
    return null;
  }

  /**
   * Convert math notation in a cloned DOM node (mutates in place).
   * Handles fractions (<sup>3</sup><sub>4</sub> → (3/4)),
   * exponents (10<sup>0.48</sup> → 10^(0.48)), subscripts (H<sub>2</sub> → H_(2)),
   * MathML (<mfrac>), and CSS fraction containers.
   */
  function convertMathNotation(clone) {
    // 1. MathML fractions: <mfrac><mn>3</mn><mn>4</mn></mfrac> → (3/4)
    clone.querySelectorAll('mfrac').forEach(mf => {
      if (mf.children.length >= 2) {
        const num = mf.children[0].textContent.trim();
        const den = mf.children[1].textContent.trim();
        if (num && den) { mf.replaceWith('(' + num + '/' + den + ')'); return; }
      }
    });

    // 2. CSS fraction containers: .frac, .fraction, etc.
    clone.querySelectorAll('[class*="frac" i]').forEach(frac => {
      const children = Array.from(frac.children);
      if (children.length >= 2) {
        const num = children[0].textContent.trim();
        const den = children[children.length - 1].textContent.trim();
        if (num && den && num.length < 20 && den.length < 20) {
          frac.replaceWith('(' + num + '/' + den + ')');
          return;
        }
      }
    });

    // 3. Handle <sup>/<sub> — detect fraction vs exponent
    const sups = Array.from(clone.querySelectorAll('sup'));
    for (const sup of sups) {
      if (!sup.parentNode) continue; // already removed
      const content = sup.textContent.trim();
      if (!content) { sup.remove(); continue; }

      let isFraction = false;
      let subEl = null;
      let slashNodes = [];

      // Check if sup is followed by [optional / or ⁄] then <sub> — inline fraction
      let next = sup.nextSibling;
      while (next) {
        if (next.nodeType === Node.TEXT_NODE) {
          const t = next.textContent.trim();
          if (t === '/' || t === '\u2044' || t === '\u2215' || t === '') {
            if (t) slashNodes.push(next);
            next = next.nextSibling;
            continue;
          }
          break;
        }
        if (next.nodeType === Node.ELEMENT_NODE && next.tagName === 'SUB') {
          isFraction = true;
          subEl = next;
        }
        break;
      }

      // Also check: sup + sub as children of a small container (stacked fraction)
      if (!isFraction && sup.parentElement) {
        const parent = sup.parentElement;
        const directSub = parent.querySelector(':scope > sub');
        if (directSub && parent.children.length <= 4) {
          isFraction = true;
          subEl = directSub;
        }
      }

      if (isFraction && subEl) {
        const den = subEl.textContent.trim();
        slashNodes.forEach(n => n.remove());
        subEl.remove();
        sup.replaceWith('(' + content + '/' + den + ')');
      } else {
        // Not a fraction → exponent: 10<sup>0.48</sup> → 10^(0.48)
        sup.replaceWith('^(' + content + ')');
      }
    }

    // 4. Remaining <sub> elements (standalone subscripts, not part of fractions)
    clone.querySelectorAll('sub').forEach(sub => {
      const content = sub.textContent.trim();
      if (content) sub.replaceWith('_(' + content + ')');
      else sub.remove();
    });
  }

  /**
   * Walk a DOM node's text nodes and join with spaces.
   * Unlike textContent, this prevents adjacent elements from merging.
   */
  function walkTextNodes(node) {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const parts = [];
    while (walker.nextNode()) {
      const t = walker.currentNode.textContent.trim();
      if (t) parts.push(t);
    }
    return parts.join(' ')
      .replace(/\s+/g, ' ')
      .replace(/ \^/g, '^')      // no space before ^ (10 ^(0.48) → 10^(0.48))
      .replace(/ _\(/g, '_(')    // no space before _( (H _(2) → H_(2))
      .trim();
  }

  /**
   * Walk a DOM node's text nodes with math-aware extraction.
   * Converts fractions, exponents, subscripts before walking.
   */
  function getSpacedText(node) {
    const clone = node.cloneNode(true);
    convertMathNotation(clone);
    return walkTextNodes(clone);
  }

  /**
   * Strip leading question number prefix: "1.", "2)", "Q3:", "Question 1." etc.
   * Only strips if followed by a clear delimiter to avoid mangling numbers like "1.5 liters"
   */
  function stripQuestionNumber(text) {
    if (!text) return '';
    return text
      .replace(/^\s*(?:Q(?:uestion)?\.?\s*)?\d{1,4}\s*[\)\:]\s*/i, '')  // 1) or Q1: or Question 2:
      .replace(/^\s*(?:Q(?:uestion)?\.?\s*)?\d{1,4}\.\s+/i, '')          // 1. (dot + space, not 1.5)
      .trim();
  }

  function cleanContainerHTML(container) {
    const clone = container.cloneNode(true);

    // Remove non-content elements
    clone.querySelectorAll('script, style, noscript, iframe, link, meta').forEach(n => n.remove());

    // Remove img src attributes (images sent separately as base64)
    clone.querySelectorAll('img').forEach(img => {
      img.removeAttribute('src');
      img.removeAttribute('srcset');
      img.removeAttribute('loading');
    });

    // Strip noise attributes but keep semantic ones
    const keepAttrs = new Set([
      'type', 'name', 'value', 'role', 'for', 'id',
      'aria-label', 'aria-labelledby', 'aria-checked', 'aria-selected',
      'checked', 'selected', 'disabled', 'placeholder', 'href'
    ]);
    clone.querySelectorAll('*').forEach(el => {
      for (const attr of [...el.attributes]) {
        if (!keepAttrs.has(attr.name)) el.removeAttribute(attr.name);
      }
    });

    // Collapse whitespace and return
    let html = clone.innerHTML.replace(/\s+/g, ' ').trim();

    // Truncate if too large (safety valve — most questions are < 5KB)
    if (html.length > 15000) {
      html = html.substring(0, 15000) + '<!-- truncated -->';
    }

    return html;
  }

  function extractQuestionText(container) {
    // Strategy 1: Range API — extract all text from container start to first answer element
    // Walk text nodes with spaces to prevent element-boundary merging (e.g. "1.217")
    const firstAnswer = findFirstAnswerElement(container);
    if (firstAnswer) {
      try {
        const range = document.createRange();
        range.setStart(container, 0);
        range.setEndBefore(firstAnswer);
        const fragment = range.cloneContents();
        const text = stripQuestionNumber(getSpacedText(fragment));
        range.detach();
        if (text.length > 5) return text;
      } catch (e) {
        devWarn('Range extraction failed:', e.message);
      }
    }

    // Strategy 2: Clone container, remove answer-related elements, take remaining text
    // Keep labels (they often contain question text) — only remove input controls
    const clone = container.cloneNode(true);
    clone.querySelectorAll(
      'input, select, textarea, button, ' +
      '[role="radio"], [role="checkbox"], [role="option"], ' +
      '[data-answer], [data-option]'
    ).forEach(el => el.remove());
    const remaining = stripQuestionNumber(getSpacedText(clone));
    if (remaining.length > 5) return remaining;

    // Strategy 3: Full container text — no hard truncation
    return stripQuestionNumber(getSpacedText(container));
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

  function findDivBasedOptions(container) {
    // Check ul/ol > li items
    const lists = container.querySelectorAll('ul, ol');
    for (const list of lists) {
      const items = Array.from(list.querySelectorAll(':scope > li')).filter(li => isVisible(li));
      if (items.length >= 2 && items.length <= 10) {
        const nonEmpty = items.filter(item => {
          const t = item.textContent.trim();
          return t.length > 0 && t.length < 500;
        });
        if (nonEmpty.length >= 2) {
          const avgLen = nonEmpty.reduce((sum, item) => sum + item.textContent.trim().length, 0) / nonEmpty.length;
          if (avgLen < 300) {
            const options = [];
            items.forEach((item, index) => {
              const text = item.textContent.trim();
              if (text.length > 0 && text.length < 500) {
                options.push({
                  element: item, inputElement: item,
                  text: stripOptionIdentifier(text) || text,
                  value: text,
                  identifier: String.fromCharCode(65 + index),
                  isCustom: true
                });
              }
            });
            if (options.length >= 2) {
              devLog('Div options found via list items:', options.length);
              return options;
            }
          }
        }
      }
    }

    // Check data-answer/data-option/data-testid elements
    const dataOptions = container.querySelectorAll('[data-answer], [data-option], [data-testid*="answer"], [data-testid*="option"]');
    if (dataOptions.length >= 2 && dataOptions.length <= 10) {
      const options = [];
      dataOptions.forEach((opt, index) => {
        const text = opt.textContent.trim();
        if (text) {
          options.push({
            element: opt, inputElement: opt,
            text: stripOptionIdentifier(text) || text,
            value: opt.getAttribute('data-value') || text,
            identifier: String.fromCharCode(65 + index),
            isCustom: true
          });
        }
      });
      if (options.length >= 2) {
        devLog('Div options found via data attributes:', options.length);
        return options;
      }
    }

    // Find groups of same-tag siblings with short text
    const wrappers = [container, ...container.querySelectorAll('div, section, fieldset, form')];
    for (const parent of wrappers) {
      const children = Array.from(parent.children).filter(c => {
        if (!isVisible(c)) return false;
        const text = c.textContent.trim();
        return text.length > 0 && text.length < 300;
      });
      if (children.length >= 2 && children.length <= 10) {
        const tags = children.map(c => c.tagName);
        const sameTag = tags.every(t => t === tags[0]);
        if (sameTag) {
          const avgLen = children.reduce((sum, c) => sum + c.textContent.trim().length, 0) / children.length;
          if (avgLen < 300) {
            // Skip if it looks like navigation
            const looksLikeNav = children.every(c => c.querySelector('a') && c.textContent.trim().length < 20);
            if (!looksLikeNav) {
              const options = [];
              children.forEach((child, index) => {
                const text = child.textContent.trim();
                options.push({
                  element: child, inputElement: child,
                  text: stripOptionIdentifier(text) || text,
                  value: text,
                  identifier: String.fromCharCode(65 + index),
                  isCustom: true
                });
              });
              if (options.length >= 2) {
                devLog('Div options found via same-tag siblings:', options.length, 'tag:', tags[0]);
                return options;
              }
            }
          }
        }
      }
    }

    return null;
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
        const label = getOptionLabel(radio);
        const optionContainer = radio.closest('label, li, div.answer, [class*="option"], [class*="answer"], [class*="choice"]')
          || radio.closest('tr')
          || radio.parentElement;
        options.push({
          element: optionContainer,
          inputElement: radio,
          text: label || radio.value || `Option ${index + 1}`,
          value: radio.value,
          identifier: String.fromCharCode(65 + index)
        });
      });
      devLog('Options found via radio buttons:', options.length,
        'texts:', options.map(o => o.text.substring(0, 20)));
      return { type: isTrueFalse(options) ? 'TRUE_FALSE' : 'MULTIPLE_CHOICE', options };
    }

    // ---- Strategy 2: Checkboxes ----
    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    if (checkboxes.length >= 2) {
      const options = [];
      checkboxes.forEach((cb, index) => {
        const label = getOptionLabel(cb);
        const optionContainer = cb.closest('label, li, div.answer, [class*="option"], [class*="answer"], [class*="choice"]')
          || cb.closest('tr')
          || cb.parentElement;
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
        const label = getOptionLabel(select);
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

    // ---- Strategy 5: ARIA role-based options (before text inputs) ----
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

    // ---- Strategy 6: Universal div-based clickable options ----
    const divOptions = findDivBasedOptions(container);
    if (divOptions && divOptions.length >= 2) {
      return { type: isTrueFalse(divOptions) ? 'TRUE_FALSE' : 'MULTIPLE_CHOICE', options: divOptions };
    }

    // ---- Strategy 7: Text inputs (last resort before SHORT_ANSWER) ----
    const textInputs = container.querySelectorAll(
      'input[type="text"], input[type="number"], input:not([type]):not([role="combobox"]), textarea'
    );
    if (textInputs.length > 0) {
      const input = textInputs[0];
      devLog('Found text input/textarea for fill-in');
      return { type: input.tagName.toLowerCase() === 'textarea' ? 'ESSAY' : 'FILL_BLANK', options: [], inputElement: input };
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

    // NEW: Get cleaned HTML for AI — primary content source
    const containerHTML = cleanContainerHTML(container);

    let questionText = extractQuestionText(container);
    const optionData = extractOptionsAndType(container);
    const images = await extractImages(container);

    // Support image-based questions: if text is too short but images exist,
    // the question content is in the image(s)
    if ((!questionText || questionText.length < 3) && images.length === 0) {
      devWarn('Question text too short and no images found');
      return null;
    }

    if ((!questionText || questionText.length < 10) && images.length > 0) {
      questionText = (questionText || '').trim();
      questionText += (questionText ? ' ' : '') +
        '[The question is in the attached image(s). Analyze the image(s) to determine the question and select the correct answer.]';
      devLog('Image-based question detected, augmented text');
    }

    // Detect question subtype for accuracy enhancement
    const { refinedType, instructions } = detectQuestionSubtype(questionText, optionData.type);

    const platform = detectPlatform();
    const isNegation = refinedType === 'MCQ_NEGATIVE' || refinedType === 'MCQ_EXCEPT';

    devLog('Question extracted:', {
      type: optionData.type,
      refinedType,
      isNegation,
      platform,
      instructions: instructions ? instructions.substring(0, 50) : '(none)',
      textLength: questionText.length,
      options: optionData.options?.length || 0,
      matchItems: optionData.matchItems?.length || 0,
      images: images.length,
      questionPreview: questionText.substring(0, 300)
    });

    return {
      containerHTML,
      questionText,
      type: refinedType,
      baseType: optionData.type,
      isNegation,
      instructions,
      options: optionData.options.map(o => ({ text: o.text, identifier: o.identifier, value: o.value })),
      matchItems: optionData.matchItems?.map(m => ({ text: m.text, identifier: m.identifier, selectOptions: m.selectOptions })),
      images,
      platform,
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
    try { input.scrollIntoView({ block: 'nearest', behavior: 'instant' }); } catch (_) { }

    // Strategy 1: Focus + full event sequence on input
    try { input.focus(); } catch (_) { }
    dispatchFullClickSequence(input);

    // Strategy 2: Native .click() — handles jQuery, onclick attrs
    try { input.click(); } catch (_) { }

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
      try { label.click(); } catch (_) { }
      dispatchFullClickSequence(label);
    }

    // Strategy 5: Keyboard Space on focused input (browser native radio/checkbox toggle)
    try {
      input.focus();
      dispatchKeyboardSpace(input);
    } catch (_) { }

    // Verify after a short delay
    setTimeout(() => {
      if (!input.checked) {
        devWarn('Click verification FAILED — force-setting checked');
        input.checked = true;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        try { input.click(); } catch (_) { }
        // Try the container too
        const container = input.closest('li, div, label, [class*="option"], [class*="answer"]');
        if (container) {
          try { container.click(); } catch (_) { }
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
    try { element.scrollIntoView({ block: 'nearest', behavior: 'instant' }); } catch (_) { }

    // Strategy 1: Focus + full event sequence
    try { element.focus(); } catch (_) { }
    dispatchFullClickSequence(element);

    // Strategy 2: Native .click()
    try { element.click(); } catch (_) { }

    // Strategy 3: Keyboard activation
    try {
      element.focus();
      dispatchKeyboardEnter(element);
      dispatchKeyboardSpace(element);
    } catch (_) { }

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
          try { child.click(); } catch (_) { }
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
        try { parentLi.click(); } catch (_) { }
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

    // 1. Direct identifier match (A, B, C, D or 1, 2, 3, 4)
    for (const opt of options) {
      if (opt.identifier.toUpperCase() === upperAnswer) return opt;
      if (opt.identifier.toUpperCase() === strippedUpper) return opt;
    }

    // 2. First char match — only if answer is short (likely just the identifier)
    if (stripped.length <= 3) {
      const firstChar = strippedUpper.charAt(0);
      if (/^[A-Z0-9]$/.test(firstChar)) {
        for (const opt of options) {
          if (opt.identifier.toUpperCase() === firstChar) return opt;
        }
      }
    }

    // 3. Exact text match (case-insensitive)
    const lowerAnswer = cleanAnswer.toLowerCase();
    for (const opt of options) {
      if (opt.text.toLowerCase().trim() === lowerAnswer) return opt;
    }

    // 4. Extract identifier from verbose AI response
    // "The answer is C", "The correct option is B", "Option C is correct"
    const identifierPatterns = [
      /(?:answer|correct\s+(?:option|answer|choice)|option)\s+(?:is|:)\s*\(?([A-D])\)?/i,
      /\(?([A-D])\)?\s+is\s+(?:the\s+)?(?:correct|right|answer)/i,
      /^.*?(?:is|=|:)\s*\(?([A-D])\)?\.?\s*$/i,
    ];
    for (const pattern of identifierPatterns) {
      const match = cleanAnswer.match(pattern);
      if (match) {
        const letter = match[1].toUpperCase();
        for (const opt of options) {
          if (opt.identifier.toUpperCase() === letter) {
            devLog('Matched identifier from verbose answer:', letter);
            return opt;
          }
        }
      }
    }

    // 5. Extract numbers from verbose answer and match against option text
    // "The sum is 240" → match option with text "240"
    const numbers = cleanAnswer.match(/\b(\d+(?:\.\d+)?)\b/g);
    if (numbers) {
      for (const num of numbers) {
        for (const opt of options) {
          if (opt.text.trim() === num) {
            devLog('Matched number from verbose answer:', num);
            return opt;
          }
        }
      }
    }

    // 6. Partial text match (both directions, but require minimum length)
    for (const opt of options) {
      const optLower = opt.text.toLowerCase().trim();
      if (optLower.length > 1 && (optLower.includes(lowerAnswer) || lowerAnswer.includes(optLower))) {
        return opt;
      }
    }

    // 7. True/False specific
    const tfLower = lowerAnswer.replace(/[^a-z]/g, '');
    if (tfLower === 'true' || tfLower === 'false') {
      for (const opt of options) {
        if (opt.text.toLowerCase().trim() === tfLower) return opt;
      }
    }

    // 8. Word-level matching — check if any option text is a distinct word in the answer
    const answerWords = lowerAnswer.split(/[\s,;.!?()]+/).filter(w => w.length > 1);
    for (const opt of options) {
      const optLower = opt.text.toLowerCase().trim();
      if (optLower.length > 1 && answerWords.includes(optLower)) {
        devLog('Matched option via word-level:', optLower);
        return opt;
      }
    }

    // 9. Number extraction from both answer and options for numerical matching
    if (numbers && numbers.length > 0) {
      for (const opt of options) {
        const optNumbers = opt.text.match(/\b(\d+(?:\.\d+)?)\b/g);
        if (optNumbers) {
          for (const num of numbers) {
            if (optNumbers.includes(num)) {
              devLog('Matched via numerical overlap:', num);
              return opt;
            }
          }
        }
      }
    }

    // 10. Fuzzy match: normalize both strings, remove punctuation/articles, compare
    const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\b(a|an|the|is|are|was|were)\b/g, '').replace(/\s+/g, ' ').trim();
    const normalizedAnswer = normalize(cleanAnswer);
    if (normalizedAnswer.length > 3) {
      let bestScore = 0;
      let bestOpt = null;
      for (const opt of options) {
        const normalizedOpt = normalize(opt.text);
        if (normalizedOpt.length === 0) continue;
        // Check substring containment after normalization
        if (normalizedOpt === normalizedAnswer) {
          devLog('Matched via normalized exact:', opt.text.substring(0, 30));
          return opt;
        }
        // Jaccard similarity on words
        const answerWordSet = new Set(normalizedAnswer.split(' ').filter(w => w.length > 1));
        const optWordSet = new Set(normalizedOpt.split(' ').filter(w => w.length > 1));
        const intersection = [...answerWordSet].filter(w => optWordSet.has(w)).length;
        const union = new Set([...answerWordSet, ...optWordSet]).size;
        const similarity = union > 0 ? intersection / union : 0;
        if (similarity > bestScore && similarity >= 0.5) {
          bestScore = similarity;
          bestOpt = opt;
        }
      }
      if (bestOpt) {
        devLog('Matched via fuzzy similarity:', bestScore.toFixed(2), bestOpt.text.substring(0, 30));
        return bestOpt;
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
    element.style.outline = '2px solid rgba(45, 212, 191, 0.4)';
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
      navigator.clipboard.writeText(answer).catch(() => { });
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
          navigator.clipboard.writeText(answer).catch(() => { });
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
          navigator.clipboard.writeText(answer).catch(() => { });
        }
        break;
      }

      case 'MATCHING': {
        if (!matchItems || matchItems.length === 0) {
          devWarn('No match items for MATCHING type');
          navigator.clipboard.writeText(answer).catch(() => { });
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
              navigator.clipboard.writeText(answer).catch(() => { });
              devLog('No input found, copied to clipboard');
            }
          } else {
            navigator.clipboard.writeText(answer).catch(() => { });
          }
        } else {
          navigator.clipboard.writeText(answer).catch(() => { });
        }
        break;
      }

      default:
        devWarn('Unknown question type:', type);
        navigator.clipboard.writeText(answer).catch(() => { });
    }
  }

  // ============================================================
  // EXPLANATION MODAL (Dev-Only)
  // Shift+Double-click shows answer with step-by-step explanation
  // ============================================================

  let explanationModalElement = null;

  function injectExplanationStyles() {
    if (document.getElementById('qs-explanation-styles')) return;
    const style = document.createElement('style');
    style.id = 'qs-explanation-styles';
    style.textContent = `
      .qs-modal-overlay {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        display: flex;
        align-items: center;
        justify-content: center;
        background: transparent;
      }
      .qs-modal {
        background: #fff;
        border-radius: 14px;
        border: 2px solid #2DD4BF;
        box-shadow: 0 25px 60px -12px rgba(0,0,0,0.3), 0 0 0 1px rgba(45, 212, 191, 0.3);
        max-width: 380px;
        width: 92vw;
        max-height: 70vh;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        transform: scale(0.95) translateY(10px);
        transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      }
      .qs-modal.qs-modal-md { max-width: 480px; max-height: 78vh; }
      .qs-modal.qs-modal-lg { max-width: 640px; max-height: 85vh; }
      .qs-modal-overlay.qs-visible .qs-modal {
        transform: scale(1) translateY(0);
      }
      .qs-modal.qs-dragged {
        transform: none !important;
        transition: none !important;
      }
      .qs-modal-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 14px 18px 12px;
        border-bottom: 1px solid #f0f0f0;
        cursor: grab;
        user-select: none;
      }
      .qs-modal-header.qs-dragging { cursor: grabbing; }
      .qs-modal-title {
        font-size: 16px;
        font-weight: 600;
        color: #111;
        margin: 0;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .qs-modal-badge {
        background: linear-gradient(135deg, #EEF2FF, #E0E7FF);
        color: #4338CA;
        font-size: 10px;
        font-weight: 700;
        padding: 3px 8px;
        border-radius: 100px;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      .qs-modal-close {
        width: 32px; height: 32px;
        border: none;
        background: transparent;
        border-radius: 8px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #999;
        transition: all 0.15s ease;
        font-size: 20px;
        line-height: 1;
      }
      .qs-modal-close:hover { background: #f5f5f5; color: #333; }
      .qs-modal-body {
        padding: 14px 18px;
        overflow-y: auto;
        flex: 1;
      }
      .qs-modal-section { margin-bottom: 12px; }
      .qs-modal-section:last-child { margin-bottom: 0; }
      .qs-modal-label {
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: #999;
        margin-bottom: 4px;
      }
      .qs-modal-question {
        font-size: 13px;
        color: #333;
        line-height: 1.5;
        background: #FAFAFA;
        padding: 10px 14px;
        border-radius: 8px;
        border: 1px solid #f0f0f0;
        max-height: 100px;
        overflow-y: auto;
      }
      .qs-modal-answer-box {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 14px 16px;
        background: linear-gradient(135deg, #ECFDF5, #F0FDF4);
        border-radius: 10px;
        border: 1px solid #BBF7D0;
      }
      .qs-modal-answer-letter {
        font-size: 24px;
        font-weight: 800;
        color: #059669;
        min-width: 36px;
        height: 36px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: #fff;
        border-radius: 8px;
        border: 2px solid #059669;
      }
      .qs-modal-answer-text {
        font-size: 15px;
        font-weight: 600;
        color: #065F46;
        flex: 1;
      }
      .qs-modal-explanation {
        font-size: 14px;
        color: #374151;
        line-height: 1.75;
        padding: 14px 16px;
        background: #F8FAFC;
        border-radius: 10px;
        border: 1px solid #E2E8F0;
      }
      .qs-modal-explanation p { margin: 0 0 8px 0; }
      .qs-modal-explanation p:last-child { margin-bottom: 0; }
      .qs-modal-explanation strong { color: #111827; }
      .qs-modal-explanation ol, .qs-modal-explanation ul {
        margin: 6px 0;
        padding-left: 20px;
      }
      .qs-modal-explanation li {
        margin-bottom: 4px;
      }
      .qs-modal-footer {
        display: flex;
        gap: 8px;
        padding: 12px 18px 14px;
        border-top: 1px solid #f0f0f0;
      }
      .qs-modal-btn {
        flex: 1;
        padding: 8px 14px;
        border-radius: 8px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.15s ease;
        border: none;
        text-align: center;
      }
      .qs-modal-btn-primary {
        background: #4F46E5;
        color: white;
      }
      .qs-modal-btn-primary:hover { background: #4338CA; }
      .qs-modal-btn-secondary {
        background: #F3F4F6;
        color: #374151;
      }
      .qs-modal-btn-secondary:hover { background: #E5E7EB; }
      .qs-loading-container {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 12px;
        padding: 32px 16px;
      }
      .qs-loading-dots {
        display: flex;
        gap: 6px;
      }
      .qs-loading-dots span {
        width: 8px; height: 8px;
        border-radius: 50%;
        background: #4F46E5;
        animation: qs-bounce 1.4s infinite ease-in-out both;
      }
      .qs-loading-dots span:nth-child(1) { animation-delay: -0.32s; }
      .qs-loading-dots span:nth-child(2) { animation-delay: -0.16s; }
      .qs-loading-dots span:nth-child(3) { animation-delay: 0; }
      @keyframes qs-bounce {
        0%, 80%, 100% { transform: scale(0); }
        40% { transform: scale(1.0); }
      }
      .qs-loading-text {
        font-size: 13px;
        color: #888;
      }
      .qs-modal-error {
        color: #DC2626;
        background: #FEF2F2;
        border: 1px solid #FECACA;
        padding: 12px 16px;
        border-radius: 10px;
        font-size: 13px;
      }
    `;
    document.head.appendChild(style);
  }

  function escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function showExplanationModal(questionText) {
    injectExplanationStyles();

    if (explanationModalElement) explanationModalElement.remove();

    const sizeClass = modalSize === 'large' ? 'qs-modal-lg' : modalSize === 'medium' ? 'qs-modal-md' : '';
    const overlay = document.createElement('div');
    overlay.className = 'qs-modal-overlay';
    overlay.innerHTML = `
      <div class="qs-modal ${sizeClass}">
        <div class="qs-modal-header">
          <div class="qs-modal-title">
            Explanation
            <span class="qs-modal-badge">AI</span>
          </div>
          <button class="qs-modal-close" data-qs-close>&times;</button>
        </div>
        <div class="qs-modal-body">
          <div class="qs-modal-section">
            <div class="qs-modal-label">Question</div>
            <div class="qs-modal-question">${escapeHTML(questionText.substring(0, 500))}</div>
          </div>
          <div class="qs-modal-section" id="qs-answer-section" style="display:none">
            <div class="qs-modal-label">Answer</div>
            <div class="qs-modal-answer-box">
              <div class="qs-modal-answer-letter" id="qs-answer-letter"></div>
              <div class="qs-modal-answer-text" id="qs-answer-text"></div>
            </div>
          </div>
          <div class="qs-modal-section" id="qs-explanation-section">
            <div class="qs-modal-label">Explanation</div>
            <div class="qs-loading-container" id="qs-loading">
              <div class="qs-loading-dots"><span></span><span></span><span></span></div>
              <div class="qs-loading-text">Analyzing question...</div>
            </div>
            <div class="qs-modal-explanation" id="qs-explanation-text" style="display:none"></div>
            <div class="qs-modal-error" id="qs-explanation-error" style="display:none"></div>
          </div>
        </div>
        <div class="qs-modal-footer">
          <button class="qs-modal-btn qs-modal-btn-secondary" data-qs-close>Close</button>
          <button class="qs-modal-btn qs-modal-btn-primary" id="qs-apply-btn" style="display:none">Apply Answer</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    explanationModalElement = overlay;

    requestAnimationFrame(() => overlay.classList.add('qs-visible'));

    // Close handlers
    overlay.querySelectorAll('[data-qs-close]').forEach(btn => {
      btn.addEventListener('click', () => hideExplanationModal());
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) hideExplanationModal();
    });

    makeModalDraggable(overlay);
    return overlay;
  }

  function makeModalDraggable(overlay) {
    const modal = overlay.querySelector('.qs-modal');
    const header = overlay.querySelector('.qs-modal-header');
    if (!modal || !header) return;

    let isDragging = false;
    let startX, startY, startLeft, startTop;

    header.addEventListener('mousedown', (e) => {
      if (e.target.closest('.qs-modal-close')) return;
      isDragging = true;
      header.classList.add('qs-dragging');

      const rect = modal.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      startLeft = rect.left;
      startTop = rect.top;

      modal.classList.add('qs-dragged');
      modal.style.position = 'fixed';
      modal.style.left = startLeft + 'px';
      modal.style.top = startTop + 'px';
      modal.style.margin = '0';
      overlay.style.alignItems = 'flex-start';
      overlay.style.justifyContent = 'flex-start';

      e.preventDefault();
    });

    const onMove = (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      modal.style.left = Math.max(0, Math.min(window.innerWidth - 100, startLeft + dx)) + 'px';
      modal.style.top = Math.max(0, Math.min(window.innerHeight - 50, startTop + dy)) + 'px';
    };

    const onUp = () => {
      if (isDragging) {
        isDragging = false;
        header.classList.remove('qs-dragging');
      }
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function formatExplanationText(text) {
    // Convert simple markdown to HTML
    let html = escapeHTML(text);

    // Bold: **text**
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    // Numbered lists: lines starting with "1. ", "2. " etc.
    html = html.replace(/^(\d+)\.\s+(.+)$/gm, '<li value="$1">$2</li>');
    html = html.replace(/((?:<li[^>]*>.*<\/li>\s*)+)/g, '<ol>$1</ol>');

    // Bullet lists: lines starting with "- "
    html = html.replace(/^-\s+(.+)$/gm, '<li>$1</li>');
    html = html.replace(/((?:<li>.*<\/li>\s*)+)/g, (match) => {
      // Only wrap in <ul> if not already inside <ol>
      if (match.includes('value=')) return match;
      return '<ul>' + match + '</ul>';
    });

    // Line breaks for remaining newlines (but not inside lists)
    html = html.replace(/\n{2,}/g, '</p><p>');
    html = html.replace(/\n/g, '<br>');

    // Wrap in paragraph
    html = '<p>' + html + '</p>';

    // Clean up empty paragraphs
    html = html.replace(/<p>\s*<\/p>/g, '');

    return html;
  }

  function updateExplanationModal(answer, explanation, domRefs, options) {
    if (!explanationModalElement) return;

    const answerSection = explanationModalElement.querySelector('#qs-answer-section');
    const answerLetter = explanationModalElement.querySelector('#qs-answer-letter');
    const answerText = explanationModalElement.querySelector('#qs-answer-text');
    const loading = explanationModalElement.querySelector('#qs-loading');
    const explanationText = explanationModalElement.querySelector('#qs-explanation-text');
    const applyBtn = explanationModalElement.querySelector('#qs-apply-btn');

    if (loading) loading.style.display = 'none';

    // Show answer section only when answer is provided (Solve mode)
    if (answer && answerSection && answerLetter) {
      let displayLetter = answer;
      let displayText = '';
      if (options && options.length > 0) {
        const matched = findMatchingOption(options.map(o => ({ text: o.text, identifier: o.identifier, value: o.value })), answer);
        if (matched) {
          displayLetter = matched.identifier;
          displayText = matched.text;
        }
      }
      answerLetter.textContent = displayLetter.length <= 2 ? displayLetter : displayLetter.charAt(0);
      answerText.textContent = displayText || answer;
      answerSection.style.display = '';
    }

    if (explanationText && explanation) {
      explanationText.innerHTML = formatExplanationText(explanation);
      explanationText.style.display = '';
    }

    // Show Apply button only when there's an answer to apply
    if (applyBtn && domRefs && answer) {
      applyBtn.style.display = '';
      applyBtn.addEventListener('click', () => {
        applyAnswer(domRefs, answer);
        hideExplanationModal();
      });
    }
  }

  function showExplanationError(errorMsg) {
    if (!explanationModalElement) return;
    const loading = explanationModalElement.querySelector('#qs-loading');
    const errorEl = explanationModalElement.querySelector('#qs-explanation-error');
    if (loading) loading.style.display = 'none';
    if (errorEl) {
      errorEl.textContent = errorMsg;
      errorEl.style.display = '';
    }
  }

  function hideExplanationModal() {
    if (!explanationModalElement) return;
    explanationModalElement.classList.remove('qs-visible');
    setTimeout(() => {
      explanationModalElement?.remove();
      explanationModalElement = null;
    }, 200);
  }

  // ============================================================
  // SELECTION TOOLBAR (Highlight → Solve / Explain / Rephrase)
  // ============================================================

  let selToolbar = null;
  let selTimeout = null;

  function injectSelToolbarStyles() {
    if (document.getElementById('qs-sel-styles')) return;
    const s = document.createElement('style');
    s.id = 'qs-sel-styles';
    s.textContent = `
      .qs-sel-toolbar {
        position: fixed;
        z-index: 2147483646;
        display: flex;
        align-items: center;
        gap: 1px;
        padding: 3px;
        background: #1a1a2e;
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 10px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.35), 0 0 0 1px rgba(0,0,0,0.1);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        opacity: 0;
        transform: translateY(4px);
        transition: opacity 0.15s ease, transform 0.15s ease;
        pointer-events: none;
      }
      .qs-sel-toolbar.qs-visible {
        opacity: 1;
        transform: translateY(0);
        pointer-events: auto;
      }
      .qs-sel-btn {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 5px 10px;
        border: none;
        background: transparent;
        color: #b0b0c0;
        font-size: 11px;
        font-weight: 500;
        cursor: pointer;
        border-radius: 7px;
        transition: all 0.1s ease;
        white-space: nowrap;
      }
      .qs-sel-btn:hover {
        background: rgba(255,255,255,0.08);
        color: #fff;
      }
      .qs-sel-btn svg { width: 13px; height: 13px; }
      .qs-sel-div {
        width: 1px;
        height: 14px;
        background: rgba(255,255,255,0.08);
      }
    `;
    document.head.appendChild(s);
  }

  function showSelToolbar(text, rect) {
    injectSelToolbarStyles();
    hideSelToolbar();

    const tb = document.createElement('div');
    tb.className = 'qs-sel-toolbar';

    const btns = [];
    if (featureHighlight) {
      btns.push(`<button class="qs-sel-btn" data-action="solve"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg>Solve</button>`);
      btns.push(`<span class="qs-sel-div"></span>`);
      btns.push(`<button class="qs-sel-btn" data-action="explain"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>Explain</button>`);
    }
    if (featureRephrase) {
      if (btns.length > 0) btns.push(`<span class="qs-sel-div"></span>`);
      btns.push(`<button class="qs-sel-btn" data-action="rephrase"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>Rephrase</button>`);
    }
    if (btns.length === 0) return;

    tb.innerHTML = btns.join('');

    // Position above selection
    let top = rect.top - 42 + window.scrollY;
    let left = rect.left + rect.width / 2;
    if (top < 10) top = rect.bottom + 8 + window.scrollY;

    tb.style.top = (top - window.scrollY) + 'px';
    tb.style.left = left + 'px';
    tb.style.transform = 'translateX(-50%) translateY(4px)';

    // Clamp to viewport
    document.body.appendChild(tb);
    const tbRect = tb.getBoundingClientRect();
    if (tbRect.right > window.innerWidth - 8) {
      tb.style.left = (window.innerWidth - tbRect.width - 8) + 'px';
      tb.style.transform = 'translateY(4px)';
    }
    if (tbRect.left < 8) {
      tb.style.left = '8px';
      tb.style.transform = 'translateY(4px)';
    }

    selToolbar = tb;
    requestAnimationFrame(() => {
      tb.classList.add('qs-visible');
      tb.style.transform = tb.style.transform.replace('translateY(4px)', 'translateY(0)');
    });

    // Button handlers
    tb.addEventListener('click', async (evt) => {
      const action = evt.target.closest('[data-action]')?.dataset.action;
      if (!action) return;
      hideSelToolbar();
      await handleSelAction(action, text);
    });
  }

  function hideSelToolbar() {
    if (selToolbar) {
      selToolbar.remove();
      selToolbar = null;
    }
  }

  async function handleSelAction(action, text) {
    if (processing) return;
    processing = true;
    devLog('Selection action:', action, 'text:', text.substring(0, 60));

    try {
      if (action === 'rephrase') {
        const modal = showRephraseModal(text);
        try {
          const result = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(
              { type: 'PROCESS_REPHRASE', data: { text } },
              (resp) => {
                if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
                if (resp.success) resolve(resp.result);
                else reject(new Error(resp.error));
              }
            );
          });
          updateRephraseModal(result);
        } catch (err) {
          showRephraseError(err.message);
        }
      } else {
        // Solve or Explain — try to find question context near the selection
        const sel = window.getSelection();
        const anchor = sel?.anchorNode?.parentElement || document.body;
        const context = await extractQuestionContext(anchor);
        const msgType = action === 'solve' ? 'PROCESS_SOLVE' : 'PROCESS_EXPLANATION';

        if (!context) {
          // Fallback: treat selected text as the question directly
          const fallbackContext = {
            questionText: text,
            type: 'SHORT_ANSWER',
            baseType: 'SHORT_ANSWER',
            isNegation: false,
            instructions: '',
            options: [],
            images: [],
            platform: detectPlatform(),
          };

          const modal = showExplanationModal(text);
          if (!modal) { processing = false; return; }
          try {
            const resp = await new Promise((resolve, reject) => {
              chrome.runtime.sendMessage(
                { type: msgType, data: fallbackContext },
                (r) => {
                  if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
                  if (r.success) resolve(r);
                  else reject(new Error(r.error));
                }
              );
            });
            updateExplanationModal(resp.answer, resp.explanation, null, []);
          } catch (err) { showExplanationError(err.message); }
        } else {
          const domRefs = context._domRefs;
          delete context._domRefs;

          const modal = showExplanationModal(context.questionText);
          if (!modal) { processing = false; return; }
          try {
            const resp = await new Promise((resolve, reject) => {
              chrome.runtime.sendMessage(
                { type: msgType, data: context },
                (r) => {
                  if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
                  if (r.success) resolve(r);
                  else reject(new Error(r.error));
                }
              );
            });
            updateExplanationModal(resp.answer, resp.explanation, domRefs, context.options);
          } catch (err) { showExplanationError(err.message); }
        }
      }
    } catch (err) {
      devError('Selection action error:', err.message);
    } finally {
      processing = false;
    }
  }

  // Rephrase modal (reuses base modal styles)
  function showRephraseModal(originalText) {
    injectExplanationStyles();
    if (explanationModalElement) explanationModalElement.remove();

    const sizeClass = modalSize === 'large' ? 'qs-modal-lg' : modalSize === 'medium' ? 'qs-modal-md' : '';
    const overlay = document.createElement('div');
    overlay.className = 'qs-modal-overlay';
    overlay.innerHTML = `
      <div class="qs-modal ${sizeClass}">
        <div class="qs-modal-header">
          <div class="qs-modal-title">Rephrase <span class="qs-modal-badge">AI</span></div>
          <button class="qs-modal-close" data-qs-close>&times;</button>
        </div>
        <div class="qs-modal-body">
          <div class="qs-modal-section">
            <div class="qs-modal-label">Original</div>
            <div class="qs-modal-question">${escapeHTML(originalText.substring(0, 500))}</div>
          </div>
          <div class="qs-modal-section">
            <div class="qs-modal-label">Rephrased</div>
            <div class="qs-loading-container" id="qs-loading">
              <div class="qs-loading-dots"><span></span><span></span><span></span></div>
              <div class="qs-loading-text">Rephrasing...</div>
            </div>
            <div class="qs-modal-explanation" id="qs-rephrase-result" style="display:none"></div>
            <div class="qs-modal-error" id="qs-rephrase-error" style="display:none"></div>
          </div>
        </div>
        <div class="qs-modal-footer">
          <button class="qs-modal-btn qs-modal-btn-secondary" data-qs-close>Close</button>
          <button class="qs-modal-btn qs-modal-btn-primary" id="qs-copy-btn" style="display:none">Copy</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    explanationModalElement = overlay;
    requestAnimationFrame(() => overlay.classList.add('qs-visible'));
    overlay.querySelectorAll('[data-qs-close]').forEach(b => b.addEventListener('click', hideExplanationModal));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) hideExplanationModal(); });
    makeModalDraggable(overlay);
    return overlay;
  }

  function updateRephraseModal(result) {
    if (!explanationModalElement) return;
    const loading = explanationModalElement.querySelector('#qs-loading');
    const resultEl = explanationModalElement.querySelector('#qs-rephrase-result');
    const copyBtn = explanationModalElement.querySelector('#qs-copy-btn');
    if (loading) loading.style.display = 'none';
    if (resultEl) { resultEl.textContent = result; resultEl.style.display = ''; }
    if (copyBtn) {
      copyBtn.style.display = '';
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(result).catch(() => { });
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
      });
    }
  }

  function showRephraseError(msg) {
    if (!explanationModalElement) return;
    const loading = explanationModalElement.querySelector('#qs-loading');
    const errEl = explanationModalElement.querySelector('#qs-rephrase-error');
    if (loading) loading.style.display = 'none';
    if (errEl) { errEl.textContent = msg; errEl.style.display = ''; }
  }

  // Selection listeners
  document.addEventListener('mouseup', (e) => {
    if (!isActive) return;
    if (!featureHighlight && !featureRephrase) return;
    if (e.target.closest('.qs-modal-overlay, .qs-sel-toolbar, .qs-draw-overlay')) return;

    clearTimeout(selTimeout);
    selTimeout = setTimeout(() => {
      const sel = window.getSelection();
      const text = sel?.toString()?.trim();
      if (!text || text.length < 3) { hideSelToolbar(); return; }
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (rect.width > 0) showSelToolbar(text, rect);
    }, 300);
  });

  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('.qs-sel-toolbar')) hideSelToolbar();
  });

  // ============================================================
  // DRAW REGION (Rectangle capture → Solve)
  // ============================================================

  let drawOverlay = null;

  function injectDrawStyles() {
    if (document.getElementById('qs-draw-styles')) return;
    const s = document.createElement('style');
    s.id = 'qs-draw-styles';
    s.textContent = `
      .qs-draw-overlay {
        position: fixed;
        top: 0; left: 0; right: 0; bottom: 0;
        z-index: 2147483646;
        cursor: crosshair;
        background: rgba(0,0,0,0.12);
        transition: background 0.15s ease;
      }
      .qs-draw-rect {
        position: fixed;
        border: 2px solid #4F46E5;
        background: rgba(79, 70, 229, 0.06);
        border-radius: 3px;
        pointer-events: none;
        z-index: 2147483647;
      }
      .qs-draw-hint {
        position: fixed;
        bottom: 24px;
        left: 50%;
        transform: translateX(-50%);
        padding: 8px 16px;
        background: #1a1a2e;
        color: #e0e0e0;
        font-size: 12px;
        border-radius: 8px;
        z-index: 2147483647;
        font-family: -apple-system, sans-serif;
        box-shadow: 0 4px 20px rgba(0,0,0,0.3);
        pointer-events: none;
      }
      .qs-draw-hint kbd {
        display: inline-block;
        padding: 1px 5px;
        background: rgba(255,255,255,0.1);
        border-radius: 3px;
        font-size: 11px;
        font-family: monospace;
        margin: 0 2px;
      }
    `;
    document.head.appendChild(s);
  }

  function startDrawRegion() {
    if (!featureDrawRegion || drawOverlay) return;
    injectDrawStyles();
    devLog('Draw region started');

    const overlay = document.createElement('div');
    overlay.className = 'qs-draw-overlay';

    const hint = document.createElement('div');
    hint.className = 'qs-draw-hint';
    hint.innerHTML = 'Click and drag to select a region. Press <kbd>Esc</kbd> to cancel.';

    const rectEl = document.createElement('div');
    rectEl.className = 'qs-draw-rect';
    rectEl.style.display = 'none';

    document.body.appendChild(overlay);
    document.body.appendChild(hint);
    document.body.appendChild(rectEl);
    drawOverlay = overlay;

    let startX = 0, startY = 0, drawing = false;

    const onDown = (e) => {
      startX = e.clientX;
      startY = e.clientY;
      drawing = true;
      rectEl.style.display = 'block';
      rectEl.style.left = startX + 'px';
      rectEl.style.top = startY + 'px';
      rectEl.style.width = '0';
      rectEl.style.height = '0';
    };

    const onMove = (e) => {
      if (!drawing) return;
      const x = Math.min(startX, e.clientX);
      const y = Math.min(startY, e.clientY);
      const w = Math.abs(e.clientX - startX);
      const h = Math.abs(e.clientY - startY);
      rectEl.style.left = x + 'px';
      rectEl.style.top = y + 'px';
      rectEl.style.width = w + 'px';
      rectEl.style.height = h + 'px';
    };

    const cleanup = () => {
      overlay.remove();
      hint.remove();
      rectEl.remove();
      drawOverlay = null;
      document.removeEventListener('keydown', onKey);
    };

    const onUp = async (e) => {
      if (!drawing) return;
      drawing = false;
      const x = Math.min(startX, e.clientX);
      const y = Math.min(startY, e.clientY);
      const w = Math.abs(e.clientX - startX);
      const h = Math.abs(e.clientY - startY);
      cleanup();

      if (w < 20 || h < 20) return; // Too small
      await captureAndProcess({ x, y, width: w, height: h });
    };

    const onKey = (e) => {
      if (e.key === 'Escape') cleanup();
    };

    overlay.addEventListener('mousedown', onDown);
    document.addEventListener('mousemove', onMove);
    overlay.addEventListener('mouseup', onUp);
    document.addEventListener('keydown', onKey);
  }

  // ============================================================
  // SNAP IT (Screen capture → Solve)
  // ============================================================

  async function snapIt() {
    if (!featureSnapIt) return;
    devLog('Snap it triggered');
    await captureAndProcess(null); // null = full viewport
  }

  async function captureAndProcess(region) {
    if (processing) return;
    processing = true;

    // Show loading modal immediately
    const modal = showExplanationModal(region
      ? 'Analyzing selected region...'
      : 'Analyzing screen capture...');
    if (!modal) { processing = false; return; }

    try {
      // Request screenshot from background
      const screenshot = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: 'CAPTURE_TAB' }, (resp) => {
          if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
          if (resp?.success) resolve(resp.dataUrl);
          else reject(new Error(resp?.error || 'Capture failed'));
        });
      });

      // Crop if region specified
      let imageData;
      if (region) {
        const dpr = window.devicePixelRatio || 1;
        imageData = await cropImage(screenshot, {
          x: region.x * dpr,
          y: region.y * dpr,
          width: region.width * dpr,
          height: region.height * dpr,
        });
      } else {
        // Use full screenshot
        const base64 = screenshot.split(',')[1];
        const mimeType = screenshot.split(';')[0].split(':')[1];
        imageData = { data: base64, mimeType };
      }

      // Send to AI for explanation
      const context = {
        questionText: '[The question is in the attached image. Analyze the image to determine the question, identify the options if any, and provide the correct answer.]',
        type: 'MULTIPLE_CHOICE',
        baseType: 'MULTIPLE_CHOICE',
        isNegation: false,
        instructions: '',
        options: [],
        images: [imageData],
        platform: detectPlatform(),
      };

      const resp = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          { type: 'PROCESS_SOLVE', data: context },
          (r) => {
            if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
            if (r.success) resolve(r);
            else reject(new Error(r.error));
          }
        );
      });

      updateExplanationModal(resp.answer, resp.explanation, null, []);
    } catch (err) {
      devError('Capture error:', err.message);
      showExplanationError('Capture failed: ' + err.message);
    } finally {
      processing = false;
    }
  }

  function cropImage(dataUrl, region) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = Math.min(region.width, img.width - region.x);
        canvas.height = Math.min(region.height, img.height - region.y);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, region.x, region.y, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
        const cropped = canvas.toDataURL('image/png');
        resolve({
          data: cropped.split(',')[1],
          mimeType: 'image/png'
        });
      };
      img.onerror = () => reject(new Error('Failed to load screenshot'));
      img.src = dataUrl;
    });
  }

  // ============================================================
  // KEYBOARD SHORTCUTS (Draw/Snap + Escape)
  // ============================================================

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (explanationModalElement) hideExplanationModal();
      if (drawOverlay) { drawOverlay.remove(); drawOverlay = null; }
      return;
    }

    // Check for Ctrl (Win/Linux) or Cmd (Mac)
    const modKey = e.ctrlKey || e.metaKey;

    // Ctrl/Cmd+Shift+D → Draw region (works when feature is enabled, independent of isActive)
    if (modKey && e.shiftKey && e.key === 'D') {
      if (featureDrawRegion) {
        e.preventDefault();
        startDrawRegion();
      }
      return;
    }

    // Ctrl/Cmd+Shift+S → Snap it (works when feature is enabled, independent of isActive)
    if (modKey && e.shiftKey && e.key === 'S') {
      if (featureSnapIt) {
        e.preventDefault();
        snapIt();
      }
      return;
    }

    if (!isActive) return;
  });

  // ============================================================
  // DOUBLE-CLICK HANDLER
  // ============================================================

  /**
   * Smart target resolution: find the best element to use as question anchor.
   * Tries: (1) direct click target, (2) the selected text's parent, (3) element at click position,
   * (4) nearest question container by proximity.
   */
  function resolveClickTarget(e, selInfo) {
    // Use selection anchor if available (user highlighted text near the question)
    if (selInfo && selInfo.anchor && selInfo.anchor !== document.body) {
      devLog('Using selection anchor as target:', selInfo.anchor.tagName);
      return selInfo.anchor;
    }
    return e.target;
  }

  document.addEventListener('dblclick', async (e) => {
    if (!isActive || !featureDblClickSolve || processing) return;

    // 1d. Debounce — reject clicks within 300ms
    const now = Date.now();
    if (now - lastDblClickTime < 300) {
      devLog('Debounced double-click (too fast)');
      return;
    }
    lastDblClickTime = now;

    // 1g. Offline detection
    if (!navigator.onLine) {
      showToast('You are offline. Check your internet connection.', 'error', 4000);
      return;
    }

    const isExplainMode = e.shiftKey;

    devLog('--- DOUBLE-CLICK ---', isExplainMode ? '(EXPLAIN MODE)' : '');
    devLog('Target:', e.target.tagName,
      'class:', e.target.className?.toString()?.substring(0, 60),
      'id:', e.target.id?.substring(0, 30),
      'at:', Math.round(e.clientX) + ',' + Math.round(e.clientY));

    // 1e. Capture selection info before clearing
    const sel = window.getSelection();
    const selInfo = sel && sel.rangeCount > 0 && sel.toString().trim().length > 0
      ? { anchor: sel.anchorNode?.nodeType === Node.TEXT_NODE ? sel.anchorNode.parentElement : sel.anchorNode, text: sel.toString().trim() }
      : null;
    // Clear text selection caused by double-click
    try { sel?.removeAllRanges(); } catch (_) {}

    processing = true;
    const startTime = Date.now();
    let loadingToast = null;
    let processingContainer = null;

    try {
      // Smart target resolution (pass selInfo)
      const resolvedTarget = resolveClickTarget(e, selInfo);
      if (resolvedTarget !== e.target) {
        devLog('Resolved target:', resolvedTarget.tagName,
          'class:', resolvedTarget.className?.toString()?.substring(0, 40));
      }

      const context = await extractQuestionContext(resolvedTarget);
      if (!context) {
        devWarn('No question context found — took', Date.now() - startTime, 'ms');
        showToast('No question detected. Try clicking directly on a question.', 'error', 3000);
        processing = false;
        return;
      }

      const domRefs = context._domRefs;
      delete context._domRefs;

      // 1b. Loading indicator on question container (only when notifications enabled)
      processingContainer = domRefs.container;
      if (processingContainer && featureNotifications) {
        processingContainer.classList.add('qs-processing');
      }

      // 1f. Loading toast
      const requestTimeout = 35000;
      loadingToast = showToast('Processing question...', 'loading');

      devLog('Sending to AI:', context.type,
        'options:', context.options?.length || 0,
        'images:', context.images?.length || 0,
        'question:', context.questionText?.substring(0, 80));

      if (isExplainMode) {
        // --- Explanation Mode: show modal with answer + explanation ---
        if (loadingToast) loadingToast.dismiss();
        loadingToast = null;
        const modal = showExplanationModal(context.questionText);
        if (!modal) {
          processing = false;
          return;
        }

        try {
          // 1c. Timeout wrapper
          const response = await withTimeout(
            new Promise((resolve, reject) => {
              chrome.runtime.sendMessage(
                { type: 'PROCESS_EXPLANATION', data: context },
                (resp) => {
                  if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
                  if (resp.success) resolve(resp);
                  else reject(new Error(resp.error));
                }
              );
            }),
            requestTimeout,
            `Request timed out after ${requestTimeout / 1000} seconds. Please try again.`
          );

          devLog('Explanation received — total time:', Date.now() - startTime, 'ms');
          updateExplanationModal(response.answer, response.explanation, domRefs, context.options);
        } catch (err) {
          devError('Explanation error:', err.message);
          showExplanationError('Failed to get explanation: ' + err.message);
        }
      } else {
        // --- Normal Mode: auto-answer ---
        // 1c. Timeout wrapper
        const response = await withTimeout(
          new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(
              { type: 'PROCESS_QUESTION', data: context },
              (resp) => {
                if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
                if (resp.success) resolve(resp.answer);
                else reject(new Error(resp.error));
              }
            );
          }),
          requestTimeout,
          `Request timed out after ${requestTimeout / 1000} seconds. Please try again.`
        );

        devLog('AI answer:', response, '— total time:', Date.now() - startTime, 'ms');
        if (loadingToast) loadingToast.dismiss();
        loadingToast = null;
        applyAnswer(domRefs, response);
        showToast('Answer applied', 'success', 2000);
      }
    } catch (err) {
      devError('Error processing question:', err.message);
      if (loadingToast) loadingToast.dismiss();
      loadingToast = null;

      // 1f. Categorized error messages
      let userMessage = 'Something went wrong. Please try again.';
      const msg = err.message || '';
      if (msg.includes('timed out')) {
        userMessage = 'Request timed out. Please try again.';
      } else if (msg.includes('Rate limit') || msg.includes('429')) {
        userMessage = 'Rate limit reached. Please wait a moment.';
      } else if (msg.includes('Network') || msg.includes('Failed to fetch') || msg.includes('net::')) {
        userMessage = 'Network error. Check your internet connection.';
      } else if (msg.includes('API key') || msg.includes('No API key')) {
        userMessage = 'API key not configured. Open extension settings.';
      } else if (msg.includes('disconnected') || msg.includes('Extension context invalidated') || msg.includes('Receiving end does not exist')) {
        userMessage = 'Extension disconnected. Reload the page.';
      }

      showToast(userMessage, 'error', 4000);
    } finally {
      processing = false;
      // 1b. Remove loading indicator
      if (processingContainer) {
        processingContainer.classList.remove('qs-processing');
      }
    }
  }, true);

  devLog('Content script loaded. Dev mode:', IS_DEV);

})();
