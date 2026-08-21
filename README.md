# codex-web-chatgpt-orchestrator

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
node scripts/cli.mjs identity               # current conversation identity
node scripts/cli.mjs list --query <q>       # list visible conversations
node scripts/cli.mjs select --title <t>     # select a conversation (or --id / --url)
node scripts/cli.mjs turn "<prompt>"        # one atomic brain turn → exact new reply
node scripts/cli.mjs turn --nonce           # self-test: exact-reply roundtrip check
node scripts/cli.mjs run --goal "<goal>" [--max-rounds n] [--cwd <dir>]
```

`run` executes the full loop: the brain plans with acceptance criteria, the Codex worker executes, evidence flows back, and the brain reviews — repeating until `completed`, `blocked`, `repeated`, `awaiting_user`, or `max_rounds`.

## Verification scripts

```bash
node scripts/verify_turn.mjs          # M1: atomic turn + nonce roundtrip
node scripts/verify_executor.mjs <dir># M2: worker creates a proof file in <dir>
```

## Safety boundaries

- No ChatGPT API calls, no cookie reading, no CAPTCHA bypass. You sign in manually in a visible browser.
- The dedicated profile is separate from your normal browser profile.
- The worker never auto-approves anything; approval requests stop the run.
- Repository content sent to web ChatGPT is your choice — review what `run` sends when working with sensitive code.

## Status

- M1 (reliable web ChatGPT send/receive): ✅ verified via nonce roundtrip
- M2 (full brain-hand loop): implemented; end-to-end proof pending executor quota availability

## License

Copyright © 2026. All rights reserved. Contact the author for licensing.
