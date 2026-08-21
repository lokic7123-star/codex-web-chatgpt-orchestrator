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

// absolute path of the repo a working directory belongs to (its common .git)
async function gitCommonDir(p) {
  const { stdout } = await git(["rev-parse", "--git-common-dir"], p);
  const out = String(stdout).trim();
  const absolute = out.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(out);
  return absolute ? resolve(out) : resolve(p, out);
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
      const wtDir = resolve(existingPath);
      const inside = await git(["rev-parse", "--is-inside-work-tree"], wtDir);
      const branch = String((await git(["rev-parse", "--abbrev-ref", "HEAD"], wtDir)).stdout).trim();
      // reuse ONLY if it is a worktree of THE SAME repository and one of ours
      // (webpro/* branch) — a polluted/repurposed store path must not cross repos
      const sameRepo = (await gitCommonDir(wtDir)) === (await gitCommonDir(repo));
      if (String(inside.stdout).trim() === "true" && sameRepo && branch.startsWith("webpro/")) {
        return { path: wtDir, branch, reused: true };
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
  // without --force a dirty worktree is refused by git — that refusal is
  // deterministic, so retrying is pointless and the fs fallback below must
  // NEVER run: uncommitted changes must not be silently destroyed.
  const attempts = force ? 3 : 1;
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await git(args, cwd);
      return;
    } catch (error) {
      lastError = error;
      if (!force) break;
      await sleep(150 * (attempt + 1));
    }
  }
  if (force !== true) throw lastError;
  rmSync(target, { recursive: true, force: true });
  if (!existsSync(target)) {
    if (repoCwd) {
      try { await git(["worktree", "prune"], resolve(repoCwd)); } catch {}
    }
    return;
  }
  throw lastError;
}
