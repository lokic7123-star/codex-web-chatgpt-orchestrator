#!/usr/bin/env node
// M2 executor verification: start codex app-server, create bridge-proof.txt with a
// random nonce, and confirm the file exists with the exact content.
// This validates the executor adapter + watchdog path in a controlled temp workspace.

import { createExecutorAdapter } from "../src/orchestration/executor_adapter.mjs";
import { freezeExecutorSnapshot } from "../src/adapters/executor_provider.mjs";

const ws = process.argv[2];
if (!ws) { console.error("usage: verify_executor.mjs <workspace-dir>"); process.exit(1); }

const nonce = `M2PROOF_${Math.random().toString(36).slice(2, 10)}`;
const task = `In this workspace, create a file named bridge-proof.txt whose ONLY content is exactly: ${nonce}`;

let adapter;
try {
  adapter = createExecutorAdapter({ cwd: ws, timeoutMs: 300000, idleMs: 90000 });
  const snapshot = await freezeExecutorSnapshot({});
  console.log("executor snapshot:", JSON.stringify(snapshot, null, 2));

  const result = await adapter.execute({ task, text: task });
  console.log("execute ok:", !result.isError);
  console.log("execute text:", JSON.stringify(result.content?.[0]?.text || ""));
  if (result.isError) {
    console.log("error:", JSON.stringify(result, null, 2));
    process.exit(1);
  }

  await new Promise(r => setTimeout(r, 2000));

  const fs = await import("node:fs");
  const file = `${ws}\\bridge-proof.txt`;
  const exists = fs.existsSync(file);
  let content = "";
  if (exists) content = fs.readFileSync(file, "utf8").trim();
  console.log("file exists:", exists);
  console.log("content:", JSON.stringify(content));
  console.log("content matches nonce:", exists && content === nonce);
  console.log("VERIFY:", exists && content === nonce ? "PASS" : "FAIL");
} finally {
  if (adapter) await adapter.close();
}
