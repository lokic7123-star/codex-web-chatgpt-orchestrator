// Session registry: JSON file as the record of orchestration sessions
// (pre-SQLite; the SQLite control plane with leases is a later milestone).
//
// Concurrency model: one process owns the sessions it runs, and every write is
// synchronous load -> mutate -> atomic save, so calls cannot interleave inside
// the Node event loop. Cross-process writers are not supported yet by design.
//
// Windows lessons applied: writes go through temp file + rename with retry
// (rename can hit EPERM under Defender / open handles), and the target
// directory is created recursively.

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export function defaultSessionStore() {
  return process.env.WEB_PRO_SESSIONS
    || join(homedir(), ".codex", "web-pro-orchestrator", "sessions.json");
}

const RECORD_FIELDS = [
  "name", "goal", "cwd", "status", "round", "max_rounds",
  "conversation", "executor_thread_id", "last_error", "result_summary",
];

function waitSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {}
}

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, text, "utf8");
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(tmp, file);
      return;
    } catch (error) {
      if (attempt >= 4) {
        try { unlinkSync(tmp); } catch {}
        throw error;
      }
      waitSync(80 * (attempt + 1));
    }
  }
}

export function createSessionManager({ file = defaultSessionStore() } = {}) {
  function load() {
    if (!existsSync(file)) return [];
    try {
      const data = JSON.parse(readFileSync(file, "utf8"));
      if (Array.isArray(data?.sessions)) return data.sessions;
      if (Array.isArray(data)) return data;
      return [];
    } catch {
      return [];
    }
  }

  function save(sessions) {
    mkdirSync(dirname(file), { recursive: true });
    writeAtomic(file, `${JSON.stringify({ version: 1, sessions }, null, 2)}\n`);
  }

  return {
    get file() { return file; },

    list() {
      return load();
    },

    get(idOrName) {
      const key = String(idOrName || "").toLowerCase();
      return load().find(s => s.id === idOrName || String(s.name).toLowerCase() === key) || null;
    },

    // Create or update. Matching: by id when given, else by unique name.
    upsert(patch = {}) {
      const sessions = load();
      const now = new Date().toISOString();
      let rec = null;
      if (patch.id) rec = sessions.find(s => s.id === patch.id) || null;
      if (!rec && patch.name) {
        const key = String(patch.name).toLowerCase();
        rec = sessions.find(s => String(s.name).toLowerCase() === key) || null;
      }
      if (!rec) {
        rec = {
          id: randomUUID().slice(0, 8),
          name: patch.name || `s-${now.replace(/[-:T]/g, "").slice(0, 15)}`,
          goal: "",
          cwd: null,
          status: "registered",
          round: 0,
          max_rounds: null,
          conversation: null,
          executor_thread_id: null,
          last_error: null,
          result_summary: null,
          created_at: now,
        };
        sessions.push(rec);
      }
      for (const k of RECORD_FIELDS) {
        if (patch[k] !== undefined) rec[k] = patch[k];
      }
      rec.updated_at = now;
      save(sessions);
      return rec;
    },

    remove(idOrName) {
      const sessions = load();
      const key = String(idOrName || "").toLowerCase();
      const next = sessions.filter(s => s.id !== idOrName && String(s.name).toLowerCase() !== key);
      if (next.length === sessions.length) return false;
      save(next);
      return true;
    },
  };
}
