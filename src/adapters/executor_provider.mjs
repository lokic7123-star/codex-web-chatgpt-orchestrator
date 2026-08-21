// Executor provider definition + codex_current frozen-snapshot resolution.
// A route freezes its resolved config at creation so later config edits cannot
// silently change which model a running task uses.

export const DEFAULT_EXECUTOR_PROVIDER = "codex_current";

/**
 * Freeze a route's executor config at creation time.
 * `resolveSnapshot` reads the user's live Codex config once; the returned
 * object is stored on the route and never re-read.
 */
export async function freezeExecutorSnapshot({ resolveSnapshot = null } = {}) {
  const live = typeof resolveSnapshot === "function" ? await resolveSnapshot() : null;
  return {
    provider: DEFAULT_EXECUTOR_PROVIDER,
    resolved: {
      model: null,
      profile: null,
      ...(live || {}),
    },
    frozen_at: new Date().toISOString(),
  };
}
