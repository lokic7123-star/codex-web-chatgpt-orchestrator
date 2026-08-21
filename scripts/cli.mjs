#!/usr/bin/env node
// Web Pro Orchestrator CLI (no MCP).
// Commands:
//   turn  <prompt>              atomic brain turn against web ChatGPT
//   turn  --nonce               run the M1 acceptance: echo BRIDGE_OK_<nonce>
//   identity                    read current conversation identity
//   health                      check browser + composer availability
//   list                        list visible conversations
//   select  --title <t>|--id <id>|--url <u>
//   run  --goal <g> [--max-rounds n] [--cwd d]   full brain-hand loop
//   run-multi --spec <plan.json>                 N parallel brain-hand loops
//   sessions                    list registered orchestration sessions
//   status                      runner state
// Logs go to stderr; results to stdout (so results can be piped/parsed).

import { readFileSync } from "node:fs";
import { CdpClient, BrainSession, DEFAULT_PORT } from "../src/browser/cdp.mjs";
import { createBrainAdapter } from "../src/orchestration/brain_adapter.mjs";
import { createExecutorAdapter } from "../src/orchestration/executor_adapter.mjs";
import { createRunner, newState } from "../src/orchestration/runner.mjs";
import { createSessionManager } from "../src/orchestration/session_manager.mjs";
import { normalizeEntries, runParallelSessions } from "../src/orchestration/multi.mjs";

const args = process.argv.slice(2);
const cmd = args[0];

function fail(msg) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}
function out(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}
function getFlag(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
}
function hasFlag(name) {
  return args.includes(`--${name}`);
}

function getSession() {
  const port = Number(process.env.WEB_PRO_PORT || DEFAULT_PORT);
  return new BrainSession({ client: new CdpClient({ port }), providerId: "chatgpt" });
}

async function main() {
  if (!cmd || cmd === "--help" || cmd === "-h") {
    out({ usage: "web-orchestrator <turn|identity|health|list|select|run|run-multi|sessions|status>", note: "see source header for args" });
    process.exit(0);
  }

  switch (cmd) {
    case "health": {
      const s = getSession();
      const health = await s.healthCheck();
      out({ health, connected: s.client.connected });
      return;
    }
    case "identity": {
      const s = getSession();
      out({ identity: await s.getIdentity() });
      return;
    }
    case "list": {
      const s = getSession();
      out({ conversations: await s.listConversations(getFlag("query") || "") });
      return;
    }
    case "select": {
      const s = getSession();
      const r = await s.selectConversation({ title: getFlag("title"), external_id: getFlag("id"), url: getFlag("url") });
      if (!r.selected) fail(r.error || "selection failed");
      out(r);
      return;
    }
    case "turn": {
      const s = getSession();
      const prompt = hasFlag("nonce")
        ? `Reply exactly: BRIDGE_OK_${Math.random().toString(36).slice(2, 10)}`
        : args[1];
      if (!prompt) fail("turn requires a prompt argument (or --nonce)");
      const result = await s.brainTurn(prompt, { timeoutMs: Number(getFlag("timeout") || 120000) });
      out(result);
      if (!result.ok) process.exit(1);
      return;
    }
    case "run": {
      const goal = getFlag("goal");
      if (!goal) fail("run requires --goal");
      const session = getSession();
      const brain = createBrainAdapter({ session });
      const executor = createExecutorAdapter({ cwd: getFlag("cwd") || process.cwd() });
      let st = newState(goal, []);
      const runner = createRunner({
        getState: () => st,
        setState: ns => { st = ns; },
        brain,
        executor,
        onEvent: ev => process.stderr.write(`[event] ${ev.type} ${ev.summary}\n`),
      });
      if (getFlag("max-rounds")) st.maxRounds = Number(getFlag("max-rounds"));
      const result = await runner.runUntilStop({});
      out(result);
      await executor.close();
      return;
    }
    case "sessions": {
      const mgr = createSessionManager();
      out({ store: mgr.file, sessions: mgr.list() });
      return;
    }
    case "run-multi": {
      const specFile = getFlag("spec");
      if (!specFile) fail("run-multi requires --spec <plan.json>");
      let raw;
      try { raw = readFileSync(specFile, "utf8"); } catch { fail(`cannot read spec file: ${specFile}`); }
      let spec;
      try { spec = JSON.parse(raw); } catch (e) { fail(`spec is not valid JSON: ${e.message}`); }
      const entries = normalizeEntries(spec);
      const mgr = createSessionManager();
      const results = await runParallelSessions({
        entries,
        manager: mgr,
        port: Number(process.env.WEB_PRO_PORT || DEFAULT_PORT),
      });
      out({ results });
      if (results.some(r => r.status === "failed")) process.exitCode = 1;
      return;
    }
    case "status": {
      out({ note: "CLI is stateless per-invocation; use `run` for a full loop" });
      return;
    }
    default:
      fail(`unknown command: ${cmd}`);
  }
}

main().then(() => process.exit(0)).catch(e => fail(e.message));
