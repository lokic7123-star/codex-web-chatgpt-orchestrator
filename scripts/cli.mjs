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
//   doctor                      environment self-check (node/cdp/codex/store)
//   status                      runner state
// Logs go to stderr; results to stdout (so results can be piped/parsed).

import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { accessSync, constants as fsConstants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CdpClient, BrainSession, DEFAULT_PORT } from "../src/browser/cdp.mjs";
import { createBrainAdapter } from "../src/orchestration/brain_adapter.mjs";
import { createExecutorAdapter, readCodexConfigSnapshot } from "../src/orchestration/executor_adapter.mjs";
import { createRunner, newState } from "../src/orchestration/runner.mjs";
import { createSessionManager } from "../src/orchestration/session_manager.mjs";
import { normalizeEntries, runParallelSessions, validateAllowedCwds } from "../src/orchestration/multi.mjs";

const execFileP = promisify(execFile);

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

async function runDoctor() {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: String(detail ?? "").slice(0, 200) });

  // node version
  const major = Number(process.versions.node.split(".")[0]);
  add("node>=22", major >= 22, `node ${process.versions.node}`);

  // codex CLI available
  try {
    const { stdout } = await execFileP("cmd", ["/c", "codex", "--version"], { timeout: 15000, windowsHide: true });
    add("codex CLI", true, stdout.trim().split(/\r?\n/)[0]);
  } catch (e) {
    add("codex CLI", false, e.message);
  }

  // frozen-config readability
  const snap = readCodexConfigSnapshot();
  add("codex config model", Boolean(snap.model), snap.model || "not set in ~/.codex/config.toml");

  // browser / CDP endpoint
  const port = Number(process.env.WEB_PRO_PORT || DEFAULT_PORT);
  let cdpOk = false;
  let browserDetail = "";
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    const v = await res.json();
    cdpOk = res.ok;
    browserDetail = v.Browser || "unknown";
  } catch (e) {
    browserDetail = `${e.message} — launch the dedicated browser first (README setup step 1)`;
  }
  add(`CDP :${port}`, cdpOk, browserDetail);

  // brain page: logged in + composer usable
  if (cdpOk) {
    try {
      const s = getSession();
      const h = await s.healthCheck();
      const names = (h.strategies || []).filter(x => x.input).map(x => x.name);
      add("brain composer", Boolean(h.ok), names.join(", ") || "no input strategy ready");
      s.client.close(); // release the DevTools websocket before exit
    } catch (e) {
      add("brain composer", false, e.message);
    }
  } else {
    add("brain composer", false, "skipped: CDP not reachable");
  }

  // session registry store writable
  try {
    const mgr = createSessionManager();
    accessSync(dirname(mgr.file), fsConstants.W_OK);
    add("sessions store writable", true, mgr.file);
  } catch (e) {
    add("sessions store writable", false, e.message);
  }

  return { ok: checks.every(c => c.ok), port, checks };
}

async function main() {
  if (!cmd || cmd === "--help" || cmd === "-h") {
    out({ usage: "web-orchestrator <turn|identity|health|list|select|run|run-multi|sessions|doctor|status>", note: "see source header for args" });
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
      if (!result.ok) process.exitCode = 1;
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
      // optional guardrail: spec.allowed_cwds or WEB_PRO_ALLOWED_CWDS (';' separated)
      const allowed = Array.isArray(spec?.allowed_cwds)
        ? spec.allowed_cwds
        : String(process.env.WEB_PRO_ALLOWED_CWDS || "").split(";").map(s => s.trim()).filter(Boolean);
      try {
        validateAllowedCwds(entries, allowed);
      } catch (e) {
        fail(e.message);
      }
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
    case "doctor": {
      out(await runDoctor());
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

// let the event loop drain naturally: forcing process.exit() while DevTools
// websockets / child handles are still closing crashes libuv on Windows
main().then(() => { process.exitCode = 0; }).catch(e => fail(e.message));
