'use strict';

const platform = require('./platform');
const { assertMailjetSenderActive } = require('../src/mailjetSender');
const { renderBrandedEmail, ensureBrandedEmail } = require('../src/emailTemplate');

async function platformSmtpSettings() {
  // Batch 48: the mail provider selector + Cloudflare fields ride along
  // so platform mail honours the same Custom/Cloudflare choice. cf.account_id
  // is included as the account-id fallback for the native provider.
  const keys = [
    'smtp.host',
    'smtp.port',
    'smtp.secure',
    'smtp.user',
    'smtp.pass',
    'smtp.from_name',
    'smtp.from_email',
    'mail.provider',
    'mail.cf_token',
    'mail.cf_account_id',
    'cf.account_id',
  ];
  const out = {};
  for (const k of keys) out[k] = await platform.getPlatformSetting(k, '');
  return out;
}

/**
 * Send platform mail through the shared Bitpype HTML template.
 * Prefer structured fields (title, paragraphs, cta) when composing new emails.
 */
async function sendPlatformMail({ to, subject, html, text, title, paragraphs, cta, preheader, footerNote }) {
  const settings = await platformSmtpSettings();
  const { getProvider } = require('../src/email');
  const provider = getProvider(settings, null);
  // Batch 48: the stub check alone decides "not configured" now — with
  // the native Cloudflare provider selected, smtp.host may legitimately
  // be empty while mail is fully configured. (For custom this is
  // identical to before: no host has always meant the stub.)
  if (provider.name === 'stub') {
    const e = new Error('Platform mail is not configured');
    e.code = 'SMTP_NOT_CONFIGURED';
    throw e;
  }
  await assertMailjetSenderActive(settings);

  const payload =
    Array.isArray(paragraphs) && paragraphs.length
      ? renderBrandedEmail({
          title: title || subject,
          paragraphs,
          text: text || paragraphs.join('\n\n'),
          cta,
          preheader,
          footerNote,
        })
      : ensureBrandedEmail({
          subject,
          title,
          html: html || text || '',
          text: text || undefined,
          cta,
          preheader,
          footerNote,
        });

  const result = await provider.send({
    to,
    subject,
    html: payload.html,
    text: payload.text,
    skipBrand: true,
  });
  console.log(
    '[mailer] sent',
    JSON.stringify({
      to,
      subject,
      provider: provider.name,
      smtpResponse: result && result.response,
      messageId: result && result.messageId,
    })
  );
  return {
    sent: true,
    provider: provider.name,
    smtpResponse: result && result.response,
    messageId: result && result.messageId,
  };
}

module.exports = {
  sendPlatformMail,
  platformSmtpSettings,
  assertMailjetSenderActive,
  renderBrandedEmail,
  ensureBrandedEmail,
};
