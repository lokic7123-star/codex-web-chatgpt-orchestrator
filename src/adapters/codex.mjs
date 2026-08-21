// Codex App Server JSON-RPC client with a TurnWatchdog.
// NEVER auto-approves. Approval/interaction requests surface as awaiting_user.
// Windows: npm/codex are .cmd so spawn via cmd /c on win32.

import { spawn } from "node:child_process";
import readline from "node:readline";
import os from "node:os";

export const DEFAULT_TIMEOUT_MS = 300000;       // hard timeout (5 min)
export const DEFAULT_IDLE_TIMEOUT_MS = 90000;   // idle timeout (90s)
export const FATAL_STDERR_PATTERNS = [
  /no such file/i,
  /failed to (start|launch|connect)/i,
  /authentication required/i,
  /invalid.*(credential|token|api.?key)/i,
];

const isWin = os.platform() === "win32";

function spawnCodex(args, cwd, env) {
  if (isWin) {
    // .cmd requires cmd /c on Windows
    return spawn("cmd", ["/c", "codex", ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"], shell: false });
  }
  return spawn("codex", args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
}

export class TurnWatchdog {
  constructor({ hardMs = DEFAULT_TIMEOUT_MS, idleMs = DEFAULT_IDLE_TIMEOUT_MS, onTimeout = null } = {}) {
    this.hardMs = hardMs;
    this.idleMs = idleMs;
    this.onTimeout = onTimeout;
    this.lastEventAt = 0;
    this.startedAt = 0;
    this.timer = null;
  }

  start(turnId) {
    this.startedAt = Date.now();
    this.lastEventAt = Date.now();
    this._arm(turnId);
  }

  // call on every item/delta/event to refresh idle timer
  pulse() {
    this.lastEventAt = Date.now();
  }

  _arm(turnId) {
    clearTimeout(this.timer);
    const now = Date.now();
    const elapsed = now - this.startedAt;
    const idleElapsed = now - this.lastEventAt;
    const hardLeft = Math.max(0, this.hardMs - elapsed);
    const idleLeft = Math.max(0, this.idleMs - idleElapsed);
    const wait = Math.min(hardLeft, idleLeft);
    if (wait <= 0) {
      const reason = idleLeft <= 0 ? "idle_timeout" : "hard_timeout";
      this.onTimeout?.({ turnId, reason });
      return;
    }
    this.timer = setTimeout(() => this._arm(turnId), wait + 10);
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  state() {
    return {
      started_at: this.startedAt || null,
      last_event_at: this.lastEventAt || null,
      hard_ms: this.hardMs,
      idle_ms: this.idleMs,
    };
  }
}

export class CodexExecutor {
  constructor({
    args = ["app-server", "--listen", "stdio://"],
    cwd = process.cwd(),
    env = process.env,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    idleMs = DEFAULT_IDLE_TIMEOUT_MS,
    onApproval = null,
    clientInfo = { name: "web-pro-orchestrator", title: "Web Pro Orchestrator", version: "0.1.0" },
  } = {}) {
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.timeoutMs = timeoutMs;
    this.idleMs = idleMs;
    this.onApproval = onApproval;
    this.clientInfo = clientInfo;
    this.child = null;
    this.state = "disconnected";
    this.nextId = 1;
    this.pending = new Map();
    this.turnWaiters = new Map();
    this.turnText = new Map();
    this.watchdogs = new Map();
    this.lastError = null;
  }

  async connect() {
    if (this.child && this.state === "ready") return this;
    this.state = "starting";
    this.lastError = null;
    try {
      this.child = spawnCodex(this.args, this.cwd, this.env);
    } catch (error) {
      this.state = "unavailable";
      this.lastError = String(error);
      throw Object.assign(new Error(`Codex Adapter unavailable: ${this.lastError}`), { code: "CODEX_ADAPTER_UNAVAILABLE" });
    }
    this.child.on("error", error => this._fail(error));
    this.child.on("exit", (code, signal) => {
      if (this.state !== "closed") this._fail(new Error(`codex app-server exited (${code ?? "unknown"}${signal ? `, ${signal}` : ""})`));
    });
    const rl = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    rl.on("line", line => this._handleLine(line));
    this.child.stderr?.on("data", chunk => {
      const text = String(chunk);
      this.lastError = text.trim() || this.lastError;
      for (const pat of FATAL_STDERR_PATTERNS) {
        if (pat.test(text)) {
          this._fail(Object.assign(new Error(`fatal stderr pattern: ${pat}`), { code: "CODEX_FATAL_STDERR" }));
          break;
        }
      }
    });
    await this.request("initialize", { clientInfo: this.clientInfo });
    this._send({ jsonrpc: "2.0", method: "initialized", params: {} });
    this.state = "ready";
    return this;
  }

  _send(message) {
    if (!this.child?.stdin?.writable) throw new Error("Codex Adapter is not connected");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}, { timeoutMs = this.timeoutMs } = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`request timed out: ${method}`), { code: "CODEX_ADAPTER_TIMEOUT" }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this._send({ jsonrpc: "2.0", id, method, params }); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  _handleLine(line) {
    if (!String(line).trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const p = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(p.timer);
      if (message.error) {
        const error = new Error(message.error.message || `request failed: ${p.method}`);
        error.code = message.error.code || "CODEX_REQUEST_FAILED";
        error.data = message.error.data;
        p.reject(error);
      } else {
        p.resolve(message.result);
      }
      return;
    }
    if (message.method && message.id !== undefined) {
      // A request requiring user interaction (approval, permission, etc.)
      // NEVER auto-approve. Surface as awaiting_user via onApproval.
      if (this.onApproval) this.onApproval(message);
      this._send({ jsonrpc: "2.0", id: message.id, error: { code: -32001, message: "requires user approval; surfaced as awaiting_user" } });
    }
    if (message.method) this._handleNotification(message);
  }

  _handleNotification(message) {
    const params = message.params || {};
    const turnId = params.turnId || params.turn?.id || "unknown";
    if (message.method === "item/agentMessage/delta") {
      const wd = this.watchdogs.get(turnId);
      if (wd) wd.pulse();
      this.turnText.set(turnId, `${this.turnText.get(turnId) || ""}${params.delta || ""}`);
    }
    if (message.method === "item/completed" && params.item?.type === "agentMessage") {
      const text = textFromItem(params.item);
      if (text) this.turnText.set(turnId, `${this.turnText.get(turnId) || ""}${text}`);
    }
    if (message.method === "turn/completed") {
      const wd = this.watchdogs.get(turnId);
      if (wd) { wd.stop(); this.watchdogs.delete(turnId); }
      const completed = {
        thread_id: params.threadId || null,
        turn_id: turnId || null,
        turn: params.turn || null,
        text: this.turnText.get(turnId) || "",
      };
      if (turnId && turnId !== "unknown") {
        this.completedTurns ??= new Map();
        this.completedTurns.set(turnId, completed);
        const waiter = this.turnWaiters.get(turnId);
        if (waiter) {
          this.turnWaiters.delete(turnId);
          clearTimeout(waiter.timer);
          waiter.resolve(completed);
        }
      }
    }
  }

  _fail(error) {
    const wasStarting = this.state === "starting";
    const normalized = wasStarting
      ? Object.assign(new Error(`Codex Adapter unavailable: ${String(error)}`), { code: "CODEX_ADAPTER_UNAVAILABLE" })
      : error;
    this.lastError = String(normalized);
    this.state = "unavailable";
    for (const wd of this.watchdogs.values()) wd.stop();
    this.watchdogs.clear();
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(normalized); }
    this.pending.clear();
    for (const w of this.turnWaiters.values()) { clearTimeout(w.timer); w.reject(normalized); }
    this.turnWaiters.clear();
  }

  async startThread({ thread_id, cwd = this.cwd, model = null, baseInstructions = null, approvalPolicy = null, sandbox = null } = {}) {
    await this.connect();
    const method = thread_id ? "thread/resume" : "thread/start";
    const params = thread_id
      ? { threadId: thread_id }
      : { cwd, model, baseInstructions, approvalPolicy, sandbox };
    const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== null && v !== undefined));
    const result = await this.request(method, clean);
    const thread = result?.thread || {};
    return { ...result, thread_id: thread.id || thread_id || null };
  }

  async sendTask({ thread_id, text, input, timeoutMs = this.timeoutMs, idleMs = this.idleMs, model = null, effort = null } = {}) {
    if (!thread_id) throw new Error("codex_thread_id is required");
    if (!String(text || "").trim() && !Array.isArray(input)) throw new Error("task text or input is required");
    await this.connect();
    const overrides = {};
    if (model) overrides.model = model;
    if (effort) overrides.reasoningEffort = effort;
    const reqResult = await this.request("turn/start", {
      threadId: thread_id,
      input: input || [{ type: "text", text: String(text).trim() }],
      ...overrides,
    });
    const turnId = reqResult?.turn?.id;
    if (!turnId) return { ...reqResult, thread_id, completed: false, text: "", watchdog: null };

    if (this.completedTurns?.has(turnId)) {
      return { ...reqResult, ...this.completedTurns.get(turnId), completed: true, watchdog: null };
    }

    const watchdog = new TurnWatchdog({
      hardMs: timeoutMs,
      idleMs,
      onTimeout: async ({ turnId: tid, reason }) => {
        // try interrupt first; if it fails, kill the child
        try {
          await this.request("turn/interrupt", { turnId: tid }, { timeoutMs: 15000 });
          watchdog.timeoutInfo.timed_out = reason;
        } catch {
          this._killChild();
          watchdog.timeoutInfo.killed = true;
        }
        const waiter = this.turnWaiters.get(tid);
        if (waiter) {
          this.turnWaiters.delete(tid);
          clearTimeout(waiter.timer);
          waiter.reject(Object.assign(new Error(`turn ${reason}`), { code: reason === "idle_timeout" ? "CODEX_IDLE_TIMEOUT" : "CODEX_HARD_TIMEOUT", reason }));
        }
      },
    });
    watchdog.timeoutInfo = { timed_out: null, killed: false };
    this.watchdogs.set(turnId, watchdog);
    watchdog.start(turnId);

    const completion = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.turnWaiters.delete(turnId);
        reject(Object.assign(new Error("turn timed out"), { code: "CODEX_TURN_TIMEOUT" }));
      }, timeoutMs + 30000);
      this.turnWaiters.set(turnId, { resolve, reject, timer });
    });
    watchdog.stop();
    return { ...reqResult, ...completion, completed: true, watchdog: watchdog.state() };
  }

  async readThread(thread_id) {
    if (!thread_id) throw new Error("codex_thread_id is required");
    await this.connect();
    return this.request("thread/read", { threadId: thread_id });
  }

  _killChild() {
    try { this.child?.kill?.(); } catch {}
    this.state = "closed";
  }

  close() {
    this.state = "closed";
    for (const wd of this.watchdogs.values()) wd.stop();
    this.watchdogs.clear();
    for (const p of this.pending.values()) clearTimeout(p.timer);
    for (const w of this.turnWaiters.values()) clearTimeout(w.timer);
    this.pending.clear();
    this.turnWaiters.clear();
    try { this.child?.kill?.(); } catch {}
    this.child = null;
  }

  status() {
    return {
      state: this.state,
      args: this.args,
      cwd: this.cwd,
      last_error: this.lastError,
      pending_requests: this.pending.size,
      active_turns: this.turnWaiters.size,
    };
  }
}

function textFromItem(item) {
  if (!item || typeof item !== "object") return "";
  if (typeof item.text === "string") return item.text;
  if (typeof item.message === "string") return item.message;
  if (!Array.isArray(item.content)) return "";
  return item.content.map(part => (typeof part === "string" ? part : part?.text || "")).join("");
}
