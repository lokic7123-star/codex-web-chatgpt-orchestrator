// Stop policy: fingerprinting + round limits.

import { createHash } from "node:crypto";

export const DEFAULT_MAX_ROUNDS = 20;
export const HARD_MAX_ROUNDS = 50;

export function fingerprint(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export function maxRoundsOf(value, fallback = DEFAULT_MAX_ROUNDS) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, HARD_MAX_ROUNDS);
}

export function roundLimitReached(round, maxRounds) {
  const limit = maxRoundsOf(maxRounds);
  return Number(round) >= limit - 1;
}
