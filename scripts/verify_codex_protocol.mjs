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

// ---- T7/T8: failure-recovery path with a fake child (audit F11) ----
import { PassThrough } from "node:stream";

function makeFakeChild(registry, { echo = true } = {}) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const listeners = {};
  // self-echoing initialize: whatever id the adapter asks on stdin, answer
  // success on stdout. echo:false simulates a hung app-server (initialize
  // never answers) — used for the first child in the retry scenario.
  if (echo) {
    stdin.on("data", chunk => {
      for (const l of String(chunk).split("\n").filter(Boolean)) {
        try {
          const msg = JSON.parse(l);
          if (msg.method === "initialize") {
            stdout.write(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\n"));
          }
        } catch {}
      }
    });
  }
  const child = {
    stdout,
    stderr,
    stdin,
    on(ev, fn) { (listeners[ev] ??= []).push(fn); },
    // kill(): record + fire exit asynchronously (like a real process death)
    kill() {
      registry.killed.push(child);
      queueMicrotask(() => (listeners.exit || []).forEach(f => f(0, null)));
    },
    emitExit(code) { (listeners.exit || []).forEach(f => f(code ?? 0, null)); },
  };
  return child;
}

const waitFor = async (cond, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await new Promise(r => setTimeout(r, 25)); }
  return cond();
};

// T7: retry after failed initialize must not let the KILLED child's stale
// exit event tear down the fresh connection (F11 regression)
{
  const registry = { killed: [] };
  const children = [];
  // first child is SILENT (initialize never answers -> attempt times out);
  // later children echo and reach ready
  const ex = new CodexExecutor({
    timeoutMs: 150,
    spawnImpl: () => {
      const c = makeFakeChild(registry, { echo: children.length > 0 });
      children.push(c);
      return c;
    },
  });
  const attempt1 = ex.connect();
  const timedOut = await attempt1.then(() => false, e => e.code === "CODEX_ADAPTER_TIMEOUT");
  check("T7a first attempt fails via initialize timeout", timedOut);

  const attempt2 = ex.connect(); // retry: kills child1, spawns echoing child2
  const ready = await waitFor(() => ex.state === "ready");
  check("T7b first child was killed for cleanup", registry.killed.length === 1);
  check("T7c retry reaches ready state", ready && ex.state === "ready");

  // now the STALE child's death event arrives — must be ignored
  children[0]?.emitExit(1);
  await new Promise(r => setTimeout(r, 50));
  check("T7d stale child exit does not tear down fresh connection", ex.state === "ready");
  await attempt2.catch(() => {});
}

// T8: the CURRENT child dying still fails the executor
{
  const registry = { killed: [] };
  const ex = new CodexExecutor({ timeoutMs: 2000, spawnImpl: () => makeFakeChild(registry) });
  await ex.connect();
  const current = ex.child;
  current.emitExit(3);
  await new Promise(r => setTimeout(r, 50));
  check("T8 current child exit marks executor unavailable", ex.state === "unavailable");
}

console.log(`\n${pass} passed, ${failCount} failed`);
process.exit(failCount ? 1 : 0);
