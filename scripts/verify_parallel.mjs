#!/usr/bin/env node
// Parallel-sessions verification.
//   Part A (live, chat quota only): two EXCLUSIVE brain sessions each get their
//     own tab, turn in parallel, and each reply must contain its exact nonce;
//     the two conversations must be distinct. Requires browser + login AND
//     leaves two short test conversations in your ChatGPT history — run it
//     deliberately with `node scripts/verify_parallel.mjs a`.
//   Part B (offline, no quota): two mock brain-hand runners share one
//     SessionManager concurrently; records must stay isolated and land
//     "completed" through the real acceptance gate.
// Usage: node scripts/verify_parallel.mjs [a|b|both]   (default: b — offline)

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CdpClient, BrainSession, DEFAULT_PORT } from "../src/browser/cdp.mjs";
import { createSessionManager } from "../src/orchestration/session_manager.mjs";
import { createRunner, newState } from "../src/orchestration/runner.mjs";

const port = Number(process.env.WEB_PRO_PORT || DEFAULT_PORT);
let pass = 0;
let failCount = 0;
const check = (name, cond) => {
  if (cond) { pass += 1; console.log(`PASS ${name}`); }
  else { failCount += 1; console.log(`FAIL ${name}`); }
};
const rand = () => Math.random().toString(36).slice(2, 10);

// ---------------- Part A: live parallel brain turns ----------------

async function partA() {
  console.log("\n== Part A: two exclusive brain sessions turn in parallel ==");
  const mk = async tag => {
    const client = new CdpClient({ port });
    const session = new BrainSession({ client, exclusive: true });
    await session.ensureConnected();
    console.log(`  [${tag}] dedicated tab ${client.target?.id || "?"}`);
    return { tag, client, session };
  };
  const a = await mk("A");
  const b = await mk("B");
  const nonceA = `PAR_A_${rand()}`;
  const nonceB = `PAR_B_${rand()}`;
  try {
    const [ra, rb] = await Promise.all([
      a.session.brainTurn(`Reply exactly: ${nonceA}`, { timeoutMs: 150000 }),
      b.session.brainTurn(`Reply exactly: ${nonceB}`, { timeoutMs: 150000 }),
    ]);
    check("A1 session A turn ok", ra.ok === true);
    if (!ra.ok) console.log(`  [A] reason=${ra.completion_reason} error=${ra.error}`);
    check("A2 session A reply contains its exact nonce", ra.ok && String(ra.assistant_message).includes(nonceA));
    check("A3 session B turn ok", rb.ok === true);
    if (!rb.ok) console.log(`  [B] reason=${rb.completion_reason} error=${rb.error}`);
    check("A4 session B reply contains its exact nonce", rb.ok && String(rb.assistant_message).includes(nonceB));
    const idA = a.session.identity?.external_id;
    const idB = b.session.identity?.external_id;
    check("A5 conversations are distinct", Boolean(idA && idB && idA !== idB));
    check("A6 no cross-talk (A reply has no B nonce)", ra.ok && !String(ra.assistant_message).includes(nonceB));
  } finally {
    for (const { client } of [a, b]) {
      const tid = client.target?.id;
      client.close();
      if (tid) {
        try { await fetch(`http://127.0.0.1:${port}/json/close/${tid}`); } catch {}
      }
    }
  }
}

// ---------------- Part B: offline concurrent runners + registry ----------------

function mockBrain(steps) {
  // steps: [{ task }] — review returns continue until the last step, then completed.
  return {
    async plan({ round }) {
      const step = steps[Math.min(round, steps.length - 1)];
      return {
        content: [{ type: "text", text: "plan" }],
        structuredContent: {
          status: "continue",
          task: step.task,
          acceptance: [{ id: "A1", requirement: "proof exists" }],
          reason: "mock",
        },
      };
    },
    async report() {
      return { content: [{ type: "text", text: "ack" }], structuredContent: { ok: true } };
    },
    async review({ round }) {
      const done = round >= steps.length - 1;
      return {
        content: [{ type: "text", text: "review" }],
        structuredContent: {
          status: done ? "completed" : "continue",
          next_task: done ? "" : steps[Math.min(round + 1, steps.length - 1)].task,
          evidence: done ? [{ acceptance_id: "A1", type: "file_check", pass: true, summary: "mock proof" }] : [],
          reason: done ? "all acceptance proven" : "mock continue",
        },
      };
    },
  };
}

function mockExecutor(tag) {
  return {
    async execute({ task }) {
      return {
        content: [{ type: "text", text: `${tag} did: ${task}` }],
        structuredContent: {
          status: "done",
          evidence: [{ acceptance_id: "A1", type: "file_check", pass: true, summary: `mock evidence from ${tag}` }],
          summary: "mock execution",
        },
      };
    },
  };
}

async function partB() {
  console.log("\n== Part B: two mock runners share one SessionManager concurrently ==");
  const file = join(tmpdir(), `wpo-sessions-test-${Date.now()}.json`);
  const mgr = createSessionManager({ file });
  try {
    const mkRun = (tag, steps) => {
      const rec = mgr.upsert({ name: `mock-${tag}`, goal: `goal-${tag}`, cwd: join(tmpdir(), `wpo-mock-${tag}`), status: "running" });
      let st = newState(`goal-${tag}`, []);
      st.maxRounds = 6;
      const runner = createRunner({
        getState: () => st,
        setState: ns => { st = ns; },
        brain: mockBrain(steps),
        executor: mockExecutor(tag),
        persist: async s => mgr.upsert({ id: rec.id, status: "running", round: s.round }),
      });
      return runner.runUntilStop({}).then(r => {
        mgr.upsert({ id: rec.id, status: r.status, round: st.round, result_summary: r.review?.reason || null });
        return { tag, recId: rec.id, result: r };
      });
    };

    const [ra, rb] = await Promise.all([
      mkRun("alpha", [{ task: "step a1" }, { task: "step a2" }]),           // completes after 2 rounds
      mkRun("beta", [{ task: "step b1" }, { task: "step b2" }, { task: "step b3" }]), // after 3 rounds
    ]);

    check("B1 alpha completed via acceptance gate", ra.result.status === "completed");
    check("B2 beta completed via acceptance gate", rb.result.status === "completed");

    const recA = mgr.get(ra.recId);
    const recB = mgr.get(rb.recId);
    check("B3 both records persisted", Boolean(recA && recB));
    check("B4 record ids distinct", recA?.id !== recB?.id);
    check("B5 statuses recorded completed", recA?.status === "completed" && recB?.status === "completed");
    check("B6 rounds isolated (alpha != beta)", Number(recA?.round) !== Number(recB?.round));
    check("B7 goals not cross-contaminated", recA?.goal === "goal-alpha" && recB?.goal === "goal-beta");
    check("B8 store file holds both sessions", mgr.list().length >= 2);
  } finally {
    try { rmSync(file, { force: true }); } catch {}
  }
}

// ---------------- main ----------------

const only = String(process.argv[2] || "b").toLowerCase();
if (only === "both" || only === "a") await partA();
if (only === "both" || only === "b") await partB();
console.log(`\n${pass} passed, ${failCount} failed`);
process.exit(failCount ? 1 : 0);
