# Probe

**Focused follow-up conversations for ChatGPT and Open WebUI.**

Probe lets you select any part of a ChatGPT or Open WebUI response and ask questions about
that exact passage in a separate, contextual conversation. Your original chat
stays focused while you clarify, challenge, or explore the details that matter.

## The Problem

Long ChatGPT conversations become difficult to follow when every clarification
is added to the main thread. A small question about one sentence can interrupt
the original task, bury useful context, and make the conversation harder to
scan later.

Probe gives those side questions their own space. It carries over the selected
passage and its surrounding context, so you can investigate one idea without
changing the direction of the main chat.

## How Probe Helps

1. Select text inside a ChatGPT response.
2. Choose **Ask with Probe** beside the selection.
3. Ask a focused question in the compact Probe card.
4. Continue with follow-up questions while the card remains open.

Each answer appears beside the Probe **P** logo. Press **Enter** to send,
**Shift+Enter** for a new line, minimize the card when you need more room, or
close it to end the temporary conversation.

## Features

- **Selection-based context:** Start from the exact sentence or passage you
  want to explore.
- **Separate conversation:** Keep clarifications out of the main ChatGPT
  thread.
- **Context-aware follow-ups:** Continue asking questions without selecting the
  source text again.
- **Streaming answers:** Read the response as it is generated.
- **Compact interface:** Use a responsive card that can be minimized or closed.
- **Native appearance:** Automatically follows the active chat UI theme.
- **No API key:** Uses your existing signed-in ChatGPT or Open WebUI session.
- **Provider modules:** ChatGPT and Open WebUI support live in separate provider
  scripts selected by a detector at runtime.
- **Temporary sessions:** On ChatGPT, closing the card removes the hidden
  Temporary Chat session.
- **Local history:** Stores up to 50 recent Probe exchanges per ChatGPT
  conversation in browser extension storage.

## Privacy

Probe sends the selected excerpt, the nearby user question, and the surrounding
AI response to the active provider through your existing signed-in session. On
ChatGPT this uses a hidden Temporary Chat. On Open WebUI this uses the same-origin
Open WebUI chat completion API for the domain you are already using.

Probe has no developer-controlled backend, does not store API keys or
authentication cookies, and does not transmit your content to a third-party
service. Recent question-and-answer entries are stored locally in your browser
through `chrome.storage.local`.

## Availability

Probe is built for Microsoft Edge, ChatGPT, and Open WebUI. Open WebUI support
works on custom domains by detecting the Open WebUI app at runtime instead of
hard-coding one hostname. Installation and Edge deployment instructions are
available in [INSTALLATION.md](INSTALLATION.md).

## Current Limitations

- Probe depends on each provider's page structure, which can change over time.
- The ChatGPT temporary background conversation uses additional browser memory
  while the Probe card is open.
- Open WebUI support requires a signed-in Open WebUI page with an available model.

## Disclaimer

Probe is an independent browser extension and is not affiliated with, endorsed
by, or sponsored by OpenAI or Open WebUI. ChatGPT is a trademark of OpenAI.
