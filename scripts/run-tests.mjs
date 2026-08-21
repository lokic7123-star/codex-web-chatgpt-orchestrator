// Run every offline verification suite; nonzero exit on any failure.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const suites = [
  "verify_codex_protocol.mjs",
  "verify_parallel.mjs",   // part b only (offline)
  "verify_rollover.mjs",
  "verify_resume.mjs",
  "verify_worktree.mjs",
];

let failed = 0;
for (const suite of suites) {
  console.log(`\n== ${suite}`);
  const r = spawnSync(process.execPath, [join(root, "scripts", suite)], { stdio: "inherit" });
  if (r.status !== 0) failed += 1;
}

console.log(`\n${suites.length - failed}/${suites.length} suites passed`);
process.exitCode = failed ? 1 : 0;
