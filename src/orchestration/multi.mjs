// Multi-session orchestration: N isolated brain-hand loops in ONE process.
//
// Isolation per session:
//   - dedicated chatgpt.com tab (exclusive BrainSession: never steals an
//     unbound tab; rebinds only by its own target/conversation identity)
//   - dedicated codex app-server child + workspace cwd (executor adapter)
//   - own runner state machine and registry record
//
// Phase 1 binds tabs/conversations sequentially (no /json/new races),
// Phase 2 runs all loops concurrently via Promise.allSettled: one session
// failing must not take the others down.

import { CdpClient, BrainSession } from "../browser/cdp.mjs";
import { createBrainAdapter } from "./brain_adapter.mjs";
import { createExecutorAdapter } from "./executor_adapter.mjs";
import { ensureWorktree } from "./worktree.mjs";
import { TERMINAL_STATUSES } from "../../scripts/protocol.mjs";
import { createRunner, newState } from "./runner.mjs";
import { resolve, sep } from "node:path";

const clipStr = (v, n) => String(v ?? "").slice(0, n);

// Persistable runner-state snapshot: bounded (history/fingerprints capped,
// bulky report text dropped — it is rebuilt by the executor each round).
export function snapshotRunnerState(s = {}) {
  const roundNum = Number.isInteger(Number(s.round)) ? Number(s.round) : 0;
  return {
    mode: s.mode,
    goal: s.goal,
    constraints: Array.isArray(s.constraints) ? s.constraints : [],
    maxRounds: s.maxRounds,
    round: roundNum,
    checkpoint: s.checkpoint ? clipStr(s.checkpoint, 6000) : null,
    executor_generation: s.executor_generation ?? 1,
    history: Array.isArray(s.history) ? s.history.slice(-10) : [],
    // keep only fingerprints of rounds that will NOT be re-executed; the
    // round being redone already left one, and carrying it over would make
    // the stagnation detector misfire "repeated" on the first resumed round
    workspaceFingerprints: Array.isArray(s.workspaceFingerprints) ? s.workspaceFingerprints.slice(0, roundNum) : [],
    latestPlan: s.latestPlan ? {
      status: s.latestPlan.status || "continue",
      task: clipStr(s.latestPlan.task, 1000),
      acceptance: Array.isArray(s.latestPlan.acceptance) ? s.latestPlan.acceptance : [],
      reason: clipStr(s.latestPlan.reason, 500),
    } : null,
    latestReview: s.latestReview ? {
      status: s.latestReview.status || "continue",
      reason: clipStr(s.latestReview.reason, 500),
    } : null,
  };
}

// Restore a saved snapshot for continuation. Sanitizes terminal markers so a
// previously stopped run (blocked/max_rounds/...) can actually continue:
// terminal reviews are cleared; only a "continue" plan survives as the
// pending task. Returns null when nothing restorable is saved.
export function restoreRunnerState(saved, { goal, constraints } = {}) {
  if (!saved || typeof saved !== "object") return null;
  if (saved.mode !== "brain-hand" || !Number.isInteger(Number(saved.round))) return null;
  const st = { ...newState(goal ?? saved.goal ?? "", constraints ?? []), ...saved, goal: goal ?? saved.goal ?? "", constraints: constraints ?? [] };
  st.round = Number(saved.round);
  if (st.latestReview && TERMINAL_STATUSES.has(st.latestReview.status)) st.latestReview = null;
  if (st.latestPlan && TERMINAL_STATUSES.has(st.latestPlan.status) && st.latestPlan.status !== "continue") st.latestPlan = null;
  st.history = Array.isArray(st.history) ? st.history : [];
  st.executor_generation = st.executor_generation ?? 1;
  st.checkpoint = st.checkpoint ?? null;
  return st;
}

export function normalizeEntries(spec) {
  const arr = Array.isArray(spec)
    ? spec
    : Array.isArray(spec?.sessions) ? spec.sessions : null;
  if (!arr || arr.length === 0) {
    throw new Error("spec must be an array of {name, goal, cwd} entries (or {sessions:[...]})");
  }
  if (arr.length > 8) throw new Error("at most 8 parallel sessions are supported");
  return arr.map((e, i) => {
    if (!e?.goal) throw new Error(`spec[${i}]: "goal" is required`);
    if (!e?.cwd) throw new Error(`spec[${i}]: "cwd" is required`);
    const maxRounds = e.max_rounds != null ? Number(e.max_rounds) : null;
    if (maxRounds != null && (!Number.isInteger(maxRounds) || maxRounds < 1)) {
      throw new Error(`spec[${i}]: max_rounds must be a positive integer`);
    }
    const threadRounds = e.thread_rounds != null ? Number(e.thread_rounds) : null;
    if (threadRounds != null && (!Number.isInteger(threadRounds) || threadRounds < 1)) {
      throw new Error(`spec[${i}]: thread_rounds must be a positive integer`);
    }
    return {
      name: String(e.name || `session-${i + 1}`),
      goal: String(e.goal),
      cwd: String(e.cwd),
      max_rounds: maxRounds,
      thread_rounds: threadRounds,
      fresh: e.fresh === true,
      worktree: e.worktree === true,
      constraints: Array.isArray(e.constraints) ? e.constraints.map(String) : [],
      conversation: e.conversation && typeof e.conversation === "object" ? e.conversation : null,
    };
  });
}

// Optional guardrail: every session cwd must fall under one of the allowed
// roots (protects against a typo'd spec pointing the worker at system dirs).
export function validateAllowedCwds(entries, allowedRoots) {
  const roots = (Array.isArray(allowedRoots) ? allowedRoots : [])
    .map(r => normPath(String(r || "")))
    .filter(Boolean);
  if (!roots.length) return;
  for (const e of entries) {
    const c = normPath(String(e.cwd));
    const ok = roots.some(r => c === r || c.startsWith(r.endsWith(sep) ? r : r + sep));
    if (!ok) {
      throw new Error(`session "${e.name}": cwd "${e.cwd}" is outside allowed_cwds (${roots.join(", ")})`);
    }
  }
}

function normPath(p) {
  if (!p) return "";
  let r = resolve(p);
  if (process.platform === "win32") r = r.toLowerCase();
  return r.endsWith(sep) ? r.slice(0, -sep.length) : r;
}

export async function runParallelSessions({ entries, manager, port, onLog = null }) {
  const log = msg => {
    try { onLog?.(msg); } catch {}
    process.stderr.write(`[multi] ${msg}\n`);
  };

  // Phase 1 (sequential): bind every session to its OWN tab / conversation.
  // Resume semantics: a session NAME reopens its recorded conversation and
  // rebinds to the existing tab showing it — no new tab, no new conversation.
  const prepared = [];
  try {
    for (const entry of entries) {
      const client = new CdpClient({ port });
      const session = new BrainSession({ client, exclusive: true });
      let conv = entry.conversation;
      let resumed = false;
      if (!conv) {
        const prior = manager.get(entry.name);
        const pid = prior?.conversation?.external_id;
        const purl = prior?.conversation?.canonical_url;
        // only a REAL conversation id is resumable; a homepage url is not
        if (pid) {
          conv = { external_id: pid };
          resumed = true;
        } else if (purl && /\/c\//.test(purl)) {
          conv = { url: purl };
          resumed = true;
        }
      }
      await session.openConversation(conv || undefined);
      prepared.push({ entry, client, session });
      log(`[${entry.name}] ${resumed ? "resumed conversation" : conv ? "opened conversation" : "fresh conversation"} · tab ${client.target?.id || "?"}${session.identity?.external_id ? ` · conversation ${session.identity.external_id}` : ""}`);
    }
  } catch (error) {
    for (const p of prepared) { try { p.client.close(); } catch {} }
    throw error;
  }

  // Phase 2 (concurrent): independent brain-hand loops.
  const runs = prepared.map(({ entry, client, session }) =>
    runOne({ entry, client, session, manager, log }));
  const settled = await Promise.allSettled(runs);
  return settled.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    return {
      name: entries[i]?.name || `session-${i + 1}`,
      stopped: true,
      status: "failed",
      reason: String(r.reason?.message || r.reason),
    };
  });
}

async function runOne({ entry, client, session, manager, log }) {
  const rec = manager.upsert({
    name: entry.name,
    goal: entry.goal,
    cwd: entry.cwd,
    status: "running",
    max_rounds: entry.max_rounds,
    last_error: null,
    result_summary: null,
    conversation: session.identity,
  });
  log(`[${rec.name}] loop started (record ${rec.id})`);
  let executor = null;
  let wt = null;
  try {
    // worktree isolation (opt-in): the worker edits its own checkout; the
    // original repository is never touched. Resume reuses a recorded
    // worktree when it still exists; fresh:true forces a brand-new one.
    let effectiveCwd = entry.cwd;
    if (entry.worktree) {
      wt = await ensureWorktree({
        name: entry.name,
        repoCwd: entry.cwd,
        existingPath: entry.fresh ? null : (rec?.worktree_path ?? null),
      });
      effectiveCwd = wt.path;
      log(`[${rec.name}] ${wt.reused ? "reusing" : "created"} worktree ${effectiveCwd} (${wt.branch})`);
      manager.upsert({ id: rec.id, worktree_path: wt.path, worktree_branch: wt.branch });
    }

    const executor = createExecutorAdapter({
      cwd: effectiveCwd,
      onApproval: req => {
        try {
          log(`[${rec.name}] APPROVAL REQUIRED: ${req.method || "approval"} ${JSON.stringify(req.params || {}).slice(0, 260)}`);
        } catch {}
      },
    });

    // progress resume: same name continues from the saved runner snapshot
    // (round/history/checkpoint) unless spec sets fresh:true
    let st;
    const saved = entry.fresh ? null : rec?.state;
    const restored = restoreRunnerState(saved, { goal: entry.goal, constraints: entry.constraints });
    if (restored) {
      st = restored;
      st.maxRounds = Number.isInteger(entry.max_rounds) ? entry.max_rounds : (st.maxRounds ?? 20);
      log(`[${rec.name}] resumed progress at round ${st.round} (generation ${st.executor_generation}, history ${st.history.length})`);
    } else {
      st = newState(entry.goal, entry.constraints);
      if (Number.isInteger(entry.max_rounds)) st.maxRounds = entry.max_rounds;
    }

    const runner = createRunner({
      getState: () => st,
      setState: ns => { st = ns; },
      brain: createBrainAdapter({ session }),
      executor,
      onEvent: ev => log(`[${rec.name}] ${ev.type}: ${ev.summary}`),
      persist: async s => {
        manager.upsert({
          id: rec.id,
          status: "running",
          round: s.round,
          executor_generation: s.executor_generation ?? 1,
          conversation: session.identity,
          executor_thread_id: executor.threadId,
          state: snapshotRunnerState(s),
        });
      },
    });

    const result = await runner.runUntilStop({ thread_rounds: entry.thread_rounds });
    const baseSummary = String(result.reason || result.review?.reason || "").slice(0, 400);
    manager.upsert({
      id: rec.id,
      status: result.status || "unknown",
      round: st.round,
      executor_generation: st.executor_generation ?? 1,
      state: snapshotRunnerState(st),
      conversation: session.identity,
      executor_thread_id: executor.threadId,
      // a terminal reason is not necessarily an error; only failures are
      last_error: result.status === "failed" ? String(result.reason || "").slice(0, 500) : null,
      result_summary: (baseSummary + (wt ? ` [merge branch ${wt.branch}, then remove worktree: git worktree remove --force "${wt.path}"]` : "")).slice(0, 500) || null,
    });
    log(`[${rec.name}] finished: ${result.status}`);
    return {
      name: rec.name,
      id: rec.id,
      status: result.status,
      rounds_run: result.rounds_run,
      reason: result.reason || result.review?.reason || null,
      worktree: wt ? { path: wt.path, branch: wt.branch } : null,
    };
  } catch (error) {
    const msg = String(error?.message || error);
    manager.upsert({
      id: rec.id,
      status: "failed",
      last_error: msg.slice(0, 500),
      conversation: session.identity,
      executor_thread_id: executor?.threadId ?? null,
    });
    log(`[${rec.name}] failed: ${msg}`);
    return { name: rec.name, id: rec.id, stopped: true, status: "failed", reason: msg };
  } finally {
    try { if (executor) await executor.close(); } catch {}
    try { client.close(); } catch {}
    if (wt) log(`[${rec.name}] worktree kept for review/merge: ${wt.path} (branch ${wt.branch})`);
  }
}
