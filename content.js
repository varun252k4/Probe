const MAX_EXCERPT_LENGTH = 6000;

const FORMAT_RULES =
  'Formatting rules:\n' +
  '- Reply in Markdown.\n' +
  '- Put every code sample in a fenced block with a language tag.\n' +
  '- Write any mathematics as LaTeX so it renders as a real formula, not as plain text.\n' +
  '- Use a short bullet list or a table when comparing things.\n' +
  '- If a diagram or flow would help, output one self-contained SVG inside a ```svg fenced block, ' +
  'roughly 460x260, using only shapes and text, with no scripts, external images or stylesheets.';

const RICH_TAGS = new Set(['p', 'br', 'strong', 'b', 'em', 'i', 'code', 'pre', 'ul', 'ol', 'li', 'img',
  'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'a']);
const SVG_TAGS = new Set(['svg', 'g', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse',
  'text', 'tspan', 'defs', 'marker', 'title', 'desc', 'lineargradient', 'radialgradient', 'stop', 'clippath']);
const SVG_ATTRS = new Set(['d', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
  'stroke-dasharray', 'viewbox', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
  'points', 'transform', 'text-anchor', 'dominant-baseline', 'font-size', 'font-family', 'font-weight',
  'opacity', 'fill-opacity', 'stroke-opacity', 'offset', 'stop-color', 'gradientunits', 'id',
  'xmlns', 'preserveaspectratio', 'marker-end', 'marker-start', 'refx', 'refy', 'orient',
  'markerwidth', 'markerheight']);

const MAX_PANELS = 5;

const FONT_STACKS = {
  default: '"OpenAI Sans", "Segoe UI", system-ui, sans-serif',
  system: 'system-ui, "Segoe UI", Roboto, Arial, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
};

const DEFAULT_SETTINGS = {
  fontFamily: 'default',
  fontSize: 13,
  accent: '#2563eb',
  openWebUIEnabled: true,
  openWebUIModel: '',
  saveHistory: true,
};

let settings = { ...DEFAULT_SETTINGS };
let activeProvider = null;
let initialized = false;

let askBubble = null;
let chooser = null;
let lastSelectionText = '';
let lastSelectionContext = null;
let panelSequence = 0;
let panelStackTop = 2147483001;
const panels = new Set();

const providerApi = {
  get settings() { return settings; },
  waitForElement,
  revealCollapsedCode,
  extractAnswer,
  renderMarkdownishAnswer,
};

if (window.top === window) {
  applySettings(settings);
  watchSettings();
  bootstrapProvider();
}

function applySettings(next) {
  settings = { ...DEFAULT_SETTINGS, ...next };
  const root = document.documentElement;
  if (!root) {
    document.addEventListener('DOMContentLoaded', () => applySettings(settings), { once: true });
    return;
  }
  root.style.setProperty('--sideask-font', FONT_STACKS[settings.fontFamily] || FONT_STACKS.default);
  root.style.setProperty('--sideask-font-size', `${settings.fontSize}px`);
  root.style.setProperty('--sideask-accent', settings.accent);
}

function watchSettings() {
  if (!globalThis.chrome?.storage?.sync) return;
  chrome.storage.sync.get(DEFAULT_SETTINGS, (stored) => applySettings(stored));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const next = { ...settings };
    Object.entries(changes).forEach(([key, change]) => { next[key] = change.newValue; });
    applySettings(next);
  });
}

function bootstrapProvider() {
  const provider = window.ProbeProviders?.detect(settings);
  if (provider) {
    initializeProvider(provider);
    return;
  }

  const observer = new MutationObserver(() => {
    const nextProvider = window.ProbeProviders?.detect(settings);
    if (!nextProvider) return;
    observer.disconnect();
    initializeProvider(nextProvider);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(() => observer.disconnect(), 30000);
}

function initializeProvider(provider) {
  if (initialized) return;
  initialized = true;
  activeProvider = provider;

  document.addEventListener('mouseup', onSelectionChange);
  document.addEventListener('keyup', onSelectionChange);
  document.addEventListener('selectionchange', debounce(onSelectionChange, 150));
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (chooser) {
      removeChooser();
      return;
    }
    const focused = [...panels].find((session) => session.element.contains(document.activeElement));
    if (focused) closePanel(focused);
  });

  document.addEventListener('mousedown', (event) => {
    if (chooser && !chooser.contains(event.target)) removeChooser();
  });

  if (provider.warmup) {
    const beginWarmup = () => {
      const schedule = window.requestIdleCallback || ((callback) => setTimeout(callback, 500));
      schedule(() => provider.warmup(providerApi), { timeout: 1500 });
    };
    if (document.readyState === 'complete') beginWarmup();
    else window.addEventListener('load', beginWarmup, { once: true });
  }
}

function onSelectionChange(e) {
  if (chooser) return;
  // Ignore selection churn caused by interacting with our own UI.
  if (e && e.target && ((askBubble && askBubble.contains(e.target)) || isInsideAnyPanel(e.target))) {
    return;
  }

  const selection = window.getSelection();
  const text = selection ? selection.toString().trim() : '';

  if (!text || text.length < 2) {
    removeBubble();
    return;
  }

  const range = selection.getRangeAt(0);
  const commonNode = range.commonAncestorContainer;
  const container = commonNode && (commonNode.nodeType === 1 ? commonNode : commonNode.parentElement);
  const assistantEl = container ? activeProvider?.findAssistantElement?.(container) : null;
  if (!assistantEl) {
    removeBubble();
    return;
  }

  lastSelectionText = text;
  lastSelectionContext = activeProvider?.getSelectionContext?.(assistantEl) || {
    userQuestion: '',
    fullAnswer: assistantEl.innerText.trim().slice(0, 12000),
  };
  const rect = range.getBoundingClientRect();
  showBubble(rect);
}

function debounce(fn, wait) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

function removeBubble() {
  if (askBubble) {
    askBubble.remove();
    askBubble = null;
  }
}

function isInsideAnyPanel(node) {
  return [...panels].some((session) => session.element.contains(node));
}

function removeChooser() {
  if (chooser) {
    chooser.remove();
    chooser = null;
  }
  panels.forEach((session) => session.element.classList.remove('sideask-highlight'));
}

// Ordinals stay contiguous so the badge on a card always matches its chooser row.
function renumberSessions() {
  [...panels].forEach((session, index) => {
    session.ordinal = index + 1;
    const chip = session.element.querySelector('.sideask-session-chip');
    if (chip) chip.textContent = String(session.ordinal);
  });
}

function normalizeExcerpt(text) {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function focusSession(session) {
  const panel = session.element;
  panel.style.zIndex = String(++panelStackTop);
  clampPanelIntoViewport(session);
  panel.classList.add('sideask-highlight');
  setTimeout(() => panel.classList.remove('sideask-highlight'), 1200);
  if (!panel.classList.contains('sideask-minimized')) panel.querySelector('.sideask-input').focus();
}

function buildChooserItem(badgeText, title, subtitle) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'sideask-chooser-item';
  const badge = document.createElement('span');
  badge.className = 'sideask-chooser-badge';
  badge.textContent = badgeText;
  const text = document.createElement('span');
  text.className = 'sideask-chooser-text';
  const titleEl = document.createElement('span');
  titleEl.className = 'sideask-chooser-title';
  titleEl.textContent = title;
  const subtitleEl = document.createElement('span');
  subtitleEl.className = 'sideask-chooser-sub';
  subtitleEl.textContent = subtitle;
  text.append(titleEl, subtitleEl);
  button.append(badge, text);
  return button;
}

function showSessionChooser(rect, excerpt, sourceContext) {
  removeChooser();
  chooser = document.createElement('div');
  chooser.className = 'sideask-chooser';
  chooser.setAttribute('role', 'menu');

  const label = document.createElement('div');
  label.className = 'sideask-chooser-label';
  label.textContent = 'Ask this in…';
  chooser.appendChild(label);

  const excerptKey = normalizeExcerpt(excerpt);
  const sessionHasExcerpt = (session) => session.contexts.some((c) => normalizeExcerpt(c) === excerptKey);
  const duplicate = [...panels].find(sessionHasExcerpt);
  const atLimit = panels.size >= MAX_PANELS;

  let newSubtitle = 'Start a separate conversation';
  if (duplicate) newSubtitle = `Already open in session ${duplicate.ordinal}`;
  else if (atLimit) newSubtitle = `Limit of ${MAX_PANELS} reached — close a card first`;

  const newItem = buildChooserItem('+', 'New session', newSubtitle);
  newItem.disabled = Boolean(duplicate) || atLimit;
  newItem.addEventListener('click', () => {
    removeChooser();
    openPanel(excerpt, rect, sourceContext);
  });
  chooser.appendChild(newItem);

  [...panels].forEach((session) => {
    const isDuplicate = sessionHasExcerpt(session);
    const asked = session.element.querySelectorAll('.sideask-turn').length;
    let subtitle;
    if (isDuplicate) subtitle = 'Already has this context — click to focus';
    else if (asked) subtitle = `${asked} question${asked > 1 ? 's' : ''} asked`;
    else subtitle = 'No questions yet';

    const item = buildChooserItem(String(session.ordinal), truncate(session.excerpt, 42), subtitle);
    item.addEventListener('mouseenter', () => session.element.classList.add('sideask-highlight'));
    item.addEventListener('mouseleave', () => session.element.classList.remove('sideask-highlight'));
    item.addEventListener('click', () => {
      removeChooser();
      if (isDuplicate) focusSession(session);
      else addContextToSession(session, excerpt, sourceContext);
    });
    chooser.appendChild(item);
  });

  document.body.appendChild(chooser);
  const height = chooser.offsetHeight;
  const width = chooser.offsetWidth;
  chooser.style.top = `${clamp(rect.bottom + 8, 8, Math.max(8, window.innerHeight - height - 8))}px`;
  chooser.style.left = `${clamp(rect.left, 8, Math.max(8, window.innerWidth - width - 8))}px`;
}

function addContextToSession(session, excerpt, sourceContext) {
  session.excerpt = excerpt;
  session.sourceContext = sourceContext;
  session.contexts.push(excerpt);
  // Only a session that already has history needs the new excerpt announced mid-conversation.
  session.pendingContext = session.hasContext;

  const panel = session.element;
  panel.classList.remove('sideask-empty');
  panel.classList.remove('sideask-minimized');
  panel.style.zIndex = String(++panelStackTop);

  const block = document.createElement('div');
  block.className = 'sideask-added-context';
  const label = document.createElement('div');
  label.className = 'sideask-context-label';
  label.textContent = 'Added context';
  const quote = document.createElement('blockquote');
  quote.className = 'sideask-excerpt';
  quote.textContent = truncate(excerpt, 500);
  block.append(label, quote);
  panel.querySelector('.sideask-turns').appendChild(block);

  const thread = panel.querySelector('.sideask-thread');
  requestAnimationFrame(() => { thread.scrollTop = thread.scrollHeight; });
  panel.querySelector('.sideask-input').focus();
}

function showBubble(rect) {
  removeBubble();
  askBubble = document.createElement('button');
  askBubble.type = 'button';
  askBubble.className = 'sideask-bubble';
  askBubble.innerHTML = '<span class="sideask-bubble-label">Ask with <strong>Probe</strong></span><span class="sideask-bubble-arrow" aria-hidden="true">→</span>';
  askBubble.style.top = `${Math.min(rect.bottom + 8, window.innerHeight - 44)}px`;
  askBubble.style.left = `${Math.max(10, Math.min(rect.left, window.innerWidth - 148))}px`;
  askBubble.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  askBubble.addEventListener('click', (e) => {
    e.stopPropagation();
    const excerpt = lastSelectionText;
    const context = lastSelectionContext;
    removeBubble();
    if (panels.size === 0) openPanel(excerpt, rect, context);
    else showSessionChooser(rect, excerpt, context);
  });
  document.body.appendChild(askBubble);
}

function openPanel(excerpt, rect, sourceContext) {
  // Each card owns a full ChatGPT iframe, so the count is capped for memory.
  while (panels.size >= MAX_PANELS) closePanel(panels.values().next().value);

  const panelId = ++panelSequence;
  const panel = document.createElement('div');
  panel.className = 'sideask-panel sideask-empty';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-labelledby', `sideask-title-${panelId}`);
  panel.style.zIndex = String(++panelStackTop);

  const session = {
    id: panelId,
    element: panel,
    excerpt,
    sourceContext,
    contexts: [excerpt],
    pendingContext: false,
    abortController: null,
    frame: null,
    hasContext: false,
    userPlaced: false,
  };
  panels.add(session);

  panel.addEventListener('pointerdown', () => {
    panel.style.zIndex = String(++panelStackTop);
  }, true);

  panel.innerHTML = `
    <div class="sideask-header">
      <div class="sideask-title-group">
        <span class="sideask-brand" aria-hidden="true">P</span>
        <div class="sideask-heading">
          <div class="sideask-title-row">
            <div class="sideask-title" id="sideask-title-${panelId}">Probe</div>
            <span class="sideask-session-chip" title="Session number">1</span>
          </div>
          <div class="sideask-subtitle">Explore this response</div>
        </div>
      </div>
      <div class="sideask-window-actions">
        <button type="button" class="sideask-minimize" aria-label="Minimize" aria-expanded="true">−</button>
        <button type="button" class="sideask-close" aria-label="Close">×</button>
      </div>
    </div>
    <div class="sideask-content">
      <div class="sideask-thread">
        <div class="sideask-context-label">Selected context</div>
        <blockquote class="sideask-excerpt"></blockquote>
        <div class="sideask-turns"></div>
      </div>
      <div class="sideask-composer-shell">
        <label class="sideask-visually-hidden" for="sideask-question-${panelId}">Your question</label>
        <div class="sideask-composer">
          <textarea id="sideask-question-${panelId}" class="sideask-input" placeholder="Message Probe" rows="1" maxlength="1200"></textarea>
          <button type="button" class="sideask-ask-btn" aria-label="Send question" disabled>
            <span aria-hidden="true">↑</span>
          </button>
        </div>
      </div>
    </div>
    <div class="sideask-resize sideask-resize-n" data-dir="n" aria-hidden="true"></div>
    <div class="sideask-resize sideask-resize-s" data-dir="s" aria-hidden="true"></div>
    <div class="sideask-resize sideask-resize-e" data-dir="e" aria-hidden="true"></div>
    <div class="sideask-resize sideask-resize-w" data-dir="w" aria-hidden="true"></div>
    <div class="sideask-resize sideask-resize-ne" data-dir="ne" aria-hidden="true"></div>
    <div class="sideask-resize sideask-resize-nw" data-dir="nw" aria-hidden="true"></div>
    <div class="sideask-resize sideask-resize-se" data-dir="se" aria-hidden="true"></div>
    <div class="sideask-resize sideask-resize-sw" data-dir="sw" aria-hidden="true"></div>
  `;

  panel.querySelector('.sideask-excerpt').textContent = truncate(excerpt, 500);
  panel.querySelector('.sideask-close').addEventListener('click', () => closePanel(session));

  const textarea = panel.querySelector('.sideask-input');
  const askBtn = panel.querySelector('.sideask-ask-btn');
  const minimizeBtn = panel.querySelector('.sideask-minimize');
  const subtitle = panel.querySelector('.sideask-subtitle');
  const thread = panel.querySelector('.sideask-thread');
  const turns = panel.querySelector('.sideask-turns');

  askBtn.addEventListener('click', submitQuestion);
  // A resized panel carries inline sizing that would otherwise defeat the minimized style.
  let restoreSize = null;
  minimizeBtn.addEventListener('click', () => {
    const minimized = panel.classList.toggle('sideask-minimized');
    minimizeBtn.textContent = minimized ? '+' : '−';
    minimizeBtn.setAttribute('aria-label', minimized ? 'Restore' : 'Minimize');
    minimizeBtn.setAttribute('aria-expanded', String(!minimized));
    if (minimized) {
      restoreSize = { width: panel.style.width, height: panel.style.height, maxHeight: panel.style.maxHeight };
      panel.style.width = '';
      panel.style.height = '';
      panel.style.maxHeight = '';
      clampPanelIntoViewport(session);
    } else {
      if (restoreSize) {
        panel.style.width = restoreSize.width;
        panel.style.height = restoreSize.height;
        panel.style.maxHeight = restoreSize.maxHeight;
      }
      positionPanel(session, rect);
      textarea.focus();
    }
  });
  textarea.addEventListener('input', () => {
    askBtn.disabled = !textarea.value.trim();
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
  });
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submitQuestion();
    }
  });

  function submitQuestion() {
    const question = textarea.value.trim();
    if (!question || session.abortController) return;

    const requestController = new AbortController();
    session.abortController = requestController;
    const turn = createTurn(question);
    turns.appendChild(turn.element);
    panel.classList.remove('sideask-empty');
    requestAnimationFrame(() => positionPanel(session, rect));
    askBtn.disabled = true;
    textarea.disabled = true;
    textarea.value = '';
    textarea.style.height = 'auto';
    panel.dataset.state = 'loading';
    subtitle.textContent = 'Answering…';
    requestAnimationFrame(() => { thread.scrollTop = thread.scrollHeight; });

    const startedAt = Date.now();
    let streaming = false;
    const waitingMessages = ['Thinking', 'Reading the selected context', 'Working through your question', 'Still working'];
    const timer = setInterval(() => {
      const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
      turn.elapsed.textContent = `${elapsedSeconds}s`;
      if (!streaming) {
        const messageIndex = elapsedSeconds < 3 ? 0 : elapsedSeconds < 7 ? 1 : elapsedSeconds < 12 ? 2 : 3;
        turn.status.textContent = waitingMessages[messageIndex];
      }
    }, 1000);

    askInConversation(
      session,
      buildSessionPrompt(session, question),
      requestController.signal,
      // The answer is built off-screen and inserted once, so the thread never jumps mid-write.
      (phase) => {
        if (phase === 'Writing answer' || phase === 'Rendering image') streaming = true;
        turn.status.textContent = phase;
        subtitle.textContent = phase;
      }
    )
      .then((answer) => {
        session.hasContext = true;
        session.pendingContext = false;
        const wasAtBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 60;
        turn.status.textContent = 'Complete';
        subtitle.textContent = 'Answer ready';
        turn.skeleton.hidden = true;
        renderAnswer(turn.answerBox, answer);
        turn.resultActions.hidden = false;
        if (wasAtBottom) requestAnimationFrame(() => { thread.scrollTop = thread.scrollHeight; });
        saveHistory(session.excerpt, question, answer.text);
      })
      .catch((err) => {
        if (err.name !== 'AbortError') {
          subtitle.textContent = 'Could not answer';
          turn.skeleton.hidden = true;
          turn.errorBox.hidden = false;
          turn.errorBox.textContent = err.message;
          textarea.value = question;
        }
      })
      .finally(() => {
        clearInterval(timer);
        turn.progress.hidden = true;
        textarea.disabled = false;
        askBtn.disabled = !textarea.value.trim();
        if (session.abortController === requestController) session.abortController = null;
        if (panels.has(session)) {
          delete panel.dataset.state;
          if (!panel.classList.contains('sideask-minimized')) textarea.focus();
        }
      });
  }

  document.body.appendChild(panel);
  renumberSessions();
  positionPanel(session, rect);
  enablePanelDrag(session, panel.querySelector('.sideask-header'));
  enablePanelResize(session, panel.querySelectorAll('.sideask-resize'));
  textarea.focus();
}

function createTurn(question) {
  const element = document.createElement('div');
  element.className = 'sideask-turn';
  element.innerHTML = `
    <div class="sideask-user-message">
      <div class="sideask-user-bubble"></div>
    </div>
    <div class="sideask-result">
      <span class="sideask-assistant-mark" aria-label="Probe">P</span>
      <div class="sideask-assistant-message">
        <div class="sideask-progress" role="status" aria-live="polite">
          <span class="sideask-thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span>
          <span class="sideask-status">Preparing</span>
          <span class="sideask-elapsed" aria-hidden="true"></span>
        </div>
        <div class="sideask-skeleton" aria-hidden="true"><span></span><span></span><span></span></div>
        <div class="sideask-answer"></div>
        <div class="sideask-result-actions" hidden>
          <button type="button" class="sideask-copy" aria-label="Copy answer">Copy</button>
        </div>
        <div class="sideask-error" role="alert" hidden></div>
      </div>
    </div>
  `;

  element.querySelector('.sideask-user-bubble').textContent = question;
  const answerBox = element.querySelector('.sideask-answer');
  const copyButton = element.querySelector('.sideask-copy');
  copyButton.addEventListener('click', async () => {
    await navigator.clipboard.writeText(answerBox.dataset.plain || answerBox.textContent);
    copyButton.textContent = 'Copied';
    setTimeout(() => { copyButton.textContent = 'Copy'; }, 1200);
  });

  return {
    element,
    progress: element.querySelector('.sideask-progress'),
    status: element.querySelector('.sideask-status'),
    elapsed: element.querySelector('.sideask-elapsed'),
    skeleton: element.querySelector('.sideask-skeleton'),
    answerBox,
    resultActions: element.querySelector('.sideask-result-actions'),
    errorBox: element.querySelector('.sideask-error'),
  };
}

function positionPanel(session, rect) {
  const panel = session.element;
  if (session.userPlaced) {
    clampPanelIntoViewport(session);
    return;
  }
  const margin = 12;
  const cascade = (panels.size - 1) * 26;
  const panelRect = panel.getBoundingClientRect();
  const left = clamp(rect.left + cascade, margin, Math.max(margin, window.innerWidth - panelRect.width - margin));
  const below = rect.bottom + margin + cascade;
  const preferredTop = below + panelRect.height <= window.innerHeight - margin
    ? below
    : rect.top - panelRect.height - margin;
  const top = clamp(preferredTop, margin, Math.max(margin, window.innerHeight - panelRect.height - margin));
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}

function closePanel(session) {
  if (!session || !panels.has(session)) return;
  session.abortController?.abort();
  session.abortController = null;
  activeProvider?.closeSession?.(session);
  session.hasContext = false;
  session.element.remove();
  panels.delete(session);
  renumberSessions();
  if (activeProvider?.warmup) setTimeout(() => activeProvider.warmup(providerApi), 300);
}

window.addEventListener('resize', () => {
  panels.forEach((session) => clampPanelIntoViewport(session));
});

function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max));
}

function clampPanelIntoViewport(session) {
  const panel = session.element;
  const margin = 8;
  const rect = panel.getBoundingClientRect();
  panel.style.left = `${clamp(rect.left, margin, Math.max(margin, window.innerWidth - rect.width - margin))}px`;
  panel.style.top = `${clamp(rect.top, margin, Math.max(margin, window.innerHeight - rect.height - margin))}px`;
}

function enablePanelDrag(session, handle) {
  const panel = session.element;
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest('button')) return;
    const rect = panel.getBoundingClientRect();
    const grabX = event.clientX - rect.left;
    const grabY = event.clientY - rect.top;
    session.userPlaced = true;
    panel.classList.add('sideask-dragging');
    handle.setPointerCapture(event.pointerId);

    const onMove = (move) => {
      panel.style.left = `${clamp(move.clientX - grabX, 0, window.innerWidth - panel.offsetWidth)}px`;
      panel.style.top = `${clamp(move.clientY - grabY, 0, window.innerHeight - panel.offsetHeight)}px`;
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      panel.classList.remove('sideask-dragging');
    };

    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    event.preventDefault();
  });
}

function enablePanelResize(session, grips) {
  const panel = session.element;
  const MIN_WIDTH = 320;
  const MIN_HEIGHT = 240;

  grips.forEach((grip) => {
    grip.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const dir = grip.dataset.dir;
      const rect = panel.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
      session.userPlaced = true;
      panel.classList.remove('sideask-empty');
      panel.classList.add('sideask-resizing');
      panel.style.maxHeight = 'none';
      grip.setPointerCapture(event.pointerId);

      const onMove = (move) => {
        const dx = move.clientX - startX;
        const dy = move.clientY - startY;
        let { left, top, width, height } = rect;

        if (dir.includes('e')) width = clamp(rect.width + dx, MIN_WIDTH, window.innerWidth - rect.left);
        if (dir.includes('s')) height = clamp(rect.height + dy, MIN_HEIGHT, window.innerHeight - rect.top);
        if (dir.includes('w')) {
          width = clamp(rect.width - dx, MIN_WIDTH, rect.right);
          left = rect.right - width;
        }
        if (dir.includes('n')) {
          height = clamp(rect.height - dy, MIN_HEIGHT, rect.bottom);
          top = rect.bottom - height;
        }

        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
        panel.style.width = `${width}px`;
        panel.style.height = `${height}px`;
      };
      const onUp = () => {
        grip.removeEventListener('pointermove', onMove);
        grip.removeEventListener('pointerup', onUp);
        panel.classList.remove('sideask-resizing');
      };

      grip.addEventListener('pointermove', onMove);
      grip.addEventListener('pointerup', onUp);
      event.preventDefault();
      event.stopPropagation();
    });
  });
}

function truncate(str, max) {
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

function saveHistory(excerpt, question, answer) {
  if (!settings.saveHistory || !globalThis.chrome?.storage?.local) return;
  const key = `probe:${activeProvider?.id || 'page'}:${location.href.split('#')[0]}`;
  chrome.storage.local.get([key], (data) => {
    const list = data[key] || [];
    list.push({ excerpt, question, answer, ts: Date.now() });
    chrome.storage.local.set({ [key]: list.slice(-50) });
  });
}

function buildPrompt(excerpt, question, sourceContext) {
  const focusedExcerpt = excerpt.slice(0, MAX_EXCERPT_LENGTH);
  const originalQuestion = sourceContext?.userQuestion || 'Not available';
  const fullAnswer = sourceContext?.fullAnswer || focusedExcerpt;
  return (
    `Answer a focused follow-up about a selected part of an AI response.\n\n` +
    `Original user question:\n${originalQuestion}\n\n` +
    `Full response for context:\n${fullAnswer}\n\n` +
    `Selected excerpt:\n${focusedExcerpt}\n\n` +
    `Follow-up question:\n${question}\n\n` +
    `Answer the follow-up directly and concisely. Use the broader context only when needed, ` +
    `and do not repeat the full response.\n\n${FORMAT_RULES}`
  );
}

function buildFollowUpPrompt(question) {
  return (
    `Follow-up question: ${question}\n\n` +
    `Answer directly and concisely using the context from this temporary chat.\n\n${FORMAT_RULES}`
  );
}

function buildSessionPrompt(session, question) {
  if (!session.hasContext) return buildPrompt(session.excerpt, question, session.sourceContext);
  if (session.pendingContext) return buildAddedContextPrompt(session.excerpt, question);
  return buildFollowUpPrompt(question);
}

function buildAddedContextPrompt(excerpt, question) {
  return (
    `Here is another excerpt from the same response:\n${excerpt.slice(0, MAX_EXCERPT_LENGTH)}\n\n` +
    `Follow-up question:\n${question}\n\n` +
    `Answer directly and concisely, using this new excerpt together with the earlier context.\n\n${FORMAT_RULES}`
  );
}

function renderAnswer(box, answer) {
  box.dataset.plain = answer.text;
  if (answer.content && answer.content.childNodes.length) {
    box.classList.add('sideask-answer-rich');
    box.replaceChildren(...answer.content.childNodes);
  } else {
    box.textContent = answer.text;
  }
}

// ChatGPT renders SVG and other rich blocks as a preview whose source is absent from the DOM.
function revealCollapsedCode(node) {
  node.querySelectorAll('button').forEach((button) => {
    const label = (button.getAttribute('aria-label') || button.textContent || '').trim();
    if (label === 'Code' && button.getAttribute('aria-pressed') !== 'true') button.click();
  });
}

function extractAnswer(node) {
  // Import first so every later step works inside our own document.
  const clone = document.importNode(node, true);
  clone.querySelectorAll('script, style, button, .sr-only').forEach((el) => el.remove());

  const container = document.createElement('div');
  copyAllowedNodes(clone, container, false);
  const text = container.textContent.trim();
  renderSvgBlocks(container);
  decorateCodeBlocks(container);
  decorateImages(container);
  return { text, content: container };
}

// KaTeX markup is kept intact because ChatGPT's own stylesheet and fonts render it in place.
function sanitizeKatex(source) {
  const clone = source.cloneNode(true);
  clone.querySelectorAll('script, style').forEach((el) => el.remove());
  clone.querySelectorAll('.katex-mathml').forEach((el) => el.remove());
  [clone, ...clone.querySelectorAll('*')].forEach((el) => {
    [...el.attributes].forEach((attr) => {
      const name = attr.name.toLowerCase();
      if (!['class', 'style', 'aria-hidden'].includes(name)) el.removeAttribute(attr.name);
    });
  });
  return clone;
}

function copyAllowedNodes(source, target, inSvg) {
  source.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      target.appendChild(document.createTextNode(child.nodeValue));
      return;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) return;

    const tag = child.localName.toLowerCase();
    const isSvg = inSvg || tag === 'svg';

    if (!isSvg && child.classList
      && (child.classList.contains('katex') || child.classList.contains('katex-display'))) {
      target.appendChild(sanitizeKatex(child));
      return;
    }

    if (!isSvg && tag === 'pre') {
      const codeEl = child.querySelector('code');
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = (codeEl || child).textContent;
      pre.appendChild(code);
      target.appendChild(pre);
      return;
    }

    const allowed = isSvg ? SVG_TAGS.has(tag) : RICH_TAGS.has(tag);
    if (!allowed) {
      copyAllowedNodes(child, target, isSvg && inSvg);
      return;
    }

    const element = isSvg
      ? document.createElementNS('http://www.w3.org/2000/svg', child.localName)
      : document.createElement(tag);

    [...child.attributes].forEach((attr) => {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) return;
      if (isSvg) {
        if (!SVG_ATTRS.has(name)) return;
      } else if (tag === 'img') {
        if (!['src', 'alt', 'width', 'height'].includes(name)) return;
        if (name === 'src' && !/^(https:|blob:)/i.test(attr.value)) return;
      } else if (name === 'class') {
        if (!attr.value.startsWith('sideask-')) return;
      } else if (name === 'href') {
        if (!/^https?:/i.test(attr.value)) return;
      } else {
        return;
      }
      element.setAttribute(attr.name, attr.value);
    });

    if (!isSvg && tag === 'a') {
      element.setAttribute('target', '_blank');
      element.setAttribute('rel', 'noopener noreferrer');
    }

    copyAllowedNodes(child, element, isSvg);
    target.appendChild(element);
  });
}

function makeToolButton(label) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'sideask-tool-btn';
  button.textContent = label;
  return button;
}

function flashLabel(button, temporary, original) {
  button.textContent = temporary;
  setTimeout(() => { button.textContent = original; }, 1200);
}

function decorateImages(container) {
  container.querySelectorAll('img').forEach((img) => {
    const source = img.getAttribute('src');
    if (!source) return;

    const figure = document.createElement('div');
    figure.className = 'sideask-figure';
    const bar = document.createElement('div');
    bar.className = 'sideask-tool-bar';

    const openBtn = makeToolButton('Open');
    openBtn.addEventListener('click', () => window.open(source, '_blank', 'noopener'));

    const downloadBtn = makeToolButton('Download');
    downloadBtn.addEventListener('click', async () => {
      try {
        const response = await fetch(source);
        const url = URL.createObjectURL(await response.blob());
        const link = document.createElement('a');
        link.href = url;
        link.download = 'probe-image.png';
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        flashLabel(downloadBtn, 'Saved', 'Download');
      } catch {
        window.open(source, '_blank', 'noopener');
      }
    });

    bar.append(openBtn, downloadBtn);
    img.replaceWith(figure);
    figure.append(bar, img);
  });
}

function decorateCodeBlocks(container) {
  container.querySelectorAll('pre:not(.sideask-diagram-source)').forEach((pre) => {
    const wrap = document.createElement('div');
    wrap.className = 'sideask-code';
    const bar = document.createElement('div');
    bar.className = 'sideask-tool-bar';
    const copyBtn = makeToolButton('Copy');
    copyBtn.addEventListener('click', async () => {
      await navigator.clipboard.writeText(pre.textContent);
      flashLabel(copyBtn, 'Copied', 'Copy');
    });
    bar.appendChild(copyBtn);
    pre.replaceWith(wrap);
    wrap.append(bar, pre);
  });
}

function renderSvgBlocks(container) {
  container.querySelectorAll('code').forEach((code) => {
    const source = code.textContent.trim();
    if (!/^<svg[\s>]/i.test(source) || !/<\/svg>$/i.test(source)) return;

    const parsed = new DOMParser().parseFromString(source, 'image/svg+xml');
    if (parsed.querySelector('parsererror')) return;
    const svg = parsed.documentElement;
    if (!svg || svg.localName.toLowerCase() !== 'svg') return;

    const canvas = document.createElement('div');
    canvas.className = 'sideask-diagram-canvas';
    copyAllowedNodes({ childNodes: [svg] }, canvas, false);
    if (!canvas.firstChild) return;

    const figure = document.createElement('div');
    figure.className = 'sideask-diagram';

    const sourceBlock = document.createElement('pre');
    sourceBlock.className = 'sideask-diagram-source';
    sourceBlock.hidden = true;
    const sourceCode = document.createElement('code');
    sourceCode.textContent = source;
    sourceBlock.appendChild(sourceCode);

    const bar = document.createElement('div');
    bar.className = 'sideask-tool-bar';

    const codeBtn = makeToolButton('Code');
    codeBtn.addEventListener('click', () => {
      sourceBlock.hidden = !sourceBlock.hidden;
      codeBtn.textContent = sourceBlock.hidden ? 'Code' : 'Diagram';
    });

    const copyBtn = makeToolButton('Copy');
    copyBtn.addEventListener('click', async () => {
      await navigator.clipboard.writeText(source);
      flashLabel(copyBtn, 'Copied', 'Copy');
    });

    const downloadBtn = makeToolButton('Download');
    downloadBtn.addEventListener('click', () => {
      const url = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'probe-diagram.svg';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      flashLabel(downloadBtn, 'Saved', 'Download');
    });

    bar.append(codeBtn, copyBtn, downloadBtn);
    figure.append(bar, canvas, sourceBlock);
    (code.closest('pre') || code).replaceWith(figure);
  });
}

function waitForElement(doc, selector, predicate = () => true, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const find = () => {
      const element = doc.querySelector(selector);
      if (element && predicate(element)) return element;
      return null;
    };
    const existing = find();
    if (existing) {
      resolve(existing);
      return;
    }

    const observer = new MutationObserver(() => {
      const element = find();
      if (!element) return;
      clearTimeout(timeout);
      observer.disconnect();
      resolve(element);
    });
    const timeout = setTimeout(() => {
      observer.disconnect();
      reject(new Error('The response provider took too long to become ready.'));
    }, timeoutMs);
    observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true });
  });
}

async function askInConversation(session, promptText, signal, onUpdate) {
  if (!activeProvider?.ask) throw new Error('No response provider is active for this page.');
  return activeProvider.ask(session, promptText, signal, onUpdate, providerApi);
}

function renderMarkdownishAnswer(text) {
  const container = document.createElement('div');
  const parts = text.split(/```([\w-]*)\n([\s\S]*?)```/g);
  for (let index = 0; index < parts.length; index += 3) {
    appendTextBlock(container, parts[index]);
    if (index + 2 >= parts.length) continue;
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    if (parts[index + 1]) code.className = `language-${parts[index + 1]}`;
    code.textContent = parts[index + 2].trim();
    pre.appendChild(code);
    container.appendChild(pre);
  }
  decorateCodeBlocks(container);
  return container;
}

function appendTextBlock(container, text) {
  text.split(/\n{2,}/).forEach((paragraph) => {
    const value = paragraph.trim();
    if (!value) return;
    const p = document.createElement('p');
    p.textContent = value;
    container.appendChild(p);
  });
}
