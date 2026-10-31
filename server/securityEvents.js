'use strict';
/**
 * Batch 103 — security event stores.
 *
 * SEC-08: MCP dispatch audit log. Every tools/call is recorded with
 * workspace, token id + prefix, tool name, target ids (picked from the
 * arguments), and the ok/error outcome. 90-day retention, pruned
 * opportunistically on write. Read side is staff-only (Admin routes).
 *
 * SEC-21: auth-event log. Login success/failure on both surfaces, MFA
 * failures and lockouts, and MCP 401s (by presented-token prefix + IP)
 * — the trace Audit 2 §L found completely missing. Lockouts also emit
 * a console alert line so they surface in the app logs immediately.
 *
 * Both writers are BEST-EFFORT: a logging failure must never break the
 * request path (same posture as rateLimitStore). DDL follows the
 * rateLimitStore lazy-ensure pattern (works before/after migrate()).
 */
const { query, driver } = require('./db');

let ensured = null;
function ensureTables() {
  if (!ensured) {
    ensured = (async () => {
      if (driver() === 'sqlite') {
        await query(
          `CREATE TABLE IF NOT EXISTS mcp_audit_log (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             workspace_id INTEGER,
             token_id INTEGER,
             token_prefix TEXT,
             tool TEXT NOT NULL,
             target_json TEXT,
             ok INTEGER NOT NULL DEFAULT 1,
             error TEXT,
             at INTEGER NOT NULL
           )`
        );
        await query('CREATE INDEX IF NOT EXISTS idx_mcp_audit_at ON mcp_audit_log (at)');
        await query('CREATE INDEX IF NOT EXISTS idx_mcp_audit_ws ON mcp_audit_log (workspace_id, at)');
        await query(
          `CREATE TABLE IF NOT EXISTS auth_events (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             surface TEXT NOT NULL,
             event TEXT NOT NULL,
             email TEXT,
             user_id INTEGER,
             workspace_id INTEGER,
             token_prefix TEXT,
             ip TEXT,
             detail TEXT,
             at INTEGER NOT NULL
           )`
        );
        await query('CREATE INDEX IF NOT EXISTS idx_auth_events_at ON auth_events (at)');
        await query('CREATE INDEX IF NOT EXISTS idx_auth_events_surface ON auth_events (surface, at)');
      } else {
        await query(
          `CREATE TABLE IF NOT EXISTS mcp_audit_log (
             id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
             workspace_id BIGINT UNSIGNED NULL,
             token_id BIGINT UNSIGNED NULL,
             token_prefix VARCHAR(32) NULL,
             tool VARCHAR(191) NOT NULL,
             target_json TEXT NULL,
             ok TINYINT NOT NULL DEFAULT 1,
             error VARCHAR(500) NULL,
             at BIGINT NOT NULL,
             KEY idx_mcp_audit_at (at),
             KEY idx_mcp_audit_ws (workspace_id, at)
           ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        );
        await query(
          `CREATE TABLE IF NOT EXISTS auth_events (
             id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
             surface VARCHAR(32) NOT NULL,
             event VARCHAR(64) NOT NULL,
             email VARCHAR(320) NULL,
             user_id BIGINT UNSIGNED NULL,
             workspace_id BIGINT UNSIGNED NULL,
             token_prefix VARCHAR(32) NULL,
             ip VARCHAR(64) NULL,
             detail VARCHAR(500) NULL,
             at BIGINT NOT NULL,
             KEY idx_auth_events_at (at),
             KEY idx_auth_events_surface (surface, at)
           ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        );
      }
    })();
    ensured.catch(() => {
      ensured = null;
    });
  }
  return ensured;
}

const MCP_AUDIT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const AUTH_EVENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
let writesSincePrune = 0;

async function pruneOpportunistic(now) {
  writesSincePrune += 1;
  if (writesSincePrune < 250) return;
  writesSincePrune = 0;
  try {
    await query('DELETE FROM mcp_audit_log WHERE at < :cut', { cut: now - MCP_AUDIT_RETENTION_MS });
    await query('DELETE FROM auth_events WHERE at < :cut', { cut: now - AUTH_EVENT_RETENTION_MS });
  } catch {
    /* best-effort */
  }
}

const TARGET_KEYS = ['id', 'leadId', 'lead_id', 'websiteId', 'siteId', 'jobId', 'domain', 'pageId', 'formId', 'tokenId'];
function pickTargets(args) {
  const out = {};
  if (args && typeof args === 'object') {
    for (const k of TARGET_KEYS) {
      if (args[k] != null && (typeof args[k] === 'number' || typeof args[k] === 'string')) out[k] = args[k];
    }
  }
  return out;
}

/** SEC-08 — record one MCP tools/call outcome. Never throws. */
async function recordMcpCall({ workspaceId, tokenId, tokenPrefix, tool, args, ok, error }) {
  try {
    await ensureTables();
    const now = Date.now();
    await query(
      `INSERT INTO mcp_audit_log (workspace_id, token_id, token_prefix, tool, target_json, ok, error, at)
       VALUES (:ws, :tid, :prefix, :tool, :target, :ok, :error, :at)`,
      {
        ws: workspaceId != null ? Number(workspaceId) : null,
        tid: tokenId != null ? Number(tokenId) : null,
        prefix: tokenPrefix ? String(tokenPrefix).slice(0, 32) : null,
        tool: String(tool || '').slice(0, 191),
        target: JSON.stringify(pickTargets(args)).slice(0, 2000),
        ok: ok ? 1 : 0,
        error: error ? String(error).slice(0, 500) : null,
        at: now,
      }
    );
    await pruneOpportunistic(now);
  } catch {
    /* audit must never break dispatch */
  }
}

/** SEC-21 — record one auth event. Never throws. Lockouts alert. */
async function recordAuthEvent({ surface, event, email, userId, workspaceId, tokenPrefix, ip, detail }) {
  try {
    await ensureTables();
    await query(
      `INSERT INTO auth_events (surface, event, email, user_id, workspace_id, token_prefix, ip, detail, at)
       VALUES (:surface, :event, :email, :uid, :ws, :prefix, :ip, :detail, :at)`,
      {
        surface: String(surface || '').slice(0, 32),
        event: String(event || '').slice(0, 64),
        email: email ? String(email).slice(0, 320) : null,
        uid: userId != null ? Number(userId) : null,
        ws: workspaceId != null ? Number(workspaceId) : null,
        prefix: tokenPrefix ? String(tokenPrefix).slice(0, 32) : null,
        ip: ip ? String(ip).slice(0, 64) : null,
        detail: detail ? String(detail).slice(0, 500) : null,
        at: Date.now(),
      }
    );
    if (event === 'mfa_lockout') {
      // The alert channel: admin-visible store (above) + a loud log
      // line the operator sees in the app logs in real time.
      console.warn(
        `[auth-alert] MFA LOCKOUT surface=${surface} email=${email || ''} user=${userId || ''} ip=${ip || ''}`
      );
    }
    await pruneOpportunistic(Date.now());
  } catch {
    /* auth logging must never break auth */
  }
}

async function listMcpAudit({ workspaceId = null, limit = 100 } = {}) {
  await ensureTables();
  const lim = Math.max(1, Math.min(500, Number(limit) || 100));
  const rows =
    workspaceId != null
      ? await query(
          `SELECT id, workspace_id, token_id, token_prefix, tool, target_json, ok, error, at
             FROM mcp_audit_log WHERE workspace_id = :ws ORDER BY id DESC LIMIT ${lim}`,
          { ws: Number(workspaceId) }
        )
      : await query(
          `SELECT id, workspace_id, token_id, token_prefix, tool, target_json, ok, error, at
             FROM mcp_audit_log ORDER BY id DESC LIMIT ${lim}`
        );
  return rows.map((r) => {
    let targets = {};
    try {
      targets = r.target_json ? JSON.parse(r.target_json) : {};
    } catch {
      targets = {};
    }
    return { ...r, targets };
  });
}

async function listAuthEvents({ surface = null, limit = 100 } = {}) {
  await ensureTables();
  const lim = Math.max(1, Math.min(500, Number(limit) || 100));
  if (surface) {
    return query(
      `SELECT id, surface, event, email, user_id, workspace_id, token_prefix, ip, detail, at
         FROM auth_events WHERE surface = :surface ORDER BY id DESC LIMIT ${lim}`,
      { surface: String(surface).slice(0, 32) }
    );
  }
  return query(
    `SELECT id, surface, event, email, user_id, workspace_id, token_prefix, ip, detail, at
       FROM auth_events ORDER BY id DESC LIMIT ${lim}`
  );
}

module.exports = {
  ensureTables,
  recordMcpCall,
  recordAuthEvent,
  listMcpAudit,
  listAuthEvents,
  pickTargets,
  MCP_AUDIT_RETENTION_MS,
};
