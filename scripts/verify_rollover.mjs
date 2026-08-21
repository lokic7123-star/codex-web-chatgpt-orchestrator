#!/usr/bin/env node
// Thread-rollover verification (offline, no quota):
// a mock brain + counting mock executor drive the REAL runner with
// thread_rounds=2 over 5 rounds. Asserts:
//   - rollover fires exactly at rounds 2 and 4 (2 rollovers, final generation 3)
//   - each new thread is seeded with the latest checkpoint summary
//   - the brain's plan prompt receives the checkpoint from round 2 onward
//   - the run still completes through the acceptance gate

let pass = 0;
let failCount = 0;
const check = (name, cond) => {
  if (cond) { pass += 1; console.log(`PASS ${name}`); }
  else { failCount += 1; console.log(`FAIL ${name}`); }
};

const { createRunner, newState } = await import("../src/orchestration/runner.mjs");

const planCalls = [];
const checkpointCalls = [];
const rolloverSeeds = [];

function mockBrain() {
  return {
    async plan({ round, checkpoint }) {
      planCalls.push({ round, checkpoint: checkpoint ?? null });
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
      const done = round >= 4;
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
    async checkpoint({ history }) {
      const summary = `CP:${history.length}`;
      checkpointCalls.push(summary);
      return { content: [{ type: "text", text: "cp" }], structuredContent: { ok: true, summary } };
    },
  };
}

function mockExecutor() {
  let threads = 0;
  return {
    get threadCount() { return threads; },
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
    async rollover(seed) {
      threads += 1;
      rolloverSeeds.push(String(seed || ""));
      return `thread-${threads}`;
    },
  };
}

let st = newState("rollover test goal", []);
st.maxRounds = 6;
const executor = mockExecutor();
const runner = createRunner({
  getState: () => st,
  setState: ns => { st = ns; },
  brain: mockBrain(),
  executor,
});

const result = await runner.runUntilStop({ thread_rounds: 2 });

check("R1 run completed via acceptance gate", result.status === "completed");
check("R2 rollover fired twice (rounds 2 and 4)", rolloverSeeds.length === 2);
check("R3 final generation is 3", st.executor_generation === 3);
check("R4 first seed carries CP:2", rolloverSeeds[0]?.includes("CP:2"));
check("R5 second seed carries CP:4", rolloverSeeds[1]?.includes("CP:4"));
check("R6 brain checkpoint consulted twice", checkpointCalls.length === 2);
check("R7 plan received checkpoint from round 2 onward",
  planCalls.find(c => c.round === 2)?.checkpoint !== null
  && planCalls.find(c => c.round === 3)?.checkpoint !== null
  && planCalls.find(c => c.round === 0)?.checkpoint === null);
check("R8 history recorded for all 5 rounds", st.history.length === 5);

console.log(`\n${pass} passed, ${failCount} failed`);
process.exit(failCount ? 1 : 0);
