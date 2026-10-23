'use strict';

// System IPC channels (Workstream 5): settings, secrets, prompt library,
// AI usage, automation kill switch, and activity log.
// src/db.js and src/ai.js are owned by other workstreams; they are loaded
// defensively here and everything degrades gracefully when absent.

const path = require('path');

// ---------------------------------------------------------------------------
// Settings keys
// ---------------------------------------------------------------------------

// Settings registry is canonical in server/settingsKeys.js (port of
// audit D3) — this module re-exports it so existing consumers keep
// one source of truth. Do not re-define key lists here.
const { SECRET_KEYS, SETTABLE_KEYS, validateSetting } = require('../../server/settingsKeys');

const TASK_KEYS = ['research', 'generation', 'scoring', 'email', 'qa', 'editor', 'followup', 'image', 'vision'];

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Seed prompt bodies (fallback if src/seed.js is unavailable — owned by
// another workstream). Prompts are system instructions, not secrets.
// ---------------------------------------------------------------------------

const FALLBACK_PROMPTS = {
  research_lead: {
    name: 'Research lead',
    body: 'You are a business research assistant. Given a local business name, category, and location, summarize only FACTS you are confident about: services offered, hours, contact details, and online presence. Never invent facts. If you do not know something, say UNKNOWN rather than guessing. Return a short JSON object with fields: services[], hours, phone, email, website, socials[], summary, confidence (high|medium|low).',
  },
  score_lead: {
    name: 'Score lead',
    body: 'You are a lead-scoring assistant for a website sales agency. Given a business profile (category, rating, review count, has website or not, location), output a score 0-100 and a brief breakdown of positive and negative signals as JSON: {score, breakdown: {signal: points}}. Do not invent data that was not provided.',
  },
  build_website: {
    name: 'Build website',
    body: 'You are a web designer generating a small-business website as structured JSON: {pages: [{slug, title, sections: [{type, heading, body}]}]}. Use ONLY facts provided in the brief. Mark every factual claim with claim_class: VERIFIED (from business data), OWNER_PROVIDED (owner told us), or AI_COPY (marketing filler). Never present AI_COPY as fact. Keep copy friendly and concise.',
  },
  qa_website: {
    name: 'QA website',
    body: 'You are a QA reviewer for generated small-business websites. Check the provided site JSON for: placeholder text left behind, factual claims without a VERIFIED/OWNER_PROVIDED source, broken structure, missing contact info, and mobile-hostile layouts. Return JSON: {pass: boolean, issues: [{severity, page, detail}]}.',
  },
  write_outreach: {
    name: 'Write outreach',
    body: 'You are writing a short cold email for a website agency to a local business owner. Personalize only with provided facts. Keep it under 120 words, one clear call to action (view their free website preview). No hype, no false claims, no fake testimonials. Return JSON: {subject, body}.',
  },
  follow_up: {
    name: 'Follow-up email',
    body: 'You are writing a brief follow-up email (max 80 words) referencing the earlier preview we sent. One call to action. Do not claim anything not in the provided facts. Return JSON: {subject, body}.',
  },
  site_editor: {
    name: 'Site editor',
    body: 'You are a precise website editor. Apply the requested change to the provided site JSON with the smallest possible diff. Do not invent new business facts. If the request needs a fact you do not have, leave a clearly-marked [NEEDS INFO] placeholder instead of guessing. Return JSON: {pages, theme, summary}.',
  },
};

function getSeedPrompts() {
  try {
    const seed = require('../seed.js'); // owned by another workstream
    if (seed && Array.isArray(seed.PROMPT_SEEDS) && seed.PROMPT_SEEDS.length) {
      return seed.PROMPT_SEEDS;
    }
  } catch { /* seed.js not ready yet — use fallback */ }
  return Object.entries(FALLBACK_PROMPTS).map(([key, p]) => ({ key, name: p.name, body: p.body }));
}

function seedBodyFor(key) {
  const found = getSeedPrompts().find((p) => p.key === key);
  return found ? found.body : null;
}

// ---------------------------------------------------------------------------
// Channel registration
// ---------------------------------------------------------------------------

function register(ipcMain, db) {
  const needDb = () => {
    if (!db) throw new Error('Database is not ready yet.');
  };
  const getSetting = (key) => {
    needDb();
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
  };
  const setSetting = (key, value) => {
    needDb();
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  };
  const logActivity = (area, message) => {
    needDb();
    db.prepare('INSERT INTO activity_log (area, message) VALUES (?, ?)').run(area, String(message).slice(0, 2000));
  };

  // -- settings:getAll ------------------------------------------------------
  ipcMain.handle('settings:getAll', () => {
    needDb();
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const out = {};
    for (const r of rows) {
      out[r.key] = SECRET_KEYS.includes(r.key) && r.value ? '***' : r.value;
    }
    return out;
  });

  // -- settings:set ---------------------------------------------------------
  ipcMain.handle('settings:set', (_evt, { key, value } = {}) => {
    const v = validateSetting(String(key || ''), value);
    if (!v.ok) throw new Error(v.error);
    setSetting(String(key), v.value);
    // Cross-field check: qualified threshold must stay below hot threshold.
    const q = parseInt(getSetting('score.threshold_qualified'), 10);
    const h = parseInt(getSetting('score.threshold_hot'), 10);
    if (Number.isInteger(q) && Number.isInteger(h) && q >= h) {
      throw new Error('score.threshold_qualified must be lower than score.threshold_hot.');
    }
    logActivity('settings', `Setting updated: ${key}`);
    return { ok: true, key, value: v.value };
  });

  // -- settings:setSecret ---------------------------------------------------
  ipcMain.handle('settings:setSecret', (_evt, { key, value } = {}) => {
    key = String(key || '');
    if (!SECRET_KEYS.includes(key)) {
      throw new Error(`"${key}" is not a secret setting. Use settings:set for regular settings.`);
    }
    const v = value == null ? '' : String(value);
    if (v.length > 2000) throw new Error('Secret value is too long (max 2000 chars).');
    setSetting(key, v);
    logActivity('settings', `Secret updated: ${key} (value redacted)`);
    return { ok: true, key, set: v !== '' };
  });

  // -- prompts:list ----------------------------------------------------------
  ipcMain.handle('prompts:list', () => {
    needDb();
    return db.prepare('SELECT key, name, body, updated_at FROM prompts ORDER BY key').all();
  });

  // -- prompts:save ----------------------------------------------------------
  ipcMain.handle('prompts:save', (_evt, { key, body } = {}) => {
    key = String(key || '');
    body = body == null ? '' : String(body);
    const seeds = getSeedPrompts();
    if (!seeds.some((p) => p.key === key)) throw new Error(`Unknown prompt key "${key}".`);
    if (body.trim() === '') throw new Error('Prompt body may not be empty.');
    if (body.length > 20000) throw new Error('Prompt body is too long (max 20000 chars).');
    needDb();
    db.prepare("UPDATE prompts SET body = ?, updated_at = datetime('now') WHERE key = ?").run(body, key);
    logActivity('prompts', `Prompt saved: ${key}`);
    return { ok: true, key };
  });

  // -- prompts:reset ---------------------------------------------------------
  ipcMain.handle('prompts:reset', (_evt, key = '') => {
    key = String(key || '');
    const body = seedBodyFor(key);
    if (body == null) throw new Error(`Unknown prompt key "${key}".`);
    needDb();
    db.prepare("UPDATE prompts SET body = ?, updated_at = datetime('now') WHERE key = ?").run(body, key);
    logActivity('prompts', `Prompt restored to seed default: ${key}`);
    return { ok: true, key };
  });

  // -- ai:status -------------------------------------------------------------
  ipcMain.handle('ai:status', () => {
    needDb();
    try {
      const ai = require('../ai');
      if (typeof ai.setDb === 'function') ai.setDb(db);
      const configured = !!(ai.aiConfigured && ai.aiConfigured());
      const modelImage = getSetting('ai.model.image') || 'gpt-image-2.5-sunburst';
      const modelDefault = getSetting('ai.model.default') || 'gpt-4o-mini';
      return { ok: true, configured, modelImage, modelDefault };
    } catch (e) {
      return { ok: false, configured: false, error: e.message || String(e) };
    }
  });

  // -- ai:usage --------------------------------------------------------------
  ipcMain.handle('ai:usage', (_evt, { days } = {}) => {
    needDb();
    let d = days == null ? 30 : parseInt(days, 10);
    if (!Number.isInteger(d) || d < 1 || d > 365) throw new Error('days must be an integer 1-365.');
    const byTask = db.prepare(`
      SELECT task,
             COUNT(*) AS calls,
             SUM(prompt_tokens) AS prompt_tokens,
             SUM(completion_tokens) AS completion_tokens,
             ROUND(SUM(cost_usd), 4) AS cost_usd
      FROM ai_usage
      WHERE at >= datetime('now', '-' || ? || ' days')
      GROUP BY task ORDER BY cost_usd DESC
    `).all(d);
    const today = db.prepare(`
      SELECT ROUND(COALESCE(SUM(cost_usd), 0), 4) AS c FROM ai_usage
      WHERE date(at) = date('now', 'localtime')
    `).get().c;
    const month = db.prepare(`
      SELECT ROUND(COALESCE(SUM(cost_usd), 0), 4) AS c FROM ai_usage
      WHERE strftime('%Y-%m', at) = strftime('%Y-%m', 'now', 'localtime')
    `).get().c;
    return { days: d, byTask, todayUsd: today, monthUsd: month };
  });

  // -- automation:pause / automation:resume -----------------------------------
  ipcMain.handle('automation:pause', () => {
    setSetting('automation_paused', '1');
    logActivity('automation', 'Automation PAUSED (kill switch engaged). Scanning, generation, campaigns, follow-ups and AI actions stopped.');
    return { ok: true, paused: true };
  });
  ipcMain.handle('automation:resume', () => {
    setSetting('automation_paused', '0');
    logActivity('automation', 'Automation RESUMED by user.');
    return { ok: true, paused: false };
  });

  // -- activity:recent --------------------------------------------------------
  ipcMain.handle('activity:recent', (_evt, args = {}) => {
    needDb();
    const { pageArgs, pageResult } = require('../paginate');
    // Back-compat: { limit } alone = first page of that size.
    const opts = args || {};
    const paging = pageArgs(
      { page: opts.page || 1, pageSize: opts.pageSize != null ? opts.pageSize : (opts.limit || 50) },
      { pageSize: 50, maxSize: 200 }
    );
    const total = db.prepare('SELECT COUNT(*) AS c FROM activity_log').get().c;
    const rows = db.prepare(
      'SELECT id, area, message, at FROM activity_log ORDER BY id DESC LIMIT ? OFFSET ?'
    ).all(paging.pageSize, paging.offset);
    return Object.assign({ rows }, pageResult(rows, total, paging.page, paging.pageSize));
  });

  // -- mcp:setup --------------------------------------------------------------
  // Describes the stdio server so any MCP client can connect. Does not start
  // the server (that process owns stdin). Also returns Tailscale HTTP details.
  ipcMain.handle('mcp:setup', async () => {
    needDb();
    const catalog = require('../mcpCatalog');
    const mcpRemote = require('../mcpRemote');
    const script = path.resolve(__dirname, '..', 'mcp.js');
    const dbPath = db && typeof db.name === 'string' && db.name ? path.resolve(db.name) : '';
    const entry = {
      command: 'node',
      args: [script],
      env: { WS_DB_PATH: dbPath },
    };
    const quote = (value) => JSON.stringify(String(value));
    const examples = [
      {
        title: 'Cursor, Claude Desktop, Windsurf',
        note: 'The same command, args, and env, under mcpServers.',
        body: JSON.stringify({ mcpServers: { 'website-scout': entry } }, null, 2),
      },
      {
        title: 'VS Code',
        note: 'The same stdio server, under servers, with type stdio.',
        body: JSON.stringify({
          servers: { 'website-scout': { type: 'stdio', ...entry } },
        }, null, 2),
      },
      {
        title: 'Codex',
        note: 'The same command as a stdio server entry in config.toml.',
        body: [
          '[mcp_servers.website-scout]',
          `command = ${quote(entry.command)}`,
          `args = [${entry.args.map(quote).join(', ')}]`,
          '',
          '[mcp_servers.website-scout.env]',
          `WS_DB_PATH = ${quote(dbPath)}`,
        ].join('\n'),
      },
    ];
    let recent = [];
    try {
      recent = db.prepare(`
        SELECT id, area, message, at FROM activity_log
        WHERE area = 'mcp' OR message LIKE '%via MCP%'
        ORDER BY id DESC LIMIT 15
      `).all();
    } catch { recent = []; }
    const versions = Array.isArray(catalog.protocolVersions) && catalog.protocolVersions.length
      ? catalog.protocolVersions
      : [catalog.protocolVersion];
    const remote = await mcpRemote.connectionInfo(db);
    return {
      server: catalog.server,
      protocolVersion: catalog.protocolVersion,
      protocolVersions: versions,
      transport: 'stdio',
      framing: 'newline-delimited JSON-RPC 2.0',
      script,
      dbPath,
      command: entry.command,
      args: entry.args,
      env: entry.env,
      config: JSON.stringify(entry, null, 2),
      examples,
      tools: catalog.tools,
      recent,
      remote,
      notes: [
        'Local: newline-delimited JSON-RPC 2.0 over stdin/stdout. Any MCP client starts it.',
        'Remote (Tailscale): start the HTTP listener on this page, then use the Tailscale URL + Bearer token from another device on your tailnet.',
        'WS_DB_PATH must be the desktop app database. Without it, the server uses ~/.config/Website Scout/websitescout.db, which is a different file on Windows.',
        'initialize echoes the client’s protocolVersion when this server supports it (' + versions[0] + ' through ' + versions[versions.length - 1] + ').',
        'Queuing waiting_on_agent (assign / redesign / improve / email submit) writes the optional agent trigger file and may desktop-notify or run Settings → Design agent command. Redesign/improvements also POST design.agent_webhook_url when set. Use design.agentTrigger for path/status; claim work with design.next.',
        'design.review returns screenshot paths only (no base64). design.emailRedesign covers paste/drop inbound change requests — IMAP is not wired yet.',
        'design.lessons exposes the learning playbook/events; briefs include learned_lessons when Settings → Design learning is on.',
        'email.send and other autonomous tools honor the kill switch, the suppression list, and the daily caps from Settings.',
        'Secrets are redacted in the MCP activity log. The HTTP bearer token is stored in Settings as mcp.http_token.',
      ],
    };
  });

  ipcMain.handle('mcp:httpStart', async () => {
    needDb();
    const mcpRemote = require('../mcpRemote');
    const result = await mcpRemote.start(db);
    const remote = await mcpRemote.connectionInfo(db);
    return { ...result, remote };
  });
  ipcMain.handle('mcp:httpStop', () => {
    needDb();
    return require('../mcpRemote').stop();
  });
  ipcMain.handle('mcp:httpStatus', async () => {
    needDb();
    const mcpRemote = require('../mcpRemote');
    const remote = await mcpRemote.connectionInfo(db);
    const http = remote.http || {};
    const health = { ok: !!http.healthOk };
    return {
      running: http.running,
      pid: http.pid,
      port: http.port,
      publicUrl: http.publicUrl,
      tokenSet: http.tokenSet,
      token: http.token,
      startedAt: http.startedAt,
      lastExit: http.lastExit,
      health,
      listening: http.listening,
      listenerSource: http.listenerSource,
      remote,
    };
  });
  ipcMain.handle('mcp:httpRotateToken', async () => {
    needDb();
    const mcpRemote = require('../mcpRemote');
    const result = await mcpRemote.rotateToken(db);
    const remote = await mcpRemote.connectionInfo(db);
    return { ...result, remote };
  });
  ipcMain.handle('mcp:setPublicUrl', async (_evt, args = {}) => {
    needDb();
    const mcpRemote = require('../mcpRemote');
    const result = mcpRemote.setPublicUrl(db, args && args.url != null ? args.url : args);
    const remote = await mcpRemote.connectionInfo(db);
    return { ...result, remote };
  });
  ipcMain.handle('mcp:setListenPort', async (_evt, args = {}) => {
    needDb();
    const mcpRemote = require('../mcpRemote');
    const result = mcpRemote.setListenPort(db, args && args.port != null ? args.port : args);
    const remote = await mcpRemote.connectionInfo(db);
    return { ...result, remote };
  });
}

// Stop HTTP MCP when the app is quitting (best-effort, once).
let quitHooked = false;
function hookQuit() {
  if (quitHooked) return;
  try {
    const { app } = require('electron');
    if (app && typeof app.on === 'function') {
      quitHooked = true;
      app.on('before-quit', () => {
        try { require('../mcpRemote').stop(); } catch { /* ignore */ }
      });
    }
  } catch { /* not in Electron */ }
}
hookQuit();

module.exports = { register, SETTABLE_KEYS, SECRET_KEYS, TASK_KEYS, validateSetting };
