// Acceptance-driven completion gate (review #3).
// completed requires: for EVERY mandatory acceptance criterion, there is
// matching evidence whose result == pass. Having "some evidence" is not enough.

export function normalizeAcceptance(raw = []) {
  const list = Array.isArray(raw) ? raw : [];
  return list.map((item, idx) => {
    if (typeof item === "string") {
      return { id: `A${idx + 1}`, requirement: item, mandatory: true };
    }
    if (item && typeof item === "object") {
      return {
        id: String(item.id || `A${idx + 1}`),
        requirement: String(item.requirement || item.summary || ""),
        mandatory: item.mandatory !== false,
      };
    }
    return null;
  }).filter(Boolean);
}

export function normalizeEvidence(raw = []) {
  const list = Array.isArray(raw) ? raw : [];
  return list.map(item => {
    if (typeof item === "string") {
      return { acceptance_id: "", type: "text", summary: item, pass: true };
    }
    if (item && typeof item === "object") {
      return {
        acceptance_id: String(item.acceptance_id || item.acceptanceId || ""),
        type: String(item.type || "text"),
        command: item.command,
        exit_code: item.exit_code,
        summary: String(item.summary || ""),
        pass: item.pass === true || (item.exit_code !== undefined ? Number(item.exit_code) === 0 : item.pass === true),
      };
    }
    return null;
  }).filter(Boolean);
}

/**
 * Evaluate the completion gate.
 * @returns {{ ok:boolean, mandatoryMet:number, mandatoryTotal:number, missing:[], failed:[], proven:boolean }}
 */
export function evaluateAcceptanceGate({ acceptance = [], evidence = [] } = {}) {
  const criteria = normalizeAcceptance(acceptance);
  const ev = normalizeEvidence(evidence);
  const mandatory = criteria.filter(c => c.mandatory);

  const missing = [];
  const failed = [];
  for (const c of mandatory) {
    const matches = ev.filter(e => e.acceptance_id === c.id);
    if (matches.length === 0) {
      missing.push(c);
      continue;
    }
    const pass = matches.some(e => e.pass);
    if (!pass) failed.push(c);
  }

  const mandatoryMet = mandatory.length - missing.length - failed.length;
  return {
    ok: mandatory.length > 0 ? (missing.length === 0 && failed.length === 0) : false,
    proven: mandatory.length > 0,
    mandatoryMet,
    mandatoryTotal: mandatory.length,
    missing: missing.map(c => c.id),
    failed: failed.map(c => c.id),
    rule: "completed requires every mandatory acceptance criterion to have a passing evidence item",
  };
}

/**
 * Enforce the gate on a review decision. Downgrade completed -> blocked when
 * the acceptance gate is not satisfied.
 */
export function enforceAcceptanceGate(decision = {}, acceptance = [], evidence = []) {
  const gate = evaluateAcceptanceGate({ acceptance, evidence });
  const adjusted = { ...decision };
  if (adjusted.status === "completed" && !gate.ok) {
    adjusted.status = "blocked";
    adjusted.reason = `completion claimed but acceptance gate not met; missing=${gate.missing.join(",") || "none"} failed=${gate.failed.join(",") || "none"}`;
  }
  return { decision: adjusted, gate };
}
