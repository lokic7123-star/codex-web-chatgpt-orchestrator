// Brain adapter: maps the runner's brain.plan/report/review onto BrainSession
// (web ChatGPT) using the atomic brainTurn, with protocol schema gate + one repair.

import { validateBrainPlan, validateBrainReview, parseBrainReply, extractJson, clip } from "../../scripts/protocol.mjs";

export function createBrainAdapter({ session, promptBuilder = null, reportTurns = false } = {}) {
  if (!session) throw new TypeError("brain adapter requires a session");

  const brain = {
    async plan({ goal, constraints, round, checkpoint, history, ...rest }) {
      const prompt = typeof promptBuilder?.plan === "function"
        ? promptBuilder.plan({ goal, constraints, round })
        : defaultPlanPrompt(goal, constraints, { checkpoint, history });
      const reply = await session.brainTurn(prompt, { timeoutMs: rest.timeout_ms });
      if (!reply.ok) return brainError(reply.completion_reason, reply.error);
      const parsed = await parseBrainReply(reply.assistant_message, {
        askRepair: async repairText => {
          const r = await session.brainTurn(repairText, { timeoutMs: rest.timeout_ms });
          return r.ok ? r.assistant_message : "";
        },
      });
      if (!parsed.ok) return brainError("brain_protocol_error", parsed.error);
      return { content: [{ type: "text", text: reply.assistant_message }], structuredContent: parsed };
    },

    // optional standalone acknowledgement turn — the review prompt already
    // carries the report, so this is OFF by default to save a chat turn/round
    async report({ round, plan, report, report_text }) {
      const prompt = typeof promptBuilder?.report === "function"
        ? promptBuilder.report({ round, plan, report, report_text })
        : defaultReportPrompt(report_text || "");
      const reply = await session.brainTurn(prompt, { timeoutMs: undefined });
      if (!reply.ok) return brainError(reply.completion_reason, reply.error);
      return { content: [{ type: "text", text: reply.assistant_message }], structuredContent: { ok: true } };
    },

    async review({ round, plan, report, report_text, ...rest }) {
      const prompt = typeof promptBuilder?.review === "function"
        ? promptBuilder.review({ round, plan, report, report_text })
        : defaultReviewPrompt(plan, report);
      const reply = await session.brainTurn(prompt, { timeoutMs: rest.timeout_ms });
      if (!reply.ok) return brainError(reply.completion_reason, reply.error);
      const parsed = validateBrainReview(reply.assistant_message);
      if (!parsed.ok) {
        // one repair attempt
        const r = await session.brainTurn(repairText(reply.assistant_message, parsed.error), { timeoutMs: rest.timeout_ms });
        const second = r.ok ? validateBrainReview(r.assistant_message) : parsed;
        if (!second.ok) return brainError("brain_protocol_error", second.error);
        return { content: [{ type: "text", text: r.assistant_message }], structuredContent: second };
      }
      return { content: [{ type: "text", text: reply.assistant_message }], structuredContent: parsed };
    },

    async checkpoint({ goal, history, checkpoint }) {
      const prompt = [
        "Summarize the orchestration progress so far into a compact checkpoint.",
        "It will seed a FRESH executor thread that has no other memory. Include:",
        "the original goal, what is already done/proven, what remains, and key decisions or constraints learned.",
        'Return JSON only, no markdown fences: {"summary":"compact factual summary"}',
        "",
        `GOAL: ${clip(goal)}`,
        `PREVIOUS CHECKPOINT: ${clip(checkpoint || "none")}`,
        `ROUND HISTORY: ${clip(JSON.stringify(history || []), 4000)}`,
      ].join("\n");
      const reply = await session.brainTurn(prompt, {});
      if (!reply.ok) return brainError(reply.completion_reason, reply.error);
      const parsed = extractJson(reply.assistant_message);
      const summary = String(parsed?.summary || reply.assistant_message || "").slice(0, 6000);
      return { content: [{ type: "text", text: summary }], structuredContent: { ok: true, summary } };
    },
  };

  if (!reportTurns) delete brain.report;
  return brain;
}

function brainError(code, message) {
  return { isError: true, content: [{ type: "text", text: message || code }], structuredContent: { code, reason: message, status: "blocked" } };
}

function defaultPlanPrompt(goal, constraints, ctx = {}) {
  const lines = [
    "You are the planning brain supervising a Codex executor.",
    "Create the next concrete, verifiable task for the executor. Do not claim you edited files or ran commands.",
    "Return JSON only, no markdown fences, no surrounding prose, exactly this shape:",
    '{"status":"continue","task":"one concrete next task","acceptance":[{"id":"A1","requirement":"..."}],"constraints":["..."],"evidence":["..."],"reason":"brief"}',
    "Allowed status: continue, completed, blocked, repeated, awaiting_user.",
    "",
    `GOAL: ${clip(goal)}`,
    `CONSTRAINTS: ${JSON.stringify(constraints)}`,
  ];
  if (ctx.checkpoint) {
    lines.push(`CHECKPOINT (facts from earlier rounds; trust this):\n${clip(ctx.checkpoint, 3000)}`);
  }
  if (Array.isArray(ctx.history) && ctx.history.length) {
    lines.push(`RECENT ROUNDS:\n${ctx.history.slice(-2).map(h => `- r${h.round}: ${h.task} => ${h.status}`).join("\n")}`);
  }
  return lines.join("\n");
}

function defaultReportPrompt(reportText) {
  return [
    "The executor submitted the following execution report. Record it as external evidence.",
    "Reply with a concise acknowledgement only.",
    "",
    `EXECUTOR REPORT:\n${clip(reportText)}`,
  ].join("\n");
}

function defaultReviewPrompt(plan, report) {
  // acceptance ids as the plan defines them — evidence with other ids cannot
  // confirm or veto anything (the gate matches by exact id)
  const criteria = Array.isArray(plan?.acceptance) ? plan.acceptance : [];
  const idList = criteria.map((c, i) => (typeof c === "string" ? `A${i + 1}` : String(c?.id || `A${i + 1}`))).join(", ");
  return [
    "You are the planning brain reviewing the executor's latest work against the acceptance criteria.",
    'Return JSON only: {"status":"continue|completed|blocked|repeated|awaiting_user","next_task":"... or empty","acceptance":[...],"constraints":[...],"evidence":[...],"reason":"..."}',
    "Gate semantics (enforced mechanically after your reply):",
    "- completed ONLY when every mandatory acceptance criterion has passing evidence.",
    "- Your evidence items are DECISIVE: one item with pass:false for a criterion VETOES the executor's self-report, even if the executor claims success.",
    `- Every evidence item MUST use acceptance_id exactly as defined in the plan (${idList || "none defined"}). Items with other ids are ignored by the gate.`,
    "- If you could not verify a criterion yourself, mark its evidence pass:false and use status blocked/continue — do not guess pass:true.",
    "",
    `PLAN: ${clip(JSON.stringify(plan || {}))}`,
    `REPORT: ${clip(JSON.stringify(report || {}))}`,
  ].join("\n");
}

function repairText(raw, error) {
  return [
    "Your previous response did not conform to the required JSON schema.",
    "Return JSON only, no markdown fences, no surrounding text.",
    `Validation error: ${error}`,
    `Previous: ${String(raw).slice(0, 1500)}`,
  ].join("\n");
}
