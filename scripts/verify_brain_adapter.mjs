#!/usr/bin/env node
// Brain-adapter protocol verification (offline, no quota):
//   P1/P2 plan: garbage reply -> one repair turn -> valid JSON accepted;
//               garbage twice -> brain_protocol_error (never infinite repair)
//   P3/P4 review: valid review JSON passes; malformed review -> one repair
//   P5 checkpoint: {"summary": "..."} extracted into structuredContent
//   P6 reportTurns:false (default) removes the report method entirely
// Assertions are named P1..P9 in run order.

import { createBrainAdapter } from "../src/orchestration/brain_adapter.mjs";

let pass = 0;
let failCount = 0;
const check = (name, cond) => {
  if (cond) { pass += 1; console.log(`PASS ${name}`); }
  else { failCount += 1; console.log(`FAIL ${name}`); }
};

function scriptedSession(replies) {
  const calls = [];
  return {
    calls,
    async brainTurn(prompt) {
      calls.push(String(prompt || ""));
      const next = replies[Math.min(calls.length - 1, replies.length - 1)];
      return { ok: true, assistant_message: typeof next === "function" ? next(calls.length) : next };
    },
  };
}

const validPlan = '{"status":"continue","task":"write the module","acceptance":[{"id":"A1","requirement":"tests pass"}],"reason":"go"}';
const validReview = '{"status":"completed","next_task":"","evidence":[{"acceptance_id":"A1","type":"file_check","pass":true}],"reason":"proven"}';

// P1 repair succeeds
{
  const s = scriptedSession(["I would start by looking at the code first.", validPlan]);
  const brain = createBrainAdapter({ session: s });
  const r = await brain.plan({ goal: "g", constraints: [], round: 0 });
  check("P1 repaired plan accepted", !r.isError && r.structuredContent?.task === "write the module");
  check("P2 exactly one repair turn issued", s.calls.length === 2);
}

// P2 repair fails -> protocol error, no third call
{
  const s = scriptedSession(["nope", "still not json"]);
  const brain = createBrainAdapter({ session: s });
  const r = await brain.plan({ goal: "g", constraints: [], round: 0 });
  check("P3 double garbage -> brain_protocol_error", r.isError && r.structuredContent?.code === "brain_protocol_error");
  check("P4 no infinite repair (2 turns max)", s.calls.length === 2);
}

// P3/P4 review gate
{
  const s = scriptedSession([validReview]);
  const brain = createBrainAdapter({ session: s });
  const r = await brain.review({ round: 1, plan: {}, report: {} });
  check("P5 valid review passes gate", !r.isError && r.structuredContent?.status === "completed");
}
{
  const s = scriptedSession(["sounds done to me", validReview]);
  const brain = createBrainAdapter({ session: s });
  const r = await brain.review({ round: 1, plan: {}, report: {} });
  check("P6 malformed review repaired once", !r.isError && r.structuredContent?.status === "completed" && s.calls.length === 2);
}

// P5 checkpoint summary extraction
{
  const s = scriptedSession(['{"summary":"goal X; A done; B remains"}']);
  const brain = createBrainAdapter({ session: s });
  const r = await brain.checkpoint({ goal: "X", history: [{ round: 0, task: "t", status: "continue" }], checkpoint: null });
  check("P7 checkpoint summary extracted", r.structuredContent?.summary === "goal X; A done; B remains");
}

// P6 default adapter has NO report method (saves a chat turn per round)
{
  const s = scriptedSession([]);
  const withReport = createBrainAdapter({ session: s, reportTurns: true });
  const withoutReport = createBrainAdapter({ session: s });
  check("P8 reportTurns:true keeps report", typeof withReport.report === "function");
  check("P9 default adapter drops report", typeof withoutReport.report === "undefined");
}

console.log(`\n${pass} passed, ${failCount} failed`);
process.exit(failCount ? 1 : 0);
