(() => {
  const ASSISTANT_SELECTOR = '[data-message-author-role="assistant"], .agent-turn';
  const SELECTORS = {
    input: '#prompt-textarea',
    sendButton: 'button[data-testid="send-button"]',
    stopButton: 'button[data-testid="stop-button"], button[aria-label="Stop generating"]',
    assistantMessage: '[data-message-author-role="assistant"]',
  };
  const FRAME_URL = 'https://chatgpt.com/?temporary-chat=true';
  const REQUEST_TIMEOUT_MS = 180000;

  let framePromise = null;

  function detect() {
    return /^(chatgpt\.com|chat\.openai\.com)$/i.test(location.hostname);
  }

  function findAssistantElement(container) {
    return container.closest(ASSISTANT_SELECTOR);
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

  function warmup(api) {
    if (framePromise) return framePromise;
    framePromise = createHiddenFrame(FRAME_URL).then(async (iframe) => {
      try {
        const doc = iframe.contentDocument;
        if (!doc) throw new Error('Could not access the private response session.');
        await api.waitForElement(doc, SELECTORS.input);
        return iframe;
      } catch (error) {
        iframe.remove();
        throw error;
      }
    });
    framePromise.catch(() => { framePromise = null; });
    return framePromise;
  }

  async function takeWarmFrame(api) {
    const pendingFrame = warmup(api);
    try {
      return await pendingFrame;
    } finally {
      if (framePromise === pendingFrame) framePromise = null;
    }
  }

  function waitForAnswer(doc, initialCount, signal, onUpdate, api) {
    return new Promise((resolve, reject) => {
      let lastSignature = '';
      let lastChangeAt = Date.now();

      const finish = (error, answer) => {
        clearInterval(checkInterval);
        clearTimeout(timeout);
        signal.removeEventListener('abort', onAbort);
        error ? reject(error) : resolve(answer);
      };
      const onAbort = () => finish(new DOMException('Request cancelled.', 'AbortError'));
      let settling = false;
      const check = () => {
        const messages = doc.querySelectorAll(SELECTORS.assistantMessage);
        if (messages.length <= initialCount) return;
        const node = messages[messages.length - 1];
        const text = node.textContent.trim();
        const images = [...node.querySelectorAll('img')].map((img) => img.getAttribute('src') || '').filter(Boolean);
        const signature = `${text.length}:${text.slice(-160)}#${images.join('|')}`;
        if (signature !== lastSignature && (text || images.length)) {
          lastSignature = signature;
          lastChangeAt = Date.now();
          onUpdate(images.length && !text ? 'Rendering image' : 'Writing answer');
        }
        const isGenerating = Boolean(doc.querySelector(SELECTORS.stopButton));
        if (lastSignature && !isGenerating && !settling && Date.now() - lastChangeAt >= 700) {
          settling = true;
          api.revealCollapsedCode(node);
          setTimeout(() => finish(null, api.extractAnswer(node)), 450);
        }
      };

      const checkInterval = setInterval(check, 220);
      const timeout = setTimeout(() => finish(new Error('The response timed out. Please try again.')), REQUEST_TIMEOUT_MS);
      signal.addEventListener('abort', onAbort, { once: true });
      check();
    });
  }

  async function ask(session, promptText, signal, onUpdate, api) {
    onUpdate(session.frame ? 'Continuing conversation' : (framePromise ? 'Connecting' : 'Preparing private chat'));
    const iframe = session.frame || await takeWarmFrame(api);
    session.frame = iframe;
    try {
      if (signal.aborted) throw new DOMException('Request cancelled.', 'AbortError');
      const doc = iframe.contentDocument;
      if (!doc) throw new Error('Could not access the private response session.');
      const input = await api.waitForElement(doc, SELECTORS.input);
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
      const sendBtn = await api.waitForElement(
        doc,
        SELECTORS.sendButton,
        (button) => !button.disabled && button.getAttribute('aria-disabled') !== 'true'
      );
      if (signal.aborted) throw new DOMException('Request cancelled.', 'AbortError');
      onUpdate('Thinking');
      sendBtn.click();
      return await waitForAnswer(doc, initialCount, signal, onUpdate, api);
    } catch (error) {
      iframe.remove();
      if (session.frame === iframe) session.frame = null;
      session.hasContext = false;
      throw error;
    }
  }

  function closeSession(session) {
    session.frame?.remove();
    session.frame = null;
  }

  window.ProbeProviders.register({
    id: 'chatgpt',
    detect,
    findAssistantElement,
    getSelectionContext,
    warmup,
    ask,
    closeSession,
  });
})();
