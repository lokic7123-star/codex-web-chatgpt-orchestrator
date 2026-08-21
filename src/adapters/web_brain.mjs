// Brain provider as a BEHAVIOR adapter (not just DOM selector config).
// Provider exposes behavior; DOM details stay inside. Runner never touches selectors.

export const DEFAULT_BRAIN_PROVIDER = "chatgpt";

const CHATGPT_SELECTORS = Object.freeze({
  input: Object.freeze([
    '[contenteditable="true"][role="textbox"]',
    "textarea:not([disabled])",
    '[contenteditable="true"]',
  ]),
  input_names: Object.freeze(["contenteditable-role", "enabled-textarea", "contenteditable-fallback"]),
  send: Object.freeze(['button[data-testid="send-button"]']),
  assistant: Object.freeze(['[data-message-author-role="assistant"]']),
  conversation_link: Object.freeze(['a[href*="/c/"]']),
  conversation_prefixes: Object.freeze(["/c/"]),
  send_terms: Object.freeze(["send", "发送"]),
});

function makeChatgptProvider({ evaluate, providerId = "chatgpt" } = {}) {
  const sel = CHATGPT_SELECTORS;
  return {
    id: providerId,
    display_name: "ChatGPT Web",
    selection_hint: "Default planning brain. Uses chat quota, not Codex quota.",
    startUrl: "https://chatgpt.com/",
    hosts: Object.freeze(["chatgpt.com", "www.chatgpt.com"]),
    conversation_prefixes: sel.conversation_prefixes,

    // ---- behavior ----
    async detectPage() {
      // returns page/login/conversation state without assuming DOM shape
      const login = await evaluate(`(() => {
        const terms = ${JSON.stringify(["log in", "sign up", "登录", "注册"])};
        const text = (document.body ? document.body.innerText : '').slice(0, 4000);
        return terms.some(t => text.toLowerCase().includes(t.toLowerCase()));
      })()`);
      return { loggedIn: !login, host: typeof location !== "undefined" ? location.hostname : "" };
    },

    async findComposer() {
      return this._firstPresent(sel.input);
    },

    async sendMessage(text) {
      // SYNC fill: set text and fire events. Sending is done via clickSend
      // (separate call) to avoid awaiting inside a navigation-prone context.
      const value = JSON.stringify(String(text));
      return evaluate(`(() => {
        const value = ${value};
        const selectors = ${JSON.stringify(sel.input)};
        const input = selectors.map(s => document.querySelector(s)).find(el => el);
        if (!input) return { ok: false, error: 'no visible input box' };
        input.focus();
        let filled = '';
        if (input.tagName === 'TEXTAREA') {
          // React-controlled textarea (fresh-chat homepage): execCommand leaves
          // the framework state desynced (draft ends up in ?prompt-textarea= and
          // send becomes a no-op). Use the native value setter instead.
          const desc = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
          if (desc && desc.set) desc.set.call(input, value);
          else input.value = value;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          filled = input.value || '';
        } else {
          document.execCommand('insertText', false, value);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: value }));
          filled = input.innerText || '';
        }
        return { ok: Boolean(filled), text: filled, kind: input.tagName };
      })()`);
    },

    async findAndClickSend() {
      // SYNC: find the send button (by testid first, label fallback) and click.
      return evaluate(`(() => {
        const sendSelectors = ${JSON.stringify(sel.send)};
        const sendTerms = ${JSON.stringify(sel.send_terms)};
        let send = null;
        for (const s of sendSelectors) {
          const el = document.querySelector(s);
          if (el) { send = el; break; }
        }
        if (!send) {
          send = [...document.querySelectorAll('button')].find(b => {
            const label = ((b.getAttribute('aria-label') || '') + ' ' + (b.innerText || '')).toLowerCase();
            return sendTerms.some(t => label.includes(t.toLowerCase()));
          });
        }
        if (!send) return { ok: false, error: 'no send button' };
        if (send.disabled || send.getAttribute('aria-disabled') === 'true') {
          return { ok: false, error: 'send button disabled', retry: true };
        }
        send.click();
        return { ok: true, via: send.getAttribute('data-testid') || 'label' };
      })()`);
    },

    async countAssistantMessages() {
      return evaluate(`(() => {
        const selectors = ${JSON.stringify(sel.assistant)};
        for (const s of selectors) {
          const n = document.querySelectorAll(s).length;
          if (n > 0) return n;
        }
        return 0;
      })()`);
    },

    async readLatestAssistant() {
      return evaluate(`(() => {
        const selectors = ${JSON.stringify(sel.assistant)};
        for (const s of selectors) {
          const nodes = [...document.querySelectorAll(s)];
          if (nodes.length) return nodes[nodes.length - 1].innerText || '';
        }
        return '';
      })()`);
    },

    async isGenerating() {
      return evaluate(`(() => {
        const terms = ${JSON.stringify(["stop", "generating", "停止", "生成中"])};
        const text = (document.body ? document.body.innerText : '').slice(0, 3000).toLowerCase();
        return terms.some(t => text.includes(t.toLowerCase()));
      })()`);
    },

    async getConversationIdentity() {
      const data = await evaluate(`(() => {
        const href = location.href;
        let url = null;
        try { url = new URL(href); } catch {}
        const path = url ? url.pathname : '';
        const prefixes = ${JSON.stringify(sel.conversation_prefixes)};
        const links = ${JSON.stringify(sel.conversation_link)};
        const currentLink = document.querySelector(links[0]);
        const rawTitle = (currentLink?.getAttribute('aria-label') || currentLink?.innerText || document.title || '').trim();
        const title = rawTitle.replace('，已置顶对话', '').replace('（未读）', '').trim();
        let id = null;
        for (const p of prefixes) {
          if (path.toLowerCase().startsWith(p.toLowerCase())) {
            const rem = path.slice(p.length).split('/')[0];
            if (/^[A-Za-z0-9_-]+$/.test(rem)) id = rem;
          }
        }
        return { url: href, path, title, id, is_conversation: Boolean(prefixes.some(p => path.toLowerCase().startsWith(p.toLowerCase()))) };
      })()`);
      return { provider: this.id, external_id: data.id || null, canonical_url: data.url || null, title: data.title || null };
    },

    async listConversations(query = "") {
      const q = JSON.stringify(String(query || "").trim().toLowerCase());
      return evaluate(`(() => {
        const query = ${q};
        const seen = new Set();
        const selectors = ${JSON.stringify(sel.conversation_link)};
        return selectors.flatMap(s => [...document.querySelectorAll(s)]).map(a => {
          const url = a.href.split('?')[0];
          const rawTitle = (a.getAttribute('aria-label') || a.innerText || '').trim();
          const title = rawTitle.replace('，已置顶对话', '').replace('（未读）', '').trim();
          return { title, url, current: url === location.href.split('?')[0] };
        }).filter(i => i.title && !seen.has(i.url) && seen.add(i.url))
          .filter(i => !query || i.title.toLowerCase().includes(query));
      })()`);
    },

    async healthCheck() {
      const inputSelectors = JSON.stringify(sel.input);
      const inputNames = JSON.stringify(sel.input_names);
      const sendSelectors = JSON.stringify(sel.send);
      const sendTerms = JSON.stringify(sel.send_terms);
      return evaluate(`(() => {
        const inputSelectors = ${inputSelectors};
        const inputNames = ${inputNames};
        const sendSelectors = ${sendSelectors};
        const sendTerms = ${sendTerms};
        const buttons = [...document.querySelectorAll('button')];
        const sendByLabel = buttons.some(b => {
          const label = ((b.getAttribute('aria-label') || '') + ' ' + (b.innerText || '')).toLowerCase();
          return sendTerms.some(t => label.includes(t.toLowerCase()));
        });
        const strategies = inputSelectors.map((s, i) => ({
          name: inputNames[i] || ('input-' + i),
          input: s,
          send: Boolean(document.querySelector(s) && (sendSelectors.some(x => document.querySelector(x)) || sendByLabel)),
        }));
        return { ok: strategies.some(x => x.send), strategies };
      })()`);
    },

    // ---- internal helper ----
    async _firstPresent(selectors) {
      for (const s of selectors) {
        const found = await evaluate(`Boolean(document.querySelector(${JSON.stringify(s)}))`);
        if (found) return s;
      }
      return null;
    },
  };
}

export function createBrainProvider(providerId = DEFAULT_BRAIN_PROVIDER, { evaluate } = {}) {
  if (providerId === "chatgpt") return makeChatgptProvider({ evaluate, providerId });
  const error = new Error(`unsupported brain_provider: ${providerId}`);
  error.code = "BRAIN_PROVIDER_UNSUPPORTED";
  throw error;
}

export function listBrainProviders() {
  return [
    { id: "chatgpt", display_name: "ChatGPT Web", selection_hint: "Default planning brain. Uses chat quota, not Codex quota.", start_url: "https://chatgpt.com/" },
  ];
}

export function providerMatchesUrl(providerOrHosts, rawUrl) {
  const hosts = Array.isArray(providerOrHosts) ? providerOrHosts : providerOrHosts.hosts;
  try {
    const url = new URL(String(rawUrl || ""));
    return hosts.includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}
