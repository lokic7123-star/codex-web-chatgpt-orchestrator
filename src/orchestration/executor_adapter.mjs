// Executor adapter: maps the runner's executor.execute onto CodexExecutor
// (codex app-server) using the frozen executor snapshot and the watchdog.
// Returns structured evidence consumed by the acceptance gate.

import { CodexExecutor } from "../adapters/codex.mjs";
import { freezeExecutorSnapshot } from "../adapters/executor_provider.mjs";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Read the live ~/.codex/config.toml model/reasoning so codex_current can freeze it.
// Section-aware: only TOP-LEVEL keys count (a `model=` inside [profile.x] must
// not leak into the frozen snapshot).
export function readCodexConfigSnapshot() {
  const p = join(homedir(), ".codex", "config.toml");
  const out = { model: null, reasoning_effort: null, service_tier: null };
  if (!existsSync(p)) return out;
  try {
    let section = "";
    for (const rawLine of readFileSync(p, "utf8").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const sec = line.match(/^\[+([^\]]+)\]+$/);
      if (sec) { section = sec[1].trim().toLowerCase(); continue; }
      if (section) continue;
      const kv = line.match(/^(model|model_reasoning_effort|service_tier)\s*=\s*"([^"]*)"/);
      if (!kv) continue;
      const key = kv[1] === "model_reasoning_effort" ? "reasoning_effort" : kv[1];
      if (out[key] == null) out[key] = kv[2] || null;
    }
  } catch {}
  return out;
}

/**
 * Map the worker's raw output onto the plan's acceptance criteria so the
 * acceptance gate can match evidence ids. The worker's own success flag sets
 * pass; the brain's review still independently judges completion on top.
 */
export function buildExecutorEvidence({ plan = null, text = "", isError = false } = {}) {
  const summary = String(text ?? "").slice(0, 2000);
  const pass = !isError;
  const raw = Array.isArray(plan?.acceptance) ? plan.acceptance : [];
  const ids = raw.map((a, i) => (typeof a === "string" ? `A${i + 1}` : String(a?.id || `A${i + 1}`)));
  if (!ids.length) return [{ acceptance_id: "", type: "executor_text", summary, pass }];
  return ids.map(id => ({ acceptance_id: id, type: "executor_text", summary, pass }));
}

export function createExecutorAdapter({
  cwd = process.cwd(),
  snapshot = null,
  resolveSnapshot = null,
  onApproval = null,
  timeoutMs = 300000,
  idleMs = 90000,
} = {}) {
  let executor = null;
  let activeSnapshot = snapshot;
  let threadId = null;
  let pendingApproval = null;
  let ensuring = null;

  const summarizeApproval = req => {
    try {
      return `${req.method || "approval"} ${JSON.stringify(req.params || {}).slice(0, 260)}`;
    } catch {
      return String(req?.method || "approval");
    }
  };

  // in-flight guard: concurrent ensure calls share one spawn (audit F2)
  function ensureExecutor() {
    if (executor) return Promise.resolve(threadId);
    if (!ensuring) {
      ensuring = (async () => {
        if (!activeSnapshot) {
          activeSnapshot = await freezeExecutorSnapshot({ resolveSnapshot: resolveSnapshot || readCodexConfigSnapshot });
        }
        const model = activeSnapshot.resolved.model;
        const args = ["app-server", "--listen", "stdio://"];
        executor = new CodexExecutor({
          args,
          cwd,
          timeoutMs,
          idleMs,
          onApproval: req => {
            pendingApproval = summarizeApproval(req);
            if (typeof onApproval === "function") onApproval(req);
          },
        });
        const started = await executor.startThread({
          model: model || undefined,
          cwd,
          sandbox: "workspace-write", // allow the worker to write within the workspace (e.g. create files)
        });
        threadId = started.thread_id;
        return threadId;
      })().catch(error => {
        // startThread failed (auth, bad model, crash): discard the
        // half-initialized executor so the next execute can retry cleanly —
        // keeping it would short-circuit every retry into a misleading
        // "codex_thread_id is required" error (audit F6b)
        try { executor?.close?.(); } catch {}
        executor = null;
        threadId = null;
        throw error;
      }).finally(() => { ensuring = null; });
    }
    return ensuring;
  }

  const adapter = {
    get snapshot() { return activeSnapshot; },
    get threadId() { return threadId; },
    async status() {
      return executor ? executor.status() : { state: "not_started" };
    },

    async execute({ task, text, plan, round, timeout_ms, effort }) {
      const tid = await ensureExecutor();
      pendingApproval = null;
      try {
        const result = await executor.sendTask({
          thread_id: tid,
          text: String(task || text),
          timeoutMs: timeout_ms || timeoutMs,
          idleMs,
          model: activeSnapshot.resolved.model || undefined,
          effort,
        });
        // compile structured evidence from the worker's text, mapped onto the
        // plan's acceptance ids so the acceptance gate can match them
        return {
          content: [{ type: "text", text: result.text || "" }],
          structuredContent: {
            status: "done",
            changes: extractChanges(result.text),
            tests: extractTests(result.text),
            evidence: buildExecutorEvidence({ plan, text: result.text || "", isError: false }),
            summary: String(result.text || "").slice(0, 6000),
          },
        };
      } catch (error) {
        const code = error.code || "";
        const isApproval = /approval|permission/i.test(String(error.message || ""));
        const status = code.includes("TIMEOUT") ? "failed"
          : (isApproval ? "awaiting_user" : "blocked");
        const reason = isApproval && pendingApproval
          ? `${error.message} [approval request: ${pendingApproval}]`
          : error.message;
        return {
          isError: true,
          content: [{ type: "text", text: reason }],
          structuredContent: { status, code, reason, approval: isApproval ? pendingApproval : undefined },
        };
      }
    },

    async rollover(baseInstructions = "") {
      // start a FRESH thread on the same app-server child, seeding it with the
      // checkpoint summary so the new thread keeps goal context (design §10)
      await ensureExecutor();
      const started = await executor.startThread({
        model: activeSnapshot.resolved.model || undefined,
        cwd,
        sandbox: "workspace-write",
        baseInstructions: String(baseInstructions || "").trim() || undefined,
      });
      threadId = started.thread_id;
      return threadId;
    },

    async close() {
      if (executor) executor.close();
      executor = null;
    },
  };

  return adapter;
}

function extractChanges(text) {
  if (!text) return [];
  return (String(text).match(/(?:modified|created|deleted|updated)[:\s]+[^\n]+/gi) || []).slice(0, 20);
}

function extractTests(text) {
  if (!text) return [];
  return (String(text).match(/(?:test|passed|failed)[:\s]+[^\n]+/gi) || []).slice(0, 20);
}
