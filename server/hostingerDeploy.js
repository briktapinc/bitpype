'use strict';

/**
 * Batch 59 — one-click Hostinger deployment for /landing software
 * signups (Ely's order, 2026-10-29).
 *
 * A software-interest lead (created by the /landing form — source
 * 'landing-software'; see server/routes/landing.js and the Batch 68
 * note on isSoftwareInterestLead) can be deployed
 * a fresh, STANDARD-edition BitPype install on a new Hostinger VPS,
 * bought through the Hostinger API (see server/hostingerClient.js for
 * the doc-verified endpoints). New installs are never given any
 * elevated edition role — the bootstrap below writes a plain install
 * whose owner is the customer.
 *
 * Money safety:
 *   - The purchase is the ONLY money-moving call, and it is attempted
 *     exactly once per deployment: a UNIQUE active_lead_key column
 *     holds `ws:lead` while a deployment is queued/provisioning/
 *     installing/ready, so a double-click, a replay, or a second tab
 *     can never create a second active deployment — and the purchase
 *     step itself runs only from the 'queued' state, marking
 *     purchase_started_at BEFORE the API call. If the process dies
 *     mid-purchase, the row is failed PURCHASE_OUTCOME_UNKNOWN on
 *     resume instead of re-buying (Ely checks hPanel, then retries).
 *   - The price charged is re-read from the live Hostinger catalog at
 *     start time and must match what the confirmation dialog showed.
 *
 * Flow: queued → (purchase) → provisioning (VM polled until running)
 * → installing (the VM's post-install script builds the instance and
 * phones home) → ready (setup-token email sent) | failed (coded).
 * The install bundle is THIS app's own source tree, streamed once to
 * the VM from a token URL; the post-install script (created via the
 * Hostinger API, referenced by id at purchase) installs Docker, the
 * bundle, per-install generated secrets, and a Caddy front door that
 * gives the instance real HTTPS on its Hostinger hostname — which is
 * what lets the bootstrap set general.public_url to the instance URL
 * through the app's own settings writer (that setting requires an
 * https root URL). The script finishes by creating a password-setup
 * token for the customer's bootstrap account (same
 * password_reset_tokens mechanics as a password reset, 72h expiry)
 * and posting it to the callback; only its SHA-256 hash is stored
 * here. The raw token is used exactly once: in the emailed setup link.
 *
 * Keys: the Hostinger API token lives in the platform setting
 * hostinger.api_token (secretBox-encrypted, platform-only). The
 * per-deployment callback secret + bundle token exist in plaintext
 * ONLY inside the post-install script stored on Ely's Hostinger
 * account; this server stores SHA-256 hashes of both.
 */

const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
const { query, driver } = require('./db');
const platform = require('./platform');
const domain = require('./domain');
const stripeClient = require('./stripeClient');
const realClient = require('./hostingerClient');
const realMailer = require('./mailer');

const ACTIVE_STATUSES = ['queued', 'provisioning', 'installing', 'ready'];
const PROVISION_TIMEOUT_MS = Number(process.env.HOSTINGER_PROVISION_TIMEOUT_MS || 25 * 60 * 1000);
const INSTALL_TIMEOUT_MS = Number(process.env.HOSTINGER_INSTALL_TIMEOUT_MS || 45 * 60 * 1000);
const SETUP_TOKEN_TTL_MS = 72 * 60 * 60 * 1000;

let clientOverride = null;
let mailerOverride = null;
/** Tests only: inject a scripted Hostinger client / mailer. */
function __setClientForTests(c) {
  clientOverride = c || null;
}
function __setMailerForTests(m) {
  mailerOverride = m || null;
}
function client() {
  return clientOverride || realClient;
}
async function sendMail(args) {
  if (mailerOverride) return mailerOverride(args);
  return realMailer.sendPlatformMail(args);
}

function coded(code, message, detail) {
  const e = new Error(message);
  e.code = code;
  if (detail != null && detail !== '') e.detail = String(detail).slice(0, 900);
  return e;
}
function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}
function nowSql(d = new Date()) {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}
function parseDbTime(s) {
  if (!s) return null;
  const t = new Date(String(s).replace(' ', 'T') + (String(s).includes('Z') ? '' : 'Z'));
  return Number.isFinite(t.getTime()) ? t : null;
}
function timingSafeEqualHex(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  return ba.length === bb.length && ba.length > 0 && crypto.timingSafeEqual(ba, bb);
}

/* ------------------------------ config ------------------------------ */

async function getConfig() {
  const [token, priceId, dcRaw, tplRaw] = await Promise.all([
    platform.getPlatformSetting('hostinger.api_token', ''),
    platform.getPlatformSetting('hostinger.default_price_id', ''),
    platform.getPlatformSetting('hostinger.data_center_id', ''),
    platform.getPlatformSetting('hostinger.template_id', ''),
  ]);
  const dataCenterId = /^\d+$/.test(String(dcRaw || '').trim()) ? Number(dcRaw) : null;
  const templateId = /^\d+$/.test(String(tplRaw || '').trim()) ? Number(tplRaw) : null;
  const missing = [];
  if (!String(token || '').trim()) missing.push('hostinger.api_token');
  if (!String(priceId || '').trim()) missing.push('hostinger.default_price_id');
  if (!dataCenterId) missing.push('hostinger.data_center_id');
  if (!templateId) missing.push('hostinger.template_id');
  return {
    configured: missing.length === 0,
    tokenSet: !!String(token || '').trim(),
    missing,
    priceId: String(priceId || '').trim(),
    dataCenterId,
    templateId,
  };
}

/** Ping the account: payment methods + a catalog read. No writes. */
async function testConnection() {
  const cfg = await getConfig();
  if (!cfg.tokenSet) {
    throw coded('HOSTINGER_NOT_CONFIGURED', 'No Hostinger API token is saved yet — paste one above and save first.');
  }
  const methods = await client().listPaymentMethods();
  const items = await client().getCatalog();
  let vpsPrices = 0;
  for (const item of items || []) vpsPrices += ((item && item.prices) || []).length;
  const def = methods.find((m) => m && m.is_default) || null;
  return {
    ok: true,
    paymentMethods: methods.length,
    hasDefaultPaymentMethod: !!def,
    defaultPaymentMethod: def ? String(def.name || def.payment_method || '') : '',
    catalogItems: (items || []).length,
    catalogPrices: vpsPrices,
    configured: cfg.configured,
    missing: cfg.missing,
  };
}

/* --------------------------- lead helpers --------------------------- */

function isSoftwareInterestLead(lead) {
  if (!lead) return false;
  // Batch 68 (final review M-5): eligibility keys off the CREATED-BY
  // marker only — the lead's source, which the /landing route sets
  // when (and only when) it CREATES the lead. Tags and lead_group no
  // longer confer eligibility: the landing fold used to union them
  // onto ANY existing lead with the same email, and imports / manual
  // edits can set them too — either way a lead /landing didn't create
  // must never become one-click-deployable off the back of them.
  return String(lead.source || '') === 'landing-software';
}

function loadLead(workspaceId, leadId) {
  let got = null;
  try {
    got = domain.leadsGet(workspaceId, leadId);
  } catch {
    got = null;
  }
  const lead = got && got.lead ? got.lead : null;
  if (!lead) throw coded('NOT_FOUND', `Lead ${leadId} was not found in workspace ${workspaceId}.`);
  return lead;
}

function leadEvent(workspaceId, leadId, type, detail) {
  try {
    domain.withDb(workspaceId, (db) => {
      db.prepare('INSERT INTO lead_events (lead_id, type, detail) VALUES (?, ?, ?)').run(
        leadId,
        type,
        String(detail || '').slice(0, 2000)
      );
    });
  } catch (e) {
    console.warn('[hostingerDeploy] lead event failed:', e && e.message);
  }
}

/* --------------------------- deployments ---------------------------- */

function publicDeployment(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    workspaceId: Number(row.workspace_id),
    leadId: Number(row.lead_id),
    status: String(row.status),
    planItemId: row.plan_item_id || '',
    planName: row.plan_name || '',
    priceCents: row.price_cents == null ? null : Number(row.price_cents),
    firstPeriodPriceCents:
      row.first_period_price_cents == null ? null : Number(row.first_period_price_cents),
    currency: row.currency || '',
    orderId: row.hostinger_order_id || '',
    subscriptionId: row.hostinger_subscription_id || '',
    vmId: row.hostinger_vm_id || '',
    hostname: row.hostname || '',
    ipAddress: row.ip_address || '',
    instanceUrl: row.instance_url || '',
    adminEmail: row.admin_email || '',
    setupExpiresAt: row.setup_expires_at || null,
    emailSentAt: row.email_sent_at || null,
    warning: row.warning || '',
    errorCode: row.error_code || '',
    errorDetail: row.error_detail || '',
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

async function getDeployment(id) {
  const rows = await query('SELECT * FROM deployments WHERE id = :id LIMIT 1', { id: Number(id) });
  return rows && rows[0] ? rows[0] : null;
}

async function latestForLead(workspaceId, leadId) {
  const rows = await query(
    'SELECT * FROM deployments WHERE workspace_id = :ws AND lead_id = :lead ORDER BY id DESC LIMIT 1',
    { ws: Number(workspaceId), lead: Number(leadId) }
  );
  return rows && rows[0] ? rows[0] : null;
}

async function updateDeployment(id, patch) {
  const allowed = [
    'status', 'plan_item_id', 'plan_name', 'price_cents', 'first_period_price_cents', 'currency',
    'hostinger_order_id', 'hostinger_subscription_id', 'hostinger_vm_id', 'hostinger_script_id',
    'hostname', 'ip_address', 'instance_url', 'setup_token_hash', 'setup_expires_at',
    'email_sent_at', 'warning', 'error_code', 'error_detail', 'purchase_started_at',
    'active_lead_key',
  ];
  const sets = [];
  const params = { id: Number(id) };
  for (const [k, v] of Object.entries(patch || {})) {
    if (!allowed.includes(k)) continue;
    sets.push(`${k} = :${k}`);
    params[k] = v;
  }
  sets.push(driver() === 'sqlite' ? "updated_at = datetime('now')" : 'updated_at = CURRENT_TIMESTAMP');
  if (sets.length === 1) return;
  await query(`UPDATE deployments SET ${sets.join(', ')} WHERE id = :id`, params);
}

async function failDeployment(id, code, message, detail) {
  const dep = await getDeployment(id);
  if (!dep || dep.status === 'failed' || dep.status === 'ready') return dep;
  const detailText = [message, detail].filter(Boolean).join(' — ').slice(0, 1000);
  await updateDeployment(id, {
    status: 'failed',
    error_code: String(code || 'DEPLOY_FAILED').slice(0, 48),
    error_detail: detailText,
    active_lead_key: null,
  });
  leadEvent(
    Number(dep.workspace_id),
    Number(dep.lead_id),
    'deployment_failed',
    `Hostinger deployment #${id} failed (${code}): ${detailText}${dep.hostinger_vm_id ? ` — VM ${dep.hostinger_vm_id} may need cleanup in hPanel` : ''}`
  );
  try {
    await platform.audit(dep.created_by || null, 'hostinger.deploy.failed', `deployment=${id} code=${code}${dep.hostinger_vm_id ? ` vm=${dep.hostinger_vm_id}` : ''}`);
  } catch { /* audit is best-effort */ }
  return getDeployment(id);
}

/* ------------------------- bootstrap script ------------------------- */

/**
 * The post-install script stored on Ely's Hostinger account and run
 * once, as root, on the customer's fresh VM. Placeholders %%…%% are
 * substituted per deployment. It contains NO edition role stamp of
 * any kind — a plain standard install — and no first-party domain
 * literal: callback/bundle URLs arrive fully built.
 */
/**
 * Batch 68 (final review H-4): the admin email is validated against a
 * strict addr-spec subset — no quotes, no `$`, no backticks, nothing
 * that can act inside a shell script — and a failing address is
 * REFUSED, not silently mangled (a mangled admin email would strand
 * the customer's install). The workspace name is display-only, so it
 * keeps the silent-sanitize treatment, now stripping `$` and
 * backticks too. Independently of both, the generated script never
 * places either value inside the unquoted .env heredoc (see below).
 */
const DEPLOY_EMAIL_RE = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;

function buildBootstrapScript({ deploymentId, leadEmail, workspaceName, callbackUrl, callbackSecret, bundleUrl }) {
  const cleanEmail = String(leadEmail || '').trim().slice(0, 200);
  if (!DEPLOY_EMAIL_RE.test(cleanEmail)) {
    throw coded(
      'VALIDATION',
      'The lead email contains characters that cannot be embedded safely in the install script — correct the lead email before deploying.'
    );
  }
  const cleanWs = String(workspaceName || 'Primary').replace(/['"\\$`\n\r]/g, '').slice(0, 80) || 'Primary';
  const template = `#!/bin/bash
# BitPype one-click install — deployment %%ID%% (standard edition).
# Runs once as root on a fresh Ubuntu VPS (Hostinger post-install hook;
# output also lands in /var/log/bitpype-install.log). It installs
# Docker, downloads the BitPype source bundle from our server,
# generates THIS install's secrets on THIS machine, starts the stack
# behind a Caddy HTTPS front door, creates the owner's password-setup
# token, and phones the result home. Nothing here phones out anywhere
# else, and no credential for this install ever leaves this machine
# except the one-time setup token in the final callback.
set -u
exec >>/var/log/bitpype-install.log 2>&1
echo "== bitpype install %%ID%% start $(date -u +%Y-%m-%dT%H:%M:%SZ) =="
post_cb() { curl -fsS -m 20 -X POST '%%CALLBACK_URL%%' -H 'Content-Type: application/json' -d "$1" >/dev/null 2>&1 || true; }
fail() { post_cb "$(printf '{"deploymentId":%%ID%%,"secret":"%%SECRET%%","status":"failed","error":"%s"}' "$1")"; echo "FAILED at: $1"; exit 1; }
export DEBIAN_FRONTEND=noninteractive
apt-get update -y || fail "apt-update"
apt-get install -y ca-certificates curl openssl || fail "apt-install"
curl -fsSL https://get.docker.com | sh || fail "docker-install"
docker version >/dev/null 2>&1 || fail "docker-unavailable"
mkdir -p /opt/bitpype && cd /opt/bitpype || fail "mkdir"
curl -fsSL '%%BUNDLE_URL%%' -o bundle.tar.gz || fail "bundle-download"
tar xzf bundle.tar.gz || fail "bundle-extract"
MYSQL_ROOT_PASSWORD=$(openssl rand -hex 24)
MYSQL_PASSWORD=$(openssl rand -hex 24)
SESSION_SECRET=$(openssl rand -hex 32)
SETTINGS_ENCRYPTION_KEY=$(openssl rand -base64 32)
BOOTSTRAP_PASSWORD=$(openssl rand -hex 24)
HOSTN=$(hostname -f 2>/dev/null || hostname)
IPADDR=$(hostname -I 2>/dev/null | awk '{print $1}')
case "$HOSTN" in
  *.*) PUBLIC_HOST="$HOSTN"; INSTANCE_URL="https://$HOSTN" ;;
  *) PUBLIC_HOST="$IPADDR"; INSTANCE_URL="http://$IPADDR" ;;
esac
cat > .env <<EOF
MYSQL_ROOT_PASSWORD=$MYSQL_ROOT_PASSWORD
MYSQL_USER=scout
MYSQL_PASSWORD=$MYSQL_PASSWORD
MYSQL_DATABASE=website_scout
SESSION_SECRET=$SESSION_SECRET
SETTINGS_ENCRYPTION_KEY=$SETTINGS_ENCRYPTION_KEY
APP_URL=$INSTANCE_URL
BOOTSTRAP_PASSWORD=$BOOTSTRAP_PASSWORD
BOOTSTRAP_SUPER_ADMIN=1
EOF
printf '%s\\n' 'BOOTSTRAP_EMAIL=%%EMAIL%%' >> .env
printf '%s\\n' 'BOOTSTRAP_WORKSPACE=%%WORKSPACE%%' >> .env
cat > docker-compose.override.yml <<'EOF'
services:
  web:
    image: caddy:2-alpine
    restart: unless-stopped
    depends_on:
      - app
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
volumes:
  caddy_data:
  caddy_config:
EOF
case "$INSTANCE_URL" in
  https://*) printf '%s {\\n  reverse_proxy app:3000\\n}\\n' "$PUBLIC_HOST" > Caddyfile ;;
  *) printf ':80 {\\n  reverse_proxy app:3000\\n}\\n' > Caddyfile ;;
esac
docker compose up -d --build || fail "compose-up"
ok=0
for i in $(seq 1 100); do
  if curl -fsS -m 5 http://127.0.0.1:3080/health >/dev/null 2>&1; then ok=1; break; fi
  sleep 10
done
[ "$ok" = "1" ] || fail "health-timeout"
cat > bp-setup.js <<'NODEEOF'
(async () => {
  const crypto = require('crypto');
  const { query } = require('/app/server/db');
  const platform = require('/app/server/platform');
  const url = process.env.INSTANCE_URL || '';
  if (url.indexOf('https://') === 0) {
    await platform.setPlatformSetting('general.public_url', url);
  }
  const rows = await query('SELECT id FROM users WHERE email = :e LIMIT 1', { e: process.env.ADMIN_EMAIL || '' });
  if (!rows || !rows[0]) { console.error('bootstrap user not found'); process.exit(2); }
  const raw = crypto.randomBytes(24).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const exp = new Date(Date.now() + 72 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  await query('DELETE FROM password_reset_tokens WHERE user_id = :u', { u: rows[0].id });
  await query('INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (:u, :h, :x)', { u: rows[0].id, h: hash, x: exp });
  console.log(raw);
})().catch((e) => { console.error((e && e.message) || e); process.exit(1); });
NODEEOF
docker compose cp ./bp-setup.js app:/tmp/bp-setup.js || fail "setup-copy"
SETUP_TOKEN=$(docker compose exec -T -e INSTANCE_URL="$INSTANCE_URL" -e ADMIN_EMAIL='%%EMAIL%%' app node /tmp/bp-setup.js | tail -1 | tr -d '\\r') || fail "setup-token"
[ -n "$SETUP_TOKEN" ] || fail "setup-token-empty"
READY_JSON=$(printf '{"deploymentId":%%ID%%,"secret":"%%SECRET%%","status":"ready","instance_url":"%s","setup_token":"%s"}' "$INSTANCE_URL" "$SETUP_TOKEN")
for i in 1 2 3; do
  if curl -fsS -m 20 -X POST '%%CALLBACK_URL%%' -H 'Content-Type: application/json' -d "$READY_JSON" >/dev/null 2>&1; then break; fi
  sleep 5
done
echo "== bitpype install %%ID%% complete: $INSTANCE_URL =="
`;
  return template
    .split('%%ID%%').join(String(Number(deploymentId)))
    .split('%%EMAIL%%').join(cleanEmail)
    .split('%%WORKSPACE%%').join(cleanWs)
    .split('%%CALLBACK_URL%%').join(String(callbackUrl))
    .split('%%SECRET%%').join(String(callbackSecret))
    .split('%%BUNDLE_URL%%').join(String(bundleUrl));
}

/* ------------------------------ preview ----------------------------- */

async function previewForLead(workspaceId, leadId) {
  const lead = loadLead(workspaceId, leadId);
  if (!isSoftwareInterestLead(lead)) {
    throw coded('NOT_SOFTWARE_LEAD', 'One-click deployment is only available on software-interest leads (the /landing signups).');
  }
  const cfg = await getConfig();
  const existing = await latestForLead(workspaceId, leadId);
  const out = {
    eligible: true,
    lead: { id: Number(lead.id), name: lead.business_name || '', email: lead.email || '' },
    configured: cfg.configured,
    missing: cfg.missing,
    existing: publicDeployment(existing),
    plan: null,
  };
  if (!cfg.configured) return out;
  const items = await client().getCatalog();
  const price = client().findCatalogPrice(items, cfg.priceId);
  if (!price) {
    throw coded(
      'PLAN_UNAVAILABLE',
      `The configured VPS plan (${cfg.priceId}) is not in the Hostinger catalog on this account. Check the price ID in Admin → Settings → Hostinger.`
    );
  }
  out.plan = { ...price, dataCenterId: cfg.dataCenterId, templateId: cfg.templateId };
  return out;
}

/* ------------------------------- start ------------------------------ */

async function startDeployment({ workspaceId, leadId, actorUserId, confirmText, confirmPriceCents, confirmFirstPeriodCents }) {
  const lead = loadLead(workspaceId, leadId);
  if (!isSoftwareInterestLead(lead)) {
    throw coded('NOT_SOFTWARE_LEAD', 'One-click deployment is only available on software-interest leads (the /landing signups).');
  }
  const email = String(lead.email || '').trim();
  if (!email || !DEPLOY_EMAIL_RE.test(email)) {
    // Batch 68 (H-4): the same strict charset the bootstrap script
    // enforces — the loose [^\s@] shape accepted `$`/backtick payloads.
    throw coded('VALIDATION', 'This lead has no usable email address — the instance admin account needs one.');
  }
  const cfg = await getConfig();
  if (!cfg.configured) {
    throw coded(
      'HOSTINGER_NOT_CONFIGURED',
      `Hostinger deployment is not fully configured — missing: ${cfg.missing.join(', ')}. Set them in Admin → Settings → Hostinger.`,
      cfg.missing.join(',')
    );
  }
  const prev = await latestForLead(workspaceId, leadId);
  if (prev && ACTIVE_STATUSES.includes(String(prev.status))) {
    const e = coded('DEPLOYMENT_ACTIVE', `Lead ${leadId} already has a ${prev.status} deployment (#${prev.id}).`, `deployment=${prev.id}`);
    e.deploymentId = Number(prev.id);
    throw e;
  }
  // Batch 68 (final review Low #4): the typed-DEPLOY confirmation and
  // BOTH price confirmations are enforced HERE, server-side and
  // unconditionally — before Batch 68 the price checks ran only when
  // the caller bothered to send the fields, so a bare API call bought
  // at whatever the live catalog said. (Placed after the config /
  // active-deployment checks so the dormant and already-running
  // answers stay exactly as Batch 59 pinned them.)
  if (String(confirmText || '') !== 'DEPLOY') {
    throw coded('CONFIRM_REQUIRED', 'Type DEPLOY to confirm the purchase.');
  }
  if (confirmPriceCents == null || confirmFirstPeriodCents == null) {
    throw coded('CONFIRM_REQUIRED', 'Both catalog price confirmations are required — review the live price and confirm again.');
  }
  const items = await client().getCatalog();
  const price = client().findCatalogPrice(items, cfg.priceId);
  if (!price) {
    throw coded('PLAN_UNAVAILABLE', `The configured VPS plan (${cfg.priceId}) is not in the Hostinger catalog on this account.`);
  }
  const firstPeriod = price.firstPeriodPriceCents != null ? price.firstPeriodPriceCents : price.priceCents;
  if (Number(confirmPriceCents) !== price.priceCents) {
    const e = coded('PRICE_CHANGED', 'The catalog price changed since the confirmation was shown — review the new price and confirm again.', JSON.stringify(price));
    e.plan = price;
    throw e;
  }
  if (Number(confirmFirstPeriodCents) !== firstPeriod) {
    const e = coded('PRICE_CHANGED', 'The catalog price changed since the confirmation was shown — review the new price and confirm again.', JSON.stringify(price));
    e.plan = price;
    throw e;
  }

  const callbackSecret = crypto.randomBytes(32).toString('hex');
  const bundleToken = crypto.randomBytes(32).toString('hex');
  const base = stripeClient.appUrl().replace(/\/+$/, '');
  const callbackUrl = `${base}/api/v1/hostinger-deploy/callback`;
  const bundleUrl = `${base}/api/v1/hostinger-deploy/bundle?token=${bundleToken}`;

  let inserted;
  try {
    inserted = await query(
      `INSERT INTO deployments
        (workspace_id, lead_id, lead_email, status, plan_item_id, plan_name, price_cents,
         first_period_price_cents, currency, admin_email, callback_secret_hash,
         bundle_token_hash, active_lead_key, created_by)
       VALUES (:ws, :lead, :email, 'queued', :priceId, :planName, :priceCents,
         :firstPeriod, :currency, :email, :cbHash, :bundleHash, :activeKey, :actor)`,
      {
        ws: Number(workspaceId),
        lead: Number(leadId),
        email,
        priceId: price.priceId,
        planName: price.itemName || price.priceName || price.priceId,
        priceCents: price.priceCents,
        firstPeriod,
        currency: price.currency,
        cbHash: sha256(callbackSecret),
        bundleHash: sha256(bundleToken),
        activeKey: `${Number(workspaceId)}:${Number(leadId)}`,
        actor: actorUserId || null,
      }
    );
  } catch (e) {
    if (e && (e.code === 'ER_DUP_ENTRY' || /unique/i.test(String(e.message || '')))) {
      const e2 = coded('DEPLOYMENT_ACTIVE', `Lead ${leadId} already has an active deployment.`);
      throw e2;
    }
    throw e;
  }
  const deploymentId = Number(inserted.insertId);

  // The install script must exist before the purchase references it.
  try {
    const script = buildBootstrapScript({
      deploymentId,
      leadEmail: email,
      workspaceName: lead.business_name || 'Primary',
      callbackUrl,
      callbackSecret,
      bundleUrl,
    });
    if (Buffer.byteLength(script, 'utf8') > 48 * 1024) {
      throw coded('INSTALL_SCRIPT_TOO_LARGE', 'The generated install script exceeds the Hostinger 48 KB post-install limit.');
    }
    const created = await client().createPostInstallScript({
      name: `BitPype install #${deploymentId}`,
      content: script,
    });
    await updateDeployment(deploymentId, { hostinger_script_id: String(created.id) });
  } catch (e) {
    await failDeployment(deploymentId, e.code || 'HOSTINGER_API', e.message, e.detail);
    throw e;
  }

  leadEvent(workspaceId, leadId, 'deployment_started', `Hostinger deployment #${deploymentId} started — ${price.itemName || price.priceId} (${price.currency} ${(firstPeriod / 100).toFixed(2)} first period)`);
  try {
    await platform.audit(actorUserId || null, 'hostinger.deploy.start', `deployment=${deploymentId} lead=${leadId} priceId=${price.priceId}`);
  } catch { /* best-effort */ }

  setImmediate(() => {
    advanceDeployment(deploymentId).catch((e) => console.warn('[hostingerDeploy] advance', deploymentId, e && e.message));
  });
  return publicDeployment(await getDeployment(deploymentId));
}

async function retryDeployment(args) {
  const prev = await latestForLead(args.workspaceId, args.leadId);
  if (!prev) throw coded('NOT_FOUND', 'No previous deployment exists for this lead.');
  if (String(prev.status) !== 'failed') {
    throw coded('NOT_RETRYABLE', `Only a failed deployment can be retried — the latest deployment is ${prev.status}.`);
  }
  return startDeployment(args);
}

/* --------------------------- state machine -------------------------- */

function setupBody(cfg, dep) {
  return {
    data_center_id: cfg.dataCenterId,
    template_id: cfg.templateId,
    post_install_script_id: dep.hostinger_script_id ? Number(dep.hostinger_script_id) : undefined,
  };
}

async function advanceDeployment(id) {
  const dep = await getDeployment(id);
  if (!dep) return;
  if (dep.status === 'queued') return stepPurchase(dep);
  if (dep.status === 'provisioning') return stepProvision(dep);
  if (dep.status === 'installing') return stepInstallWatch(dep);
}

/**
 * Batch 68 (final review H-6): atomically claim a queued deployment
 * for the purchase step. The UPDATE only matches while the row is
 * still 'queued', and the caller proceeds only when exactly one row
 * was affected — so two overlapping advances (the start setImmediate
 * racing a ticker tick, or two ticks) can never both reach the money
 * call. The claim also stamps purchase_started_at BEFORE the call:
 * if the process dies mid-purchase, the resume path sees the stamp
 * with no order/vm/subscription and fails PURCHASE_OUTCOME_UNKNOWN
 * instead of buying twice.
 */
async function claimDeploymentForPurchase(id) {
  const ts = driver() === 'sqlite' ? "datetime('now')" : 'CURRENT_TIMESTAMP';
  const r = await query(
    `UPDATE deployments SET status = 'provisioning', purchase_started_at = :now, updated_at = ${ts} WHERE id = :id AND status = 'queued'`,
    { id: Number(id), now: nowSql() }
  );
  const n = r && (r.affectedRows != null ? r.affectedRows : r.changes);
  return Number(n) === 1;
}

async function stepPurchase(dep) {
  // Batch 68 (H-6): never purchase without the install script — the
  // row is inserted before createPostInstallScript completes, and a
  // purchase in that window would buy a VM with no install attached.
  // (The ticker also excludes scriptless queued rows; this is the
  // hard gate behind it.)
  if (!dep.hostinger_script_id) {
    console.warn('[hostingerDeploy] purchase deferred — install script not created yet', dep.id);
    return;
  }
  // Atomic claim: exactly one concurrent advance proceeds.
  if (!(await claimDeploymentForPurchase(dep.id))) return;
  const cfg = await getConfig();
  if (!cfg.configured) {
    return failDeployment(dep.id, 'HOSTINGER_NOT_CONFIGURED', 'Hostinger settings were incomplete when the purchase step ran.', cfg.missing.join(','));
  }
  let res;
  try {
    res = await client().purchaseVirtualMachine({
      item_id: dep.plan_item_id,
      setup: setupBody(cfg, dep),
    });
  } catch (e) {
    const rawCode = e.code || 'HOSTINGER_PURCHASE_FAILED';
    if (rawCode === 'HOSTINGER_UNREACHABLE' || rawCode === 'HOSTINGER_API') {
      // Batch 68 (final review H-5): the outcome is UNKNOWN — a
      // timeout/5xx can land AFTER Hostinger processed the payment.
      // Do NOT fail the deployment here: 'failed' is retryable, and a
      // retry would buy a second VM. The row stays 'provisioning'
      // with purchase_started_at stamped (by the claim), and
      // stepProvision's lost-purchase guard converts it to
      // PURCHASE_OUTCOME_UNKNOWN after the grace window — the honest
      // path where a human checks hPanel before any retry.
      console.warn('[hostingerDeploy] purchase outcome ambiguous — left provisioning for the outcome-unknown guard', dep.id, rawCode, e && e.message);
      return;
    }
    let code = rawCode;
    if (code === 'HOSTINGER_VALIDATION' && /item|plan|price|catalog/i.test(String(e.detail || e.message || ''))) {
      code = 'PLAN_UNAVAILABLE';
    }
    return failDeployment(dep.id, code, e.message, e.detail);
  }
  const patch = {};
  if (res.paymentProcessing) {
    const raw = res.raw || {};
    if (raw.id != null) patch.hostinger_order_id = String(raw.id);
    if (raw.subscription_id) patch.hostinger_subscription_id = String(raw.subscription_id);
    await updateDeployment(dep.id, patch);
    return; // the ticker finds the VM by subscription_id
  }
  if (res.order) {
    if (res.order.id != null) patch.hostinger_order_id = String(res.order.id);
    if (res.order.subscription_id) patch.hostinger_subscription_id = String(res.order.subscription_id);
  }
  const vm = res.virtualMachine;
  if (vm) {
    if (vm.id != null) patch.hostinger_vm_id = String(vm.id);
    if (vm.subscription_id) patch.hostinger_subscription_id = String(vm.subscription_id);
    if (vm.hostname) patch.hostname = String(vm.hostname);
    const ip = client().firstIpv4(vm);
    if (ip) patch.ip_address = ip;
    if (vm.plan) patch.plan_name = String(vm.plan);
  }
  await updateDeployment(dep.id, patch);
  const fresh = await getDeployment(dep.id);
  if (vm && String(vm.state || '') === 'initial') {
    try {
      await client().setupVirtualMachine(vm.id, setupBody(cfg, fresh));
    } catch (e) {
      return failDeployment(dep.id, e.code || 'HOSTINGER_SETUP_FAILED', `VM ${vm.id} was purchased but its setup call failed: ${e.message}`, e.detail);
    }
  }
  return stepProvision(await getDeployment(dep.id));
}

async function stepProvision(dep) {
  const created = parseDbTime(dep.created_at);
  // Lost-purchase guard: the purchase call started long ago but no
  // order/subscription/VM was ever recorded → the outcome is unknown;
  // never re-buy blind. (120s grace so a live in-flight call — capped
  // at a 30s timeout — is never mistaken for a lost one.)
  if (
    dep.purchase_started_at &&
    !dep.hostinger_order_id &&
    !dep.hostinger_subscription_id &&
    !dep.hostinger_vm_id &&
    Date.now() - new Date(parseDbTime(dep.purchase_started_at)).getTime() > 120000
  ) {
    return failDeployment(
      dep.id,
      'PURCHASE_OUTCOME_UNKNOWN',
      'The purchase request started but its outcome was never recorded (the app restarted mid-purchase). Check hPanel for a new VPS/subscription before retrying — retrying blind could buy a second server.'
    );
  }
  if (created && Date.now() - created.getTime() > PROVISION_TIMEOUT_MS) {
    return failDeployment(
      dep.id,
      'PROVISION_TIMEOUT',
      `The VPS did not reach running state within ${Math.round(PROVISION_TIMEOUT_MS / 60000)} minutes.`,
      dep.hostinger_vm_id ? `VM ${dep.hostinger_vm_id} (${dep.hostname || 'no hostname yet'}) — check it in hPanel.` : 'No VM id was recorded.'
    );
  }
  const cfg = await getConfig();
  let vm = null;
  try {
    if (!dep.hostinger_vm_id && dep.hostinger_subscription_id) {
      const list = await client().listVirtualMachines();
      vm = (list || []).find((v) => v && String(v.subscription_id || '') === String(dep.hostinger_subscription_id)) || null;
      if (vm && vm.id != null) {
        await updateDeployment(dep.id, { hostinger_vm_id: String(vm.id) });
        dep = await getDeployment(dep.id);
      }
    }
    if (dep.hostinger_vm_id) {
      vm = await client().getVirtualMachine(dep.hostinger_vm_id);
    }
  } catch (e) {
    if (e.code === 'HOSTINGER_AUTH' || e.code === 'HOSTINGER_NOT_CONFIGURED') {
      return failDeployment(dep.id, e.code, e.message, e.detail);
    }
    console.warn('[hostingerDeploy] poll', dep.id, e && e.message);
    return; // transient — next tick retries
  }
  if (!vm) return;
  const patch = {};
  if (vm.hostname && vm.hostname !== dep.hostname) patch.hostname = String(vm.hostname);
  const ip = client().firstIpv4(vm);
  if (ip && ip !== dep.ip_address) patch.ip_address = ip;
  if (vm.plan) patch.plan_name = String(vm.plan);
  if (Object.keys(patch).length) {
    await updateDeployment(dep.id, patch);
    dep = await getDeployment(dep.id);
  }
  const state = String(vm.state || '');
  if (state === 'error') {
    return failDeployment(dep.id, 'VM_ERROR', `Hostinger reports VM ${dep.hostinger_vm_id} in state "error".`, `hostname=${dep.hostname || ''}`);
  }
  if (state === 'initial') {
    // Purchased (e.g. after a 202 payment flow) but never set up —
    // run the setup call now; errors are retried by the next tick
    // until the provisioning deadline governs.
    try {
      await client().setupVirtualMachine(dep.hostinger_vm_id, setupBody(cfg, dep));
    } catch (e) {
      console.warn('[hostingerDeploy] setup retry', dep.id, e && e.message);
    }
    return;
  }
  if (state === 'running') {
    const instanceUrl = dep.hostname ? `https://${dep.hostname}` : dep.ip_address ? `http://${dep.ip_address}` : '';
    await updateDeployment(dep.id, { status: 'installing', instance_url: instanceUrl || dep.instance_url });
    leadEvent(Number(dep.workspace_id), Number(dep.lead_id), 'deployment_installing', `VM ${dep.hostinger_vm_id} is running (${dep.hostname || dep.ip_address || ''}) — BitPype install in progress`);
  }
}

async function stepInstallWatch(dep) {
  const since = parseDbTime(dep.updated_at) || parseDbTime(dep.created_at);
  if (since && Date.now() - since.getTime() > INSTALL_TIMEOUT_MS) {
    return failDeployment(
      dep.id,
      'INSTALL_TIMEOUT',
      `The install script did not report back within ${Math.round(INSTALL_TIMEOUT_MS / 60000)} minutes.`,
      `VM ${dep.hostinger_vm_id || '?'} (${dep.hostname || ''}) — check /post_install.log and /var/log/bitpype-install.log on the server.`
    );
  }
}

/* ------------------------------ callback ---------------------------- */

function buildReadyEmail(dep, setupToken) {
  const link = `${String(dep.instance_url || '').replace(/\/+$/, '')}/app#/reset/${setupToken}`;
  const where = dep.hostname || dep.instance_url || 'your server';
  return {
    to: dep.admin_email,
    subject: 'Your BitPype instance is ready',
    title: 'Your BitPype instance is ready',
    paragraphs: [
      'Your own BitPype installation has been provisioned on its own server and is ready to set up.',
      `Instance: ${dep.instance_url}`,
      `Sign in as ${dep.admin_email}. Use the setup link below to choose your password — the link expires in 72 hours. After that, use "Forgot password" on the sign-in page instead.`,
      `When you are ready to use your own domain, point it at ${where} and set the new address under Settings → General → Public URL in your instance.`,
    ],
    cta: { url: link, label: 'Set your password' },
    text: `Your BitPype instance is ready.\n\nInstance: ${dep.instance_url}\nAdmin email: ${dep.admin_email}\nSet your password (expires in 72 hours): ${link}\n`,
  };
}

async function handleCallback(body) {
  const id = Number(body && body.deploymentId);
  if (!Number.isInteger(id) || id <= 0) throw coded('VALIDATION', 'deploymentId is required.');
  const dep = await getDeployment(id);
  if (!dep) throw coded('NOT_FOUND', 'Deployment not found.');
  const providedHash = sha256(String((body && body.secret) || ''));
  if (!dep.callback_secret_hash || !timingSafeEqualHex(providedHash, dep.callback_secret_hash)) {
    throw coded('CALLBACK_AUTH', 'Invalid deployment callback secret.');
  }
  if (dep.status === 'ready' || dep.status === 'failed') {
    return { already: true, deployment: publicDeployment(dep) };
  }
  const status = String((body && body.status) || '');
  if (status === 'failed') {
    const stage = String((body && body.error) || 'install').slice(0, 200);
    await failDeployment(id, 'INSTALL_FAILED', `The install script reported a failure at stage "${stage}".`, `VM ${dep.hostinger_vm_id || '?'} — check /post_install.log and /var/log/bitpype-install.log on the server.`);
    return { already: false, deployment: publicDeployment(await getDeployment(id)) };
  }
  if (status !== 'ready') throw coded('VALIDATION', 'status must be "ready" or "failed".');
  let instanceUrl = String((body && body.instance_url) || '').trim().replace(/\/+$/, '');
  let parsed;
  try {
    parsed = new URL(instanceUrl);
  } catch {
    throw coded('VALIDATION', 'instance_url must be a valid URL.');
  }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) {
    throw coded('VALIDATION', 'instance_url must be a plain http(s) origin.');
  }
  instanceUrl = parsed.origin;
  const setupToken = String((body && body.setup_token) || '').trim();
  if (setupToken.length < 32) throw coded('VALIDATION', 'setup_token is missing or too short.');

  await updateDeployment(id, {
    status: 'ready',
    instance_url: instanceUrl,
    setup_token_hash: sha256(setupToken),
    setup_expires_at: nowSql(new Date(Date.now() + SETUP_TOKEN_TTL_MS)),
  });
  const fresh = await getDeployment(id);
  leadEvent(Number(fresh.workspace_id), Number(fresh.lead_id), 'deployment_ready', `BitPype instance ready: ${instanceUrl} (VM ${fresh.hostinger_vm_id || '?'})`);
  try {
    await platform.audit(fresh.created_by || null, 'hostinger.deploy.ready', `deployment=${id} url=${instanceUrl}`);
  } catch { /* best-effort */ }
  // The raw setup token is used exactly here, exactly once: in the
  // emailed link. Only its hash (stored above) survives.
  try {
    await sendMail(buildReadyEmail(fresh, setupToken));
    await updateDeployment(id, { email_sent_at: nowSql() });
  } catch (e) {
    const warning = `Setup email could not be sent: ${String((e && e.message) || e).slice(0, 300)}`;
    await updateDeployment(id, { warning });
    leadEvent(Number(fresh.workspace_id), Number(fresh.lead_id), 'deployment_email_failed', warning);
  }
  return { already: false, deployment: publicDeployment(await getDeployment(id)) };
}

/* ------------------------------- bundle ----------------------------- */

/** Find the deployment a bundle token belongs to (active installs only). */
async function findDeploymentByBundleToken(token) {
  if (!token) return null;
  const rows = await query('SELECT * FROM deployments WHERE bundle_token_hash = :h LIMIT 1', {
    h: sha256(String(token)),
  });
  const dep = rows && rows[0] ? rows[0] : null;
  if (!dep) return null;
  if (!['queued', 'provisioning', 'installing'].includes(String(dep.status))) return null;
  return dep;
}

/**
 * Stream this app's own source tree as the install bundle. The
 * customer VM builds it with the repo's Dockerfile (npm ci inside the
 * build), so node_modules and runtime data are excluded.
 */
function streamBundle(res) {
  const appRoot = path.resolve(__dirname, '..');
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', 'attachment; filename="bitpype-bundle.tar.gz"');
  const tar = spawn(
    'tar',
    [
      '-czf', '-',
      '--exclude=./node_modules',
      '--exclude=./data',
      '--exclude=./tmp-upload',
      '--exclude=./.git',
      '--exclude=./design-agent-trigger.json',
      '-C', appRoot, '.',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  tar.stdout.pipe(res);
  tar.stderr.on('data', (d) => console.warn('[hostingerDeploy] bundle tar:', String(d).slice(0, 200)));
  tar.on('error', (e) => {
    console.warn('[hostingerDeploy] bundle spawn:', e.message);
    if (!res.headersSent) res.status(500).json({ ok: false, error: { code: 'BUNDLE_FAILED', message: 'Bundle build failed.' } });
    else res.destroy();
  });
  res.on('close', () => {
    try { tar.kill('SIGTERM'); } catch { /* already gone */ }
  });
}

/* ------------------------------ ticker ------------------------------ */

let tickerStarted = false;
function startDeploymentTicker() {
  if (tickerStarted) return;
  tickerStarted = true;
  const ms = Math.max(5000, Number(process.env.HOSTINGER_DEPLOY_TICK_MS || 30000));
  const timer = setInterval(() => {
    tickDeployments().catch((e) => console.warn('[hostingerDeploy] tick:', e && e.message));
  }, ms);
  if (timer.unref) timer.unref();
  // Resume anything left mid-flight by a restart.
  setImmediate(() => {
    tickDeployments().catch(() => {});
  });
}

let tickInFlight = false;
async function tickDeployments() {
  // Batch 68 (H-6): re-entrancy guard — a slow tick must never overlap
  // the next one (the atomic purchase claim is the second line of
  // defence behind this).
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    const rows = await query(
      // Queued rows enter the advanceable set only once their install
      // script exists (H-6: the row is inserted before
      // createPostInstallScript completes).
      `SELECT id FROM deployments WHERE status IN ('provisioning','installing')
          OR (status = 'queued' AND hostinger_script_id IS NOT NULL)
        ORDER BY id ASC LIMIT 10`
    );
    for (const row of rows || []) {
      await advanceDeployment(Number(row.id)).catch((e) =>
        console.warn('[hostingerDeploy] advance', row.id, e && e.message)
      );
    }
  } finally {
    tickInFlight = false;
  }
}

/** Drawer view: eligibility + config + latest deployment (+ preview when asked). */
async function getLeadDeploymentView(workspaceId, leadId, { withPreview = false } = {}) {
  const lead = loadLead(workspaceId, leadId);
  const eligible = isSoftwareInterestLead(lead);
  const cfg = await getConfig();
  const existing = eligible ? await latestForLead(workspaceId, leadId) : null;
  const view = {
    eligible,
    configured: cfg.configured,
    tokenSet: cfg.tokenSet,
    missing: cfg.missing,
    deployment: publicDeployment(existing),
    plan: null,
    previewError: '',
  };
  if (withPreview && eligible && cfg.configured && !(existing && ACTIVE_STATUSES.includes(String(existing.status)))) {
    try {
      const items = await client().getCatalog();
      const price = client().findCatalogPrice(items, cfg.priceId);
      if (price) view.plan = { ...price, dataCenterId: cfg.dataCenterId, templateId: cfg.templateId };
      else view.previewError = 'PLAN_UNAVAILABLE';
    } catch (e) {
      view.previewError = e.code || 'HOSTINGER_API';
    }
  }
  return view;
}

module.exports = {
  ACTIVE_STATUSES,
  getConfig,
  testConnection,
  isSoftwareInterestLead,
  previewForLead,
  startDeployment,
  retryDeployment,
  advanceDeployment,
  tickDeployments,
  startDeploymentTicker,
  handleCallback,
  findDeploymentByBundleToken,
  streamBundle,
  buildBootstrapScript,
  buildReadyEmail,
  publicDeployment,
  getLeadDeploymentView,
  __setClientForTests,
  __setMailerForTests,
};
