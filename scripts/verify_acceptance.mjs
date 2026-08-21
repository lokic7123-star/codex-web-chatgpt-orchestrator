#!/usr/bin/env node
// Acceptance-contract verification (offline):
//   - REAL executor evidence (acceptance_id:"") must be mapped onto plan
//     criteria ids by buildExecutorEvidence — the gate can then match it
//   - unmapped real-shaped evidence must NOT satisfy criteria (regression for
//     the audit finding that mocks hid the broken contract)
//   - a plan with no mandatory criteria is completable (vacuous gate)
//   - normalizeStatus word boundaries: "not done yet"/"undone" ≠ completed

import { evaluateAcceptanceGate, enforceAcceptanceGate } from "../src/orchestration/acceptance.mjs";
import { buildExecutorEvidence } from "../src/orchestration/executor_adapter.mjs";
import { normalizeStatus as runnerNormalize } from "../src/orchestration/runner.mjs";
import { normalizeStatus as protocolNormalize } from "../scripts/protocol.mjs";

let pass = 0;
let failCount = 0;
const check = (name, cond) => {
  if (cond) { pass += 1; console.log(`PASS ${name}`); }
  else { failCount += 1; console.log(`FAIL ${name}`); }
};

const plan = { task: "fix foo", acceptance: [{ id: "A1", requirement: "tests pass" }, "docs updated"] };

// mapping
const ev = buildExecutorEvidence({ plan, text: "worker output", isError: false });
check("A1 evidence mapped to explicit id A1", ev.some(e => e.acceptance_id === "A1" && e.pass));
check("A2 string criterion mapped to generated id A2", ev.some(e => e.acceptance_id === "A2" && e.pass));
check("A3 failed execution marks evidence pass=false",
  buildExecutorEvidence({ plan, text: "", isError: true }).every(e => e.pass === false));
check("A4 no criteria -> single unmapped evidence item",
  buildExecutorEvidence({ plan: { acceptance: [] }, text: "x" }).length === 1
  && buildExecutorEvidence({ plan: { acceptance: [] }, text: "x" })[0].acceptance_id === "");

// gate with MAPPED evidence passes; completed survives the gate
const gateOk = enforceAcceptanceGate(
  { status: "completed", reason: "done" },
  plan.acceptance,
  ev,
);
check("B1 mapped evidence lets completed stand", gateOk.decision.status === "completed" && gateOk.gate.ok);

// regression: UNMAPPED real-shaped evidence must NOT satisfy criteria
const rawEv = [{ acceptance_id: "", type: "executor_text", summary: "worker output", pass: true }];
const gateBad = enforceAcceptanceGate(
  { status: "completed", reason: "done" },
  plan.acceptance,
  rawEv,
);
check("B2 unmapped evidence downgrades completed -> blocked", gateBad.decision.status === "blocked");

// vacuous: no mandatory criteria -> completable without evidence
const vacuous = evaluateAcceptanceGate({ acceptance: [], evidence: [] });
check("B3 no-criteria plan has vacuous ok gate", vacuous.ok === true && vacuous.proven === false);
const vacuousDecision = enforceAcceptanceGate({ status: "completed" }, [], []);
check("B4 no-criteria completed not downgraded", vacuousDecision.decision.status === "completed");

// failing evidence blocks completion even when brain claims done
const failing = buildExecutorEvidence({ plan, text: "tests failed", isError: true });
const gateFail = enforceAcceptanceGate({ status: "completed" }, plan.acceptance, failing);
check("B5 failed execution blocks completion", gateFail.decision.status === "blocked");

// normalizeStatus boundaries (both copies)
for (const [label, fn] of [["C1 runner", runnerNormalize], ["C2 protocol", protocolNormalize]]) {
  check(`${label} 'not done yet' != completed`, fn("not done yet") !== "completed");
  check(`${label} 'undone' != completed`, fn("undone") !== "completed");
  check(`${label} 'completed' == completed`, fn("completed") === "completed");
  check(`${label} 'awaiting_user' == awaiting_user`, fn("awaiting_user") === "awaiting_user");
  check(`${label} 'max_rounds' == max_rounds`, fn("max_rounds") === "max_rounds");
}
check("C3 protocol ignores surrounding prose", protocolNormalize("the build must not fail") === "continue");

console.log(`\n${pass} passed, ${failCount} failed`);
process.exit(failCount ? 1 : 0);
