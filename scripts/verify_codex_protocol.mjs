#!/usr/bin/env node
// Synthetic protocol tests for CodexExecutor._handleLine (offline, no quota):
//   T1 delta+completed must not duplicate text
//   T2 completed-only turn still yields full text
//   T3 turn/failed rejects the waiter immediately (fail fast)
//   T4 unbound error notification fails the single waiting turn
//   T5 stray error without waiting turns is ignored
//   T6 watchdog pulses on every turn event (not just agentMessage deltas)

import { CodexExecutor } from "../src/adapters/codex.mjs";

let pass = 0;
let failCount = 0;
function check(name, cond) {
  if (cond) { pass += 1; console.log(`PASS ${name}`); }
  else { failCount += 1; console.log(`FAIL ${name}`); }
}
function line(ex, obj) { ex._handleLine(JSON.stringify(obj)); }
function waiter(ex, turnId) {
  return new Promise((resolve, reject) => {
    ex.turnWaiters.set(turnId, { resolve, reject, timer: setTimeout(() => {}, 1e6) });
  });
}

// T1: deltas + item/completed must NOT duplicate text
{
  const ex = new CodexExecutor();
  const p = waiter(ex, "t1");
  line(ex, { jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: "th", turnId: "t1", itemId: "i1", delta: "hello " } });
  line(ex, { jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: "th", turnId: "t1", itemId: "i1", delta: "world" } });
  line(ex, { jsonrpc: "2.0", method: "item/completed", params: { threadId: "th", turnId: "t1", item: { type: "agentMessage", id: "i1", text: "hello world" } } });
  line(ex, { jsonrpc: "2.0", method: "turn/completed", params: { threadId: "th", turnId: "t1", turn: { id: "t1", status: "completed" } } });
  const done = await p;
  check("T1 no duplication with deltas", done.text === "hello world");
}

// T2: completed-only turn (no deltas) still yields full text
{
  const ex = new CodexExecutor();
  const p = waiter(ex, "t2");
  line(ex, { jsonrpc: "2.0", method: "item/completed", params: { threadId: "th", turnId: "t2", item: { type: "agentMessage", id: "i2", text: "final answer" } } });
  line(ex, { jsonrpc: "2.0", method: "turn/completed", params: { threadId: "th", turnId: "t2", turn: { id: "t2", status: "completed" } } });
  const done = await p;
  check("T2 completed-only text", done.text === "final answer");
}

// T3: turn/failed rejects the waiter immediately with CODEX_TURN_FAILED
{
  const ex = new CodexExecutor();
  const p = waiter(ex, "t3");
  line(ex, { jsonrpc: "2.0", method: "turn/failed", params: { threadId: "th", turnId: "t3", error: { message: "usage limit exceeded" } } });
  try {
    await p;
    check("T3 turn/failed rejects", false);
  } catch (e) {
    check("T3 turn/failed rejects", e.code === "CODEX_TURN_FAILED" && /usage limit/i.test(e.message));
  }
}

// T4: unbound error notification fails the single waiting turn
{
  const ex = new CodexExecutor();
  const p = waiter(ex, "t4");
  line(ex, { jsonrpc: "2.0", method: "error", params: { error: { message: "usageLimitExceeded" } } });
  try {
    await p;
    check("T4 unbound error fails waiter", false);
  } catch (e) {
    check("T4 unbound error fails waiter", e.code === "CODEX_TURN_FAILED" && /usageLimitExceeded/.test(e.message));
  }
}

// T5: unbound error with NO waiting turns is ignored (no crash)
{
  const ex = new CodexExecutor();
  line(ex, { jsonrpc: "2.0", method: "error", params: { error: { message: "stray" } } });
  check("T5 stray error ignored", ex.turnWaiters.size === 0 && ex.state === "disconnected");
}

// T6: watchdog pulses on non-delta events (item/completed for commandExecution)
{
  const ex = new CodexExecutor();
  let pulsed = 0;
  const fakeWd = { pulse: () => { pulsed++; }, stop: () => {} };
  ex.watchdogs.set("t6", fakeWd);
  line(ex, { jsonrpc: "2.0", method: "item/completed", params: { threadId: "th", turnId: "t6", item: { type: "commandExecution", id: "c1", exitCode: 0 } } });
  line(ex, { jsonrpc: "2.0", method: "item/started", params: { threadId: "th", turnId: "t6", item: { type: "reasoning", id: "r1" } } });
  check("T6 watchdog pulses on all events", pulsed === 2);
}

console.log(`\n${pass} passed, ${failCount} failed`);
process.exit(failCount ? 1 : 0);
