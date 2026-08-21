// Orchestration runner: bounded brain-hand loop state machine.
// Runner is DOM/route-agnostic. It calls injected brain/executor callbacks and
// enforces the acceptance gate and stop policy. Executor watchdog is the
// caller's responsibility (CodexExecutor), surfaced here as awaiting_user/failed.

import { TERMINAL_STATUSES } from "../../scripts/protocol.mjs";
import { enforceAcceptanceGate } from "./acceptance.mjs";
import { fingerprint } from "./stop_policy.mjs";

export const DEFAULT_MAX_ROUNDS = 20;
export const HARD_MAX_ROUNDS = 50;

export function normalizeStatus(value, text = "") {
  const s = String(value || text || "").toLowerCase();
  if (/completed|complete|done|finished|success/.test(s)) return "completed";
  if (/blocked|blocker|无法继续|被阻塞/.test(s)) return "blocked";
  if (/repeated|repeat|loop|重复|循环/.test(s)) return "repeated";
  if (/awaiting|approval/.test(s)) return "awaiting_user";
  if (/max[_ -]?round|轮数上限/.test(s)) return "max_rounds";
  if (/failed|fail/.test(s)) return "failed";
  return "continue";
}

function list(value) {
  if (value === undefined || value === null || value === "") return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr.map(x => String(x).slice(0, 1000).trim()).filter(Boolean).slice(0, 40);
}

function clip(value, limit = 6000) {
  const text = String(value ?? "");
  return text.length <= limit ? text : `${text.slice(0, limit)}...[truncated]`;
}

function structured(result) {
  if (!result || typeof result !== "object") return {};
  return result.structuredContent && typeof result.structuredContent === "object" ? result.structuredContent : result;
}

function resultText(result) {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  const text = result.content?.find(i => i?.type === "text")?.text;
  return String(result.text ?? result.reply ?? result.output ?? text ?? "");
}

function resultError(result) {
  if (result?.isError) {
    const data = structured(result);
    return { message: resultText(result) || data.reason || "stage failed", code: data.code || "STAGE_FAILED", status: data.status };
  }
  return null;
}

function newState(goal, constraints) {
  return {
    mode: "brain-hand",
    goal: String(goal || ""),
    constraints: list(constraints),
    maxRounds: DEFAULT_MAX_ROUNDS,
    round: 0,
    latestPlan: null,
    latestReport: null,
    latestReview: null,
    workspaceFingerprints: [],
    startedAt: null,
  };
}

function workspaceState(provider) {
  // provider may expose a workspace fingerprint (e.g. git HEAD + diff hash)
  return typeof provider?.workspaceFingerprint === "function" ? provider.workspaceFingerprint() : null;
}

function taskFingerprint(plan, workspace) {
  return fingerprint({
    task: plan?.task,
    acceptance: plan?.acceptance,
    workspace: workspace || null,
  });
}

export function createRunner({
  getState = null,
  setState = null,
  brain = null,        // { plan(), report(), review() }
  executor = null,     // { execute(task, plan) -> {text, evidence, status} }
  workspace = null,    // optional workspace fingerprint provider
  maxRoundsOf = v => { const n = Number(v ?? DEFAULT_MAX_ROUNDS); return Number.isInteger(n) && n >= 1 ? Math.min(n, HARD_MAX_ROUNDS) : DEFAULT_MAX_ROUNDS; },
  roundLimitReached = null,
  onEvent = null,
  persist = null,
} = {}) {
  if (!brain?.plan || !brain?.report || !brain?.review || !executor?.execute) {
    throw new TypeError("runner requires brain {plan,report,review} and executor {execute}");
  }
  if (!getState || !setState) throw new TypeError("runner requires getState/setState");

  let state = getState();
  roundLimitReached = roundLimitReached || ((round, max) => Number(round) >= max - 1);

  async function emit(type, summary, data) {
    if (typeof onEvent === "function") await onEvent({ type, summary, data });
  }
  async function save() {
    if (typeof persist === "function") await persist(state);
  }

  async function runRound(args = {}) {
    state = getState();
    state.maxRounds = maxRoundsOf(args.max_rounds ?? state.maxRounds);
    const round = Number.isInteger(Number(state.round)) ? state.round : 0;

    if (TERMINAL_STATUSES.has(state.latestReview?.status || state.latestPlan?.status)) {
      return { stopped: true, status: state.latestReview?.status || state.latestPlan?.status, round, max_rounds: state.maxRounds, stage: "preflight" };
    }

    // 1. plan (reuse current plan if it's a continue; else ask brain)
    let plan = state.latestPlan?.task && state.latestPlan.status === "continue" ? state.latestPlan : null;
    if (!plan) {
      const planResult = await brain.plan({ ...args, goal: state.goal, constraints: state.constraints, round });
      const err = resultError(planResult);
      if (err) return stop(state, { status: err.status === "awaiting_user" ? "awaiting_user" : "blocked", round, max_rounds: state.maxRounds, stage: "plan", reason: err.message });
      plan = structured(planResult);
      state.latestPlan = plan;
    }
    if (TERMINAL_STATUSES.has(plan.status) && plan.status !== "continue") {
      return stop(state, { status: plan.status, round, max_rounds: state.maxRounds, stage: "plan", reason: plan.reason || "planner returned terminal" });
    }
    if (!plan.task) return stop(state, { status: "blocked", round, max_rounds: state.maxRounds, stage: "plan", reason: "planner returned no task" });

    await emit("TASK", `round ${round}: ${plan.task}`, { round, task: plan.task, acceptance: plan.acceptance });

    // 2. execute
    const execResult = await executor.execute({ ...args, round, task: plan.task, text: plan.task, plan });
    const execErr = resultError(execResult);
    if (execErr) {
      const status = execErr.status === "awaiting_user" ? "awaiting_user"
        : (execErr.code?.includes("TIMEOUT") ? "failed" : "blocked");
      return stop(state, { status, round, max_rounds: state.maxRounds, stage: "execute", reason: execErr.message, code: execErr.code });
    }
    const report = structured(execResult);
    state.latestReport = report;

    // 3. report to brain
    const reportResult = await brain.report({ ...args, round, plan, report, report_text: resultText(execResult) || report?.summary || "" });
    const reportErr = resultError(reportResult);
    if (reportErr) return stop(state, { status: "blocked", round, max_rounds: state.maxRounds, stage: "report", reason: reportErr.message });

    // 4. review
    const reviewResult = await brain.review({ ...args, round, plan, report, report_text: resultText(execResult) });
    const reviewErr = resultError(reviewResult);
    if (reviewErr) return stop(state, { status: "blocked", round, max_rounds: state.maxRounds, stage: "review", reason: reviewErr.message });
    let review = structured(reviewResult);

    // acceptance gate: completed requires all mandatory acceptance + passing evidence
    const gate = enforceAcceptanceGate(review, plan.acceptance, report.evidence);
    review = { ...review, ...gate.decision, completion_proof: gate.gate };
    state.latestReview = review;

    // repeated detection with workspace state
    const ws = workspaceState(workspace);
    const tKey = taskFingerprint(plan, ws);
    state.workspaceFingerprints ??= [];
    state.workspaceFingerprints.push(tKey);
    if (state.workspaceFingerprints.filter(k => k === tKey).length >= 2 && review.status === "continue") {
      review = { ...review, status: "repeated", reason: "same task + same workspace repeated without progress" };
      state.latestReview = review;
    }

    await emit("REVIEW", `round ${round} review: ${review.status}`, review);

    if (TERMINAL_STATUSES.has(review.status)) {
      await save();
      return { stopped: true, status: review.status, round, max_rounds: state.maxRounds, review, report, stage: "review" };
    }
    if (roundLimitReached(round, state.maxRounds)) {
      review = { ...review, status: "max_rounds", reason: `max rounds reached: ${state.maxRounds}` };
      state.latestReview = review;
      return stop(state, { status: "max_rounds", round, max_rounds: state.maxRounds, review, report, stage: "stop_policy", reason: review.reason });
    }

    // advance
    const nextRound = round + 1;
    const nextPlan = { round: nextRound, status: "continue", task: review.task || "", acceptance: review.acceptance, constraints: review.constraints, evidence: review.evidence, reason: review.reason };
    state.round = nextRound;
    state.latestPlan = nextPlan;
    await save();
    return { stopped: false, continued: true, status: "continue", round: nextRound, max_rounds: state.maxRounds, task: nextPlan.task, plan: nextPlan, review, report };
  }

  async function stop(state, decision) {
    const result = { stopped: true, ...decision };
    if (typeof persist === "function") await persist(state);
    return result;
  }

  async function runUntilStop(args = {}) {
    const maxRounds = maxRoundsOf(args.max_rounds ?? getState().maxRounds);
    const rounds = [];
    const hard = maxRounds + 1;
    for (let i = 0; i < hard; i += 1) {
      const r = await runRound({ ...args, max_rounds: maxRounds });
      rounds.push({ status: r.status, round: r.round, task: r.task || r.plan?.task || null, reason: r.reason || r.review?.reason || null });
      if (r.stopped || !r.continued) {
        return { ...r, rounds, rounds_run: rounds.length };
      }
    }
    return stop(getState(), { status: "max_rounds", round: Number(getState().round || 0), max_rounds: maxRounds, stage: "safety", reason: "hard loop limit reached", rounds });
  }

  return { runRound, runUntilStop, newState: () => newState("", []), createState: newState };
}

export { newState };
