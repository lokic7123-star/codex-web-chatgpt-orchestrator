// Conversation routing helpers: extract/validate ChatGPT conversation ids and URLs.

import { getBrainProvider } from "../adapters/web_brain.mjs";

export function conversationIdFromUrl(rawUrl, provider = "chatgpt") {
  try {
    const profile = getBrainProvider(provider);
    const url = new URL(rawUrl);
    for (const prefix of profile.conversation_prefixes) {
      if (url.pathname.toLowerCase().startsWith(prefix.toLowerCase())) {
        const remainder = url.pathname.slice(prefix.length).split("/")[0];
        if (/^[A-Za-z0-9_-]+$/.test(remainder)) return remainder;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function safeConversationUrl(rawUrlOrId, provider = "chatgpt") {
  const profile = getBrainProvider(provider);
  const value = String(rawUrlOrId || "").trim();
  if (!value) return null;
  if (/^[A-Za-z0-9_-]{8,}$/.test(value)) {
    return `${profile.start_url.replace(/\/$/, "")}${profile.default_conversation_prefix}${value}`;
  }
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!profile.hosts.includes(url.hostname.toLowerCase())) return null;
  if (!profile.conversation_prefixes.some(prefix => url.pathname.toLowerCase().startsWith(prefix.toLowerCase()))) return null;
  if (!conversationIdFromUrl(url.href, profile.id)) return null;
  return `${url.origin}${url.pathname}`;
}

export function conversationMatches({ expectedId, actualId, actualUrl, provider = "chatgpt" } = {}) {
  const expected = String(expectedId || "").trim();
  if (!expected) return true;
  const actual = String(actualId || conversationIdFromUrl(actualUrl, provider) || "").trim();
  return Boolean(actual) && actual === expected;
}
