// Executor adapter: maps the runner's executor.execute onto CodexExecutor
// (codex app-server) using the frozen executor snapshot and the watchdog.
// Returns structured evidence consumed by the acceptance gate.

import { CodexExecutor } from "../adapters/codex.mjs";
import { freezeExecutorSnapshot, getExecutorProvider, executorModelOf } from "../adapters/executor_provider.mjs";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Read the live ~/.codex/config.toml model/reasoning so codex_current can freeze it.
export function readCodexConfigSnapshot() {
  const p = join(homedir(), ".codex", "config.toml");
  const out = { model: null, reasoning_effort: null, service_tier: null };
  if (!existsSync(p)) return out;
  try {
    const text = readFileSync(p, "utf8");
    const m = text.match(/^model\s*=\s*"([^"]+)"/m);
    const r = text.match(/^model_reasoning_effort\s*=\s*"([^"]+)"/m);
    const s = text.match(/^service_tier\s*=\s*"([^"]+)"/m);
    if (m) out.model = m[1];
    if (r) out.reasoning_effort = r[1];
    if (s) out.service_tier = s[1];
  } catch {}
  return out;
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

  async function ensureExecutor() {
    if (executor) return;
    if (!activeSnapshot) {
      activeSnapshot = await freezeExecutorSnapshot({ resolveSnapshot: resolveSnapshot || readCodexConfigSnapshot });
    }
    const model = activeSnapshot.resolved.model;
    const profile = activeSnapshot.resolved.profile;
    const args = getExecutorProvider(activeSnapshot.provider).id === "codex_current" || !profile
      ? ["app-server", "--listen", "stdio://"]
      : ["-p", profile, "app-server", "--listen", "stdio://"];
    executor = new CodexExecutor({
      args,
      cwd,
      timeoutMs,
      idleMs,
      onApproval: req => {
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
  }

  const adapter = {
    get snapshot() { return activeSnapshot; },
    get threadId() { return threadId; },
    async status() {
      return executor ? executor.status() : { state: "not_started" };
    },

    async execute({ task, text, plan, round, timeout_ms, effort }) {
      const tid = await ensureExecutor();
      try {
        const result = await executor.sendTask({
          thread_id: tid,
          text: String(task || text),
          timeoutMs: timeout_ms || timeoutMs,
          idleMs,
          model: activeSnapshot.resolved.model || undefined,
          effort,
        });
        // compile structured evidence from the worker's text
        return {
          content: [{ type: "text", text: result.text || "" }],
          structuredContent: {
            status: "done",
            changes: extractChanges(result.text),
            tests: extractTests(result.text),
            evidence: [{ acceptance_id: "", type: "executor_text", summary: String(result.text || "").slice(0, 2000), pass: true }],
            summary: String(result.text || "").slice(0, 6000),
          },
        };
      } catch (error) {
        const code = error.code || "";
        const status = code.includes("TIMEOUT") ? "failed"
          : (String(error.message).match(/approval|permission/i) ? "awaiting_user" : "blocked");
        return {
          isError: true,
          content: [{ type: "text", text: error.message }],
          structuredContent: { status, code, reason: error.message },
        };
      }
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
