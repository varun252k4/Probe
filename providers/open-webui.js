(() => {
  const RESPONSE_SELECTOR = '#response-content-container, .chat-assistant';

  function detect(settings) {
    if (!settings.openWebUIEnabled || !isOpenWebUIPage()) return false;
    return true;
  }

  function isOpenWebUIPage() {
    try {
      if (!localStorage.getItem('token')) return false;
    } catch {
      return false;
    }
    return Boolean(document.querySelector('#chat-input, #messages-container, #response-content-container, .chat-assistant, .user-message'));
  }

  function findAssistantElement(container) {
    const response = container.closest(RESPONSE_SELECTOR);
    if (!response || response.closest('.user-message')) return null;
    return response.closest('[id^="message-"]') || response;
  }

  function getSelectionContext(assistantElement) {
    const responseContainer = assistantElement.querySelector?.('#response-content-container') || assistantElement;
    const messages = [...document.querySelectorAll('.user-message, #response-content-container')];
    const responseIndex = messages.findIndex((message) => message === responseContainer || message.contains(responseContainer));
    let userQuestion = '';
    for (let index = responseIndex - 1; index >= 0; index -= 1) {
      if (messages[index].classList.contains('user-message')) {
        userQuestion = messages[index].innerText.trim();
        break;
      }
    }
    return {
      userQuestion: userQuestion.slice(0, 4000),
      fullAnswer: responseContainer.innerText.trim().slice(0, 12000),
    };
  }

  async function ask(session, promptText, signal, onUpdate, api) {
    onUpdate('Connecting to Open WebUI');
    const token = getToken();
    if (!token) throw new Error('Open WebUI sign-in token was not found. Sign in to Open WebUI and refresh the page.');

    const model = await resolveModel(token, api.settings);
    if (!model) throw new Error('Could not find an Open WebUI model. Set a model override in Probe settings or select a model in Open WebUI.');

    const messages = [...(session.openWebUIMessages || []), { role: 'user', content: promptText }];
    onUpdate(session.openWebUIMessages?.length ? 'Continuing conversation' : 'Thinking');

    const response = await fetch(`${location.origin}/api/chat/completions`, {
      method: 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, messages, stream: true }),
    });

    if (!response.ok) throw new Error(await readError(response));

    const answerText = await readAnswer(response, signal, onUpdate);
    session.openWebUIMessages = [...messages, { role: 'assistant', content: answerText }];
    return { text: answerText, content: api.renderMarkdownishAnswer(answerText) };
  }

  function getToken() {
    try {
      return localStorage.getItem('token') || '';
    } catch {
      return '';
    }
  }

  async function resolveModel(token, settings) {
    const override = (settings.openWebUIModel || '').trim();
    if (override) return override;

    const params = new URLSearchParams(location.search);
    const urlModel = params.get('model') || params.get('models');
    if (urlModel) return urlModel.split(',').map((item) => item.trim()).find(Boolean) || '';

    const stored = readStoredModels();
    if (stored.length) return stored[0];

    const response = await fetch(`${location.origin}/api/models`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });
    if (!response.ok) return '';
    const payload = await response.json();
    const models = Array.isArray(payload) ? payload : (payload.data || []);
    const model = models.find((item) => !(item?.info?.meta?.hidden)) || models[0];
    return model?.id || '';
  }

  function readStoredModels() {
    const values = [];
    try {
      const selected = JSON.parse(sessionStorage.getItem('selectedModels') || '[]');
      if (Array.isArray(selected)) values.push(...selected);
    } catch {}
    try {
      const localSettings = JSON.parse(localStorage.getItem('settings') || '{}');
      if (Array.isArray(localSettings.models)) values.push(...localSettings.models);
    } catch {}
    return values.map((item) => String(item || '').trim()).filter(Boolean);
  }

  async function readError(response) {
    try {
      const payload = await response.json();
      return payload?.detail || payload?.error?.message || response.statusText || 'Open WebUI request failed.';
    } catch {
      return response.statusText || 'Open WebUI request failed.';
    }
  }

  async function readAnswer(response, signal, onUpdate) {
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/event-stream') || !response.body) {
      const payload = await response.json();
      return payload?.choices?.[0]?.message?.content || payload?.message?.content || payload?.content || '';
    }

    onUpdate('Writing answer');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let answer = '';

    while (true) {
      if (signal.aborted) throw new DOMException('Request cancelled.', 'AbortError');
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      lines.forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) return;
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') return;
        try {
          const chunk = JSON.parse(data);
          answer += chunk?.choices?.[0]?.delta?.content || chunk?.choices?.[0]?.message?.content || chunk?.message?.content || chunk?.content || '';
        } catch {}
      });
    }

    return answer.trim();
  }

  window.ProbeProviders.register({
    id: 'openwebui',
    detect,
    findAssistantElement,
    getSelectionContext,
    ask,
  });
})();
