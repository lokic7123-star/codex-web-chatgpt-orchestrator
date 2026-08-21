// Executor provider definitions + codex_current frozen-snapshot resolution.
// A route freezes its resolved config at creation so later config edits cannot
// silently change which model/effort a running task uses.

export const DEFAULT_EXECUTOR_PROVIDER = "codex_current";

const EXECUTOR_PROVIDERS = Object.freeze({
  codex_current: Object.freeze({
    id: "codex_current",
    display_name: "Current Codex configuration",
    default_model: null,
    inherit_config: true,
    selection_hint: "Launches Codex app-server without a forced profile, inheriting the user's local Codex provider, model, and auth. Config is frozen at route creation.",
  }),
  chatgpt_luna: Object.freeze({
    id: "chatgpt_luna",
    display_name: "ChatGPT Luna via Codex",
    codex_profile: "openai",
    default_model: "gpt-5.6-luna",
    models: Object.freeze(["gpt-5.6-luna"]),
    selection_hint: "Codex worker uses the local OpenAI/ChatGPT profile and Luna model.",
  }),
  deepseek_api: Object.freeze({
    id: "deepseek_api",
    display_name: "DeepSeek API via Codex",
    default_model: "deepseek-v4-pro",
    models: Object.freeze(["deepseek-v4-pro", "deepseek-v4-flash"]),
    codex_profiles: Object.freeze({ "deepseek-v4-pro": "deepseek-pro", "deepseek-v4-flash": "deepseek-flash" }),
    selection_hint: "DeepSeek Pro for max reasoning or Flash for lower cost/latency.",
  }),
});

export function normalizeExecutorProvider(value = DEFAULT_EXECUTOR_PROVIDER) {
  const id = String(value || DEFAULT_EXECUTOR_PROVIDER).trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]{0,31}$/.test(id)) {
    const e = new Error("executor_provider must be lowercase letters, numbers, or underscores");
    e.code = "EXECUTOR_PROVIDER_INVALID";
    throw e;
  }
  if (!EXECUTOR_PROVIDERS[id]) {
    const e = new Error(`unsupported executor_provider: ${id}`);
    e.code = "EXECUTOR_PROVIDER_UNSUPPORTED";
    throw e;
  }
  return id;
}

export function getExecutorProvider(value = DEFAULT_EXECUTOR_PROVIDER) {
  return EXECUTOR_PROVIDERS[normalizeExecutorProvider(value)];
}

export function listExecutorProviders() {
  return Object.values(EXECUTOR_PROVIDERS).map(p => ({
    id: p.id,
    display_name: p.display_name,
    default_model: p.default_model,
    models: p.models ? [...p.models] : [],
    codex_profiles: p.codex_profiles ? { ...p.codex_profiles } : undefined,
    inherit_config: Boolean(p.inherit_config),
    selection_hint: p.selection_hint,
  }));
}

export function executorModelOf(providerOrId, requestedModel = "") {
  const provider = typeof providerOrId === "string" ? getExecutorProvider(providerOrId) : providerOrId;
  const req = String(requestedModel || "").trim();
  if (provider.inherit_config) return req || null; // model resolved from frozen snapshot
  const model = req || provider.default_model;
  if (!provider.models.includes(model)) {
    const e = new Error(`unsupported executor_model for ${provider.id}: ${model}`);
    e.code = "EXECUTOR_MODEL_UNSUPPORTED";
    throw e;
  }
  return model;
}

export function executorProfileOf(providerOrId, requestedProfile = "", requestedModel = "") {
  const provider = typeof providerOrId === "string" ? getExecutorProvider(providerOrId) : providerOrId;
  const explicit = String(requestedProfile || "").trim();
  if (explicit) return explicit;
  if (provider.inherit_config) return ""; // no forced profile for codex_current
  const model = executorModelOf(provider, requestedModel);
  return provider.codex_profile || provider.codex_profiles?.[model] || "";
}

export function codexLaunchArgs(providerOrId, requestedModel = "", requestedProfile = "") {
  const provider = typeof providerOrId === "string" ? getExecutorProvider(providerOrId) : providerOrId;
  const model = executorModelOf(provider, requestedModel);
  const profile = executorProfileOf(provider, requestedProfile, model);
  const args = ["app-server", "--listen", "stdio://"];
  return profile ? ["-p", profile, ...args] : args;
}

/**
 * Freeze a route's executor config at creation time.
 * `resolveSnapshot` reads the user's live Codex config once; the returned
 * object is stored on the route and never re-read.
 */
export async function freezeExecutorSnapshot({ providerId = DEFAULT_EXECUTOR_PROVIDER, model = "", profile = "", resolveSnapshot = null } = {}) {
  const provider = normalizeExecutorProvider(providerId);
  const resolvedModel = executorModelOf(provider, model);
  const resolvedProfile = executorProfileOf(provider, profile, resolvedModel);
  const live = provider === "codex_current" && typeof resolveSnapshot === "function"
    ? await resolveSnapshot()
    : null;
  return {
    provider,
    resolved: {
      model: resolvedModel,
      profile: resolvedProfile || null,
      ...(live || {}),
    },
    frozen_at: new Date().toISOString(),
  };
}
