#!/usr/bin/env node
// M1 acceptance: single-process select/turn + nonce verification.
// Sends "Reply exactly: BRIDGE_OK_<nonce>" and requires the returned
// assistant_message to contain the EXACT same nonce.

import { CdpClient, BrainSession } from "../src/browser/cdp.mjs";

const argTitle = process.argv[2] || null;

const session = new BrainSession({ client: new CdpClient({ port: 9333 }), providerId: "chatgpt" });
const nonce = `BRIDGE_OK_${Math.random().toString(36).slice(2, 10)}`;
const prompt = `Reply exactly: ${nonce}`;

try {
  await session.ensureConnected();

  if (argTitle) {
    const sel = await session.selectConversation({ title: argTitle });
    if (!sel.selected) {
      console.log(JSON.stringify({ ok: false, step: "select", error: sel.error, candidates: sel.candidates?.slice(0, 5) }, null, 2));
      process.exit(1);
    }
  } else {
    // no title: navigate to a fresh chat so the turn creates a new conversation
    await session.client.cdp("Page.navigate", { url: "https://chatgpt.com/" });
    await new Promise(r => setTimeout(r, 2500));
  }

  const identityBefore = await session.getIdentity();
  const result = await session.brainTurn(prompt, { timeoutMs: 90000, nonce });
  const reply = result.assistant_message || "";

  const containsNonce = reply.includes(nonce);
  const identityAfter = await session.getIdentity();
  const identityStable = !identityBefore.external_id || !identityAfter.external_id || identityBefore.external_id === identityAfter.external_id;

  console.log(JSON.stringify({
    ok: result.ok && containsNonce,
    nonce,
    reply,
    containsNonce,
    identity_stable: identityStable,
    identity_before: identityBefore,
    identity_after: identityAfter,
    completion_reason: result.completion_reason,
  }, null, 2));

  await session.client.close();
  process.exit(result.ok && containsNonce ? 0 : 1);
} catch (e) {
  console.log(JSON.stringify({ ok: false, step: "error", error: e.message }, null, 2));
  process.exit(1);
}
