// @ts-check
'use strict';

/**
 * Batch 111 (consolidation step 4) — portal design chat (site agent): chat image attachments, the runSiteAgentChat pipeline, queue/history/summary, chat limits, canvas blocks, site structure read/reorder.
 * PURE code motion from server/clientPortal.js (no logic edits);
 * server/clientPortal.js re-exports the full original surface.
 */

const path = require('path');
const portalTabs = require('./portalTabs');
const { appUrl } = require('./stripeClient');
const { resolvePreviewUrl, pagesHaveEditableSections, pagesHaveFreeformHtml, resolveClientSite } = require('./portalShared');
const { renderClientSite, publishClientSitePreview, syncDesignDeliverablePages } = require('./portalSiteEdits');


/**
 * Portal Muse agent chat: run lead-scoped improve loop, then return fresh editable HTML.
 * Body: { message, pageSlug?, attachmentIds? } — Batch 96: no
 * client history; the pipeline loads the site's saved transcript
 * tail itself (a history field in the body is ignored).
 */
/** Batch 89 — design-chat image attachments (server/siteChatAttachments.js). */
async function uploadSiteChatImage(workspaceId, leadId, payload = {}) {
  const domain = require('./domain');
  const chatAtt = require('./siteChatAttachments');
  const raw = String((payload && (payload.data != null ? payload.data : payload.dataBase64)) || '');
  const b64 = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;
  const buffer = Buffer.from(b64.replace(/\s+/g, ''), 'base64');
  return domain.withDb(workspaceId, async (db) => {
    const site = resolveClientSite(db, leadId);
    if (!site) {
      throw Object.assign(new Error('No website is available yet'), { code: 'NO_SITE' });
    }
    return chatAtt.saveAttachment(db, {
      workspaceId,
      leadId,
      websiteId: site.id,
      buffer,
      originalName: payload && payload.name,
    });
  });
}

function fetchSiteChatImage(workspaceId, leadId, id, variant) {
  const domain = require('./domain');
  const chatAtt = require('./siteChatAttachments');
  return domain.withDb(workspaceId, (db) => chatAtt.readAttachment(db, { leadId, id, variant }));
}

function listSiteChatImages(workspaceId, leadId, limit) {
  const domain = require('./domain');
  const chatAtt = require('./siteChatAttachments');
  return domain.withDb(workspaceId, (db) => chatAtt.listAttachments(db, { leadId, limit }));
}

async function runSiteAgentChat(workspaceId, leadId, body = {}) {
  const museAgent = require('./museAgent');
  const domain = require('./domain');
  const chatAtt = require('./siteChatAttachments');
  const chatPending = require('./siteChatPending');
  const chatThread = require('./siteChatThread');
  const designJobs = require('../src/designJobs');
  const message = String((body && body.message) || '').trim();
  // Batch 89: a chat turn may carry image attachments (uploaded first via
  // uploadSiteChatImage). An image-only turn is valid; a turn with
  // neither text nor images is still EMPTY, exactly as before.
  const attachmentIds = chatAtt.normalizeAttachmentIds(body && body.attachmentIds);
  if (!message && !attachmentIds.length) {
    throw Object.assign(new Error('Message is required'), { code: 'EMPTY' });
  }
  if (message.length > 4000) {
    throw Object.assign(new Error('Message is too long (max 4000 characters)'), { code: 'TOO_LONG' });
  }

  // Batch 93 (context tiers): Tier 1 — a structured whole-site map
  // built fresh each turn from the workspace DB: business basics,
  // every page with its sections/content summaries, the module
  // inventory with key content (incl. DataTables / Charts), and the
  // brand/style settings. It rides the classifier, every chat mode,
  // and a queued big job's spec. Tier 2 is the agent's read tools,
  // used when a turn needs full detail beyond the map. The map is
  // deliberately a SUMMARY (capped) — raw full-site text every turn
  // would bury the conversation and degrade answers.
  const buildSiteMap = (db, site) => {
    const lines = [];
    const clip = (v, n) =>
      String(v == null ? '' : v)
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, n);
    try {
      const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(Number(leadId)) || {};
      const basics = [
        lead.business_name ? `Business: ${clip(lead.business_name, 90)}` : '',
        lead.category ? `Category: ${clip(lead.category, 60)}` : '',
        lead.phone ? `Phone: ${clip(lead.phone, 30)}` : '',
        lead.email ? `Email: ${clip(lead.email, 60)}` : '',
        [lead.city, lead.state].filter(Boolean).length
          ? `Location: ${clip([lead.city, lead.state].filter(Boolean).join(', '), 60)}`
          : '',
        lead.address ? `Address: ${clip(lead.address, 90)}` : '',
      ].filter(Boolean);
      if (basics.length) lines.push(basics.join(' · '));
    } catch {
      /* basics are best-effort */
    }
    lines.push(`Website: ${clip(site.name, 90) || 'Untitled'} (status ${clip(site.status, 20) || 'draft'})`);
    const theme = site.theme && typeof site.theme === 'object' ? site.theme : {};
    const themeBits = [];
    for (const key of ['primary', 'secondary', 'bg', 'text', 'headingFont', 'font', 'brandName', 'logoMode', 'tone', 'primaryColor', 'primary_color', 'secondaryColor', 'accentColor', 'backgroundColor', 'textColor', 'fontHeading', 'fontBody', 'logoUrl', 'logo']) {
      if (theme[key] != null && String(theme[key]).trim() !== '') {
        themeBits.push(`${key}: ${clip(theme[key], 60)}`);
      }
    }
    if (themeBits.length) lines.push(`Brand/style: ${themeBits.join(' · ')}`);
    lines.push('Pages:');
    for (const page of site.pages || []) {
      if (!page || typeof page !== 'object') continue;
      const slug = clip(page.slug || page.id || 'index', 40);
      const title = clip(page.title || page.name || '', 70);
      lines.push(`- /${slug}${title ? ` — ${title}` : ''}`);
      const sections = Array.isArray(page.sections) ? page.sections : [];
      for (const sec of sections.slice(0, 14)) {
        if (!sec || typeof sec !== 'object') continue;
        const c = sec.content && typeof sec.content === 'object' ? sec.content : sec;
        const bits = [];
        for (const key of ['headline', 'heading', 'title', 'subheadline', 'subtitle', 'text', 'body', 'description']) {
          if (c[key] != null && typeof c[key] === 'string' && c[key].trim()) {
            bits.push(clip(c[key], 110));
            if (bits.length >= 2) break;
          }
        }
        // Freestyle sections carry their content as raw HTML —
        // surface its text so the map reflects those pages too.
        if (!bits.length && typeof c.html === 'string' && c.html.trim()) {
          bits.push(clip(c.html, 150));
        }
        lines.push(`    · ${clip(sec.type || sec.kind || 'section', 30)}${bits.length ? `: ${bits.join(' — ')}` : ''}`);
      }
      if (sections.length > 14) lines.push(`    · …and ${sections.length - 14} more sections`);
    }
    try {
      const embeds = db
        .prepare('SELECT module_type FROM site_module_embeds WHERE lead_id = ? ORDER BY module_type')
        .all(Number(leadId));
      if (embeds.length) {
        lines.push(`Modules on the site: ${embeds.map((e) => e.module_type).join(', ')}`);
      }
    } catch {
      /* module inventory is best-effort */
    }
    try {
      // Batch 122 — the shared module layer: which module content
      // this business can draw on across modules, with live counts.
      // The agent composes across modules through shared.items /
      // shared.link (e.g. link a gallery album to an event so its
      // photos show on the event page).
      const share = require('./moduleShare');
      const providers = share
        .listSharedSources(db, leadId, { sample: 0 })
        .filter((s) => s.kind === 'provider' && s.count > 0);
      if (providers.length) {
        lines.push(
          `Shared content (modules are interdependent — content can be reused across modules via the shared layer; read items with shared.items, link with shared.link): ${providers
            .map((s) => `${s.type} (${s.count} published)`)
            .join(', ')}`
        );
      }
      const refs = share.listSharedRefs(db, leadId, {});
      if (refs.length) {
        lines.push(
          `Cross-module links in place: ${refs
            .map((r) => `${r.consumer_type}#${r.consumer_id} ← ${r.provider_type}#${r.provider_id}${r.role ? ` (${r.role})` : ''}`)
            .join('; ')}`
        );
      }
    } catch {
      /* shared-layer census is best-effort */
    }
    try {
      // Batch 124 — the shared taxonomy: categories are created FOR a
      // module (their scope) and items are organized by assignment.
      // The agent manages them with the categories.* tools (the same
      // service the portal editors use).
      const catSummary = require('./categories').categoriesSummary(db, leadId);
      if (catSummary.length) {
        lines.push(
          `Categories (shared taxonomy — a category belongs to one module scope and organizes that module's items by assignment; create with categories.create, assign with categories.assign or category_ids on the module write tools): ${catSummary
            .map((s) => `${s.scope} (${s.published} published / ${s.total} total, ${s.assigned_items} assignments)`)
            .join(', ')}`
        );
      }
    } catch {
      /* categories census is best-effort */
    }
    try {
      // Batch 125 — Photo Capture: moderation queue + approved count.
      // Approved photos are shared-layer content (source photocapture)
      // and can be pushed into a gallery album from the portal inbox.
      const attached = db
        .prepare("SELECT 1 FROM site_module_embeds WHERE lead_id = ? AND module_type = 'photocapture'")
        .get(Number(leadId));
      if (attached) {
        const counts = require('./siteModules').countPhotoSubmissions(db, leadId);
        lines.push(
          `Photo Capture: ${counts.pending} photo(s) awaiting moderation, ${counts.approved} approved, ${counts.rejected} rejected — moderate with photocapture.listSubmissions / photocapture.moderateSubmission; approved photos also appear via shared.items (source photocapture).`
        );
      }
    } catch {
      /* photo capture census is best-effort */
    }
    try {
      const dt = db.prepare('SELECT title, columns_json FROM datatable_configs WHERE lead_id = ?').get(Number(leadId));
      if (dt) {
        let cols = '';
        try {
          const parsed = JSON.parse(dt.columns_json || '[]');
          if (Array.isArray(parsed)) cols = parsed.map((col) => clip(col.label || col.key, 30)).filter(Boolean).join(', ');
        } catch {
          cols = '';
        }
        lines.push(`Data Table: "${clip(dt.title, 60)}"${cols ? ` (columns: ${cols})` : ''}`);
      }
    } catch {
      /* table summary is best-effort */
    }
    try {
      const chartRows = db.prepare('SELECT * FROM charts WHERE lead_id = ? LIMIT 20').all(Number(leadId));
      for (const ch of chartRows) {
        const label = clip(ch.title || ch.name || 'Chart', 50);
        const type = clip(ch.chart_type || ch.type || '', 20);
        lines.push(`Chart: "${label}"${type ? ` (${type})` : ''}`);
      }
    } catch {
      /* chart summary is best-effort */
    }
    const map = lines.join('\n');
    return map.length > 7000 ? `${map.slice(0, 7000)}\n[site map truncated — full detail is available through the read tools]` : map;
  };

  let attachmentRows = [];
  let siteId = null;
  let pageCount = 0;
  let siteContext = '';
  let siteTheme = {};
  // Batch 99: the pre-turn site fingerprint — the critic diffs
  // the post-turn site against it (collateral + "did anything
  // actually change"), and queueBigJob stamps it into the job
  // brief as the delivery baseline.
  let turnFingerprintBefore = null;
  domain.withDb(workspaceId, (db) => {
    const site = resolveClientSite(db, leadId);
    if (!site || !Array.isArray(site.pages) || !site.pages.length) {
      throw Object.assign(new Error('No website is available yet'), { code: 'NO_SITE' });
    }
    siteId = site.id;
    pageCount = site.pages.length;
    siteTheme = site.theme && typeof site.theme === 'object' ? site.theme : {};
    try {
      turnFingerprintBefore = require('./siteChatCritic').siteFingerprint(db, leadId);
    } catch {
      turnFingerprintBefore = null;
    }
    siteContext = buildSiteMap(db, site);
    if (attachmentIds.length) {
      // Ownership is enforced here: every id must belong to THIS lead.
      attachmentRows = chatAtt.loadForChat(db, { leadId, ids: attachmentIds });
    }
  });

  // Stamp the turn linkage and prepare the model-bound image copies
  // (downscaled data URLs) so the design loop can analyze the images.
  const turnRef = attachmentIds.length
    ? `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    : null;
  let modelImages = [];
  if (attachmentRows.length) {
    domain.withDb(workspaceId, (db) =>
      chatAtt.linkToTurn(db, { leadId, ids: attachmentIds, websiteId: siteId, messageRef: turnRef })
    );
    modelImages = await chatAtt.buildModelImages(attachmentRows);
  }

  const pageSlug =
    body.pageSlug != null && String(body.pageSlug).trim() !== '' ? String(body.pageSlug).trim() : undefined;

  // Batch 98 — Tier-1 v2 (review finding M1: the map was
  // style-blind). The site context learns the site's CURRENT
  // computed styles: the cascade evaluator (server/
  // siteStyleCascade.js) runs over the real render of the page
  // the owner is looking at, so the classifier, the planner and
  // the build loop can SEE e.g. the current H3 colour — on light
  // and dark sections separately — instead of guessing. The
  // chat's own style rules are listed too: they are part of the
  // site's current style state. Best-effort by design: a render
  // hiccup loses the style block, never the turn.
  try {
    const cascade = require('./siteStyleCascade');
    const styleRules = require('./styleRules');
    const renderedNow = renderClientSite(workspaceId, leadId, { editable: false, pageSlug });
    const styleLines = cascade.keyStyleLines(renderedNow.html);
    const ownRules = styleRules.listStyleRules(siteTheme.customCss || '');
    if (styleLines.length || ownRules.length) {
      const block = ['Current styles (computed from the live page — trust these over assumptions):'];
      block.push(...styleLines);
      if (ownRules.length) {
        block.push(
          `Chat-set style rules in force: ${ownRules.map((r) => `${r.selector} { ${r.property}: ${r.value} }`).join('; ')}`
        );
      }
      siteContext = `${siteContext}\n${block.join('\n')}`;
    }
  } catch {
    /* Tier-1 v2 is additive context — never a turn breaker */
  }

  // Batch 100 — the per-site ROLLING SUMMARY rides the context
  // alongside the transcript tail: settled decisions, style
  // choices, changes applied and open items from the WHOLE
  // conversation, not just the recent tail (server/
  // siteChatSummary.js, keyed by lead like every chat store —
  // a summary can never cross sites). Best-effort like Tier-1 v2.
  try {
    const chatSummary = require('./siteChatSummary');
    const summary = domain.withDb(workspaceId, (db) => chatSummary.getSummary(db, leadId));
    const summaryText = chatSummary.renderSummaryText(summary);
    if (summaryText) {
      siteContext = `${siteContext}\n\nCONVERSATION SUMMARY (rolling digest of this site's earlier chat — settled facts here are binding, do not re-ask them):\n${summaryText}`;
    }
  } catch {
    /* rolling summary is additive context — never a turn breaker */
  }

  // Batch 93: the chat is a design AGENT. Every message is classified
  // first (question / change / off-topic / ambiguous / clarification
  // answer / cancel) and routed: questions are answered read-only,
  // underspecified changes ask clarification questions with the
  // pending change stored server-side, specific SMALL changes are
  // implemented in-chat, specific BIG changes are queued to the
  // design agent, and off-topic messages are declined.
  // Batch 96: pending state is read through the TTL sweep — a
  // clarification abandoned for PENDING_TTL_DAYS (7) is deleted
  // here, before it can steer this turn, and the swept row is
  // kept aside so the reply can tell the owner honestly that
  // the old request was let go (see the note at reply assembly).
  // This turn starts fresh; a stale pending never resurrects.
  const { pending, expired: expiredPending } = domain.withDb(workspaceId, (db) =>
    chatPending.getPendingWithExpiry(db, leadId)
  );
  // Batch 96 (§12.4): the saved transcript is the conversation's
  // source of truth. The classifier and the improve loop are fed
  // THIS site's server-side tail — the history array browsers
  // used to send is retired and ignored if one still arrives,
  // so a stale or tampered client can neither lose the thread
  // nor invent one.
  const serverHistory = domain.withDb(workspaceId, (db) => chatThread.listContextTail(db, leadId));
  const cls = await domain.withDb(workspaceId, async (db) =>
    museAgent.classifyPortalChatIntent(workspaceId, leadId, {
      db,
      message,
      history: serverHistory,
      pending,
      hasImages: modelImages.length > 0,
      siteContext,
    })
  );
  if (cls && cls.error === 'muse_not_configured') {
    throw Object.assign(
      new Error('AI site chat is not configured yet. Ask your BitPype admin to add the Muse Model API key.'),
      { code: 'AI_NOT_CONFIGURED' }
    );
  }
  if (cls && cls.error === 'budget_exceeded') {
    throw Object.assign(new Error('Daily AI budget reached. Try again tomorrow or contact support.'), {
      code: 'BUDGET_EXCEEDED',
    });
  }

  const intent = cls && cls.intent ? String(cls.intent) : 'ambiguous';
  let ready = !!(cls && cls.ready);
  // Batch 94: settled dimensions — facts the owner has already
  // decided (stated outright in the request, or answered during
  // clarification). They persist on the pending row, ride every
  // later classification, and are never asked about again. This
  // turn's newly settled facts merge into the running set.
  const settledNow = chatPending.mergeSettledFacts(
    pending ? pending.settled : [],
    cls && Array.isArray(cls.settled) ? cls.settled : []
  );
  // Batch 94 CONVERGENCE SEAM: one clarification round is the
  // budget. Once a clarify-kind pending has used its round, a
  // further answer implements the change with design defaults
  // instead of asking again — unless the answer introduced a
  // genuinely new decision with no default (classifier-flagged
  // newAmbiguity). The POLICY lives in the planner module
  // (server/siteChatPlanner.shouldForceReady) so the four-role
  // rebuild lifts it whole; this handler only wires it. The
  // batch94 suite negative-proofs the seam: shimming the policy
  // off lets a stubborn classifier loop questions forever, which
  // is exactly Ely's complaint.
  const chatPlanner = require('./siteChatPlanner');
  const forceReady = !ready && chatPlanner.shouldForceReady(pending, { ...cls, intent });
  if (forceReady) ready = true;

  // Batch 98 — THE PLANNER (four-role rebuild, step 1). One call
  // site for the whole handler: for a ready change the planner
  // writes the explicit plan object (scope / settled / defaults /
  // steps / verify) and it is PERSISTED per site
  // (server/siteChatPlan.js). In-chat, the plan sandboxes the
  // implementor; for a big change, the plan IS the queued job's
  // spec. A planning miss never traps the owner — fetchPlan
  // returns null and the turn proceeds unplanned, still inside
  // the design allowlist (the pre-rebuild behaviour).
  let turnPlan = null;
  let turnPlanId = null;
  // Batch 99: the clarified spec this turn implements (hoisted
  // for the reviewer) + the reviewer's verdict for the payload.
  let turnSpecText = '';
  let turnReview = null;
  const fetchPlan = async (specForPlan, rework) => {
    try {
      if (!museAgent || typeof museAgent.planPortalChange !== 'function') return null;
      const planned = await domain.withDb(workspaceId, async (db) =>
        museAgent.planPortalChange(workspaceId, leadId, {
          db,
          message,
          specText: specForPlan,
          history: serverHistory,
          settled: settledNow,
          siteContext,
          images: modelImages,
          rework: rework || null,
        })
      );
      if (!planned || planned.error || !planned.plan) return null;
      const planObj = planned.plan;
      planObj.settled = chatPending.mergeSettledFacts(planObj.settled || [], settledNow);
      const saved = domain.withDb(workspaceId, (db) =>
        require('./siteChatPlan').savePlan(db, { leadId, plan: planObj })
      );
      return saved ? { plan: planObj, planId: saved.id } : null;
    } catch (e) {
      console.warn('[clientPortal] planner failed (continuing unplanned):', e.message || e);
      return null;
    }
  };

  // Batch 98: an image-only turn (pictures, no words) routes
  // through the PLANNER instead of the clarification trap — the
  // planner sees the image(s) and either writes an executable
  // plan (the turn becomes ready) or produces none, in which
  // case the normal clarification path asks what to do with them.
  if (
    !ready &&
    attachmentRows.length &&
    !message &&
    (intent === 'change' || intent === 'ambiguous' || intent === 'clarify_answer')
  ) {
    const p = await fetchPlan('', null);
    if (p) {
      turnPlan = p.plan;
      turnPlanId = p.planId;
      ready = true;
    }
  }
  // The size gate (Batch 93): a ready change judged BIG is queued to
  // the design agent instead of being implemented in the chat. This
  // single expression is the gate the batch93 suite negative-proofs.
  const isBig = !!(cls && cls.size === 'big');

  const runLoop = async (loopOpts) =>
    domain.withDb(workspaceId, async (db) =>
      museAgent.runPortalImproveLoop(workspaceId, leadId, {
        db,
        history: serverHistory,
        pageSlug,
        images: modelImages,
        siteContext,
        ...loopOpts,
      })
    );

  // Queue a BIG change through the EXISTING design-job queue
  // (designJobs.createJob — the same queue the staff flow uses).
  // Chat jobs carry type 'improvement' so they never collide with
  // the lead's main 'website' job. The clarified spec is distilled
  // into the job instructions, and the chat origin + attachment ids
  // are stamped into the job brief so completion can write back to
  // this thread (deliverJob hook) and the claiming agent can fetch
  // the owner's images via site.chatAttachments / site.chatAttachment.
  const queueBigJob = (specText, plan = null) => {
    const planText = plan ? require('./siteChatPlan').renderPlanForJob(plan) : '';
    const instructions = [
      'Queued from the portal site-builder chat — the owner asked for the change below and clarified it in conversation. Improve the EXISTING site; do not rebuild it from scratch.',
      '',
      // Batch 98: when the planner wrote a plan, the plan IS the
      // spec — rendered verbatim ahead of the owner's words, and
      // also stored machine-readable in the job brief
      // (chat_origin.plans) so the delivery can be verified
      // against it (Batch 99 critic/reviewer gate).
      ...(planText
        ? [planText, '', "The owner's clarified request, in their words:"]
        : []),
      specText,
      attachmentIds.length
        ? `\nThe owner attached image(s) in the chat: attachment ids ${attachmentIds.join(', ')}. Fetch them before designing with the MCP tools site.chatAttachments / site.chatAttachment (leadId ${Number(leadId)}).`
        : '',
      '\nWhen you deliver with design.deliver, include a short plain-English summary of what you changed in the payload\'s "summary" field — it is posted back to the owner in this chat thread.',
      siteContext
        ? `\nSite context (whole-site map at queue time — pull full page content, exact styles, and module data with the site tools when you need detail):\n${siteContext}`
        : '',
    ]
      .filter(Boolean)
      .join('\n');
    return domain.withDb(workspaceId, (db) => {
      designJobs.ensureTables(db);
      const chatQueue = require('./siteChatQueue');
      let jobId = null;
      // Batch 101 — merge honesty: prefer an UNSTARTED open job
      // for merging. A job an agent has already claimed
      // (in_progress) is that agent's working spec — the new
      // ask must never silently rewrite it; it becomes a second
      // job instead (see the else-branch below).
      const open = db
        .prepare(
          "SELECT * FROM design_jobs WHERE lead_id = ? AND type = 'improvement' AND status != 'delivered' ORDER BY (status = 'waiting_on_agent') DESC, id DESC LIMIT 1"
        )
        .get(Number(leadId));
      if (open && !chatQueue.shouldMergeIntoOpenJob(open)) {
        // Direct insert — designJobs.createJob would REPLACE
        // the claimed job's instructions, which is exactly the
        // dishonesty this batch removes.
        const shape = pageCount > 1 ? 'multipage' : 'landing';
        const brief0 = designJobs.buildBrief(db, Number(leadId), instructions, 'improvement', shape);
        const info = db
          .prepare(
            `INSERT INTO design_jobs (type, title, instructions, lead_id, contact_email, status, brief, site_shape, built_by)
             VALUES ('improvement', ?, ?, ?, NULL, 'waiting_on_agent', ?, ?, NULL)`
          )
          .run(`Improvement: ${(message || 'Site change').slice(0, 70)}`, instructions, Number(leadId), JSON.stringify(brief0), shape);
        jobId = Number(info.lastInsertRowid);
        designJobs.notifyAgentQueue(
          db,
          `Design job #${jobId} assigned (improvement) from the site-builder chat — a second queued job; job #${open.id} is already being built and was left untouched. Status waiting_on_agent — MCP agents: design.next or design.pending.`,
          { jobId, reason: 'assigned', status: 'waiting_on_agent' }
        );
      } else if (open) {
        // createJob would REPLACE an open job's instructions; a
        // second big ask must not silently erase the first — append.
        const merged = `${open.instructions}\n\n---\nAdditional queued request from the owner (builder chat):\n${instructions}`;
        db.prepare(
          "UPDATE design_jobs SET instructions = ?, status = 'waiting_on_agent', updated_at = datetime('now') WHERE id = ?"
        ).run(merged, open.id);
        designJobs.notifyAgentQueue(
          db,
          `Design job #${open.id} updated from the site-builder chat. Status waiting_on_agent — MCP agents: design.next or design.pending.`,
          { jobId: open.id, reason: 'refreshed', status: 'waiting_on_agent' }
        );
        jobId = Number(open.id);
      } else {
        const created = designJobs.createJob(db, {
          leadId: Number(leadId),
          type: 'improvement',
          title: `Improvement: ${(message || 'Site change').slice(0, 70)}`,
          instructions,
          siteShape: pageCount > 1 ? 'multipage' : 'landing',
        });
        jobId = Number(created.id);
      }
      const row = db.prepare('SELECT brief FROM design_jobs WHERE id = ?').get(jobId);
      /** @type {Record<string, any>} */
      let briefObj = {};
      try {
        briefObj = JSON.parse((row && row.brief) || '{}') || {};
      } catch {
        briefObj = {};
      }
      // Batch 98: the plan(s) ride the brief machine-readably —
      // on a merge into an open job the earlier plans stay (the
      // delivery is verified against ALL of them, Batch 99).
      const priorOrigin =
        briefObj.chat_origin && typeof briefObj.chat_origin === 'object' ? briefObj.chat_origin : {};
      const plans = Array.isArray(priorOrigin.plans) ? priorOrigin.plans.slice(0, 4) : [];
      if (plan) plans.push(plan);
      briefObj.chat_origin = {
        source: 'portal_site_chat',
        attachmentIds,
        websiteId: siteId,
        queuedAt: new Date().toISOString(),
        // Batch 99: the pre-request site fingerprint — the
        // deliverJob critic diffs the DELIVERED site against it
        // (collateral). Earliest wins on merges: the delivery is
        // judged against the state before the first request.
        baseline: priorOrigin.baseline || turnFingerprintBefore || null,
        ...(plans.length ? { plans, plan: plans[plans.length - 1] } : {}),
      };
      db.prepare('UPDATE design_jobs SET brief = ? WHERE id = ?').run(JSON.stringify(briefObj), jobId);
      return jobId;
    });
  };

  let mode = 'answer';
  let loop = null;
  let replyOverride = null;
  let queuedJobId = null;

  if (intent === 'offtopic') {
    mode = 'offtopic';
    replyOverride =
      "I'm the design agent for your website, so I can only help with your site — its design, content, and how it looks and works. Ask me anything about your website, or tell me about a change you'd like.";
  } else if (intent === 'cancel' && pending) {
    domain.withDb(workspaceId, (db) => chatPending.clearPending(db, leadId));
    mode = 'answer';
    replyOverride = 'No problem — I’ve dropped that change request. Your site hasn’t been changed.';
  } else if (intent === 'question') {
    mode = 'answer';
    // An either/or check that resolves as "just asking" is closed
    // out; a clarification-pending change stays alive (requirement:
    // answer the question, keep the pending change).
    if (pending && pending.kind === 'either_or') {
      domain.withDb(workspaceId, (db) => chatPending.clearPending(db, leadId));
    }
    loop = await runLoop({ message, mode: 'answer' });
  } else if (intent === 'ambiguous' && !pending && !turnPlan) {
    mode = 'clarify';
    loop = await runLoop({ message, mode: 'clarify', clarifyAbout: message, clarifyKind: 'either_or' });
    if (loop && !loop.error) {
      domain.withDb(workspaceId, (db) =>
        chatPending.savePending(db, {
          leadId,
          kind: 'either_or',
          requestText: message,
          questionsText: loop.reply,
          answers: [],
          settled: settledNow,
          rounds: 0,
          pageSlug,
        })
      );
    }
  } else if (!ready) {
    // Clarification gate: an underspecified change (fresh, a
    // clarification answer that is still not specific enough, or an
    // ambiguous message while a change is pending) — ask, never edit.
    mode = 'clarify';
    const keepPending = !!pending && intent !== 'change';
    const baseRequest = keepPending ? pending.requestText : message;
    const priorAnswers = keepPending ? pending.answers : [];
    // Batch 94: this round's number (persisted on the pending row;
    // the convergence seam above reads it next turn), and the
    // clarify loop now hears what is settled + what was already
    // asked and answered, so it cannot regenerate the same
    // checklist in new words.
    const roundNow = keepPending ? Number(pending.rounds || 0) + 1 : 1;
    loop = await runLoop({
      message,
      mode: 'clarify',
      clarifyAbout: baseRequest,
      clarifyKind: 'open',
      clarifySettled: settledNow,
      clarifyPriorQa: keepPending
        ? { questionsText: pending.questionsText || '', answers: priorAnswers }
        : null,
      clarifyRound: roundNow,
    });
    if (loop && !loop.error) {
      const answers =
        intent === 'clarify_answer' && keepPending ? [...priorAnswers, message].slice(-20) : priorAnswers;
      domain.withDb(workspaceId, (db) =>
        chatPending.savePending(db, {
          leadId,
          kind: 'clarify',
          requestText: baseRequest,
          questionsText: loop.reply,
          answers,
          settled: settledNow,
          rounds: roundNow,
          pageSlug,
        })
      );
    }
  } else {
    // Ready: a specific change (fresh, clarified, an either/or the
    // owner confirmed, or a clarification the Batch 94 convergence
    // seam closed with defaults). SMALL is implemented in-chat;
    // BIG is queued.
    // A forced-ready 'change' is a NEW change the classifier
    // declared different from the pending one — it implements on
    // its own text (the stale request is never merged into its
    // spec); clarify_answer / ambiguous replies to the pending
    // build the clarified spec from the original request.
    const fromClarify = !!pending && (intent === 'clarify_answer' || (forceReady && intent === 'ambiguous'));
    const answers = fromClarify ? [...pending.answers, message] : [];
    const specText = fromClarify
      ? [
          pending.requestText,
          '',
          'Clarifications from the owner:',
          ...answers.map((a) => `- ${a}`),
          ...(settledNow.length
            ? ['', 'Settled decisions (binding — apply exactly, do not second-guess):', ...settledNow.map((s) => `- ${s}`)]
            : []),
          '',
          'Implement this change now, following the clarifications. Fill any remaining gaps with the design defaults and state them in your summary.',
        ].join('\n')
      : message;
    // Batch 98: an image-only turn has no message text — the
    // spec is the plan the planner wrote from the image(s).
    const effectiveSpec =
      turnPlan && !String(specText || '').trim()
        ? 'The owner attached image(s) with no written instruction. A plan was written from the image(s) — implement it.'
        : specText;
    turnSpecText = effectiveSpec;
    // Batch 98: the PLANNER writes the plan for this change
    // (skipped when the image-only routing already produced one).
    // The plan finalizes routing: its size governs the fork; the
    // classifier's hypothesis (isBig) stands when planning fails.
    if (!turnPlan) {
      const p = await fetchPlan(effectiveSpec, null);
      if (p) {
        turnPlan = p.plan;
        turnPlanId = p.planId;
      }
    }
    const planSaysBig = turnPlan ? turnPlan.size === 'big' : isBig;
    if (planSaysBig) {
      mode = 'queued';
      queuedJobId = queueBigJob(effectiveSpec, turnPlan);
      if (turnPlanId) {
        domain.withDb(workspaceId, (db) =>
          require('./siteChatPlan').setPlanStatus(db, turnPlanId, 'queued', { jobId: queuedJobId })
        );
      }
      if (pending) {
        domain.withDb(workspaceId, (db) => chatPending.clearPending(db, leadId));
      }
      const sizeNote = cls && cls.borderline ? 'This one’s on the bigger side' : 'This is a bigger job';
      replyOverride = `${sizeNote}, so I’m not doing it live in the chat — I’ve queued it for the design agent with the full details${
        attachmentIds.length ? ', including the image(s) you attached' : ''
      }. They’ll pick it up from the design queue, and I’ll post their summary here in this chat when it’s done. Your site hasn’t been changed yet.`;
    } else {
      mode = 'build';
      loop = await runLoop({ message: effectiveSpec, mode: 'build', plan: turnPlan || undefined });
      if (turnPlanId) {
        domain.withDb(workspaceId, (db) =>
          require('./siteChatPlan').setPlanStatus(db, turnPlanId, loop && loop.mutated ? 'implemented' : 'failed')
        );
      }
      if (pending && loop && (!loop.error || loop.mutated)) {
        domain.withDb(workspaceId, (db) => chatPending.clearPending(db, leadId));
      }
    }
  }

  if (loop && loop.error === 'muse_not_configured') {
    throw Object.assign(
      new Error('AI site chat is not configured yet. Ask your BitPype admin to add the Muse Model API key.'),
      { code: 'AI_NOT_CONFIGURED' }
    );
  }
  if (loop && loop.error === 'budget_exceeded') {
    throw Object.assign(new Error('Daily AI budget reached. Try again tomorrow or contact support.'), {
      code: 'BUDGET_EXCEEDED',
    });
  }

  if (loop && loop.error && !loop.mutated) {
    console.warn('[clientPortal] AI chat turn failed:', String(loop.error).slice(0, 80));
    throw Object.assign(
      new Error(
        mode === 'build'
          ? 'The AI could not apply this change. No website changes were saved. Please try again.'
          : 'The AI could not answer just now. No website changes were saved. Please try again.'
      ),
      { code: 'AI_IMPROVEMENT_FAILED', status: 502 }
    );
  }

  // Ensure preview is rematerialized even if Muse skipped publish.
  if (loop && loop.mutated && !loop.published) {
    try {
      await publishClientSitePreview(workspaceId, leadId);
      loop.published = true;
    } catch (e) {
      console.warn('[clientPortal] agent-chat publish:', e.message || e);
    }
  } else if (loop && loop.mutated) {
    // Publish already ran inside the loop; still rematerialize local export for srcdoc.
    try {
      await publishClientSitePreview(workspaceId, leadId);
    } catch (e) {
      console.warn('[clientPortal] agent-chat rematerialize:', e.message || e);
    }
  }

  // Batch 99 — REVIEWER gate (in-chat builds). The critic checks
  // the ACTUAL rendered result against the plan's verify[] and
  // diffs the site fingerprint (collateral + did-anything-change);
  // the reviewer ships the summary only on a pass. On a fail it
  // sends bounded rework back through the planner (<= 2 cycles),
  // and if the change still does not verify, the reviewer
  // escalates by queueing the job itself, plan + findings
  // attached, and says so plainly. Unplanned builds get the same
  // mutation-sanity critic (a claimed change that changed nothing
  // is never reported as done).
  if (mode === 'build' && loop) {
    try {
      const siteCritic = require('./siteChatCritic');
      const chatPlanMod = require('./siteChatPlan');
      const renderForCritic = (slug) => {
        try {
          return renderClientSite(workspaceId, leadId, { editable: false, pageSlug: slug }).html;
        } catch {
          return '';
        }
      };
      const runCriticNow = () =>
        domain.withDb(workspaceId, (db) =>
          siteCritic.runCritic({
            plan: turnPlan || { intent: '', scope: { pages: ['all'] }, steps: [], verify: [] },
            before: turnFingerprintBefore,
            after: siteCritic.siteFingerprint(db, leadId),
            renderPageHtml: renderForCritic,
            expectChange: !!loop.mutated,
          })
        );
      let report = runCriticNow();
      let cycles = 0;
      while (report.verdict === 'fail' && turnPlan && cycles < 2) {
        const attempt = await fetchPlan(turnSpecText, { failures: report.failures });
        if (!attempt || !attempt.plan) break;
        if (attempt.plan.size === 'big') {
          // A rework that outgrew the chat: adopt the new plan
          // and let the escalation below queue it.
          if (turnPlanId) {
            domain.withDb(workspaceId, (db) => chatPlanMod.setPlanStatus(db, turnPlanId, 'superseded'));
          }
          turnPlan = attempt.plan;
          turnPlanId = attempt.planId;
          break;
        }
        if (turnPlanId) {
          domain.withDb(workspaceId, (db) => chatPlanMod.setPlanStatus(db, turnPlanId, 'superseded'));
        }
        turnPlan = attempt.plan;
        turnPlanId = attempt.planId;
        cycles += 1;
        loop = await runLoop({ message: turnSpecText, mode: 'build', plan: turnPlan });
        if (loop && loop.error && !loop.mutated) break;
        if (loop && loop.mutated && !loop.published) {
          try {
            await publishClientSitePreview(workspaceId, leadId);
            loop.published = true;
          } catch (e) {
            console.warn('[clientPortal] reviewer rework publish:', e.message || e);
          }
        }
        report = runCriticNow();
      }
      const reviewChecks = (report.checks || []).map((c) => ({ kind: c.kind, pass: !!c.pass, actual: String(c.actual || '') }));
      if (report.verdict === 'pass') {
        turnReview = { verdict: 'pass', cycles, checks: reviewChecks };
        if (turnPlanId) {
          domain.withDb(workspaceId, (db) => {
            chatPlanMod.setPlanReview(db, turnPlanId, turnReview);
            chatPlanMod.setPlanStatus(db, turnPlanId, 'implemented');
          });
        }
      } else if (turnPlan) {
        // Escalate: the reviewer creates the queued job itself —
        // plan + critic findings — and the reply discloses it.
        const findingsText = (report.failures || []).map((f) => `- ${f}`).join('\n');
        const escSpec = [
          turnSpecText,
          '',
          `AUTOMATED REVIEWER ESCALATION: the in-chat attempt did not pass verification after ${cycles} rework cycle(s). Critic findings:`,
          findingsText || '- the rendered site does not match the plan',
          'Fix exactly what the findings name, then verify against the plan before delivering.',
        ].join('\n');
        const escJobId = queueBigJob(escSpec, turnPlan);
        if (turnPlanId) {
          domain.withDb(workspaceId, (db) => {
            chatPlanMod.setPlanReview(db, turnPlanId, { verdict: 'escalated', cycles, checks: reviewChecks });
            chatPlanMod.setPlanStatus(db, turnPlanId, 'escalated', escJobId ? { jobId: escJobId } : {});
          });
        }
        turnReview = { verdict: 'escalated', cycles, checks: reviewChecks, escalatedJobId: escJobId || null };
        const firstFailure = (report.failures || [])[0] || 'the rendered site does not match the plan';
        replyOverride =
          `I worked on this directly, but my verification pass says it isn't right yet — ${firstFailure}. ` +
          `Rather than leave you with a half-done change, I've queued it for the design agent with the plan and the full findings; they'll finish it and I'll post here when it passes verification.` +
          (report.collateral && report.collateral.changed
            ? ' Note: part of the change did land on your staged site in the meantime — the agent will reconcile it.'
            : ' Nothing on your site was changed.');
      } else {
        turnReview = { verdict: 'fail', cycles, checks: reviewChecks };
        if (loop.mutated && report.collateral && !report.collateral.changed) {
          replyOverride =
            "I ran the change, but verifying the site afterwards shows nothing actually changed — so I won't pretend it worked. Nothing on your site was altered. Could you rephrase what you'd like, or try again in a moment?";
        }
      }
    } catch (reviewErr) {
      console.warn('[clientPortal] reviewer gate:', (reviewErr && reviewErr.message) || reviewErr);
    }
  }

  let reply = replyOverride != null ? replyOverride : (loop && loop.reply) || '';
  if (mode === 'build' && cls && cls.borderline && loop && loop.mutated) {
    reply = `Small enough to do right here in the chat.\n\n${reply}`;
  }
  if (mode === 'answer' && !replyOverride) {
    // Requirement: a question answered mid-clarification keeps the
    // pending change visible, subtly, in the reply itself.
    const still = domain.withDb(workspaceId, (db) => chatPending.getPending(db, leadId));
    if (still && still.kind === 'clarify' && !reply.includes(still.requestText.slice(0, 30))) {
      reply += `\n\n— Still holding your earlier change request (“${still.requestText.slice(0, 90)}”) whenever you’re ready to pick it back up.`;
    }
  }
  // Batch 96: if this turn swept an expired pending (TTL), say
  // so — honestly, once, in the reply itself, and in the payload
  // as pendingExpired. The owner learns the old request is gone;
  // nothing about it steered this turn.
  let pendingExpiredInfo = null;
  if (expiredPending) {
    pendingExpiredInfo = {
      requestText: expiredPending.requestText,
      createdAt: expiredPending.createdAt,
      updatedAt: expiredPending.updatedAt,
    };
    if (reply) {
      reply += `\n\n— One bit of housekeeping: your earlier change request (“${expiredPending.requestText.slice(0, 90)}”) had been waiting over a week, so I let it go rather than act on a stale request. If you’d still like it, just tell me and we’ll start it fresh.`;
    }
  }

  // Batch 104 — OPTIMISTIC PREVIEW: derive this turn's patch spec
  // deterministically from the plan (server/siteChatPatch.js —
  // pure code, no extra model calls, so Batch 97 caps and the
  // chat doctrine are untouched). The portal applies the spec to
  // the preview iframe the moment it arrives (queued jobs) while
  // verification proceeds through the existing paths; the
  // verified render — this payload's html for in-chat builds,
  // the deliverJob write-back for queued jobs — is the only
  // truth and always wins. States:
  //   queued   — a job (owner-queued big change, or the
  //              reviewer's escalation) will be verified later;
  //              the patch rides with its job id so the updates
  //              poller can confirm it (delivered) or revert it
  //              (bounced to in_review) when the job resolves.
  //   verified — the in-chat build passed the reviewer; the
  //              payload html IS the verified render.
  //   failed   — the build ran but verification says nothing
  //              (or not enough) changed; the client drops any
  //              speculative preview patch for this turn.
  /** @type {{ v?: number, tier?: number, ops?: any[], jobId?: any, partial?: boolean, state?: string } | null} */
  let optimisticPatch = null;
  try {
    const chatPatch = require('./siteChatPatch');
    if (mode === 'queued' && queuedJobId) {
      optimisticPatch = chatPatch.deriveOptimisticPatch(turnPlan, { jobId: queuedJobId }) || {
        v: 1,
        tier: 3,
        ops: [],
        jobId: Number(queuedJobId),
      };
      optimisticPatch.state = 'queued';
    } else if (mode === 'build' && turnReview && turnReview.verdict === 'escalated') {
      const escId = turnReview.escalatedJobId != null ? Number(turnReview.escalatedJobId) : null;
      optimisticPatch = chatPatch.deriveOptimisticPatch(turnPlan, { jobId: escId }) || {
        v: 1,
        tier: 3,
        ops: [],
        jobId: escId,
      };
      optimisticPatch.state = 'queued';
    } else if (mode === 'build' && turnReview && turnReview.verdict === 'pass') {
      const derived = chatPatch.deriveOptimisticPatch(turnPlan, {});
      if (derived) optimisticPatch = { ...derived, state: 'verified' };
    } else if (mode === 'build' && turnReview && turnReview.verdict === 'fail') {
      optimisticPatch = { v: 1, tier: 0, ops: [], state: 'failed' };
    }
  } catch (patchErr) {
    console.warn('[clientPortal] optimistic patch derivation:', (patchErr && patchErr.message) || patchErr);
    optimisticPatch = null;
  }

  const rendered = renderClientSite(workspaceId, leadId, {
    editable: true,
    pageSlug,
  });
  const pendingNow = domain.withDb(workspaceId, (db) => chatPending.getPending(db, leadId));

  return {
    reply,
    steps: (loop && loop.steps) || 0,
    toolCalls: (loop && loop.toolCalls) || 0,
    mutated: !!(loop && loop.mutated),
    published: !!(loop && loop.published),
    model: loop && loop.model,
    // Batch 93: how this turn was routed + whether a clarification is
    // still pending + the design job when a big change was queued.
    mode,
    pendingClarification: !!pendingNow,
    // Batch 96: the pending clarification this turn swept as
    // expired (TTL), or null — the machine-readable half of the
    // housekeeping note appended to the reply.
    pendingExpired: pendingExpiredInfo,
    // Batch 100: the turn's settled facts ride the payload so
    // the route can fold them into the rolling summary.
    settled: settledNow,
    queuedJobId,
    // Batch 101: the honest state of the job this turn queued
    // (derived from the job row, never assumed).
    queueStatus: queuedJobId
      ? domain.withDb(workspaceId, (db) => {
          try {
            const row = db.prepare('SELECT * FROM design_jobs WHERE id = ?').get(queuedJobId);
            if (!row) return null;
            let brief = {};
            try {
              brief = JSON.parse(row.brief || '{}') || {};
            } catch {
              brief = {};
            }
            return require('./siteChatQueue').jobChatState(row, brief);
          } catch {
            return null;
          }
        })
      : null,
    // Batch 98: the persisted plan this turn ran on (null when
    // the change was unplanned or the turn made no change).
    planId: turnPlanId,
    planSize: turnPlan ? turnPlan.size : null,
    // Batch 99: the reviewer's verdict for this build turn —
    // pass (with the critic's check list), escalated (the
    // reviewer queued the job itself; escalatedJobId), or fail.
    review: turnReview,
    // Batch 104: the optimistic-preview patch spec for this
    // turn (null when the turn made no previewable change).
    optimisticPatch,
    // Batch 89: echo the turn's attachments (thumbnail URLs are the
    // authorized fetch route) + whether the model received the images.
    attachments: attachmentRows.map((row) => chatAtt.publicRow(row)),
    imagesSent: !!(loop && loop.imagesSent),
    imagesDropped: !!(loop && loop.imagesDropped),
    error:
      loop && loop.error && loop.error !== 'muse_not_configured' && loop.error !== 'budget_exceeded'
        ? loop.error
        : null,
    html: rendered.html,
    previewUrl: rendered.previewUrl,
    editable: !!rendered.editable,
    theme: rendered.theme || null,
    logo: rendered.logo || null,
    pages: rendered.pages || null,
  };
}

// Batch 101 — this site's chat-origin design jobs with their
// HONEST states (server/siteChatQueue.js derives each state
// from the job's real status + verification record). Shared by
// the history payload and the updates poller so the portal's
// queue line is the same truth everywhere.
function chatQueueStatuses(db, leadId) {
  const chatQueue = require('./siteChatQueue');
  try {
    const rows = db
      .prepare(
        "SELECT * FROM design_jobs WHERE lead_id = ? AND type = 'improvement' ORDER BY id DESC LIMIT 6"
      )
      .all(Number(leadId));
    const out = [];
    for (const row of rows) {
      let brief = {};
      try {
        brief = JSON.parse(row.brief || '{}') || {};
      } catch {
        brief = {};
      }
      if (!brief.chat_origin || brief.chat_origin.source !== 'portal_site_chat') continue;
      out.push(chatQueue.jobChatState(row, brief));
      if (out.length >= 3) break;
    }
    return out;
  } catch {
    return [];
  }
}

// Batch 93: design-agent completions for chat-queued jobs land in
// site_chat_messages (written by the deliverJob hook); the portal
// fetches them here and they are marked delivered — each surfaces
// in the thread exactly once.
function takeSiteChatUpdates(workspaceId, leadId) {
  const domain = require('./domain');
  const thread = require('./siteChatThread');
  return domain.withDb(workspaceId, (db) => ({
    messages: thread.takeUndelivered(db, leadId),
    // Batch 101: queue states ride the poller too, so the
    // portal's queue line tracks queued -> building ->
    // in_review -> delivered without a reload.
    queue: chatQueueStatuses(db, leadId),
  }));
}

/**
 * Batch 94 — persist one completed chat turn (owner message +
 * agent reply) into THIS site's thread, marked delivered: the
 * owner already saw both live, so the rows are history for the
 * next panel open, never "updates". Keyed by lead like every
 * other chat-state store — a turn can only land in its own
 * site's thread.
 */
function recordSiteChatTurn(workspaceId, leadId, { userText = '', assistantText = '' } = {}) {
  const domain = require('./domain');
  const thread = require('./siteChatThread');
  return domain.withDb(workspaceId, (db) => {
    const ids = [];
    const user = String(userText || '').trim();
    if (user) {
      ids.push(thread.addMessage(db, { leadId, role: 'user', content: user, source: 'portal_chat', delivered: true }));
    }
    const assistant = String(assistantText || '').trim();
    if (assistant) {
      ids.push(
        thread.addMessage(db, { leadId, role: 'assistant', content: assistant, source: 'portal_chat', delivered: true })
      );
    }
    return { recorded: ids.length, ids };
  });
}

/** Batch 94 — the chat window's initial load: this site's latest
 * CHAT_HISTORY_LIMIT messages, oldest-first. Per-site only. */
function getSiteChatHistory(workspaceId, leadId) {
  const domain = require('./domain');
  const thread = require('./siteChatThread');
  const chatSummary = require('./siteChatSummary');
  return domain.withDb(workspaceId, (db) => ({
    messages: thread.listRecent(db, leadId),
    limit: thread.CHAT_HISTORY_LIMIT,
    // Batch 100: the rolling summary ships with the history so
    // the chat window can show the owner what the agent
    // remembers about THIS site (same per-lead keying).
    summary: chatSummary.getSummary(db, leadId),
    // Batch 101: honest queue states for this site's
    // chat-origin design jobs.
    queue: chatQueueStatuses(db, leadId),
  }));
}

/**
 * Batch 100 — merge one completed chat turn into the site's
 * rolling summary. Called by the portal chat route right after
 * the turn is recorded (the recorded message ids are the
 * citations the summary entries carry). Settled facts come from
 * the classifier's output for the turn, which rides the result
 * payload's `settled` field when present; the deterministic
 * merge lives in server/siteChatSummary.js.
 */
/**
 * @param {any} workspaceId
 * @param {any} leadId
 * @param {{ userText?: string, result?: any, ids?: any[] }} [opts]
 */
function updateSiteChatSummary(workspaceId, leadId, { userText = '', result = {}, ids = [] } = {}) {
  const domain = require('./domain');
  const chatSummary = require('./siteChatSummary');
  const idList = Array.isArray(ids) ? ids : [];
  return domain.withDb(workspaceId, (db) =>
    chatSummary.mergeTurn(db, leadId, {
      userText,
      userMsgId: idList.length ? idList[0] : null,
      assistantMsgId: idList.length > 1 ? idList[1] : null,
      settledFacts: Array.isArray(result.settled) ? result.settled : [],
      mode: result.mode || null,
      mutated: !!result.mutated,
      queuedJobId: result.queuedJobId || null,
      reviewVerdict: result.review ? result.review.verdict : null,
    })
  );
}

/**
 * Batch 97 — the per-plan daily design-chat cap, enforced at the
 * portal chat route BEFORE the pipeline runs (a refused request
 * spends no model call, is never queued, and is not counted).
 *
 * The cap follows the workspace's plan (billing.workspacePlan →
 * plans.chatRequestsPerDayFor; the value is admin-editable per
 * plan in the Batch 57 Package contents editor, blank = null =
 * unlimited). Counting is per site (lead) per calendar day —
 * site-local where the site has a timezone, else UTC — via
 * server/siteChatUsage.js.
 *
 * Who is gated: owner-tier portal sessions (owner + partner). A
 * partner chatting on a client's site draws on THAT site's pool
 * (counting keys on the lead). Staff/admin never enter through
 * the client portal; a non-owner-tier session (renter) has no
 * builder chat and passes through untouched, exactly as before.
 */
async function resolveSiteChatLimit(workspaceId) {
  const billing = require('./billing');
  const plans = require('./plans');
  const planId = await billing.workspacePlan(workspaceId);
  return { planId, planName: plans.getPlan(planId).name, limit: plans.chatRequestsPerDayFor(planId) };
}

async function gateSiteChatRequest(workspaceId, leadId, opts = {}) {
  const portalTabs = require('./portalTabs');
  if (!portalTabs.isOwnerTier(opts.userType)) {
    return { allowed: true, exempt: true, used: null, limit: null, planId: null, planName: null, timezone: null, day: null };
  }
  const domain = require('./domain');
  const chatUsage = require('./siteChatUsage');
  const { planId, planName, limit } = await resolveSiteChatLimit(workspaceId);
  const decision = domain.withDb(workspaceId, (db) =>
    chatUsage.checkAndRecord(db, { leadId, limit })
  );
  return { ...decision, planId, planName };
}

/** Read-only usage view for the chat chrome ("7 of 20 today"). */
async function getSiteChatUsage(workspaceId, leadId) {
  const domain = require('./domain');
  const chatUsage = require('./siteChatUsage');
  const { planId, planName, limit } = await resolveSiteChatLimit(workspaceId);
  return domain.withDb(workspaceId, (db) => {
    const timezone = chatUsage.siteTimezone(db, leadId);
    const day = chatUsage.dayKey(timezone);
    return {
      used: limit == null ? null : chatUsage.getDailyCount(db, leadId, day),
      limit,
      planId,
      planName,
      timezone: timezone || 'UTC',
      day,
    };
  });
}

/** The plain, honest refusal for a capped turn (never fake-processed). */
function chatLimitReplyText(gate) {
  const tzLabel = gate.timezone ? gate.timezone : 'UTC';
  return (
    `You've used all ${gate.limit} of today's design chat requests for this site ` +
    `(${gate.used} of ${gate.limit} on the ${gate.planName} plan). ` +
    `The daily counter resets at midnight (${tzLabel}). ` +
    `Nothing was changed by this message, and it doesn't count against tomorrow — ` +
    `just send it again after the reset.`
  );
}

/**
 * Build HTML for canvas insert (design module or widget) without relocating
 * existing embeds. Enables module/form embeds when placing a widget.
 * Body: { kind: 'layout'|'module'|'form', type?, cols?, formId? }
 */
function prepareCanvasBlock(workspaceId, leadId, body = {}) {
  const domain = require('./domain');
  const structure = require('../src/siteStructure');
  const engine = require('../src/websiteEngine');
  const modules = require('./siteModules');
  const forms = require('./contactForms');
  const { appUrl } = require('./stripeClient');
  const kind = String(body.kind || body.mode || 'layout').toLowerCase();
  const base = appUrl();

  if (kind === 'layout' || kind === 'design-module' || kind === 'design_module' || kind === 'section') {
    const sectionType = String(body.type || body.sectionType || body.section_type || 'text')
      .trim()
      .toLowerCase();
    if (!sectionType) {
      throw Object.assign(new Error('type is required'), { code: 'INVALID' });
    }
    const cols = body.cols != null ? Number(body.cols) : undefined;
    const content = structure.defaultSectionContent(sectionType, { cols });
    let html = engine.sectionToHtml({ type: sectionType, content }, {});
    if (typeof engine.sanitizeHtml === 'function') html = engine.sanitizeHtml(html);
    return { kind: 'layout', type: sectionType, html };
  }

  if (kind === 'module' || kind === 'widget-module') {
    const moduleType = String(body.type || body.moduleType || body.module_type || '')
      .trim()
      .toLowerCase();
    if (!moduleType) {
      throw Object.assign(new Error('module type is required'), { code: 'INVALID' });
    }
    return domain.withDb(workspaceId, (db) => {
      const mod = ensureModuleTokenForInsert(db, workspaceId, leadId, moduleType);
      db.prepare(
        `UPDATE site_module_embeds
         SET published = 1, embed_enabled = 1, updated_at = datetime('now')
         WHERE lead_id = ? AND module_type = ?`
      ).run(Number(leadId), moduleType);
      const row = modules.getEmbedRow(db, Number(leadId), moduleType);
      const embed = modules.publicEmbed(row, mod.apiBase || base);
      let html = modules.embedBlockHtml(embed, mod.apiBase || base);
      if (typeof modules.ensureModuleEmbedScript === 'function') {
        html = modules.ensureModuleEmbedScript(html, mod.apiBase || base);
      }
      return {
        kind: 'module',
        type: moduleType,
        html,
        embedEnable: {
          kind: 'module',
          moduleType,
          token: embed && embed.public_token ? embed.public_token : mod.token,
        },
      };
    });
  }

  if (kind === 'form' || kind === 'widget-form') {
    const formId = body.formId != null ? Number(body.formId) : Number(body.id);
    return domain.withDb(workspaceId, (db) => {
      let row = null;
      if (Number.isInteger(formId) && formId > 0 && typeof forms.getFormRowById === 'function') {
        row = forms.getFormRowById(db, Number(leadId), formId);
      }
      if (!row && body.token) {
        row = db
          .prepare('SELECT * FROM contact_forms WHERE lead_id = ? AND public_token = ?')
          .get(Number(leadId), String(body.token));
      }
      if (!row && typeof forms.listFormRows === 'function') {
        const list = forms.listFormRows(db, Number(leadId));
        row = (list || [])[0] || null;
      }
      if (!row || !row.public_token) {
        throw Object.assign(new Error('No form available to place'), { code: 'NOT_FOUND' });
      }
      db.prepare(
        `UPDATE contact_forms
         SET published = 1, embed_enabled = 1, updated_at = datetime('now')
         WHERE id = ?`
      ).run(row.id);
      const pub = forms.publicForm(row, []);
      let html = forms.embedBlockHtml(pub, base);
      if (typeof forms.ensureFormEmbedScript === 'function') {
        html = forms.ensureFormEmbedScript(html, base);
      }
      return {
        kind: 'form',
        type: 'form',
        formId: row.id,
        html,
        embedEnable: {
          kind: 'form',
          moduleType: '',
          token: row.public_token,
        },
      };
    });
  }

  throw Object.assign(new Error('Unknown canvas block kind'), { code: 'INVALID' });
}

/**
 * Menu + section structure for portal reorder UI.
 */
function getClientSiteStructure(workspaceId, leadId) {
  const domain = require('./domain');
  const structure = require('../src/siteStructure');
  return domain.withDb(workspaceId, (db) => {
    const site = resolveClientSite(db, leadId);
    if (!site || !Array.isArray(site.pages) || !site.pages.length) {
      throw Object.assign(new Error('No website is available yet'), { code: 'NO_SITE' });
    }
    const summary = structure.summarizeStructure(site.pages);
    return {
      siteId: site.id,
      name: site.name,
      freeform: pagesHaveFreeformHtml(site.pages),
      hasSections: pagesHaveEditableSections(site.pages),
      menu: summary.menu,
      pages: summary.pages,
    };
  });
}

/**
 * Reorder menu (pages) or sections. Banner/hero/nav sections stay pinned.
 * Body: { scope: 'menu'|'sections', pageIndex?, fromIndex, direction?: -1|1,
 *         action?: 'move'|'nest'|'unnest' } — nest/unnest = WordPress-style submenu indent.
 */
function ensureModuleTokenForInsert(db, workspaceId, leadId, moduleType) {
  const modules = require('./siteModules');
  const { appUrl } = require('./stripeClient');
  const type = String(moduleType || '')
    .trim()
    .toLowerCase();
  if (!modules.MODULE_TYPES.includes(type)) {
    throw Object.assign(new Error(`Unknown module type: ${type}`), { code: 'INVALID' });
  }
  const meta = modules.MODULE_META[type];
  const base = appUrl();
  // Token only — do not attachModule/sync here (that strips managed embeds and
  // dual-writes html+sections). Structure insert owns the in-page mount.
  let row = modules.getEmbedRow(db, Number(leadId), type);
  if (!row) {
    row = modules.ensureEmbed(db, Number(leadId), type, {
      workspaceId: Number(workspaceId),
      title: meta.defaultTitle,
    });
  }
  if (!row.public_token) {
    const token = modules.makePublicToken(Number(workspaceId));
    db.prepare("UPDATE site_module_embeds SET public_token = ?, updated_at = datetime('now') WHERE id = ?").run(
      token,
      row.id
    );
    row = modules.getEmbedRow(db, Number(leadId), type);
  }
  return {
    token: row.public_token,
    apiBase: base,
    title: row.title || meta.label,
  };
}

function applyClientStructureReorder(workspaceId, leadId, body = {}) {
  const domain = require('./domain');
  const structure = require('../src/siteStructure');
  const modules = require('./siteModules');
  const scope = String(body.scope || '').toLowerCase();
  const fromIndex = Number(body.fromIndex);
  const action = String(body.action || 'move').toLowerCase();
  const isNest = action === 'nest' || action === 'indent';
  const isUnnest = action === 'unnest' || action === 'outdent';
  const isToggleNav = action === 'togglenav' || action === 'toggle-nav' || action === 'toggle_nav';
  const isInsertModule = action === 'insertmodule' || action === 'insert-module' || action === 'insert_module';
  const isInsertSection =
    action === 'insertsection' ||
    action === 'insert-section' ||
    action === 'insert_section' ||
    action === 'insertblock' ||
    action === 'insert-block' ||
    action === 'insert_block';
  const isAddPage = action === 'addpage' || action === 'add-page' || action === 'add_page';
  if (scope !== 'menu' && scope !== 'sections') {
    throw Object.assign(new Error('scope must be menu or sections'), { code: 'INVALID' });
  }
  if (isInsertModule || isInsertSection) {
    if (scope !== 'sections') {
      throw Object.assign(new Error('insert requires scope sections'), { code: 'INVALID' });
    }
  } else if (isAddPage) {
    if (scope !== 'menu') {
      throw Object.assign(new Error('addPage requires scope menu'), { code: 'INVALID' });
    }
  } else if (!Number.isInteger(fromIndex) || fromIndex < 0) {
    throw Object.assign(new Error('Invalid fromIndex'), { code: 'INVALID' });
  }
  if (
    !isInsertModule &&
    !isInsertSection &&
    !isAddPage &&
    scope === 'sections' &&
    !isNest &&
    !isUnnest &&
    !isToggleNav
  ) {
    const direction = Number(body.direction);
    if (direction !== 1 && direction !== -1) {
      throw Object.assign(new Error('direction must be 1 or -1'), { code: 'INVALID' });
    }
  }
  if (!isInsertModule && !isInsertSection && !isAddPage && scope === 'menu' && !isNest && !isUnnest && !isToggleNav) {
    const direction = Number(body.direction);
    if (direction !== 1 && direction !== -1) {
      throw Object.assign(new Error('direction must be 1 or -1'), { code: 'INVALID' });
    }
  }

  const prepared = domain.withDb(workspaceId, (db) => {
    const site = resolveClientSite(db, leadId);
    if (!site || !Array.isArray(site.pages) || !site.pages.length) {
      throw Object.assign(new Error('No website is available yet'), { code: 'NO_SITE' });
    }
    let result;
    if (isAddPage) {
      const title = String(body.title || '').trim();
      if (!title) {
        throw Object.assign(new Error('Page title is required'), { code: 'INVALID' });
      }
      const slug = body.slug != null ? String(body.slug).trim() : undefined;
      const shellHtml = modules.shellHtmlFromPages(site.pages, slug || structure.titleToPageSlug(title));
      result = structure.createClientPage(site.pages, {
        title,
        slug,
        shellHtml,
        fillShellMain: modules.fillShellMain,
        defaultInner: modules.defaultClientPageInner,
      });
      if (!result.changed) {
        throw Object.assign(new Error('Could not create page'), { code: 'NO_MOVE' });
      }
      if (
        result.pageIndex != null &&
        result.pages[result.pageIndex] &&
        typeof result.pages[result.pageIndex].html === 'string'
      ) {
        result.pages[result.pageIndex].html = modules.ensureClientPageChrome(result.pages[result.pageIndex].html);
      }
    } else if (isInsertSection) {
      const pageIndex = Number(body.pageIndex);
      const afterIndex = Number(body.afterIndex);
      const sectionType = String(body.sectionType || body.section_type || body.type || '')
        .trim()
        .toLowerCase();
      if (!Number.isInteger(pageIndex) || pageIndex < 0) {
        throw Object.assign(new Error('Invalid pageIndex'), { code: 'INVALID' });
      }
      if (!Number.isInteger(afterIndex) || afterIndex < -1) {
        throw Object.assign(new Error('Invalid afterIndex'), { code: 'INVALID' });
      }
      if (!sectionType) {
        throw Object.assign(new Error('sectionType is required'), { code: 'INVALID' });
      }
      const cols = body.cols != null ? Number(body.cols) : undefined;
      const html = body.html != null ? String(body.html) : undefined;
      result = structure.insertContentSection(site.pages, pageIndex, afterIndex, sectionType, { cols, html });
      if (!result.changed) {
        throw Object.assign(
          new Error(
            result.reason === 'no_sections'
              ? 'This page has no modular sections yet'
              : 'Cannot insert that section type'
          ),
          { code: 'NO_MOVE' }
        );
      }
    } else if (isInsertModule) {
      const pageIndex = Number(body.pageIndex);
      const afterIndex = Number(body.afterIndex);
      const moduleType = String(body.moduleType || body.module_type || '')
        .trim()
        .toLowerCase();
      if (!Number.isInteger(pageIndex) || pageIndex < 0) {
        throw Object.assign(new Error('Invalid pageIndex'), { code: 'INVALID' });
      }
      if (!Number.isInteger(afterIndex) || afterIndex < -1) {
        throw Object.assign(new Error('Invalid afterIndex'), { code: 'INVALID' });
      }
      if (!moduleType) {
        throw Object.assign(new Error('moduleType is required'), { code: 'INVALID' });
      }
      const mod = ensureModuleTokenForInsert(db, workspaceId, leadId, moduleType);
      const page = site.pages[pageIndex];
      const hasSections = page && Array.isArray(page.sections) && page.sections.length;
      if (hasSections) {
        result = structure.insertModuleSection(site.pages, pageIndex, afterIndex, {
          module_type: moduleType,
          public_token: mod.token,
          api_base: mod.apiBase,
          title: mod.title,
        });
      } else if (page && typeof page.html === 'string' && page.html.trim()) {
        const embed = modules.publicEmbed(modules.getEmbedRow(db, Number(leadId), moduleType), mod.apiBase);
        const block = modules.embedBlockHtml(embed, mod.apiBase);
        const pagesCopy = JSON.parse(JSON.stringify(site.pages));
        const p = pagesCopy[pageIndex];
        p.html = modules.ensureModuleEmbedScript(modules.injectHtmlEmbed(p.html, block), mod.apiBase);
        result = { pages: pagesCopy, changed: true };
      } else {
        throw Object.assign(new Error('This page has no sections to insert into'), { code: 'NO_MOVE' });
      }
      if (!result.changed) {
        throw Object.assign(new Error('Cannot insert module on this page'), { code: 'NO_MOVE' });
      }
    } else if (scope === 'menu') {
      result = structure.applyMenuAction(site.pages, {
        action: isToggleNav ? 'toggleNav' : isNest ? 'nest' : isUnnest ? 'unnest' : 'move',
        fromIndex,
        direction: body.direction,
      });
    } else {
      const pageIndex = Number(body.pageIndex);
      if (!Number.isInteger(pageIndex) || pageIndex < 0) {
        throw Object.assign(new Error('Invalid pageIndex'), { code: 'INVALID' });
      }
      result = structure.reorderSections(site.pages, pageIndex, fromIndex, Number(body.direction));
    }
    if (!result.changed) {
      throw Object.assign(new Error('Cannot move that item'), { code: 'NO_MOVE' });
    }
    return {
      siteId: site.id,
      pages: result.pages,
      theme: site.theme && typeof site.theme === 'object' ? site.theme : {},
      previewFallback: resolvePreviewUrl(site),
      newPageIndex: result.pageIndex,
    };
  });

  const note = isAddPage
    ? 'Client portal: added page'
    : isInsertSection
      ? 'Client portal: inserted layout section'
      : isInsertModule
        ? 'Client portal: inserted module section'
        : scope === 'menu'
          ? isToggleNav
            ? 'Client portal: menu visibility'
            : isNest
              ? 'Client portal: nested menu item'
              : isUnnest
                ? 'Client portal: unnested menu item'
                : 'Client portal: reordered menu'
          : 'Client portal: reordered sections';
  const saved = domain.sitesSave(workspaceId, prepared.siteId, {
    pages: prepared.pages,
    theme: prepared.theme,
    note,
  });
  syncDesignDeliverablePages(workspaceId, leadId, prepared.siteId, prepared.pages, prepared.theme);
  const previewRow = domain.withDb(workspaceId, (db) =>
    db.prepare(`SELECT preview_url, preview_path FROM websites WHERE id = ?`).get(prepared.siteId)
  );
  const summary = structure.summarizeStructure(prepared.pages);
  return {
    siteId: prepared.siteId,
    scope,
    version: saved.version,
    previewUrl: resolvePreviewUrl(previewRow) || prepared.previewFallback,
    menu: summary.menu,
    pages: summary.pages,
    pageIndex: prepared.newPageIndex,
  };
}


module.exports = {
  uploadSiteChatImage,
  fetchSiteChatImage,
  listSiteChatImages,
  runSiteAgentChat,
  takeSiteChatUpdates,
  recordSiteChatTurn,
  getSiteChatHistory,
  updateSiteChatSummary,
  gateSiteChatRequest,
  getSiteChatUsage,
  chatLimitReplyText,
  prepareCanvasBlock,
  getClientSiteStructure,
  applyClientStructureReorder,
};
