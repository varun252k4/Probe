const ASSISTANT_SELECTOR = '[data-message-author-role="assistant"], .agent-turn';
const SELECTORS = {
  input: '#prompt-textarea',
  sendButton: 'button[data-testid="send-button"]',
  stopButton: 'button[data-testid="stop-button"], button[aria-label="Stop generating"]',
  assistantMessage: '[data-message-author-role="assistant"]',
};
const FRAME_URL = 'https://chatgpt.com/?temporary-chat=true';
const MAX_EXCERPT_LENGTH = 6000;
const REQUEST_TIMEOUT_MS = 90000;

const MAX_PANELS = 5;

let askBubble = null;
let chooser = null;
let lastSelectionText = '';
let lastSelectionContext = null;
let framePromise = null;
let panelSequence = 0;
let panelStackTop = 2147483001;
const panels = new Set();

if (window.top === window) {
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

  const beginWarmup = () => {
    const schedule = window.requestIdleCallback || ((callback) => setTimeout(callback, 500));
    schedule(() => warmFrame(), { timeout: 1500 });
  };
  if (document.readyState === 'complete') beginWarmup();
  else window.addEventListener('load', beginWarmup, { once: true });
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
  const assistantEl = container ? container.closest(ASSISTANT_SELECTOR) : null;
  if (!assistantEl) {
    removeBubble();
    return;
  }

  lastSelectionText = text;
  lastSelectionContext = getSelectionContext(assistantEl);
  const rect = range.getBoundingClientRect();
  showBubble(rect);
}

function getSelectionContext(assistantElement) {
  const messages = [...document.querySelectorAll('[data-message-author-role]')];
  const assistantIndex = messages.indexOf(assistantElement);
  let userQuestion = '';
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    if (messages[index].dataset.messageAuthorRole === 'user') {
      userQuestion = messages[index].innerText.trim();
      break;
    }
  }
  return {
    userQuestion: userQuestion.slice(0, 4000),
    fullAnswer: assistantElement.innerText.trim().slice(0, 12000),
  };
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
    let hasPartialAnswer = false;
    const waitingMessages = ['Thinking', 'Reading the selected context', 'Working through your question', 'Still working'];
    const timer = setInterval(() => {
      const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
      turn.elapsed.textContent = `${elapsedSeconds}s`;
      if (!hasPartialAnswer) {
        const messageIndex = elapsedSeconds < 3 ? 0 : elapsedSeconds < 7 ? 1 : elapsedSeconds < 12 ? 2 : 3;
        turn.status.textContent = waitingMessages[messageIndex];
      }
    }, 1000);

    askInConversation(
      session,
      buildSessionPrompt(session, question),
      requestController.signal,
      (phase, partialAnswer) => {
        turn.status.textContent = phase;
        subtitle.textContent = phase;
        if (partialAnswer) {
          hasPartialAnswer = true;
          turn.skeleton.hidden = true;
          turn.answerBox.textContent = partialAnswer;
          thread.scrollTop = thread.scrollHeight;
        }
      }
    )
      .then((answer) => {
        session.hasContext = true;
        session.pendingContext = false;
        turn.status.textContent = 'Complete';
        subtitle.textContent = 'Answer ready';
        turn.skeleton.hidden = true;
        turn.answerBox.textContent = answer;
        turn.resultActions.hidden = false;
        thread.scrollTop = thread.scrollHeight;
        saveHistory(session.excerpt, question, answer);
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
    await navigator.clipboard.writeText(answerBox.textContent);
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
  session.frame?.remove();
  session.frame = null;
  session.hasContext = false;
  session.element.remove();
  panels.delete(session);
  renumberSessions();
  setTimeout(() => warmFrame(), 300);
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
  const key = `probe:${location.href.split('#')[0]}`;
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
    `and do not repeat the full response.`
  );
}

function buildFollowUpPrompt(question) {
  return `Follow-up question: ${question}\n\nAnswer directly and concisely using the context from this temporary chat.`;
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
    `Answer directly and concisely, using this new excerpt together with the earlier context.`
  );
}

function createHiddenFrame(url) {
  return new Promise((resolve, reject) => {
    const iframe = document.createElement('iframe');
    iframe.title = 'Probe private response session';
    iframe.style.cssText = 'position:fixed; width:1px; height:1px; opacity:0; left:-9999px; top:-9999px; pointer-events:none;';
    iframe.src = url;
    const timeout = setTimeout(() => {
      iframe.remove();
      reject(new Error('The private response session took too long to load.'));
    }, 20000);
    iframe.addEventListener('load', () => {
      clearTimeout(timeout);
      resolve(iframe);
    }, { once: true });
    iframe.addEventListener('error', () => {
      clearTimeout(timeout);
      iframe.remove();
      reject(new Error('Could not start the private response session.'));
    }, { once: true });
    document.body.appendChild(iframe);
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
      reject(new Error('ChatGPT took too long to become ready.'));
    }, timeoutMs);
    observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true });
  });
}

function warmFrame() {
  if (framePromise) return framePromise;
  framePromise = createHiddenFrame(FRAME_URL).then(async (iframe) => {
    try {
      const doc = iframe.contentDocument;
      if (!doc) throw new Error('Could not access the private response session.');
      await waitForElement(doc, SELECTORS.input);
      return iframe;
    } catch (error) {
      iframe.remove();
      throw error;
    }
  });
  framePromise.catch(() => { framePromise = null; });
  return framePromise;
}

async function takeWarmFrame() {
  const pendingFrame = warmFrame();
  try {
    return await pendingFrame;
  } finally {
    if (framePromise === pendingFrame) framePromise = null;
  }
}

function waitForAnswer(doc, initialCount, signal, onUpdate) {
  return new Promise((resolve, reject) => {
    let lastText = '';
    let lastChangeAt = Date.now();

    const finish = (error, answer) => {
      clearInterval(checkInterval);
      clearTimeout(timeout);
      observer.disconnect();
      signal.removeEventListener('abort', onAbort);
      error ? reject(error) : resolve(answer);
    };
    const onAbort = () => finish(new DOMException('Request cancelled.', 'AbortError'));
    const check = () => {
      const messages = doc.querySelectorAll(SELECTORS.assistantMessage);
      if (messages.length <= initialCount) return;
      const text = messages[messages.length - 1].innerText.trim();
      if (text && text !== lastText) {
        lastText = text;
        lastChangeAt = Date.now();
        onUpdate('Writing answer', text);
      }
      const isGenerating = Boolean(doc.querySelector(SELECTORS.stopButton));
      if (lastText && !isGenerating && Date.now() - lastChangeAt >= 700) finish(null, lastText);
    };

    const observer = new MutationObserver(check);
    observer.observe(doc.documentElement, { childList: true, subtree: true, characterData: true, attributes: true });
    const checkInterval = setInterval(check, 250);
    const timeout = setTimeout(() => finish(new Error('The response timed out. Please try again.')), REQUEST_TIMEOUT_MS);
    signal.addEventListener('abort', onAbort, { once: true });
    check();
  });
}

async function askInConversation(session, promptText, signal, onUpdate) {
  onUpdate(session.frame ? 'Continuing conversation' : (framePromise ? 'Connecting' : 'Preparing private chat'));
  const iframe = session.frame || await takeWarmFrame();
  session.frame = iframe;
  try {
    if (signal.aborted) throw new DOMException('Request cancelled.', 'AbortError');
    const doc = iframe.contentDocument;
    if (!doc) throw new Error('Could not access the private response session.');
    const input = await waitForElement(doc, SELECTORS.input);
    const initialCount = doc.querySelectorAll(SELECTORS.assistantMessage).length;

    input.focus();
    if (input.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(iframe.contentWindow.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(input, promptText);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      doc.execCommand('insertText', false, promptText);
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: promptText }));
    }
    const sendBtn = await waitForElement(
      doc,
      SELECTORS.sendButton,
      (button) => !button.disabled && button.getAttribute('aria-disabled') !== 'true'
    );
    if (signal.aborted) throw new DOMException('Request cancelled.', 'AbortError');
    onUpdate('Thinking');
    sendBtn.click();
    return await waitForAnswer(doc, initialCount, signal, onUpdate);
  } catch (error) {
    iframe.remove();
    if (session.frame === iframe) session.frame = null;
    session.hasContext = false;
    throw error;
  }
}
