#!/usr/bin/env node
// M1 acceptance: single-process select/turn + nonce verification.
// Sends "Reply exactly: BRIDGE_OK_<nonce>" and requires the returned
// assistant_message to contain the EXACT same nonce.

import { CdpClient, BrainSession } from "../src/browser/cdp.mjs";

const argTitle = process.argv[2] || null;

async function main() {
  const session = new BrainSession({ client: new CdpClient({ port: 9333 }), providerId: "chatgpt" });
  const nonce = `BRIDGE_OK_${Math.random().toString(36).slice(2, 10)}`;
  const prompt = `Reply exactly: ${nonce}`;

  try {
    await session.ensureConnected();

    if (argTitle) {
      const sel = await session.selectConversation({ title: argTitle });
      if (!sel.selected) {
        console.log(JSON.stringify({ ok: false, step: "select", error: sel.error, candidates: sel.candidates?.slice(0, 5) }, null, 2));
        process.exitCode = 1;
        return;
      }
    }

    const result = await session.brainTurn(prompt, { timeoutMs: 90000 });
    const reply = result.assistant_message || "";

    const containsNonce = reply.includes(nonce);
    // brainTurn refreshes identity after the turn; a fresh chat gains its id here
    const identityAfter = await session.getIdentity();
    const identityStable = !result.conversation_id || !identityAfter.external_id || result.conversation_id === identityAfter.external_id;

    console.log(JSON.stringify({
      ok: result.ok && containsNonce && identityStable,
      nonce,
      reply,
      containsNonce,
      identity_stable: identityStable,
      conversation_id: result.conversation_id,
      completion_reason: result.completion_reason,
    }, null, 2));

    session.client.close();
    process.exitCode = result.ok && containsNonce && identityStable ? 0 : 1;
  } catch (e) {
    console.log(JSON.stringify({ ok: false, step: "error", error: e.message }, null, 2));
    process.exitCode = 1;
  }
}

await main();
