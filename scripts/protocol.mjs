// Brain/executor output schema gate (review #7).
// raw -> extract JSON -> schema validation -> semantic validation -> repair once -> fail.
// Never blindly trust the brain's JSON.

export const TERMINAL_STATUSES = new Set(["completed", "blocked", "repeated", "awaiting_user", "max_rounds", "failed"]);

export function extractJson(text) {
  const source = String(text || "");
  // 1) fenced json block
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const parsed = tryParse(fenced[1]);
    if (parsed) return parsed;
  }
  // 2) bare JSON object anywhere
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") {
      if (start < 0) start = i;
      depth += 1;
    } else if (ch === "}" && start >= 0) {
      depth -= 1;
      if (depth === 0) {
        const parsed = tryParse(source.slice(start, i + 1));
        if (parsed) return parsed;
        start = -1;
      }
    }
  }
  return null;
}

function tryParse(str) {
  try {
    const v = JSON.parse(str);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

function asString(v) {
  return v === undefined || v === null ? "" : String(v).trim();
}

function asList(v) {
  if (v === undefined || v === null) return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr.map(x => (typeof x === "string" ? x.trim() : x)).filter(Boolean).slice(0, 40);
}

export function normalizeStatus(value, text = "") {
  // word-boundary matching on the VALUE field only, with negated phrases
  // stripped first — scanning raw prose misfires ("must not fail" → failed,
  // "not done yet" → completed)
  const s = String(value || "").toLowerCase();
  const positive = s.replace(/\b(?:not|never|hardly|barely|isn'?t|wasn'?t|aren'?t|weren'?t|don'?t|doesn'?t|didn'?t|haven'?t|hasn'?t|won'?t|can'?t|cannot)\b[^.,;]*/g, " ");
  if (/\bcompleted?\b|\bdone\b|\bfinished\b|\bsuccess\b/.test(positive)) return "completed";
  if (/\bblocked?\b|无法继续|被阻塞/.test(s)) return "blocked";
  if (/\brepeat(?:ed|ing)?\b|重复|循环/.test(s)) return "repeated";
  if (/\bawaiting(?:_user)?\b|\bapproval\b/.test(s)) return "awaiting_user";
  if (/\bmax[_ -]?rounds?\b/.test(s)) return "max_rounds";
  if (/\bfailed?\b|\berror\b/.test(s)) return "failed";
  return "continue";
}

// ---- schemas (lightweight validators; no dependency) ----

export function validateBrainPlan(rawText) {
  const parsed = extractJson(rawText);
  if (!parsed) return { ok: false, error: "no JSON object found" };
  const status = normalizeStatus(parsed.status ?? parsed.decision);
  const task = asString(parsed.task ?? parsed.next_task ?? parsed.nextTask);
  const acceptance = asList(parsed.acceptance ?? parsed.acceptance_criteria ?? parsed.acceptanceCriteria);
  const constraints = asList(parsed.constraints);
  const evidence = asList(parsed.evidence);
  const reason = asString(parsed.reason ?? parsed.rationale ?? parsed.summary);
  if (!task && status === "continue") return { ok: false, error: "continue plan requires a task" };
  return { ok: true, status, task, acceptance, constraints, evidence, reason, parsed };
}

export function validateBrainReview(rawText) {
  const parsed = extractJson(rawText);
  if (!parsed) return { ok: false, error: "no JSON object found" };
  const status = normalizeStatus(parsed.status ?? parsed.decision ?? parsed.result);
  const task = asString(parsed.next_task ?? parsed.nextTask ?? parsed.task);
  const acceptance = asList(parsed.acceptance ?? parsed.acceptance_criteria);
  const constraints = asList(parsed.constraints);
  const evidence = asList(parsed.evidence);
  const reason = asString(parsed.reason ?? parsed.summary);
  return { ok: true, status, task, acceptance, constraints, evidence, reason, parsed };
}

export function validateExecutorReport(rawText) {
  const parsed = extractJson(rawText);
  if (!parsed) return { ok: false, error: "no JSON object found" };
  const status = asString(parsed.status ?? "reported");
  const evidence = asList(parsed.evidence);
  const changes = asList(parsed.changes);
  const tests = asList(parsed.tests);
  const blockers = asList(parsed.blockers);
  const summary = asString(parsed.summary ?? parsed.report ?? parsed.result);
  return { ok: true, status, evidence, changes, tests, blockers, summary, parsed };
}

// ---- repair once ----

export function repairPrompt(rawText, validationError) {
  return [
    "Your previous response did not conform to the required JSON schema.",
    "Return JSON only, with no surrounding text or markdown fences.",
    `Validation error: ${validationError}`,
    "Shape: {\"status\":\"continue|completed|blocked|repeated|awaiting_user\",\"task\":\"...\",\"acceptance\":[...],\"constraints\":[...],\"evidence\":[...],\"reason\":\"...\"}",
    `Previous response was: ${String(rawText).slice(0, 1500)}`,
  ].join("\n");
}

// ---- top-level gate: parse with one repair attempt ----

export async function parseBrainReply(rawText, { askRepair = null } = {}) {
  let result = validateBrainPlan(rawText)?.ok ? validateBrainPlan(rawText) : null;
  const validator = rawText => validateBrainPlan(rawText);
  if (!result || !result.ok) {
    const first = validator(rawText);
    if (!first.ok && typeof askRepair === "function") {
      const repaired = await askRepair(repairPrompt(rawText, first.error || "no JSON"));
      const second = validator(String(repaired || ""));
      if (second.ok) result = second;
      else return { ok: false, error: second.error || "repair failed", protocol_error: "brain_protocol_error" };
    } else {
      return { ok: false, error: first?.error || "invalid plan", protocol_error: "brain_protocol_error" };
    }
  }
  return result;
}

export function clip(value, limit = 6000) {
  const text = String(value ?? "");
  return text.length <= limit ? text : `${text.slice(0, limit)}\n...[truncated]`;
}
