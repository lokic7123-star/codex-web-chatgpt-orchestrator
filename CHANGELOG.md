# Changelog

## 0.2.0 (2026-08-21)

### Added
- **Parallel sessions** — `run-multi --spec plan.json` runs N isolated brain-hand loops concurrently; each session gets its own chatgpt.com tab, codex app-server child, and workspace. One session failing never takes the others down.
- **Session registry** — `sessions` command + JSON store (`~/.codex/web-pro-orchestrator/sessions.json`) recording status, round, conversation identity, executor thread/generation.
- **Resume by name** — re-running the same session name rebinds to the recorded conversation (and the tab already showing it) and continues from saved progress (round/history/checkpoint). `"fresh": true` starts over.
- **Thread rollover** (`thread_rounds`) — after N rounds the brain compresses progress into a checkpoint and the worker continues in a fresh thread seeded with it.
- **Worktree isolation** (`"worktree": true`) — worker edits its own git worktree on a `webpro/<session>` branch; safe parallel work on one repository.
- **cwd whitelist** — `allowed_cwds` (spec) or `WEB_PRO_ALLOWED_CWDS` env restrict where workers may operate.
- **doctor command** — environment self-check: node / codex CLI / config model / CDP endpoint / brain composer / session store.
- Verification suites: protocol, rollover, resume, worktree, brain adapter, acceptance contract (all offline; CI runs them on every push).

### Fixed
- Executor evidence is now mapped onto plan acceptance ids — `completed` is reachable through the real acceptance gate (previously only reachable when plans carried no criteria).
- Brain review evidence participates in the gate: a review `pass:false` vetoes worker self-reported passes.
- Duplicated agent message text (deltas + completed item were both appended).
- Turn failures (e.g. usage limits) fail fast instead of hanging until the fallback timeout.
- Fresh-tab composer handling (textarea vs contenteditable), background-tab throttling, and DevTools websocket drops on suspended tabs.
- Identical replies to identical prompts are no longer rejected as "stale".
- Tab focus is only taken when the send button stays unavailable (lazy activation), so parallel sessions no longer fight over the window on every turn.
- Status parsing word boundaries ("not done yet" is not `completed`).

### Changed
- Per-round report turn is off by default (the review prompt already carries the report) — saves one chat-quota turn per round.
- MIT license.

## 0.1.0 (2026-08-21)

- Initial release: web ChatGPT brain (plan/review via CDP, chat quota) + local Codex worker (execution, Codex quota), bounded brain-hand loop with acceptance gate, watchdog, schema gate, CLI + Codex skill. M1/M2 verified.
