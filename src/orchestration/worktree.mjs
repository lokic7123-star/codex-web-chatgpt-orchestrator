// Git worktree isolation for parallel sessions.
// Design borrowed from DevSpace's worktree mode; implemented natively for
// Windows with plain git commands (no bash/WSL dependency) and a per-user
// base directory instead of inside the repository working tree.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

const sleep = ms => new Promise(r => setTimeout(r, ms));

function slug(text) {
  const s = String(text || "").toLowerCase().replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "session";
}

export function defaultWorktreeBase() {
  return process.env.WEB_PRO_WORKTREES
    || join(homedir(), ".web-pro-orchestrator", "worktrees");
}

async function git(args, cwd) {
  return exec("git", args, { cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
}

/**
 * Ensure an isolated git worktree for a session.
 * - existingPath still valid -> reuse it (resume semantics)
 * - otherwise create <baseDir>/<slug>-<ts> with branch webpro/<slug>-<ts>
 * The worktree and branch are intentionally LEFT BEHIND after the run:
 * merging/removing is a human decision, never automatic.
 */
export async function ensureWorktree({ name, repoCwd, existingPath = null, baseDir = defaultWorktreeBase() } = {}) {
  if (!repoCwd) throw Object.assign(new Error("worktree isolation requires repoCwd"), { code: "WORKTREE_NO_CWD" });
  const repo = resolve(repoCwd);
  try {
    await git(["rev-parse", "--is-inside-work-tree"], repo);
  } catch {
    throw Object.assign(new Error(`worktree isolation requires a git repository: ${repo}`), { code: "WORKTREE_NOT_A_REPO" });
  }

  if (existingPath && existsSync(existingPath)) {
    try {
      const inside = await git(["rev-parse", "--is-inside-work-tree"], resolve(existingPath));
      if (String(inside.stdout).trim() === "true") {
        const head = await git(["rev-parse", "--abbrev-ref", "HEAD"], resolve(existingPath));
        return { path: resolve(existingPath), branch: String(head.stdout).trim(), reused: true };
      }
    } catch {}
  }

  const ts = Date.now().toString(36).slice(-5);
  const dir = join(baseDir, `${slug(name)}-${ts}`);
  const branch = `webpro/${slug(name)}-${ts}`;
  mkdirSync(baseDir, { recursive: true });
  await git(["worktree", "add", "-b", branch, dir], repo);
  return { path: dir, branch, reused: false };
}

/**
 * Remove a worktree (tests / manual cleanup helper). Force: drop uncommitted changes.
 * Runs from the MAIN repository when repoCwd is given — deleting a directory
 * while some process has it as its working directory fails on Windows.
 * Retries absorb transient Defender/AV file locks; final fallback removes the
 * directory via fs and prunes git's metadata from the repo.
 */
export async function removeWorktree(worktreePath, { force = false, repoCwd = null } = {}) {
  const target = resolve(worktreePath);
  const args = ["worktree", "remove"];
  if (force) args.push("--force");
  args.push(target);
  const cwd = repoCwd ? resolve(repoCwd) : target;
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await git(args, cwd);
      return;
    } catch (error) {
      lastError = error;
      await sleep(150 * (attempt + 1));
    }
  }
  rmSync(target, { recursive: true, force: true });
  if (!existsSync(target)) {
    if (repoCwd) {
      try { await git(["worktree", "prune"], resolve(repoCwd)); } catch {}
    }
    return;
  }
  throw lastError;
}
