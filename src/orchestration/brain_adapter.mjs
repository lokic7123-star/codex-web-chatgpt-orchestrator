// Brain adapter: maps the runner's brain.plan/report/review onto BrainSession
// (web ChatGPT) using the atomic brainTurn, with protocol schema gate + one repair.

import { validateBrainPlan, validateBrainReview, parseBrainReply, clip } from "../../scripts/protocol.mjs";

export function createBrainAdapter({ session, promptBuilder = null } = {}) {
  if (!session) throw new TypeError("brain adapter requires a session");

  const brain = {
    async plan({ goal, constraints, round, ...rest }) {
      const prompt = typeof promptBuilder?.plan === "function"
        ? promptBuilder.plan({ goal, constraints, round })
        : defaultPlanPrompt(goal, constraints);
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
  };

  return brain;
}

function brainError(code, message) {
  return { isError: true, content: [{ type: "text", text: message || code }], structuredContent: { code, reason: message, status: "blocked" } };
}

function defaultPlanPrompt(goal, constraints) {
  return [
    "You are the planning brain supervising a Codex executor.",
    "Create the next concrete, verifiable task for the executor. Do not claim you edited files or ran commands.",
    "Return JSON only, no markdown fences, no surrounding prose, exactly this shape:",
    '{"status":"continue","task":"one concrete next task","acceptance":[{"id":"A1","requirement":"..."}],"constraints":["..."],"evidence":["..."],"reason":"brief"}',
    "Allowed status: continue, completed, blocked, repeated, awaiting_user.",
    "",
    `GOAL: ${clip(goal)}`,
    `CONSTRAINTS: ${JSON.stringify(constraints)}`,
  ].join("\n");
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
  return [
    "You are the planning brain reviewing the executor's latest work against the acceptance criteria.",
    'Return JSON only: {"status":"continue|completed|blocked|repeated|awaiting_user","next_task":"... or empty","acceptance":[...],"constraints":[...],"evidence":[...],"reason":"..."}',
    "Use completed ONLY when every mandatory acceptance criterion has passing evidence. Otherwise blocked/repeated/continue.",
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
