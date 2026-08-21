# codex-web-chatgpt-orchestrator

[![CI](https://github.com/lokic7123-star/codex-web-chatgpt-orchestrator/actions/workflows/ci.yml/badge.svg)](https://github.com/lokic7123-star/codex-web-chatgpt-orchestrator/actions/workflows/ci.yml)

**Let web ChatGPT plan; let a local Codex worker execute.**

A Codex plugin + CLI that drives a **user-visible web ChatGPT session** (the "brain") and a **local `codex app-server` worker** (the "hand") through a bounded brain-hand loop:

```
plan → execute → report → review → (repeat until done)
```

## Why

ChatGPT subscription **chat quota** and **Codex quota** are separate pools. Heavy planning/review work runs in the web ChatGPT UI on your chat quota, while only the concrete execution touches your Codex quota — so expensive reasoning doesn't burn the scarcer pool.

## How it works

```
┌─────────────────────────────┐
│   CLI / Codex skill         │
└──────────┬──────────────────┘
           │
┌──────────▼──────────┐     ┌──────────────────┐
│  BrainSession       │ CDP │  Chrome/Edge      │
│  (atomic brainTurn) │◄───►│  dedicated profile│
│                     │     │  chatgpt.com      │
└──────────┬──────────┘     └──────────────────┘
           │
┌──────────▼──────────┐     ┌──────────────────┐
│  Runner             │ RPC │  codex app-server │
│  state machine      │◄───►│  worker thread    │
│  acceptance gate    │     │  + TurnWatchdog   │
└─────────────────────┘     └──────────────────┘
```

Key design points:

- **Atomic brain turn** — every prompt to web ChatGPT records a baseline (message count + content hash) and only accepts a reply that is *provably new* for this turn. No stray/stale message confusion.
- **Acceptance-driven completion** — the brain's plan carries structured acceptance criteria (`A1`, `A2`, …); a run may only reach `completed` when every mandatory criterion has matching passing evidence. Claimed-but-unproven completion is downgraded to `blocked`.
- **Executor watchdog** — worker turns run under hard + idle timeouts; on timeout the turn is interrupted, then the app-server child is killed, then the route is marked `blocked`. Never auto-retries.
- **Human-in-the-loop approvals** — approval requests surface as an `awaiting_user` state (not an error); nothing is ever auto-approved.
- **Schema gate** — all brain output goes through JSON extraction → schema validation → one repair attempt → fail. The brain is never blindly trusted.
- **Stable identity** — conversations are identified by `provider + conversation_id`; browser tab targets are transient and rebound automatically.

## Requirements

- Node.js ≥ 22
- A Chromium browser (Edge or Chrome) at a known path
- An active ChatGPT session (you sign in manually — see below)
- Codex CLI (`codex`) installed and authenticated

## Setup (one-time)

1. Launch a dedicated browser profile with remote debugging:

   ```powershell
   # <EDGE_PATH> = path to your Edge/Chrome binary
   # <PROFILE_DIR> = a fresh, non-default user-data-dir for this tool only
   & "<EDGE_PATH>" --remote-debugging-address=127.0.0.1 --remote-debugging-port=9333 `
     --user-data-dir="<PROFILE_DIR>" --no-first-run --no-default-browser-check `
     "https://chatgpt.com/"
   ```

2. Sign in to ChatGPT manually in that window.

3. Verify connectivity:

   ```bash
   node scripts/verify_cdp.mjs 9333
   ```

## CLI usage

```bash
node scripts/cli.mjs health                 # browser + composer availability
node scripts/cli.mjs doctor                 # full environment self-check (node/codex/CDP/brain/store)
node scripts/cli.mjs identity               # current conversation identity
node scripts/cli.mjs list --query <q>       # list visible conversations
node scripts/cli.mjs select --title <t>     # select a conversation (or --id / --url)
node scripts/cli.mjs turn "<prompt>"        # one atomic brain turn → exact new reply
node scripts/cli.mjs turn --nonce           # self-test: exact-reply roundtrip check
node scripts/cli.mjs run --goal "<goal>" [--max-rounds n] [--cwd <dir>]
node scripts/cli.mjs run-multi --spec plan.json   # N parallel brain-hand loops
node scripts/cli.mjs sessions                     # list registered sessions
```

`run` executes the full loop: the brain plans with acceptance criteria, the Codex worker executes, evidence flows back, and the brain reviews — repeating until `completed`, `blocked`, `repeated`, `awaiting_user`, or `max_rounds`.

### Parallel sessions

`run-multi` runs several isolated brain-hand loops concurrently. Each session gets its **own chatgpt.com tab** (never stealing another session's or your manual tabs), its own `codex app-server` child, and its own workspace directory:

```json
{
  "allowed_cwds": ["D:/work"],
  "sessions": [
    { "name": "refactor", "goal": "Extract helper module in src/", "cwd": "D:/work/repo1", "max_rounds": 10, "thread_rounds": 4, "worktree": true },
    { "name": "docs", "goal": "Write README for the tools package", "cwd": "D:/work/repo2",
      "conversation": { "title": "docs planner" } }
  ]
}
```

```bash
node scripts/cli.mjs run-multi --spec plan.json
```

- Without `conversation`, each session starts a fresh ChatGPT conversation; with `conversation` (`title`, `id`, or `url`) it reuses an existing one.
- **Resume by name**: re-running a spec with the same session `name` returns to that session's recorded conversation, rebinds to the tab already showing it — and **continues from the saved progress** (round, history, checkpoint). Add `"fresh": true` to an entry to deliberately start over.
- **Worktree isolation** (`"worktree": true`): the worker edits its own `git worktree` under `~/.web-pro-orchestrator/worktrees/` on a `webpro/<session>` branch, so parallel sessions can safely share one repository. The worktree and branch are kept after the run — merging/removing is your call (the session result reminds you of both). Resume reuses the recorded worktree; `fresh: true` creates a new one. Requires the cwd to be a git repository.
- **cwd whitelist** (`allowed_cwds` at spec top level, or `WEB_PRO_ALLOWED_CWDS` env var, `;`-separated): every session cwd must fall under one of the roots, protecting against a typo'd spec pointing the worker elsewhere.
- **Thread rollover** (`thread_rounds`, optional): after N rounds on one executor thread, the brain summarizes progress into a checkpoint and the worker continues in a fresh thread seeded with it — long tasks don't drown the worker's context.
- Session records (status, round, conversation identity, executor thread/generation) persist to `~/.codex/web-pro-orchestrator/sessions.json`; inspect anytime with `sessions`.
- One session failing never takes the others down (`Promise.allSettled`).

## Verification scripts

```bash
node scripts/verify_turn.mjs              # M1: atomic turn + nonce roundtrip (live)
node scripts/verify_executor.mjs <dir>    # M2: worker creates a proof file in <dir> (live, Codex quota)
node scripts/verify_parallel.mjs [a|b]    # parallel sessions (a: live 2-tab turns, b: offline registry)
node scripts/verify_rollover.mjs          # thread rollover + checkpoint seeding (offline)
node scripts/verify_resume.mjs            # progress resume across invocations (offline)
node scripts/verify_worktree.mjs          # worktree isolation + cwd whitelist (offline)
node scripts/verify_codex_protocol.mjs    # executor JSON-RPC handling (offline)
```

CI runs every offline check on push/PR (see `.github/workflows/ci.yml`); the two live checks need a signed-in browser / Codex quota and stay manual.

## Safety boundaries

- No ChatGPT API calls, no cookie reading, no CAPTCHA bypass. You sign in manually in a visible browser.
- The dedicated profile is separate from your normal browser profile.
- The worker never auto-approves anything; approval requests stop the run.
- Repository content sent to web ChatGPT is your choice — review what `run` sends when working with sensitive code.

## Optional: give the brain GitHub access

Web ChatGPT's official GitHub connector (ChatGPT Settings → Apps → GitHub → link as an *Installed* GitHub App) lets the planning brain browse your pushed repositories and public source code on its own — handy for dependency research and cross-repo review during `run`. This project needs no changes for it: the brain simply researches further by itself, while all acceptance evidence still comes from local executor runs. Prefer scoped repository access; do not use ChatGPT's MCP file-commit path — writes belong to the local worker.

## Status

- M1 (reliable web ChatGPT send/receive): ✅ verified via nonce roundtrip
- M2 (full brain-hand loop): ✅ verified end-to-end — worker created a proof file whose content exactly matched the nonce, and the brain review returned `completed` through the schema gate
- Parallel sessions: ✅ verified — two exclusive tabs turn concurrently with zero cross-talk; resume-by-name reuses the same conversation and tab
- Thread rollover + checkpoint: ✅ implemented and offline-verified (rollover boundaries, checkpoint seeding, generation bookkeeping); live executor-side validation pending quota
- DeepSeek brain provider: not planned for now (user decision)

## License

MIT — see [LICENSE](LICENSE).
