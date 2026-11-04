'use strict';

/**
 * Batch 129: this URL is an ALIAS of the one payments webhook
 * pipeline (server/routes/paymentsWebhook.js). Site owners
 * configured /api/v1/shop/webhook/:workspaceId in their Stripe
 * dashboards before 129; the URL must keep working forever, so it
 * mounts the identical unified handler — there is no second shop
 * webhook implementation anymore.
 */

module.exports = require('./paymentsWebhook');
