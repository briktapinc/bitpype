'use strict';

/**
 * Batch 111 (consolidation step 4) — portal social: content calendar, branded post images, social generation + account/post actions.
 * PURE code motion from server/clientPortal.js (no logic edits);
 * server/clientPortal.js re-exports the full original surface.
 */



async function calendarPosts(workspaceId, leadId, { year, month, clientEmail } = {}) {
  const domain = require('./domain');
  const social = require('../src/socialMedia');
  const platform = require('./platform');
  const now = new Date();
  const y = Number(year) || now.getUTCFullYear();
  const m = Number(month) || now.getUTCMonth() + 1;
  const start = `${y}-${String(m).padStart(2, '0')}-01`;
  const endMonth = m === 12 ? 1 : m + 1;
  const endYear = m === 12 ? y + 1 : y;
  const end = `${endYear}-${String(endMonth).padStart(2, '0')}-01`;
  const billing = require('./billing');
  const { getPlan } = require('./plans');
  const platformPrice = await platform.getPlatformSetting('social.image_price_usd', '1');
  const planId = await billing.effectivePlan(workspaceId, { email: clientEmail });
  const entitlements = getPlan(planId).entitlements;
  const imagesIncluded = !!entitlements.socialImagesIncluded;
  const creditMod = require('./credits');
  const creditCfg = await creditMod.packConfig();
  const creditBalance = await creditMod.getBalance(workspaceId);

  return domain.withDb(workspaceId, (db) => {
    social.ensureTables(db);
    const rows = db
      .prepare(
        `SELECT id, campaign_id, lead_id, day_index, scheduled_at, caption, platforms,
              image_url, status, client_notes
       FROM social_posts
       WHERE lead_id = ?
         AND scheduled_at >= ?
         AND scheduled_at < ?
       ORDER BY scheduled_at ASC, id ASC`
      )
      .all(Number(leadId), start, end);

    const posts = rows.map((row) => {
      let platforms = ['facebook', 'instagram'];
      try {
        const parsed = typeof row.platforms === 'string' ? JSON.parse(row.platforms || '[]') : row.platforms;
        if (Array.isArray(parsed) && parsed.length) platforms = parsed;
      } catch {
        /* */
      }
      return {
        id: row.id,
        campaign_id: row.campaign_id,
        lead_id: row.lead_id,
        day_index: row.day_index,
        scheduled_at: row.scheduled_at,
        caption: row.caption,
        platforms,
        image_url: row.image_url,
        status: row.status,
        client_notes: row.client_notes,
        with_image: !!(row.image_url && String(row.image_url).trim()),
      };
    });

    const basePrice = social.imagePriceUsd(db, platformPrice);
    const image_price_usd = imagesIncluded ? 0 : basePrice;
    const image_credits = imagesIncluded ? 0 : creditCfg.perImage;
    return {
      year: y,
      month: m,
      posts,
      image_price_usd,
      image_credits,
      content_credits: creditCfg.perContent,
      credits_balance: creditBalance,
      credits_pack_label: creditCfg.packLabel,
      credits_configured: creditCfg.configured,
      social_images_included: imagesIncluded,
      plan: planId,
    };
  });
}

async function generatePostBrandedImage(workspaceId, leadId, postId, clientEmail = '') {
  const domain = require('./domain');
  const social = require('../src/socialMedia');
  const billing = require('./billing');
  const platform = require('./platform');
  const { getPlan } = require('./plans');

  const requireSub = (await platform.getPlatformSetting('billing.require_subscription', '1')) === '1';
  if (requireSub) {
    const ok = await billing.workspaceHasProductAccess(workspaceId);
    if (!ok) {
      throw Object.assign(new Error('An active Bitpype account is required to generate branded image ads.'), {
        code: 'PAYMENT_REQUIRED',
        status: 402,
      });
    }
  }

  const planId = await billing.effectivePlan(workspaceId, { email: clientEmail });
  const entitlements = getPlan(planId).entitlements;
  const platformPrice = await platform.getPlatformSetting('social.image_price_usd', '1');
  const included = !!entitlements.socialImagesIncluded;
  const creditMod = require('./credits');
  const cfg = await creditMod.packConfig();
  const imageCost = included ? 0 : cfg.perImage;
  let spendResult = null;
  if (imageCost > 0) {
    spendResult = await creditMod.spend(workspaceId, imageCost, {
      reason: 'social_branded_image',
      refType: 'social_post',
      refId: String(postId),
    });
  }
  try {
    const out = await domain.withDb(workspaceId, async (db) => {
      social.ensureTables(db);
      return social.generateBrandedAdImage(db, {
        postId: Number(postId),
        leadId: Number(leadId),
        platformPriceFallback: platformPrice,
        chargeUsd: included ? 0 : undefined,
        includedInPlan: included,
        planId,
        creditsCharged: imageCost,
      });
    });
    return {
      ...out,
      credits_charged: imageCost,
      credits_balance: spendResult ? spendResult.balance : await creditMod.getBalance(workspaceId),
    };
  } catch (e) {
    if (imageCost > 0) {
      try {
        await creditMod.grant(workspaceId, imageCost, {
          reason: 'refund_failed_image',
          refType: 'social_post',
          refId: String(postId),
        });
      } catch (re) {
        console.warn('[credits] refund after failed image:', re.message);
      }
    }
    throw e;
  }
}

async function generateSocial(workspaceId, leadId, clientEmail, period) {
  const domain = require('./domain');
  const days = period === 'week' ? 7 : 30;
  const monthStart = new Date().toISOString().slice(0, 10);
  // Credits for content generation are spent inside domain.socialGenerateMonth.
  return domain.socialGenerateMonth(workspaceId, {
    leadId: Number(leadId),
    monthStart,
    days,
    withImages: false,
    clientEmail: clientEmail || '',
    requireClientApproval: true,
    activate: true,
  });
}

function socialAccountsForClient(workspaceId, leadId) {
  const domain = require('./domain');
  return domain.socialAccounts(workspaceId, Number(leadId));
}

function socialOauthStartForClient(workspaceId, leadId, returnTo) {
  const domain = require('./domain');
  const dest = returnTo || '/portal?connected=1#/social';
  return domain.socialOauthStart(workspaceId, Number(leadId), dest);
}

function socialDisconnectForClient(workspaceId, leadId, accountId) {
  const domain = require('./domain');
  const social = require('../src/socialMedia');
  return domain.withDb(workspaceId, (db) => {
    social.ensureTables(db);
    const row = db.prepare('SELECT * FROM social_accounts WHERE id = ?').get(Number(accountId));
    if (!row || Number(row.lead_id) !== Number(leadId)) {
      throw Object.assign(new Error('Account not found'), { code: 'NOT_FOUND' });
    }
    return social.disconnectAccount(db, Number(accountId));
  });
}

function socialUpdatePostForClient(workspaceId, leadId, postId, patch = {}) {
  const domain = require('./domain');
  const social = require('../src/socialMedia');
  return domain.withDb(workspaceId, (db) => {
    social.ensureTables(db);
    const row = db.prepare('SELECT * FROM social_posts WHERE id = ?').get(Number(postId));
    if (!row || Number(row.lead_id) !== Number(leadId)) {
      throw Object.assign(new Error('Post not found'), { code: 'NOT_FOUND' });
    }
    const allowed = {};
    if (patch.scheduled_at != null) allowed.scheduled_at = patch.scheduled_at;
    if (patch.caption != null) allowed.caption = patch.caption;
    if (patch.status != null) {
      const st = String(patch.status);
      if (['scheduled', 'approved', 'draft', 'pending_approval', 'rejected'].includes(st)) {
        allowed.status = st;
      }
    }
    if (patch.client_notes != null) allowed.client_notes = patch.client_notes;
    return social.updatePost(db, Number(postId), allowed);
  });
}

function socialApprovePostsForClient(workspaceId, leadId, postIds) {
  const domain = require('./domain');
  const social = require('../src/socialMedia');
  const ids = (Array.isArray(postIds) ? postIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  return domain.withDb(workspaceId, (db) => {
    social.ensureTables(db);
    const approved = [];
    for (const id of ids) {
      const row = db.prepare('SELECT * FROM social_posts WHERE id = ?').get(id);
      if (!row || Number(row.lead_id) !== Number(leadId)) continue;
      db.prepare(
        "UPDATE social_posts SET status = 'scheduled', updated_at = datetime('now') WHERE id = ? AND status IN ('draft','pending_approval','approved','rejected')"
      ).run(id);
      approved.push(id);
    }
    return { approved };
  });
}


module.exports = {
  calendarPosts,
  generatePostBrandedImage,
  generateSocial,
  socialAccountsForClient,
  socialOauthStartForClient,
  socialDisconnectForClient,
  socialUpdatePostForClient,
  socialApprovePostsForClient,
};
