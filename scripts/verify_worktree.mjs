#!/usr/bin/env node
// Worktree isolation + cwd whitelist verification (offline, no quota):
//   W1  ensureWorktree creates an isolated worktree with a webpro/* branch
//   W2  resume reuses the recorded worktree when it still exists
//   W3  non-git cwd fails fast with WORKTREE_NOT_A_REPO
//   W4  fresh start creates a NEW worktree, leaving the old one intact
//   W5  removeWorktree(force) cleans up
//   W6-W8 cwd whitelist: inside passes / outside throws / empty = no guard

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { ensureWorktree, removeWorktree, defaultWorktreeBase } from "../src/orchestration/worktree.mjs";
import { normalizeEntries, validateAllowedCwds } from "../src/orchestration/multi.mjs";

const exec = promisify(execFile);
let pass = 0;
let failCount = 0;
const check = (name, cond) => {
  if (cond) { pass += 1; console.log(`PASS ${name}`); }
  else { failCount += 1; console.log(`FAIL ${name}`); }
};

const base = join(tmpdir(), `wpo-wt-test-${Date.now()}`);
const repo = join(base, "repo");
mkdirSync(repo, { recursive: true });
await exec("git", ["init", "-q"], { cwd: repo });
writeFileSync(join(repo, "seed.txt"), "seed\n");
await exec("git", ["-C", repo, "-c", "user.email=test@example.com", "-c", "user.name=test", "add", "."]);
await exec("git", ["-C", repo, "-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-q", "-m", "init"]);

try {
  // W1 create
  const wt1 = await ensureWorktree({ name: "alpha task", repoCwd: repo });
  check("W1 worktree created with webpro/* branch",
    wt1.reused === false
    && existsSync(join(wt1.path, "seed.txt"))
    && /^webpro\//.test(wt1.branch)
    && wt1.path.includes("alpha-task"));

  // W2 resume reuse
  const wt2 = await ensureWorktree({ name: "alpha task", repoCwd: repo, existingPath: wt1.path });
  check("W2 resume reuses recorded worktree", wt2.reused === true && wt2.path === wt1.path && wt2.branch === wt1.branch);

  // W3 non-git cwd fails fast
  const notRepo = join(base, "not-repo");
  mkdirSync(notRepo, { recursive: true });
  try {
    await ensureWorktree({ name: "beta", repoCwd: notRepo });
    check("W3 non-git dir rejected", false);
  } catch (e) {
    check("W3 non-git dir rejected", e.code === "WORKTREE_NOT_A_REPO");
  }

  // W4 fresh start -> new worktree, old one untouched
  const wt4 = await ensureWorktree({ name: "alpha task", repoCwd: repo, existingPath: null });
  check("W4 fresh creates new isolated worktree",
    wt4.reused === false && wt4.path !== wt1.path && existsSync(wt4.path) && wt4.branch !== wt1.branch);

  // W2b cross-repo worktree must NOT be reused (audit S3)
  const repo2 = join(base, "repo2");
  mkdirSync(repo2, { recursive: true });
  await exec("git", ["init", "-q"], { cwd: repo2 });
  writeFileSync(join(repo2, "other.txt"), "other\n");
  await exec("git", ["-C", repo2, "-c", "user.email=test@example.com", "-c", "user.name=test", "add", "."]);
  await exec("git", ["-C", repo2, "-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-q", "-m", "init"]);
  const wtOther = await ensureWorktree({ name: "gamma", repoCwd: repo2 });
  const attempt = await ensureWorktree({ name: "gamma", repoCwd: repo, existingPath: wtOther.path });
  check("W2b worktree of another repo is not reused",
    attempt.reused === false && resolve(attempt.path) !== resolve(wtOther.path));

  // W5 cleanup helper (run from the main repo, with retry for AV locks)
  await removeWorktree(wt4.path, { force: true, repoCwd: repo });
  check("W5 removeWorktree removes the directory", !existsSync(wt4.path));

  // W6-W8 cwd whitelist via normalizeEntries + validateAllowedCwds
  const entries = normalizeEntries([
    { name: "ok", goal: "g", cwd: join(repo, "sub", "dir") },
    { name: "bad", goal: "g", cwd: tmpdir() },
  ]);
  try {
    validateAllowedCwds(entries, [repo]);       // tmpdir() is outside repo
    check("W7 outside whitelist throws", false);
  } catch (e) {
    check("W7 outside whitelist throws", /outside allowed_cwds/.test(e.message) && e.message.includes("bad"));
  }
  validateAllowedCwds(entries.filter(e => e.name === "ok"), [repo, tmpdir()]);
  check("W6 inside whitelist passes (incl. subdir)", true);
  validateAllowedCwds(entries, []);             // no whitelist configured = no restriction
  check("W8 empty whitelist disables the guard", true);

  // cleanup remaining worktrees
  for (const wt of [wt1, wt2, wtOther, attempt]) {
    if (existsSync(wt.path)) await removeWorktree(wt.path, { force: true, repoCwd: repo }).catch(() => {});
  }
} finally {
  rmSync(base, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${failCount} failed`);
process.exit(failCount ? 1 : 0);
