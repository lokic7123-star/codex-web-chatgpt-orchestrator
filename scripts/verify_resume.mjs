#!/usr/bin/env node
// Progress-resume verification (offline, no quota):
//   Invocation 1: real runner stops at max_rounds=2 (rounds 0-1 done, state persisted)
//   Invocation 2: restoreRunnerState() revives the saved snapshot; the run
//     continues from round 1 and completes through the acceptance gate.
// Also covers sanitization: a saved TERMINAL review (max_rounds) must be
// cleared on restore, otherwise the preflight would stop immediately.

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionManager } from "../src/orchestration/session_manager.mjs";
import { createRunner, newState } from "../src/orchestration/runner.mjs";
import { snapshotRunnerState, restoreRunnerState } from "../src/orchestration/multi.mjs";

let pass = 0;
let failCount = 0;
const check = (name, cond) => {
  if (cond) { pass += 1; console.log(`PASS ${name}`); }
  else { failCount += 1; console.log(`FAIL ${name}`); }
};

function mockBrain(finishAtRound) {
  return {
    async plan({ round, checkpoint }) {
      return {
        content: [{ type: "text", text: "plan" }],
        structuredContent: {
          status: "continue",
          task: `task r${round}`,
          acceptance: [{ id: "A1", requirement: "proof exists" }],
          reason: "mock",
        },
      };
    },
    async report() {
      return { content: [{ type: "text", text: "ack" }], structuredContent: { ok: true } };
    },
    async review({ round }) {
      const done = round >= finishAtRound;
      return {
        content: [{ type: "text", text: "review" }],
        structuredContent: {
          status: done ? "completed" : "continue",
          next_task: done ? "" : `task r${round + 1}`,
          evidence: done ? [{ acceptance_id: "A1", type: "file_check", pass: true, summary: "proof" }] : [],
          reason: done ? "all proven" : "continue",
        },
      };
    },
  };
}

const mockExecutor = {
  async execute({ task }) {
    return {
      content: [{ type: "text", text: `did ${task}` }],
      structuredContent: {
        status: "done",
        evidence: [{ acceptance_id: "A1", type: "file_check", pass: true, summary: "evidence" }],
        summary: "ok",
      },
    };
  },
};

const file = join(tmpdir(), `wpo-resume-test-${Date.now()}.json`);
const mgr = createSessionManager({ file });
try {
  // ---- invocation 1: bounded to 2 rounds, ends as max_rounds ----
  const rec = mgr.upsert({ name: "resume-progress", goal: "long goal", cwd: "/tmp/x", status: "running", max_rounds: 2 });
  let st1 = newState("long goal", []);
  st1.maxRounds = 2;
  const runner1 = createRunner({
    getState: () => st1,
    setState: ns => { st1 = ns; },
    brain: mockBrain(3),           // would complete at round 3 — never reached here
    executor: mockExecutor,
    persist: async s => mgr.upsert({ id: rec.id, state: snapshotRunnerState(s) }),
  });
  const r1 = await runner1.runUntilStop({});
  mgr.upsert({ id: rec.id, status: r1.status, state: snapshotRunnerState(st1) });

  check("V1 first invocation stopped at max_rounds", r1.status === "max_rounds");
  check("V2 two rounds recorded before stop", st1.round === 1 && st1.history.length === 2);

  // ---- invocation 2 (fresh process simulation): restore + continue ----
  const saved = mgr.get(rec.id)?.state;
  const st2 = restoreRunnerState(saved, { goal: "long goal", constraints: [] });
  check("V3 snapshot restorable", Boolean(st2));
  check("V4 restored at saved round", st2?.round === 1);
  check("V5 terminal review sanitized (no instant preflight stop)", st2?.latestReview === null);
  check("V6 history carried over", Array.isArray(st2?.history) && st2.history.length === 2);

  // resume budget semantics (audit F10): a spec that OMITS max_rounds grants
  // a fresh default budget — the saved limit that already stopped the run
  // must never re-stop it instantly. Simulating an explicit spec override:
  st2.maxRounds = 6;

  const runner2 = createRunner({
    getState: () => st2,
    setState: ns => { st2 = ns; },
    brain: mockBrain(3),           // completes at round 3
    executor: mockExecutor,
    persist: async s => mgr.upsert({ id: rec.id, state: snapshotRunnerState(s) }),
  });
  const r2 = await runner2.runUntilStop({});

  check("V7 continuation completed via acceptance gate", r2.status === "completed");
  check("V8 rounds continued without restart (final round 3)", st2.round === 3);
  // the interrupted round appears twice (before + after resume) — honest audit log
  const histRounds = st2.history.map(h => h.round);
  check("V9 history covers every round r0..r3",
    [0, 1, 2, 3].every(r => histRounds.includes(r)) && st2.history.length <= 5);

  // ---- fresh:true escape hatch must ignore saved state ----
  const ignored = restoreRunnerState(null, { goal: "x", constraints: [] });
  check("V10 null snapshot restores to nothing", ignored === null);

  // ---- constraints inherit when spec omits them (audit S2) ----
  const savedWithConstraints = { ...saved, constraints: ["no-network", "windows-only"] };
  const stInherit = restoreRunnerState(savedWithConstraints, { goal: "long goal", constraints: [] });
  check("V11 empty constraints inherit saved values",
    JSON.stringify(stInherit?.constraints) === JSON.stringify(["no-network", "windows-only"]));
  const stOverride = restoreRunnerState(savedWithConstraints, { goal: "long goal", constraints: ["new-dir"] });
  check("V12 explicit constraints still override",
    JSON.stringify(stOverride?.constraints) === JSON.stringify(["new-dir"]));
} finally {
  try { rmSync(file, { force: true }); } catch {}
}

console.log(`\n${pass} passed, ${failCount} failed`);
process.exit(failCount ? 1 : 0);
