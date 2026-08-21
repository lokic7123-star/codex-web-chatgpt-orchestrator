---
name: web-orchestrator
description: Use web ChatGPT as a planning brain and a local Codex worker as executor via the `web-orchestrator` CLI. Use when the user wants web ChatGPT to plan/review while Codex executes, or to send a message into a live ChatGPT conversation and read the exact reply. NOT for API-based LLM calls.
---

# Web Pro Orchestrator

Drive a user-visible web ChatGPT session (brain, chat quota) and a local `codex app-server` worker (hand, Codex quota) through a bounded brain-hand loop. No API keys, no cookie reading, no CAPTCHA bypass — the user signs in manually in the dedicated browser profile.

## Prerequisites (one-time)

1. The dedicated browser is running with CDP on port 9333 and the user has signed in:
   ```powershell
   # <EDGE_PATH> = path to your Edge/Chrome binary
   # <PROFILE_DIR> = dedicated profile dir (use a fresh, non-default user-data-dir, e.g. ~/.codex/web-pro-orchestrator/chrome-profile)
   & "<EDGE_PATH>" --remote-debugging-address=127.0.0.1 --remote-debugging-port=9333 --user-data-dir="<PROFILE_DIR>" --no-first-run --no-default-browser-check "https://chatgpt.com/"
   ```
2. Verify connectivity:
   ```bash
   node <project>/scripts/verify_cdp.mjs 9333
   ```

## CLI usage

Run from the project root (`web-pro-orchestrator` checkout):

- `node scripts/cli.mjs health` — check browser + composer availability
- `node scripts/cli.mjs identity` — current conversation identity
- `node scripts/cli.mjs list --query <q>` — list visible conversations
- `node scripts/cli.mjs select --title <t>` or `--id <id>` or `--url <u>` — select a conversation
- `node scripts/cli.mjs turn --nonce` — M1 acceptance (exact reply check)
- `node scripts/cli.mjs turn "<prompt>"` — one atomic brain turn, returns the exact new reply
- `node scripts/cli.mjs run --goal "<goal>" [--max-rounds n] [--cwd <dir>]` — full bounded brain-hand loop until a terminal state
- `node scripts/cli.mjs run-multi --spec plan.json` — N parallel brain-hand loops (each gets its own tab + workspace); spec is an array of `{name, goal, cwd, max_rounds?, thread_rounds?, fresh?, worktree?, conversation?}`. Re-running the same session `name` resumes its recorded conversation AND saved progress (round/history/checkpoint); set `"fresh": true` to start over. `"worktree": true` isolates the worker in its own git worktree (safe for parallel sessions on one repo). Top-level `allowed_cwds` restricts where workers may operate.
- `node scripts/cli.mjs sessions` — list registered orchestration sessions (status/round/conversation)
- `node scripts/cli.mjs doctor` — environment self-check: node/codex CLI/CDP endpoint/brain composer/session store
- `node scripts/cli.mjs status` — runner state (note: CLI is stateless per invocation)

## Key semantics

- **Atomic brain turn** (`turn`): sends a prompt, waits for the exact new reply, and rejects stray/stale messages via a before-count + content-hash baseline.
- **Acceptance gate**: a run reaches `completed` only when every mandatory acceptance criterion has a passing evidence item. Missing/failed evidence downgrades to `blocked`.
- **Watchdog**: the Codex worker turn has a hard and an idle timeout; on timeout it interrupts, then kills the app-server child, then marks the route `blocked`. It never auto-approves.
- **awaiting_user**: approval/interaction requests stop the run in an `awaiting_user` state (not a failure); the user resolves it, then resumes.
- **Parallel sessions** (`run-multi`): each session binds an exclusive chatgpt.com tab (never steals other tabs), its own codex app-server child and workspace; one session failing does not affect the others. Same `name` = same conversation on later runs.
- **Thread rollover** (`thread_rounds` in spec): after N rounds the brain compresses progress into a checkpoint and the worker continues in a fresh executor thread seeded with it — prevents long tasks from drowning worker context.

## When to use / not use

Use when the user explicitly wants **web ChatGPT** as the planner/reviewer (chat quota) with Codex doing the execution. Do not use this skill for plain API calls, or when the user only needs local Codex without a web browser.
