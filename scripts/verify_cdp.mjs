#!/usr/bin/env node
// M1 verification: check whether a CDP browser with the dedicated profile is reachable.
// Run: node scripts/verify_cdp.mjs [port]
// If no browser is up, print the launch command to run.

import { CdpClient, DEFAULT_PORT, DEFAULT_PROFILE } from "../src/browser/cdp.mjs";

const port = Number(process.argv[2] || DEFAULT_PORT);
const client = new CdpClient({ port });

try {
  const targets = await client.listTargets();
  const pages = targets.filter(t => t.type === "page");
  console.log(`CDP OK on port ${port}. targets=${targets.length} pages=${pages.length}`);
  for (const p of pages.slice(0, 10)) console.log(`  - ${p.id} :: ${p.url}`);
  if (pages.length === 0) console.log("No page targets yet; open chatgpt.com in the window.");
} catch (e) {
  console.log(`CDP not reachable on port ${port}: ${e.message}`);
  console.log("");
  console.log("Launch a browser with the dedicated profile, then rerun:");
  console.log("");
  console.log(`  & "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" --remote-debugging-address=127.0.0.1 --remote-debugging-port=${port} --user-data-dir="${DEFAULT_PROFILE}" --no-first-run --no-default-browser-check "https://chatgpt.com/"`);
  console.log("");
  console.log("Then sign in manually in the visible window.");
  console.log("After launching, rerun this script to confirm CDP connectivity.");
}
