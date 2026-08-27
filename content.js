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

let askBubble = null;
let panel = null;
let lastSelectionText = '';
let lastSelectionContext = null;
let panelAbortController = null;
let framePromise = null;
let conversationFrame = null;
let conversationHasContext = false;

if (window.top === window) {
  document.addEventListener('mouseup', onSelectionChange);
  document.addEventListener('keyup', onSelectionChange);
  document.addEventListener('selectionchange', debounce(onSelectionChange, 150));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closePanel();
  });

  const beginWarmup = () => {
    const schedule = window.requestIdleCallback || ((callback) => setTimeout(callback, 500));
    schedule(() => warmFrame(), { timeout: 1500 });
  };
  if (document.readyState === 'complete') beginWarmup();
  else window.addEventListener('load', beginWarmup, { once: true });
}

function onSelectionChange(e) {
  // Ignore selection churn caused by interacting with our own UI.
  if (e && e.target && ((askBubble && askBubble.contains(e.target)) || (panel && panel.contains(e.target)))) {
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
    openPanel(lastSelectionText, rect, lastSelectionContext);
    removeBubble();
  });
  document.body.appendChild(askBubble);
}

function openPanel(excerpt, rect, sourceContext) {
  closePanel();

  panel = document.createElement('div');
  panel.className = 'sideask-panel sideask-empty';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-labelledby', 'sideask-title');

  panel.innerHTML = `
    <div class="sideask-header">
      <div class="sideask-title-group">
        <div>
          <div class="sideask-title" id="sideask-title">Probe</div>
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
        <label class="sideask-visually-hidden" for="sideask-question">Your question</label>
        <div class="sideask-composer">
          <textarea id="sideask-question" class="sideask-input" placeholder="Message Probe" rows="1" maxlength="1200"></textarea>
          <button type="button" class="sideask-ask-btn" aria-label="Send question" disabled>
            <span aria-hidden="true">↑</span>
          </button>
        </div>
      </div>
    </div>
  `;

  panel.querySelector('.sideask-excerpt').textContent = truncate(excerpt, 500);
  panel.querySelector('.sideask-close').addEventListener('click', closePanel);

  const textarea = panel.querySelector('.sideask-input');
  const askBtn = panel.querySelector('.sideask-ask-btn');
  const minimizeBtn = panel.querySelector('.sideask-minimize');
  const subtitle = panel.querySelector('.sideask-subtitle');
  const thread = panel.querySelector('.sideask-thread');
  const turns = panel.querySelector('.sideask-turns');

  askBtn.addEventListener('click', submitQuestion);
  minimizeBtn.addEventListener('click', () => {
    const minimized = panel.classList.toggle('sideask-minimized');
    minimizeBtn.textContent = minimized ? '+' : '−';
    minimizeBtn.setAttribute('aria-label', minimized ? 'Restore' : 'Minimize');
    minimizeBtn.setAttribute('aria-expanded', String(!minimized));
    if (!minimized) {
      positionPanel(rect);
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
    if (!question || panelAbortController) return;

    const requestController = new AbortController();
    panelAbortController = requestController;
    const turn = createTurn(question);
    turns.appendChild(turn.element);
    panel.classList.remove('sideask-empty');
    requestAnimationFrame(() => positionPanel(rect));
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
      conversationHasContext
        ? buildFollowUpPrompt(question)
        : buildPrompt(excerpt, question, sourceContext),
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
        conversationHasContext = true;
        turn.status.textContent = 'Complete';
        subtitle.textContent = 'Answer ready';
        turn.skeleton.hidden = true;
        turn.answerBox.textContent = answer;
        turn.resultActions.hidden = false;
        thread.scrollTop = thread.scrollHeight;
        saveHistory(excerpt, question, answer);
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
        if (panelAbortController === requestController) panelAbortController = null;
        if (panel) {
          delete panel.dataset.state;
          if (!panel.classList.contains('sideask-minimized')) textarea.focus();
        }
      });
  }

  document.body.appendChild(panel);
  positionPanel(rect);
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

function positionPanel(rect) {
  const margin = 12;
  const panelRect = panel.getBoundingClientRect();
  const left = Math.max(margin, Math.min(rect.left, window.innerWidth - panelRect.width - margin));
  const below = rect.bottom + margin;
  const preferredTop = below + panelRect.height <= window.innerHeight - margin
    ? below
    : rect.top - panelRect.height - margin;
  const top = Math.max(margin, Math.min(preferredTop, window.innerHeight - panelRect.height - margin));
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}

function closePanel() {
  panelAbortController?.abort();
  panelAbortController = null;
  conversationFrame?.remove();
  conversationFrame = null;
  conversationHasContext = false;
  if (panel) {
    panel.remove();
    panel = null;
  }
  setTimeout(() => warmFrame(), 300);
}

document.addEventListener('mousedown', (e) => {
  if (panel && !panel.contains(e.target) && e.target !== askBubble) {
    closePanel();
  }
});

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

async function askInConversation(promptText, signal, onUpdate) {
  onUpdate(conversationFrame ? 'Continuing conversation' : (framePromise ? 'Connecting' : 'Preparing private chat'));
  const iframe = conversationFrame || await takeWarmFrame();
  conversationFrame = iframe;
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
    if (conversationFrame === iframe) conversationFrame = null;
    conversationHasContext = false;
    throw error;
  }
}
