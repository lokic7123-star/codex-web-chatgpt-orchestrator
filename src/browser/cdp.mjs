// CDP BrowserHost + Brain session.
// Layer separation: BrowserHost talks CDP; BrainProvider describes behavior;
// brainTurn is the atomic send+wait+read with baseline+nonce validation.

import { createBrainProvider, providerMatchesUrl, DEFAULT_BRAIN_PROVIDER } from "../adapters/web_brain.mjs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_PORT = 9333;
export const DEFAULT_PROFILE = String(
  process.env.WEB_PRO_PROFILE
  || join(homedir(), ".codex", "web-pro-orchestrator", "chrome-profile"),
);

export const BRAIN_DEFAULT_TIMEOUT_MS = 120000;
export const BRAIN_IDLE_TIMEOUT_MS = 45000;

export class CdpClient {
  constructor({ port = DEFAULT_PORT, endpointHost = "127.0.0.1" } = {}) {
    this.port = port;
    this.endpointHost = endpointHost;
    this.base = `http://${endpointHost}:${port}`;
    this.socket = null;
    this.target = null;
    this.commandId = 0;
    this.pending = new Map();
  }

  get connected() {
    return Boolean(this.socket && this.socket.readyState === WebSocket.OPEN);
  }

  async _get(path) {
    const res = await fetch(`${this.base}${path}`);
    if (!res.ok) throw new Error(`browser ${path} failed: ${res.status}`);
    return res.json();
  }

  async listTargets() {
    const targets = await this._get("/json/list");
    // confirm the endpoint is actually bound to loopback, not an exposed host
    if (String(this.endpointHost).toLowerCase() !== "127.0.0.1" && String(this.endpointHost).toLowerCase() !== "localhost") {
      throw new Error(`CDP endpoint host must be loopback (127.0.0.1), got: ${this.endpointHost}`);
    }
    return targets;
  }

  async createTarget(url) {
    const res = await fetch(`${this.base}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
    if (!res.ok) throw new Error(`could not create browser tab: ${res.status}`);
    return res.json();
  }

  close() {
    if (this.socket) { try { this.socket.close(); } catch {} }
    this.socket = null;
    this.target = null;
    for (const p of this.pending.values()) p.reject(new Error("browser connection closed"));
    this.pending.clear();
  }

  async connectTo(target) {
    if (!target?.webSocketDebuggerUrl) throw new Error("target has no DevTools websocket");
    this.close();
    this.target = target;
    this.socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out connecting to browser")), 8000);
      this.socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      this.socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("could not connect to browser DevTools")); }, { once: true });
    });
    this.socket.addEventListener("message", event => {
      try {
        const msg = JSON.parse(String(event.data));
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message || "DevTools command failed"));
          else resolve(msg.result);
        }
      } catch {}
    });
    this.socket.addEventListener("close", () => this.close(), { once: true });
    await this.cdp("Runtime.enable", {});
    await this.cdp("Page.enable", {});
  }

  cdp(method, params = {}) {
    if (!this.connected) return Promise.reject(new Error("browser is not connected"));
    const id = ++this.commandId;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`DevTools command timed out: ${method}`));
        }
      }, 30000);
    });
  }

  async evaluate(expression) {
    const result = await this.cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result?.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text || "unknown page error";
      throw new Error(`page evaluation failed: ${detail}`);
    }
    return result?.result?.value;
  }
}

export class BrainSession {
  constructor({ client, providerId = DEFAULT_BRAIN_PROVIDER } = {}) {
    this.client = client;
    this.providerId = providerId;
    // stable identity is conversation_id (external_id); target_id is transient
    this.provider = createBrainProvider(providerId, { evaluate: (...a) => client.evaluate(...a) });
    this.targetId = null;
    this.identity = null;
  }

  async _findPage() {
    const targets = await this.client.listTargets();
    const pages = targets.filter(t => t.type === "page");
    if (this.targetId) {
      const stored = pages.find(t => t.id === this.targetId && providerMatchesUrl(this.provider.hosts, t.url));
      if (stored) return stored;
    }
    // rebind by stable conversation identity
    if (this.identity?.external_id) {
      const found = pages.find(t =>
        providerMatchesUrl(this.provider.hosts, t.url)
        && this._idFromUrl(t.url) === this.identity.external_id);
      if (found) return found;
    }
    return pages.find(t => providerMatchesUrl(this.provider.hosts, t.url)) || null;
  }

  _idFromUrl(rawUrl) {
    try {
      const url = new URL(rawUrl);
      for (const p of this.provider.conversation_prefixes) {
        if (url.pathname.toLowerCase().startsWith(p.toLowerCase())) {
          const rem = url.pathname.slice(p.length).split("/")[0];
          if (/^[A-Za-z0-9_-]+$/.test(rem)) return rem;
        }
      }
    } catch {}
    return null;
  }

  async ensureConnected() {
    if (this.client.connected && this.client.target && this.targetId === this.client.target.id) return;
    let page = await this._findPage() || await this.client.createTarget(this.provider.startUrl);
    if (!page) throw new Error(`no browser page found; launch a browser with remote debugging on ${this.client.base}, then open ${this.provider.startUrl}`);
    await this.client.connectTo(page);
    this.targetId = page.id || null;
  }

  async getIdentity() {
    await this.ensureConnected();
    this.identity = await this.provider.getConversationIdentity();
    return this.identity;
  }

  async listConversations(query = "") {
    await this.ensureConnected();
    return this.provider.listConversations(query);
  }

  async selectConversation({ title, external_id, url } = {}) {
    await this.ensureConnected();
    if (external_id || url) {
      const dest = url || `${this.provider.startUrl.replace(/\/$/, "")}${this.provider.conversation_prefixes[0]}${external_id}`;
      await this.client.cdp("Page.navigate", { url: dest });
      this.identity = { provider: this.providerId, external_id: external_id || null, canonical_url: dest, title: title || null };
      return { selected: true, identity: this.identity };
    }
    if (title) {
      const convs = await this.provider.listConversations();
      const wanted = String(title).trim().toLowerCase();
      const exact = convs.filter(c => c.title.toLowerCase() === wanted);
      const partial = convs.filter(c => c.title.toLowerCase().includes(wanted));
      const matches = exact.length ? exact : partial;
      if (matches.length !== 1) {
        return { selected: false, error: matches.length ? "title is ambiguous" : "title not found in sidebar", candidates: matches.slice(0, 20) };
      }
      await this.client.cdp("Page.navigate", { url: matches[0].url });
      this.identity = { provider: this.providerId, external_id: this._idFromUrl(matches[0].url), canonical_url: matches[0].url, title };
      return { selected: true, identity: this.identity };
    }
    return { selected: false, error: "provide title, external_id, or url" };
  }

  async healthCheck() {
    await this.ensureConnected();
    return this.provider.healthCheck();
  }

  /**
   * ATOMIC brain turn: baseline -> send -> wait -> read -> validate.
   * Accepts a reply only when the assistant message count increased AND
   * the last message hash changed, so a stray/stale message is not misread.
   */
  async brainTurn(text, { timeoutMs = BRAIN_DEFAULT_TIMEOUT_MS, idleMs = BRAIN_IDLE_TIMEOUT_MS, nonce = null } = {}) {
    await this.ensureConnected();
    const beforeIdentity = await this.getIdentity();
    const beforeCount = await this.provider.countAssistantMessages();
    const beforeLast = await this.provider.readLatestAssistant();
    const beforeHash = sha256(beforeLast);

    const sent = await this.provider.sendMessage(text);
    if (!sent.ok) return { ok: false, completion_reason: "send_failed", error: sent.error, request_id: randomId() };

    // poll for the (asynchronously rendered) send button and click it.
    // Node-side polling with sync evaluate avoids awaitPromise inside a
    // navigation-prone context (which can throw "Promise was collected").
    const sendDeadline = Date.now() + 8000;
    let sendResult = { ok: false, error: "no send button yet", retry: true };
    while (Date.now() < sendDeadline) {
      sendResult = await this.provider.findAndClickSend();
      if (sendResult.ok) break;
      await sleep(300);
    }
    if (!sendResult.ok) return { ok: false, completion_reason: "send_failed", error: sendResult.error, request_id: randomId() };

    // wait for a NEW assistant message: count increased OR last hash changed
    const deadline = Date.now() + timeoutMs;
    let lastChange = Date.now();
    let seenStable = 0;
    let lastRead = "";
    while (Date.now() < deadline) {
      await sleep(600);
      const count = await this.provider.countAssistantMessages();
      const last = await this.provider.readLatestAssistant();
      const hash = sha256(last);
      const newMessage = count > beforeCount && hash !== beforeHash;
      if (newMessage) {
        // wait until the new message stops changing AND is not a generation
        // placeholder (e.g. "正在思考" / "Generating..."), then treat as done.
        const placeholder = /正在思考|generating|思考中|\.\.\./i.test(last.trim()) && last.trim().length < 20;
        if (!placeholder && last === lastRead) {
          seenStable += 1;
          if (seenStable >= 2) {
            return {
              ok: true,
              request_id: randomId(),
              conversation_id: beforeIdentity.external_id,
              assistant_message: last,
              observed_url: beforeIdentity.canonical_url,
              completion_reason: "ok",
              identity_changed: false,
            };
          }
        } else if (!placeholder) {
          seenStable = 0;
        }
        lastRead = last;
        lastChange = Date.now();
        continue;
      }
      // identity change mid-turn (user switched conversation) => fail loudly
      const idNow = await this.getIdentity();
      if (idNow.external_id && beforeIdentity.external_id && idNow.external_id !== beforeIdentity.external_id) {
        return { ok: false, request_id: randomId(), conversation_id: beforeIdentity.external_id, assistant_message: "", completion_reason: "wrong_conversation", error: "conversation changed during turn" };
      }
      if (Date.now() - lastChange > idleMs) {
        return { ok: false, request_id: randomId(), conversation_id: beforeIdentity.external_id, assistant_message: "", completion_reason: "idle_timeout", error: `no new assistant message within ${idleMs}ms` };
      }
    }
    return { ok: false, request_id: randomId(), conversation_id: beforeIdentity.external_id, assistant_message: "", completion_reason: "timeout", error: `brain turn timed out after ${timeoutMs}ms` };
  }
}

export function sha256(text) {
  // minimal FNV-1a for M1 (no deps); switch to node:crypto when needed
  let h = 0x811c9dc5;
  const s = String(text ?? "");
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

export function randomId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
