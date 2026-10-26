/**
 * In-page BitPype site modules (blog, shop, courses, gallery, directory,
 * faq, testimonials, team, events, bookings).
 * Mounts on [data-bitpype-module][data-bitpype-module-token] and fetches
 * /api/v1/modules/public/:token from data-bitpype-api (or same origin).
 * Bookings also uses /slots and POST /book for calendar + time management.
 */
(function () {
  'use strict';

  if (window.BitpypeModules && window.BitpypeModules.__booted) return;

  var STYLE_ID = 'bitpype-module-embed-css';
  var ITEM_PARAM = 'bpItem';
  var TOKEN_ATTR = 'data-bitpype-module-token';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      'main.bp-mod-main, .bp-mod-main{',
      'max-width:1100px;width:100%;margin-left:auto;margin-right:auto;',
      'padding:clamp(1.75rem,4vw,3.25rem) clamp(1.1rem,3.5vw,2rem) clamp(3.5rem,8vw,5.5rem);',
      'box-sizing:border-box;',
      '}',
      'main.bp-mod-main > .bp-mod-page-title,',
      '.bp-mod-page-title{',
      'margin:0 0 0.2em;letter-spacing:-0.03em;line-height:1.08;',
      'font-size:clamp(2rem,4.5vw,3rem);',
      '}',
      '.bitpype-module-embed{',
      '--bp-mod-ink:var(--ws-text,var(--ink,currentColor));',
      '--bp-mod-muted:var(--ws-muted,var(--muted,color-mix(in srgb,var(--bp-mod-ink) 58%,transparent)));',
      '--bp-mod-line:var(--ws-line,var(--line,color-mix(in srgb,var(--bp-mod-ink) 14%,transparent)));',
      '--bp-mod-accent:var(--ws-primary,var(--accent,#0e7a68));',
      '--bp-mod-secondary:var(--ws-secondary,var(--secondary,var(--bp-mod-ink)));',
      '--bp-mod-paper:var(--ws-bg,var(--paper,#fff));',
      'color:var(--bp-mod-ink);font:inherit;line-height:1.55;width:100%;margin:1.25rem 0 0;',
      '}',
      // In-page mounts sit in a centered content column of their own, so a
      // module placed in a full-width band on a designed page aligns with the
      // page's content instead of stranding at the band's left edge. Mounts
      // already inside a narrower designed container are unaffected (the cap
      // only binds when the mount's parent is wider than the column).
      '.bitpype-module-embed.bitpype-module-inpage{',
      'max-width:1100px;margin-left:auto;margin-right:auto;box-sizing:border-box;',
      'padding-left:clamp(1.1rem,3.5vw,2rem);padding-right:clamp(1.1rem,3.5vw,2rem);',
      '}',
      '.bitpype-module-embed.bitpype-module-standalone{',
      'max-width:920px;margin:0 auto;padding:22px 16px 32px;',
      '}',
      '.bitpype-module-embed .bp-mod-lede{',
      'margin:0 0 1.35rem;max-width:42ch;color:var(--bp-mod-muted);font-size:1.05rem;',
      '}',
      '.bitpype-module-embed .bp-mod-grid{',
      'display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:1.25rem;',
      '}',
      '.bitpype-module-embed .bp-mod-card{',
      'display:flex;flex-direction:column;border:1px solid var(--bp-mod-line);',
      'border-radius:1.25rem;overflow:hidden;',
      'background:color-mix(in srgb,var(--bp-mod-paper) 94%,var(--bp-mod-ink));',
      'box-shadow:0 16px 40px color-mix(in srgb,var(--bp-mod-ink) 8%,transparent);',
      'transition:transform .18s ease,box-shadow .18s ease;',
      '}',
      '.bitpype-module-embed .bp-mod-card:hover{',
      'transform:translateY(-2px);',
      'box-shadow:0 22px 48px color-mix(in srgb,var(--bp-mod-ink) 12%,transparent);',
      '}',
      '.bitpype-module-embed .bp-mod-cover{',
      'display:block;aspect-ratio:16/10;background:linear-gradient(145deg,var(--bp-mod-secondary),var(--bp-mod-accent)) center/cover no-repeat;',
      'text-decoration:none;position:relative;',
      '}',
      '.bitpype-module-embed .bp-mod-cover-fallback{',
      'display:grid;place-items:center;color:#fff;font-weight:800;font-size:1.6rem;letter-spacing:-0.03em;',
      '}',
      '.bitpype-module-embed .bp-mod-body{padding:1rem 1.1rem 1.2rem;flex:1;display:flex;flex-direction:column;gap:0.5rem;}',
      '.bitpype-module-embed .bp-mod-card h2{',
      'font-size:1.2rem;margin:0;line-height:1.2;letter-spacing:-0.02em;',
      'font-family:var(--ws-heading-font,inherit);',
      '}',
      '.bitpype-module-embed .bp-mod-card h2 a{color:inherit;text-decoration:none;}',
      '.bitpype-module-embed .bp-mod-card h2 a:hover{color:var(--bp-mod-accent);}',
      '.bitpype-module-embed .bp-mod-meta{color:var(--bp-mod-muted);font-size:0.9rem;margin:0;}',
      '.bitpype-module-embed .bp-mod-excerpt{margin:0;font-size:0.95rem;flex:1;color:var(--bp-mod-muted);line-height:1.45;}',
      '.bitpype-module-embed .bp-mod-view-all{margin:1.25rem 0 0;}',
      '.bitpype-module-embed .bp-mod-view-all a{font-weight:700;color:var(--bp-mod-accent);text-decoration:none;}',
      '.bitpype-module-embed .bp-mod-desc{margin:0;font-size:0.95rem;flex:1;color:var(--bp-mod-muted);}',
      '.bitpype-module-embed .bp-mod-price{font-weight:700;color:var(--bp-mod-accent);margin:0;}',
      '.bitpype-module-embed .bp-mod-btn{',
      'appearance:none;border:0;border-radius:999px;background:var(--bp-mod-accent);color:#fff;',
      'font:inherit;font-weight:700;padding:0.6rem 1.1rem;cursor:pointer;text-decoration:none;',
      'display:inline-flex;align-items:center;justify-content:center;margin-top:0.35rem;align-self:flex-start;',
      '}',
      '.bitpype-module-embed .bp-mod-btn:hover{filter:brightness(1.05);}',
      '.bitpype-module-embed .bp-mod-btn.ghost{',
      'background:transparent;color:var(--bp-mod-ink);border:1.5px solid var(--bp-mod-line);',
      '}',
      '.bitpype-module-embed .bp-mod-back{',
      'display:inline-flex;align-items:center;gap:0.35rem;margin:0 0 1rem;',
      'color:var(--bp-mod-accent);font-weight:700;text-decoration:none;',
      '}',
      '.bitpype-module-embed .bp-mod-detail{',
      'border:1px solid var(--bp-mod-line);border-radius:1.4rem;padding:clamp(1.2rem,3vw,1.8rem);',
      'background:color-mix(in srgb,var(--bp-mod-paper) 96%,var(--bp-mod-ink));',
      'box-shadow:0 18px 44px color-mix(in srgb,var(--bp-mod-ink) 8%,transparent);',
      '}',
      '.bitpype-module-embed .bp-mod-detail .bp-mod-hero{',
      'width:100%;max-height:380px;object-fit:cover;border-radius:1rem;margin:0 0 1.2rem;display:block;',
      '}',
      '.bitpype-module-embed .bp-mod-detail h1{',
      'font-size:clamp(1.7rem,3.2vw,2.4rem);margin:0 0 0.45rem;letter-spacing:-0.03em;line-height:1.1;',
      'font-family:var(--ws-heading-font,inherit);',
      '}',
      '.bitpype-module-embed .bp-mod-content{line-height:1.7;margin-top:1rem;}',
      '.bitpype-module-embed .bp-mod-content img{max-width:100%;height:auto;border-radius:0.75rem;}',
      '.bitpype-module-embed .bp-mod-lessons{list-style:none;padding:0;margin:1.1rem 0 0;}',
      '.bitpype-module-embed .bp-mod-lessons li{border-top:1px solid var(--bp-mod-line);padding:0.85rem 0;}',
      '.bitpype-module-embed .bp-mod-lessons li:first-child{border-top:0;}',
      '.bitpype-module-embed .bp-mod-gallery{',
      'display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:0.75rem;margin-top:0.75rem;',
      '}',
      '.bitpype-module-embed .bp-mod-gallery a{',
      'display:block;aspect-ratio:1;background:#ddd6cb center/cover no-repeat;border-radius:0.85rem;overflow:hidden;',
      '}',
      '.bitpype-module-embed .bp-mod-empty-card{',
      'display:grid;gap:0.65rem;justify-items:start;',
      'padding:clamp(1.4rem,3vw,2rem);border-radius:1.4rem;',
      'border:1px solid var(--bp-mod-line);',
      'background:',
      'linear-gradient(135deg,color-mix(in srgb,var(--bp-mod-accent) 12%,var(--bp-mod-paper)),var(--bp-mod-paper) 55%),',
      'var(--bp-mod-paper);',
      'box-shadow:0 18px 44px color-mix(in srgb,var(--bp-mod-ink) 7%,transparent);',
      '}',
      '.bitpype-module-embed .bp-mod-empty-kicker{',
      'margin:0;font-size:0.75rem;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;',
      'color:var(--bp-mod-accent);',
      '}',
      '.bitpype-module-embed .bp-mod-empty-title{',
      'margin:0;font-size:1.35rem;letter-spacing:-0.02em;line-height:1.2;',
      'font-family:var(--ws-heading-font,inherit);',
      '}',
      '.bitpype-module-embed .bp-mod-empty-text{margin:0;color:var(--bp-mod-muted);max-width:36ch;}',
      '.bitpype-module-embed .bp-mod-err,.bitpype-module-embed .bp-mod-loading{',
      'color:var(--bp-mod-muted);margin:0;padding:0.5rem 0;',
      '}',
      '.bitpype-module-embed .bp-mod-err{color:#9b2c2c;}',
      '.bitpype-module-embed .bp-mod-title{',
      'font-size:clamp(1.5rem,2.6vw,2rem);margin:0 0 1rem;letter-spacing:-0.03em;line-height:1.1;',
      'font-family:var(--ws-heading-font,inherit);',
      '}',
      '.bitpype-module-embed .bp-mod-faq{display:grid;gap:0.65rem;}',
      '.bitpype-module-embed .bp-mod-faq details{',
      'border:1px solid var(--bp-mod-line);border-radius:1rem;padding:0.85rem 1rem;',
      'background:color-mix(in srgb,var(--bp-mod-paper) 96%,var(--bp-mod-ink));',
      '}',
      '.bitpype-module-embed .bp-mod-faq summary{',
      'cursor:pointer;font-weight:700;letter-spacing:-0.01em;list-style:none;',
      '}',
      '.bitpype-module-embed .bp-mod-faq summary::-webkit-details-marker{display:none;}',
      '.bitpype-module-embed .bp-mod-faq .bp-mod-content{margin-top:0.65rem;color:var(--bp-mod-muted);}',
      '.bitpype-module-embed .bp-mod-quote{',
      'margin:0;font-size:1.05rem;line-height:1.55;letter-spacing:-0.01em;',
      '}',
      '.bitpype-module-embed .bp-mod-stars{color:var(--bp-mod-accent);letter-spacing:0.08em;font-size:0.95rem;}',
      '.bitpype-module-embed .bp-mod-book{',
      'display:grid;gap:1.1rem;max-width:640px;',
      '}',
      '.bitpype-module-embed .bp-mod-book-row{display:grid;gap:0.45rem;}',
      '.bitpype-module-embed .bp-mod-book label{font-weight:700;font-size:0.92rem;}',
      '.bitpype-module-embed .bp-mod-book input,',
      '.bitpype-module-embed .bp-mod-book select,',
      '.bitpype-module-embed .bp-mod-book textarea{',
      'width:100%;box-sizing:border-box;border:1px solid var(--bp-mod-line);border-radius:0.85rem;',
      'padding:0.7rem 0.85rem;font:inherit;background:var(--bp-mod-paper);color:var(--bp-mod-ink);',
      '}',
      '.bitpype-module-embed .bp-mod-slots{',
      'display:flex;flex-wrap:wrap;gap:0.5rem;',
      '}',
      '.bitpype-module-embed .bp-mod-slot{',
      'appearance:none;border:1.5px solid var(--bp-mod-line);border-radius:999px;',
      'background:transparent;color:var(--bp-mod-ink);font:inherit;font-weight:700;',
      'padding:0.45rem 0.85rem;cursor:pointer;',
      '}',
      '.bitpype-module-embed .bp-mod-slot.is-selected,',
      '.bitpype-module-embed .bp-mod-slot:hover{',
      'border-color:var(--bp-mod-accent);color:var(--bp-mod-accent);',
      '}',
      '.bitpype-module-embed .bp-mod-book-msg{margin:0;color:var(--bp-mod-muted);}',
      '.bitpype-module-embed .bp-mod-book-msg.ok{color:var(--bp-mod-accent);}',
      '.bitpype-module-embed .bp-mod-book-msg.err{color:#9b2c2c;}',
      '.bitpype-module-embed .bp-mod-captcha{margin:0.35rem 0 0.65rem;}',
      '.bitpype-module-embed .bp-mod-captcha iframe{display:block;}',
      '@media (prefers-reduced-motion:reduce){',
      '.bitpype-module-embed .bp-mod-card{transition:none;}',
      '.bitpype-module-embed .bp-mod-card:hover{transform:none;}',
      '}',
      // Special Offers — Cards layout: contained grid (auto-fit collapses
      // empty tracks, cards cap at a sensible width and center, so a single
      // offer never strands at the left edge of a wide column).
      '.bitpype-module-embed .bp-mod-offers{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr));gap:1.1rem;justify-items:center;}',
      '.bitpype-module-embed .bp-mod-offer{border:1px solid var(--bp-mod-line);border-radius:1.1rem;background:var(--bp-mod-paper);overflow:hidden;display:flex;flex-direction:column;width:100%;max-width:34rem;}',
      // Special Offers — Horizontal layout: banner-style rows (image left,
      // title + description middle, code chip + expiry right), stacked.
      '.bitpype-module-embed .bp-mod-offers.is-horizontal{display:flex;flex-direction:column;gap:1rem;}',
      '.bitpype-module-embed .bp-mod-offer-row{display:grid;grid-template-columns:220px minmax(0,1fr) auto;align-items:center;gap:1.1rem;width:100%;box-sizing:border-box;border:1px solid var(--bp-mod-line);border-radius:1.1rem;background:var(--bp-mod-paper);padding:1rem 1.15rem;overflow:hidden;}',
      '.bitpype-module-embed .bp-mod-offer-row.no-img{grid-template-columns:minmax(0,1fr) auto;}',
      '.bitpype-module-embed .bp-mod-offer-row-img{display:block;border-radius:0.75rem;overflow:hidden;line-height:0;}',
      '.bitpype-module-embed .bp-mod-offer-row img{width:100%;height:128px;object-fit:cover;display:block;}',
      '.bitpype-module-embed .bp-mod-offer-row-body{display:flex;flex-direction:column;gap:0.45rem;min-width:0;}',
      '.bitpype-module-embed .bp-mod-offer-row h2{margin:0;font-size:1.15rem;line-height:1.25;font-family:var(--ws-heading-font,inherit);}',
      '.bitpype-module-embed .bp-mod-offer-row h2 a{color:inherit;text-decoration:none;}',
      '.bitpype-module-embed .bp-mod-offer-row h2 a:hover{color:var(--bp-mod-accent);}',
      '.bitpype-module-embed .bp-mod-offer-row p{margin:0;color:var(--bp-mod-muted);font-size:0.95rem;line-height:1.5;}',
      '.bitpype-module-embed .bp-mod-offer-row-side{display:flex;flex-direction:column;align-items:flex-end;gap:0.5rem;text-align:right;}',
      '.bitpype-module-embed .bp-mod-offer-row-side .bp-mod-offer-exp{margin:0;}',
      '@media (max-width:640px){',
      '.bitpype-module-embed .bp-mod-offer-row{grid-template-columns:1fr;}',
      '.bitpype-module-embed .bp-mod-offer-row.no-img{grid-template-columns:1fr;}',
      '.bitpype-module-embed .bp-mod-offer-row img{height:160px;}',
      '.bitpype-module-embed .bp-mod-offer-row-side{align-items:flex-start;text-align:left;}',
      '}',
      '.bitpype-module-embed .bp-mod-offer img{width:100%;height:160px;object-fit:cover;display:block;}',
      '.bitpype-module-embed .bp-mod-offer-body{padding:1rem 1.1rem 1.2rem;display:flex;flex-direction:column;gap:0.55rem;flex:1;}',
      '.bitpype-module-embed .bp-mod-offer h2{margin:0;font-size:1.15rem;line-height:1.25;font-family:var(--ws-heading-font,inherit);}',
      '.bitpype-module-embed .bp-mod-offer h2 a{color:inherit;text-decoration:none;}',
      '.bitpype-module-embed .bp-mod-offer h2 a:hover{color:var(--bp-mod-accent);}',
      '.bitpype-module-embed .bp-mod-offer p{margin:0;color:var(--bp-mod-muted);font-size:0.95rem;line-height:1.5;}',
      '.bitpype-module-embed .bp-mod-offer-code{align-self:flex-start;border:1.5px dashed var(--bp-mod-accent);color:var(--bp-mod-accent);border-radius:0.6rem;padding:0.3rem 0.7rem;font-weight:800;letter-spacing:0.04em;font-size:0.92rem;}',
      '.bitpype-module-embed .bp-mod-offer-terms{font-size:0.8rem;color:var(--bp-mod-muted);}',
      '.bitpype-module-embed .bp-mod-offer-exp{font-size:0.88rem;color:var(--bp-mod-muted);margin-top:auto;}',
      // Menu / Price List
      '.bitpype-module-embed .bp-mod-menu{max-width:760px;}',
      '.bitpype-module-embed .bp-mod-menu-cat{font-size:1.35rem;margin:1.8rem 0 0.4rem;padding-bottom:0.4rem;border-bottom:2px solid var(--bp-mod-accent);font-family:var(--ws-heading-font,inherit);}',
      '.bitpype-module-embed .bp-mod-menu-cat:first-child{margin-top:0;}',
      '.bitpype-module-embed .bp-mod-menu-row{display:flex;align-items:baseline;gap:0.6rem;padding:0.55rem 0 0;}',
      '.bitpype-module-embed .bp-mod-menu-name{font-weight:650;}',
      '.bitpype-module-embed .bp-mod-menu-tags{font-size:0.7rem;font-weight:800;text-transform:uppercase;letter-spacing:0.05em;color:var(--bp-mod-accent);border:1px solid currentColor;border-radius:999px;padding:0.05rem 0.5rem;white-space:nowrap;}',
      '.bitpype-module-embed .bp-mod-menu-dots{flex:1;border-bottom:2px dotted var(--bp-mod-line);transform:translateY(-4px);min-width:1.5rem;}',
      '.bitpype-module-embed .bp-mod-menu-price{font-weight:750;white-space:nowrap;}',
      '.bitpype-module-embed .bp-mod-menu-desc{margin:0.15rem 0 0.35rem;color:var(--bp-mod-muted);font-size:0.92rem;line-height:1.5;max-width:88%;}',
      '@media print{.bitpype-module-embed .bp-mod-menu-cat{border-bottom-color:#000;}.bitpype-module-embed .bp-mod-menu-dots{border-bottom-color:#999;}}',
      // Careers
      '.bitpype-module-embed .bp-mod-careers{display:flex;flex-direction:column;gap:0.9rem;max-width:820px;}',
      '.bitpype-module-embed .bp-mod-job{border:1px solid var(--bp-mod-line);border-radius:1.1rem;background:var(--bp-mod-paper);padding:1.15rem 1.25rem;}',
      '.bitpype-module-embed .bp-mod-job h2{margin:0 0 0.25rem;font-size:1.15rem;line-height:1.3;font-family:var(--ws-heading-font,inherit);}',
      '.bitpype-module-embed .bp-mod-job h2 a{color:inherit;text-decoration:none;}',
      '.bitpype-module-embed .bp-mod-job h2 a:hover{color:var(--bp-mod-accent);}',
      '.bitpype-module-embed .bp-mod-job-meta{color:var(--bp-mod-muted);font-size:0.9rem;margin:0;}',
      '.bitpype-module-embed .bp-mod-job details{margin-top:0.55rem;}',
      '.bitpype-module-embed .bp-mod-job summary{cursor:pointer;font-weight:700;color:var(--bp-mod-accent);}',
      '.bitpype-module-embed .bp-mod-job-desc{margin:0.65rem 0 0;line-height:1.65;white-space:pre-wrap;}',
      '.bitpype-module-embed .bp-mod-job-apply{margin-top:0.8rem;}',
      // Video
      '.bitpype-module-embed .bp-mod-videos{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:1.1rem;}',
      '.bitpype-module-embed .bp-mod-video{display:flex;flex-direction:column;gap:0.55rem;}',
      '.bitpype-module-embed .bp-mod-video-facade{position:relative;display:block;width:100%;padding:0;border:0;border-radius:1rem;overflow:hidden;cursor:pointer;background:#0f172a;aspect-ratio:16/9;}',
      '.bitpype-module-embed .bp-mod-video-facade img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;}',
      '.bitpype-module-embed .bp-mod-video-play{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:64px;height:64px;border-radius:50%;background:color-mix(in srgb,var(--bp-mod-accent) 92%,transparent);display:flex;align-items:center;justify-content:center;color:#fff;font-size:24px;padding-left:4px;box-shadow:0 6px 20px rgba(0,0,0,0.35);}',
      '.bitpype-module-embed .bp-mod-video-facade iframe{position:absolute;inset:0;width:100%;height:100%;border:0;}',
      '.bitpype-module-embed .bp-mod-video h2{margin:0;font-size:1.08rem;line-height:1.35;font-family:var(--ws-heading-font,inherit);}',
      '.bitpype-module-embed .bp-mod-video h2 a{color:inherit;text-decoration:none;}',
      '.bitpype-module-embed .bp-mod-video h2 a:hover{color:var(--bp-mod-accent);}',
      '.bitpype-module-embed .bp-mod-video p{margin:0;color:var(--bp-mod-muted);font-size:0.92rem;line-height:1.5;}',
      // Instant Estimate
      '.bitpype-module-embed .bp-est-service{margin:0;font-weight:700;}',
      '.bitpype-module-embed .bp-est-options{display:grid;gap:0.65rem;}',
      '.bitpype-module-embed .bp-est-opt{display:flex;align-items:center;gap:0.6rem;border:1px solid var(--bp-mod-line);border-radius:0.85rem;padding:0.7rem 0.85rem;cursor:pointer;font-weight:600;}',
      '.bitpype-module-embed .bp-est-opt input[type="checkbox"]{width:auto;flex:none;margin:0;}',
      '.bitpype-module-embed .bp-est-opt-price{margin-left:auto;color:var(--bp-mod-accent);font-weight:750;white-space:nowrap;}',
      '.bitpype-module-embed .bp-est-opt-row{display:grid;gap:0.45rem;}',
      '.bitpype-module-embed .bp-est-opt-row label{font-weight:700;font-size:0.92rem;display:flex;justify-content:space-between;gap:0.6rem;}',
      '.bitpype-module-embed .bp-est-opt-row .bp-est-opt-price{margin-left:0;}',
      '.bitpype-module-embed .bp-est-qty{max-width:110px;}',
      '.bitpype-module-embed .bp-est-total{border:1.5px solid var(--bp-mod-accent);border-radius:1rem;padding:0.9rem 1.05rem;display:flex;justify-content:space-between;align-items:baseline;gap:1rem;flex-wrap:wrap;}',
      '.bitpype-module-embed .bp-est-total-label{font-weight:700;color:var(--bp-mod-muted);}',
      '.bitpype-module-embed .bp-est-total-value{font-size:1.45rem;font-weight:800;color:var(--bp-mod-accent);letter-spacing:-0.01em;}',
      '.bitpype-module-embed .bp-est-disclaimer{margin:0;color:var(--bp-mod-muted);font-size:0.85rem;line-height:1.5;}',
      // Social Feed
      '.bitpype-module-embed .bp-mod-socialfeed{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:1.1rem;}',
      '.bitpype-module-embed .bp-mod-socialfeed.is-list{display:flex;flex-direction:column;gap:0.9rem;max-width:760px;}',
      '.bitpype-module-embed .bp-mod-social-card{border:1px solid var(--bp-mod-line);border-radius:1.1rem;background:var(--bp-mod-paper);overflow:hidden;display:flex;flex-direction:column;}',
      '.bitpype-module-embed .bp-mod-social-card img{width:100%;height:180px;object-fit:cover;display:block;}',
      '.bitpype-module-embed .bp-mod-socialfeed.is-list .bp-mod-social-card img{height:150px;}',
      '.bitpype-module-embed .bp-mod-social-body{padding:0.95rem 1.05rem 1.1rem;display:flex;flex-direction:column;gap:0.5rem;flex:1;}',
      '.bitpype-module-embed .bp-mod-social-meta{display:flex;align-items:center;gap:0.55rem;font-size:0.84rem;color:var(--bp-mod-muted);}',
      '.bitpype-module-embed .bp-mod-social-badge{font-weight:800;text-transform:uppercase;letter-spacing:0.05em;font-size:0.68rem;color:var(--bp-mod-accent);border:1px solid currentColor;border-radius:999px;padding:0.1rem 0.55rem;}',
      '.bitpype-module-embed .bp-mod-social-text{margin:0;line-height:1.55;font-size:0.96rem;}',
      '.bitpype-module-embed .bp-mod-social-link{margin-top:auto;font-weight:700;color:var(--bp-mod-accent);text-decoration:none;font-size:0.9rem;}',
      '.bitpype-module-embed .bp-mod-social-link:hover{text-decoration:underline;}',
      // Call Tracking
      '.bitpype-module-embed .bp-mod-calltracking{display:flex;}',
      '.bitpype-module-embed .bp-mod-call{display:inline-flex;flex-direction:column;gap:0.15rem;border:1.5px solid var(--bp-mod-accent);border-radius:1rem;padding:0.9rem 1.3rem;background:var(--bp-mod-paper);text-decoration:none;}',
      '.bitpype-module-embed .bp-mod-call-label{font-size:0.82rem;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--bp-mod-muted);}',
      '.bitpype-module-embed .bp-mod-call-number{font-size:1.5rem;font-weight:800;color:var(--bp-mod-accent);letter-spacing:-0.01em;line-height:1.1;}',
      '.bitpype-module-embed .bp-mod-gate{border:1px solid var(--bp-mod-line);border-radius:1.1rem;background:var(--bp-mod-paper);padding:1.6rem 1.5rem;max-width:30rem;}',
      '.bitpype-module-embed .bp-mod-gate-title{font-size:1.25rem;font-weight:800;margin:0 0 0.45rem;line-height:1.3;}',
      '.bitpype-module-embed .bp-mod-gate-text{margin:0 0 1.1rem;color:var(--bp-mod-muted);line-height:1.55;}',
      '.bitpype-module-embed .bp-mod-gate-alt{margin:1rem 0 0;font-size:0.94rem;}',
      '.bitpype-module-embed .bp-mod-gate-alt a{color:var(--bp-mod-accent);font-weight:700;}',
      '.bitpype-module-embed .bp-mod-member-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1.5rem;align-items:start;}',
      '.bitpype-module-embed .bp-mod-member-col{border:1px solid var(--bp-mod-line);border-radius:1.1rem;background:var(--bp-mod-paper);padding:1.4rem 1.35rem;}',
      '.bitpype-module-embed .bp-mod-member-col h3{margin:0 0 1rem;font-size:1.12rem;}',
      '.bitpype-module-embed .bp-mod-member-card{border:1px solid var(--bp-mod-line);border-radius:1.1rem;background:var(--bp-mod-paper);padding:1.4rem 1.35rem;max-width:30rem;}',
      '.bitpype-module-embed .bp-mod-tier-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:1rem;margin-top:1.2rem;align-items:stretch;}',
      '.bitpype-module-embed .bp-mod-tier{border:1px solid var(--bp-mod-line);border-radius:1.1rem;background:var(--bp-mod-paper);padding:1.25rem 1.2rem;display:flex;flex-direction:column;gap:.5rem;}',
      '.bitpype-module-embed .bp-mod-tier h4{margin:0;font-size:1.05rem;}',
      '.bitpype-module-embed .bp-mod-tier-price{font-size:1.35rem;font-weight:700;}',
      '.bitpype-module-embed .bp-mod-tier-price span{font-size:.85rem;font-weight:500;opacity:.75;}',
      '.bitpype-module-embed .bp-mod-tier-desc{margin:0;opacity:.85;flex:1;}',
      '.bitpype-module-embed .bp-mod-tier-current{font-weight:600;}',
      '.bitpype-module-embed .bp-mod-tiers-head{margin:1.4rem 0 0;font-size:1.12rem;}',
      '.bitpype-module-embed .bp-mod-forgot{margin-top:1rem;border-top:1px solid var(--bp-mod-line);padding-top:1rem;}',
      '.bitpype-module-embed .bp-mod-forgot summary{cursor:pointer;font-weight:600;font-size:0.94rem;}',
      '.bitpype-module-embed .bp-mod-forgot form{margin-top:0.8rem;}',
    ].join('');
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = css;
    document.head.appendChild(style);
  }

  function polishHost(el) {
    var main = el.closest('main');
    if (main) main.classList.add('bp-mod-main');
    var prev = el.previousElementSibling;
    if (prev && /^H[1-3]$/.test(prev.tagName)) prev.classList.add('bp-mod-page-title');
  }

  function emptyCopy(type) {
    if (type === 'blog') {
      return {
        kicker: 'Blog',
        title: 'Posts are on the way',
        text: 'New articles will show up here as soon as they are published.',
      };
    }
    if (type === 'ecommerce') {
      return { kicker: 'Shop', title: 'No products yet', text: 'Products will appear here once they are published.' };
    }
    if (type === 'courses') {
      return { kicker: 'Courses', title: 'No courses yet', text: 'Published courses will show up in this space.' };
    }
    if (type === 'gallery') {
      return { kicker: 'Gallery', title: 'No albums yet', text: 'Photo albums will appear here when published.' };
    }
    if (type === 'directory') {
      return {
        kicker: 'Directory',
        title: 'No listings yet',
        text: 'Directory listings will show up here when published.',
      };
    }
    if (type === 'faq') {
      return { kicker: 'FAQ', title: 'No questions yet', text: 'Published FAQs will appear here.' };
    }
    if (type === 'testimonials') {
      return {
        kicker: 'Testimonials',
        title: 'No reviews yet',
        text: 'Customer testimonials will show up here when published.',
      };
    }
    if (type === 'team') {
      return { kicker: 'Team', title: 'No team members yet', text: 'Team profiles will appear here when published.' };
    }
    if (type === 'events') {
      return { kicker: 'Events', title: 'No events yet', text: 'Upcoming events will show up here when published.' };
    }
    if (type === 'bookings') {
      return {
        kicker: 'Bookings',
        title: 'No services yet',
        text: 'Publish a bookable service to open the appointment calendar.',
      };
    }
    if (type === 'offers') {
      return { kicker: 'Special Offers', title: 'No offers right now', text: 'Check back soon for new deals.' };
    }
    if (type === 'menu') {
      return { kicker: 'Menu', title: 'Menu coming soon', text: 'Our menu is being updated — please check back shortly.' };
    }
    if (type === 'careers') {
      // No public empty state for Careers — the section renders nothing.
      return { kicker: '', title: '', text: '' };
    }
    if (type === 'socialfeed') {
      // No public empty state for Social Feed — the section renders nothing.
      return { kicker: '', title: '', text: '' };
    }
    if (type === 'video') {
      return { kicker: 'Videos', title: 'No videos yet', text: 'Videos will appear here when published.' };
    }
    return { kicker: 'Module', title: 'Nothing published yet', text: 'Published items will appear here.' };
  }

  function starsHtml(n) {
    var r = Math.max(0, Math.min(5, Math.round(Number(n) || 0)));
    if (!r) return '';
    return '<p class="bp-mod-stars" aria-label="' + r + ' of 5">' + '★'.repeat(r) + '☆'.repeat(5 - r) + '</p>';
  }

  function todayYmd() {
    var d = new Date();
    return (
      d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
    );
  }

  function renderEmpty(type) {
    var copy = emptyCopy(type);
    return (
      '<div class="bp-mod-empty-card">' +
      '<p class="bp-mod-empty-kicker">' +
      esc(copy.kicker) +
      '</p>' +
      '<p class="bp-mod-empty-title">' +
      esc(copy.title) +
      '</p>' +
      '<p class="bp-mod-empty-text">' +
      esc(copy.text) +
      '</p>' +
      '</div>'
    );
  }

  function coverHtml(href, imageUrl, label) {
    if (imageUrl) {
      return (
        '<a class="bp-mod-cover" href="' + esc(href) + '" style="background-image:url(\'' + esc(imageUrl) + '\')"></a>'
      );
    }
    var letter =
      String(label || '?')
        .trim()
        .charAt(0)
        .toUpperCase() || '?';
    return (
      '<a class="bp-mod-cover bp-mod-cover-fallback" href="' +
      esc(href) +
      '" aria-hidden="true">' +
      esc(letter) +
      '</a>'
    );
  }

  function apiBase(el) {
    var raw = el.getAttribute('data-bitpype-api') || '';
    if (raw) return String(raw).replace(/\/$/, '');
    try {
      var src = document.querySelector('script[data-bitpype-module-script],script[src*="module-embed.js"]');
      if (src && src.src) return new URL(src.src).origin;
    } catch (e) {
      /* ignore */
    }
    return '';
  }

  /* ── Membership: session storage + gate headers ──
   * Sessions live in localStorage keyed by the site's members token. Every
   * module API call carries the session (when one exists), the current page
   * slug, and any owner preview grant, so the server can enforce gating. */
  var MEMBER_SESSION_PREFIX = 'bp_member_session_';

  function storedMemberSession() {
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(MEMBER_SESSION_PREFIX) === 0) {
          var v = localStorage.getItem(k);
          if (v) return v;
        }
      }
    } catch (e) {
      /* storage unavailable */
    }
    return '';
  }

  function saveMemberSession(membersToken, sessionToken) {
    if (!membersToken) return;
    try {
      if (sessionToken) localStorage.setItem(MEMBER_SESSION_PREFIX + membersToken, sessionToken);
      else localStorage.removeItem(MEMBER_SESSION_PREFIX + membersToken);
    } catch (e) {
      /* ignore */
    }
  }

  function memberPreviewGrant() {
    try {
      return window.__BP_MEMBER_PREVIEW_GRANT__ || '';
    } catch (e) {
      return '';
    }
  }

  function pageSlugHere() {
    var p = String((window.location && window.location.pathname) || '').replace(/\/+$/, '');
    var base = p.split('/').pop() || '';
    var slug = base.replace(/\.html?$/i, '');
    return slug || 'index';
  }

  /* Only credentials that exist are sent as headers — an anonymous read
   * stays a simple request (no CORS preflight). The current page slug
   * travels as a query param for the same reason. */
  function authHeaders() {
    var h = {};
    var s = storedMemberSession();
    if (s) h['X-Bitpype-Member-Session'] = s;
    var g = memberPreviewGrant();
    if (g) h['X-Bitpype-Preview-Grant'] = g;
    return h;
  }

  function jsonHeaders() {
    var h = { 'Content-Type': 'application/json' };
    var ah = authHeaders();
    for (var k in ah) h[k] = ah[k];
    return h;
  }

  function pageQuery() {
    return 'bpPage=' + encodeURIComponent(pageSlugHere());
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var existing = document.querySelector('script[src="' + src + '"]');
      if (existing) {
        if (window.ScoutCaptcha) resolve();
        else
          existing.addEventListener('load', function () {
            resolve();
          });
        return;
      }
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = function () {
        resolve();
      };
      s.onerror = function () {
        reject(new Error('Could not load captcha helper'));
      };
      document.head.appendChild(s);
    });
  }

  function dateLabel(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch (e) {
      return '';
    }
  }

  function currentItemKey() {
    try {
      return new URLSearchParams(location.search).get(ITEM_PARAM) || '';
    } catch (e) {
      return '';
    }
  }

  function listHref() {
    var u = new URL(location.href);
    u.searchParams.delete(ITEM_PARAM);
    return u.pathname + u.search + u.hash;
  }

  function itemHref(key) {
    var u = new URL(location.href);
    u.searchParams.set(ITEM_PARAM, key);
    return u.pathname + '?' + u.searchParams.toString() + u.hash;
  }

  function shouldShowTitle(el) {
    if (el.getAttribute('data-bitpype-show-title') === '1') return true;
    if (el.getAttribute('data-bitpype-hide-title') === '1') return false;
    var prev = el.previousElementSibling;
    if (prev && /^H[1-3]$/.test(prev.tagName)) return false;
    return !el.classList.contains('bitpype-module-inpage');
  }

  function embedSettings(data) {
    var s = (data && data.settings) || (data && data.embed && data.embed.settings) || {};
    return {
      show_excerpt: !(s.show_excerpt === false || s.show_excerpt === 0 || s.show_excerpt === 'false'),
      post_limit: s.post_limit != null && Number(s.post_limit) > 0 ? Math.floor(Number(s.post_limit)) : null,
      layout: s.layout === 'horizontal' ? 'horizontal' : 'cards',
      target_page_slug: (data && data.embed && data.embed.target_page_slug) || '',
    };
  }

  function pathStem(p) {
    return String(p || '')
      .replace(/^\//, '')
      .replace(/\.html$/i, '')
      .replace(/\/$/, '')
      .toLowerCase();
  }

  /** Link to full blog page when this embed is a truncated preview on another page. */
  function viewAllPostsHref(data) {
    if (!(data && data.truncated)) return '';
    var slug = pathStem((data.embed && data.embed.target_page_slug) || '');
    if (!slug || slug === 'home') slug = 'index';
    var here = pathStem(location.pathname);
    if (!here || here === '' || here === '/') here = 'index';
    if (here === slug) return '';
    if (slug === 'index') return 'index.html';
    return slug.indexOf('.html') >= 0 ? slug : slug + '.html';
  }

  function renderAlbumDetail(album, showBack) {
    var html = '';
    if (showBack) html += '<a class="bp-mod-back" href="' + esc(listHref()) + '">← All albums</a>';
    html += '<div class="bp-mod-detail"><h1>' + esc(album.title) + '</h1>';
    if (album.description) html += '<p class="bp-mod-meta">' + esc(album.description) + '</p>';
    var imgs = album.images || [];
    if (!imgs.length) html += '<p class="bp-mod-empty">No images yet.</p>';
    else {
      html += '<div class="bp-mod-gallery">';
      for (var i = 0; i < imgs.length; i++) {
        var im = imgs[i];
        html +=
          '<a href="' +
          esc(im.image_url) +
          '" target="_blank" rel="noopener" style="background-image:url(\'' +
          esc(im.image_url) +
          '\')" title="' +
          esc(im.caption || '') +
          '"></a>';
      }
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  function offerCardHtml(it) {
    var key = it.slug || it.id;
    var html = '<article class="bp-mod-offer">';
    if (it.image_url) {
      html +=
        '<a href="' + esc(itemHref(key)) + '"><img src="' + esc(it.image_url) + '" alt="' + esc(it.title) + '" loading="lazy"></a>';
    }
    html += '<div class="bp-mod-offer-body">';
    html += '<h2><a href="' + esc(itemHref(key)) + '">' + esc(it.title) + '</a></h2>';
    if (it.description) html += '<p>' + esc(it.description) + '</p>';
    if (it.code) html += '<span class="bp-mod-offer-code">' + esc(it.code) + '</span>';
    if (it.terms) html += '<p class="bp-mod-offer-terms">' + esc(it.terms) + '</p>';
    if (it.expires_at) html += '<p class="bp-mod-offer-exp">Expires ' + esc(it.expires_at) + '</p>';
    html += '</div></article>';
    return html;
  }

  /** Horizontal (banner) layout: image left, title + description middle,
   * code chip + expiry right. Rows without an image collapse the thumb cell. */
  function offerRowHtml(it) {
    var key = it.slug || it.id;
    var html = '<article class="bp-mod-offer-row' + (it.image_url ? '' : ' no-img') + '">';
    if (it.image_url) {
      html +=
        '<a class="bp-mod-offer-row-img" href="' +
        esc(itemHref(key)) +
        '"><img src="' +
        esc(it.image_url) +
        '" alt="' +
        esc(it.title) +
        '" loading="lazy"></a>';
    }
    html += '<div class="bp-mod-offer-row-body">';
    html += '<h2><a href="' + esc(itemHref(key)) + '">' + esc(it.title) + '</a></h2>';
    if (it.description) html += '<p>' + esc(it.description) + '</p>';
    if (it.terms) html += '<p class="bp-mod-offer-terms">' + esc(it.terms) + '</p>';
    html += '</div>';
    if (it.code || it.expires_at) {
      html += '<div class="bp-mod-offer-row-side">';
      if (it.code) html += '<span class="bp-mod-offer-code">' + esc(it.code) + '</span>';
      if (it.expires_at) html += '<p class="bp-mod-offer-exp">Expires ' + esc(it.expires_at) + '</p>';
      html += '</div>';
    }
    html += '</article>';
    return html;
  }

  function menuTagsHtml(tags) {
    var list = String(tags || '')
      .split(',')
      .map(function (t) {
        return t.trim();
      })
      .filter(Boolean);
    if (!list.length) return '';
    return list
      .map(function (t) {
        return '<span class="bp-mod-menu-tags">' + esc(t) + '</span>';
      })
      .join(' ');
  }

  function menuRowHtml(it) {
    var html = '<div class="bp-mod-menu-row">';
    html += '<span class="bp-mod-menu-name">' + esc(it.name) + '</span>';
    var tags = menuTagsHtml(it.tags);
    if (tags) html += ' ' + tags;
    if (it.price_text) {
      html += '<span class="bp-mod-menu-dots" aria-hidden="true"></span>';
      html += '<span class="bp-mod-menu-price">' + esc(it.price_text) + '</span>';
    }
    html += '</div>';
    if (it.description) html += '<p class="bp-mod-menu-desc">' + esc(it.description) + '</p>';
    return html;
  }

  function renderMenuHtml(items, categories) {
    var html = '<div class="bp-mod-menu">';
    var cats = Array.isArray(categories) ? categories : [];
    var byCat = {};
    var uncategorized = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.category_id != null && cats.some(function (c) { return Number(c.id) === Number(it.category_id); })) {
        var k = String(it.category_id);
        if (!byCat[k]) byCat[k] = [];
        byCat[k].push(it);
      } else if (it.category_name) {
        var found = null;
        for (var j = 0; j < cats.length; j++) {
          if (cats[j].name === it.category_name) found = cats[j];
        }
        if (found) {
          var k2 = String(found.id);
          if (!byCat[k2]) byCat[k2] = [];
          byCat[k2].push(it);
        } else uncategorized.push(it);
      } else uncategorized.push(it);
    }
    for (var c = 0; c < cats.length; c++) {
      var group = byCat[String(cats[c].id)];
      if (!group || !group.length) continue;
      html += '<h3 class="bp-mod-menu-cat">' + esc(cats[c].name) + '</h3>';
      for (var r = 0; r < group.length; r++) html += menuRowHtml(group[r]);
    }
    for (var u = 0; u < uncategorized.length; u++) html += menuRowHtml(uncategorized[u]);
    html += '</div>';
    return html;
  }

  function careersApplyHtml(it) {
    var target = String(it.apply_target || '').trim();
    if (!target) return '';
    if (it.apply_mode === 'email') {
      return (
        '<a class="bp-mod-btn bp-mod-job-apply" href="mailto:' +
        esc(target) +
        '?subject=' +
        encodeURIComponent('Application: ' + (it.title || 'Job posting')) +
        '">Apply now</a>'
      );
    }
    if (it.apply_mode === 'url') {
      return '<a class="bp-mod-btn bp-mod-job-apply" href="' + esc(target) + '" target="_blank" rel="noopener">Apply now</a>';
    }
    if (it.apply_mode === 'form') {
      return '<a class="bp-mod-btn bp-mod-job-apply" href="' + esc(target) + '">Apply now</a>';
    }
    return '';
  }

  function careersJobHtml(it) {
    var key = it.slug || it.id;
    var meta = [it.employment_type, it.location].filter(Boolean).join(' · ');
    var html = '<article class="bp-mod-job">';
    html += '<h2><a href="' + esc(itemHref(key)) + '">' + esc(it.title) + '</a></h2>';
    if (meta) html += '<p class="bp-mod-job-meta">' + esc(meta) + '</p>';
    if (it.description) {
      html +=
        '<details><summary>View details</summary><div class="bp-mod-job-desc">' + esc(it.description) + '</div></details>';
    }
    html += careersApplyHtml(it);
    html += '</article>';
    return html;
  }

  function videoCardHtml(it) {
    var key = it.slug || it.id;
    var embed = String(it.embed_url || '');
    var thumb = String(it.thumbnail_url || '');
    var html = '<div class="bp-mod-video">';
    html +=
      '<button type="button" class="bp-mod-video-facade" data-bp-video-embed="' +
      esc(embed) +
      '" aria-label="Play video: ' +
      esc(it.title) +
      '">';
    if (thumb) html += '<img src="' + esc(thumb) + '" alt="" loading="lazy">';
    html += '<span class="bp-mod-video-play" aria-hidden="true">▶</span>';
    html += '</button>';
    html += '<h2><a href="' + esc(itemHref(key)) + '">' + esc(it.title) + '</a></h2>';
    if (it.description) html += '<p>' + esc(it.description) + '</p>';
    html += '</div>';
    return html;
  }

  function socialCardHtml(it) {
    var network = it.network === 'instagram' ? 'Instagram' : 'Facebook';
    var html = '<article class="bp-mod-social-card">';
    if (it.image_url) html += '<img src="' + esc(it.image_url) + '" alt="" loading="lazy">';
    html += '<div class="bp-mod-social-body">';
    html +=
      '<p class="bp-mod-social-meta"><span class="bp-mod-social-badge">' +
      esc(network) +
      '</span>' +
      (it.published_at ? '<span>' + esc(dateLabel(it.published_at)) + '</span>' : '') +
      '</p>';
    if (it.text) html += '<p class="bp-mod-social-text">' + esc(it.text) + '</p>';
    if (it.permalink) {
      html +=
        '<a class="bp-mod-social-link" href="' +
        esc(it.permalink) +
        '" target="_blank" rel="noopener">View post</a>';
    }
    html += '</div></article>';
    return html;
  }

  function wireVideoFacades(root) {
    var btns = root.querySelectorAll('[data-bp-video-embed]');
    for (var i = 0; i < btns.length; i++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          var src = btn.getAttribute('data-bp-video-embed');
          if (!src) return;
          var url = src + (src.indexOf('?') >= 0 ? '&' : '?') + 'autoplay=1';
          btn.innerHTML =
            '<iframe src="' +
            esc(url) +
            '" title="Video player" allow="accelerometer; autoplay; encrypted-media; picture-in-picture" allowfullscreen loading="lazy"></iframe>';
        });
      })(btns[i]);
    }
  }

  function renderList(el, data) {
    var type = data.module_type;
    var items = Array.isArray(data.items) ? data.items : [];
    var html = '';
    if (shouldShowTitle(el)) {
      html += '<h2 class="bp-mod-title">' + esc(data.title || type) + '</h2>';
    }
    if (type === 'bookings') {
      renderBookings(el, data, html);
      return;
    }
    if (type === 'members') {
      renderMembers(el, data, html);
      return;
    }
    if (type === 'estimate') {
      renderEstimate(el, data, html);
      return;
    }
    if (type === 'calltracking') {
      // The tracking number IS the call-to-action. Unconfigured (no
      // display number yet) renders nothing at all.
      var ct = data.calltracking || {};
      if (!ct.configured || !ct.display_number) {
        el.innerHTML = '';
        return;
      }
      el.innerHTML =
        html +
        '<div class="bp-mod-calltracking"><a class="bp-mod-call" href="tel:' +
        esc(ct.display_number) +
        '"><span class="bp-mod-call-label">' +
        esc(ct.cta_text || 'Call us') +
        '</span><span class="bp-mod-call-number">' +
        esc(ct.display_number_formatted || ct.display_number) +
        '</span></a></div>';
      return;
    }
    if (type === 'careers' && !items.length) {
      // Careers renders nothing at all when there are no active postings.
      el.innerHTML = '';
      return;
    }
    if (type === 'socialfeed' && !items.length) {
      // An empty Social Feed renders nothing at all — no placeholder cards.
      el.innerHTML = '';
      return;
    }
    if (!items.length) {
      el.innerHTML = html + renderEmpty(type);
      return;
    }
    if (type === 'gallery' && items.length === 1 && items[0].images) {
      el.innerHTML = html + renderAlbumDetail(items[0], false);
      return;
    }
    if (type === 'faq') {
      html += '<div class="bp-mod-faq">';
      for (var fi = 0; fi < items.length; fi++) {
        var fq = items[fi];
        html +=
          '<details><summary>' +
          esc(fq.question) +
          '</summary>' +
          '<div class="bp-mod-content">' +
          (fq.answer_html || '') +
          '</div></details>';
      }
      html += '</div>';
      el.innerHTML = html;
      return;
    }
    if (type === 'offers') {
      var offersLayout = embedSettings(data).layout;
      if (offersLayout === 'horizontal') {
        html += '<div class="bp-mod-offers is-horizontal">';
        for (var hi = 0; hi < items.length; hi++) {
          html += offerRowHtml(items[hi]);
        }
      } else {
        html += '<div class="bp-mod-offers">';
        for (var oi = 0; oi < items.length; oi++) {
          html += offerCardHtml(items[oi]);
        }
      }
      html += '</div>';
      el.innerHTML = html;
      return;
    }
    if (type === 'menu') {
      html += renderMenuHtml(items, data.categories);
      el.innerHTML = html;
      return;
    }
    if (type === 'careers') {
      html += '<div class="bp-mod-careers">';
      for (var ci = 0; ci < items.length; ci++) {
        html += careersJobHtml(items[ci]);
      }
      html += '</div>';
      el.innerHTML = html;
      return;
    }
    if (type === 'video') {
      html += '<div class="bp-mod-videos">';
      for (var vi = 0; vi < items.length; vi++) {
        html += videoCardHtml(items[vi]);
      }
      html += '</div>';
      el.innerHTML = html;
      wireVideoFacades(el);
      return;
    }
    if (type === 'socialfeed') {
      var sfLayout = (data.socialfeed && data.socialfeed.layout) || 'grid';
      html += '<div class="bp-mod-socialfeed' + (sfLayout === 'list' ? ' is-list' : '') + '">';
      for (var si = 0; si < items.length; si++) {
        html += socialCardHtml(items[si]);
      }
      html += '</div>';
      el.innerHTML = html;
      return;
    }
    html += '<div class="bp-mod-grid">';
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var key = it.slug || it.id;
      if (type === 'blog') {
        var blogSet = embedSettings(data);
        html +=
          '<article class="bp-mod-card">' +
          coverHtml(itemHref(key), it.cover_image, it.title) +
          '<div class="bp-mod-body"><h2><a href="' +
          esc(itemHref(key)) +
          '">' +
          esc(it.title) +
          '</a></h2>' +
          '<p class="bp-mod-meta">' +
          esc(dateLabel(it.published_at || it.created_at)) +
          '</p>' +
          (blogSet.show_excerpt && it.excerpt ? '<p class="bp-mod-excerpt">' + esc(it.excerpt) + '</p>' : '') +
          '</div></article>';
      } else if (type === 'ecommerce') {
        var buy = it.checkout_url
          ? '<a class="bp-mod-btn" href="' + esc(it.checkout_url) + '" target="_blank" rel="noopener">Buy</a>'
          : it.stripe_checkout
            ? '<button type="button" class="bp-mod-btn" data-bp-buy="' + esc(it.id) + '">Buy</button>'
            : '<a class="bp-mod-btn ghost" href="' + esc(itemHref(key)) + '">View</a>';
        html +=
          '<article class="bp-mod-card">' +
          coverHtml(itemHref(key), it.image_url, it.name) +
          '<div class="bp-mod-body"><h2><a href="' +
          esc(itemHref(key)) +
          '">' +
          esc(it.name) +
          '</a></h2>' +
          (it.price_label ? '<p class="bp-mod-price">' + esc(it.price_label) + '</p>' : '') +
          '<p class="bp-mod-desc">' +
          esc((it.description || '').slice(0, 140)) +
          '</p>' +
          buy +
          '</div></article>';
      } else if (type === 'courses') {
        var n = (it.lessons || []).length;
        html +=
          '<article class="bp-mod-card">' +
          coverHtml(itemHref(key), it.cover_image, it.title) +
          '<div class="bp-mod-body"><h2><a href="' +
          esc(itemHref(key)) +
          '">' +
          esc(it.title) +
          '</a></h2>' +
          '<p class="bp-mod-meta">' +
          n +
          ' lesson' +
          (n === 1 ? '' : 's') +
          '</p>' +
          '<p class="bp-mod-desc">' +
          esc((it.description || '').slice(0, 140)) +
          '</p>' +
          '<a class="bp-mod-btn ghost" href="' +
          esc(itemHref(key)) +
          '">View course</a></div></article>';
      } else if (type === 'gallery') {
        var cover = (it.images && it.images[0] && it.images[0].image_url) || '';
        var count = (it.images || []).length;
        html +=
          '<article class="bp-mod-card">' +
          coverHtml(itemHref(key), cover, it.title) +
          '<div class="bp-mod-body"><h2><a href="' +
          esc(itemHref(key)) +
          '">' +
          esc(it.title) +
          '</a></h2>' +
          '<p class="bp-mod-meta">' +
          count +
          ' photo' +
          (count === 1 ? '' : 's') +
          '</p></div></article>';
      } else if (type === 'directory') {
        html +=
          '<article class="bp-mod-card">' +
          (it.image_url
            ? '<div class="bp-mod-cover" style="background-image:url(\'' + esc(it.image_url) + '\')"></div>'
            : '<div class="bp-mod-cover bp-mod-cover-fallback" aria-hidden="true">' +
              esc(
                String(it.name || '?')
                  .charAt(0)
                  .toUpperCase()
              ) +
              '</div>') +
          '<div class="bp-mod-body"><h2>' +
          esc(it.name) +
          '</h2>' +
          (it.category ? '<p class="bp-mod-meta">' + esc(it.category) + '</p>' : '') +
          '<p class="bp-mod-desc">' +
          esc((it.description || '').slice(0, 160)) +
          '</p>' +
          (it.website_url
            ? '<a class="bp-mod-btn ghost" href="' + esc(it.website_url) + '" target="_blank" rel="noopener">Visit</a>'
            : '') +
          (it.contact_email ? '<p class="bp-mod-meta">' + esc(it.contact_email) + '</p>' : '') +
          (it.contact_phone ? '<p class="bp-mod-meta">' + esc(it.contact_phone) + '</p>' : '') +
          '</div></article>';
      } else if (type === 'testimonials') {
        html +=
          '<article class="bp-mod-card"><div class="bp-mod-body">' +
          starsHtml(it.rating) +
          '<p class="bp-mod-quote">“' +
          esc(it.quote) +
          '”</p>' +
          '<p class="bp-mod-meta"><strong>' +
          esc(it.author_name || 'Client') +
          '</strong>' +
          (it.author_title || it.author_company
            ? ' · ' + esc([it.author_title, it.author_company].filter(Boolean).join(', '))
            : '') +
          '</p></div></article>';
      } else if (type === 'team') {
        html +=
          '<article class="bp-mod-card">' +
          coverHtml(itemHref(key), it.image_url, it.name) +
          '<div class="bp-mod-body"><h2><a href="' +
          esc(itemHref(key)) +
          '">' +
          esc(it.name) +
          '</a></h2>' +
          (it.role_title ? '<p class="bp-mod-meta">' + esc(it.role_title) + '</p>' : '') +
          '<p class="bp-mod-desc">' +
          esc((it.bio || '').slice(0, 140)) +
          '</p></div></article>';
      } else if (type === 'events') {
        html +=
          '<article class="bp-mod-card">' +
          coverHtml(itemHref(key), it.image_url, it.title) +
          '<div class="bp-mod-body"><h2><a href="' +
          esc(itemHref(key)) +
          '">' +
          esc(it.title) +
          '</a></h2>' +
          '<p class="bp-mod-meta">' +
          esc(dateLabel(it.starts_at) || it.starts_at || '') +
          '</p>' +
          (it.location ? '<p class="bp-mod-meta">' + esc(it.location) + '</p>' : '') +
          '<p class="bp-mod-desc">' +
          esc((it.description || '').slice(0, 140)) +
          '</p></div></article>';
      }
    }
    html += '</div>';
    if (type === 'blog') {
      var allHref = viewAllPostsHref(data);
      if (allHref) {
        html += '<p class="bp-mod-view-all"><a href="' + esc(allHref) + '">View all posts</a></p>';
      }
    }
    el.innerHTML = html;
  }

  function renderBookings(el, data, prefixHtml) {
    var services = Array.isArray(data.items) ? data.items : [];
    if (!services.length) {
      el.innerHTML = (prefixHtml || '') + renderEmpty('bookings');
      return;
    }
    var settings = (data.booking && data.booking.settings) || {};
    var maxDays = Number(settings.max_days_ahead) || 60;
    var maxDate = new Date();
    maxDate.setDate(maxDate.getDate() + maxDays);
    var maxYmd =
      maxDate.getFullYear() +
      '-' +
      String(maxDate.getMonth() + 1).padStart(2, '0') +
      '-' +
      String(maxDate.getDate()).padStart(2, '0');
    var html = prefixHtml || '';
    html +=
      '<form class="bp-mod-book" data-bp-book="1">' +
      '<div class="bp-mod-book-row"><label for="bp-svc">Service</label><select id="bp-svc" name="service_id" required>';
    for (var i = 0; i < services.length; i++) {
      var s = services[i];
      html +=
        '<option value="' +
        esc(s.id) +
        '">' +
        esc(s.name) +
        (s.duration_label ? ' · ' + esc(s.duration_label) : '') +
        (s.price_label ? ' · ' + esc(s.price_label) : '') +
        '</option>';
    }
    html +=
      '</select></div>' +
      '<div class="bp-mod-book-row"><label for="bp-date">Date</label>' +
      '<input id="bp-date" name="date" type="date" required min="' +
      esc(todayYmd()) +
      '" max="' +
      esc(maxYmd) +
      '" value="' +
      esc(todayYmd()) +
      '" /></div>' +
      '<div class="bp-mod-book-row"><span>Available times</span><div class="bp-mod-slots" data-bp-slots></div>' +
      '<p class="bp-mod-book-msg" data-bp-slot-msg>Pick a date to see open times.</p></div>' +
      '<input type="hidden" name="starts_at" value="" />' +
      '<div class="bp-mod-book-row"><label for="bp-name">Name</label><input id="bp-name" name="customer_name" required autocomplete="name" /></div>' +
      '<div class="bp-mod-book-row"><label for="bp-email">Email</label><input id="bp-email" name="customer_email" type="email" autocomplete="email" /></div>' +
      '<div class="bp-mod-book-row"><label for="bp-phone">Phone</label><input id="bp-phone" name="customer_phone" type="tel" autocomplete="tel" /></div>' +
      '<div class="bp-mod-book-row"><label for="bp-notes">Notes</label><textarea id="bp-notes" name="notes" rows="3"></textarea></div>' +
      '<div class="bp-mod-captcha" data-bp-captcha hidden></div>' +
      '<button type="submit" class="bp-mod-btn">Request appointment</button>' +
      '<p class="bp-mod-book-msg" data-bp-book-msg></p>' +
      '</form>';
    el.innerHTML = html;
    bindBookingForm(el, data);
  }

  function bindBookingForm(el, data) {
    var form = el.querySelector('[data-bp-book]');
    if (!form) return;
    var token = el.getAttribute(TOKEN_ATTR) || '';
    var base = apiBase(el);
    var slotsBox = form.querySelector('[data-bp-slots]');
    var slotMsg = form.querySelector('[data-bp-slot-msg]');
    var bookMsg = form.querySelector('[data-bp-book-msg]');
    var startsInput = form.querySelector('[name="starts_at"]');
    var captchaBox = form.querySelector('[data-bp-captcha]');
    var submitBtn = form.querySelector('button[type="submit"]');
    var captcha = {
      enabled: false,
      getToken: async function () {
        return '';
      },
      reset: function () {},
    };
    var selectedSlot = '';

    (async function () {
      try {
        if (base) await loadScript(base + '/js/captcha.js?v=mod5');
        if (window.ScoutCaptcha && captchaBox) {
          captcha = await window.ScoutCaptcha.mount(captchaBox, { apiBase: base });
        }
      } catch (e) {
        /* captcha optional when disabled server-side */
      }
    })();

    function setSlotMsg(text, kind) {
      if (!slotMsg) return;
      slotMsg.textContent = text || '';
      slotMsg.className = 'bp-mod-book-msg' + (kind ? ' ' + kind : '');
    }

    function addDaysYmd(ymd, days) {
      var p = String(ymd || '').split('-');
      if (p.length !== 3) return ymd;
      var dt = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
      dt.setDate(dt.getDate() + days);
      return (
        dt.getFullYear() +
        '-' +
        String(dt.getMonth() + 1).padStart(2, '0') +
        '-' +
        String(dt.getDate()).padStart(2, '0')
      );
    }

    function fetchSlotsForDate(date, serviceId) {
      var path =
        (base || '') +
        '/api/v1/modules/public/' +
        encodeURIComponent(token) +
        '/slots?date=' +
        encodeURIComponent(date) +
        '&serviceId=' +
        encodeURIComponent(serviceId) +
        '&' +
        pageQuery();
      return fetch(path, { credentials: 'omit', headers: authHeaders() }).then(function (r) {
        return r.json();
      });
    }

    function findNextOpenDay(startDate, serviceId, maxDate) {
      var d = startDate;
      var guard = 0;
      function step() {
        if (d > maxDate || guard >= 90) return Promise.resolve(null);
        guard += 1;
        var probe = d;
        return fetchSlotsForDate(probe, serviceId).then(function (j) {
          if (j && j.ok) {
            var slots = (j.data && j.data.slots) || [];
            if (slots.length) return { date: probe, slots: slots };
          }
          d = addDaysYmd(probe, 1);
          return step();
        });
      }
      return step();
    }

    function loadSlots() {
      var date = form.date.value;
      var serviceId = form.service_id.value;
      selectedSlot = '';
      if (startsInput) startsInput.value = '';
      if (!date || !serviceId) return;
      setSlotMsg('Loading times…');
      if (slotsBox) slotsBox.innerHTML = '';
      fetchSlotsForDate(date, serviceId)
        .then(function (j) {
          if (!j || !j.ok) throw new Error((j && j.error) || 'Could not load times');
          var slots = (j.data && j.data.slots) || [];
          if (slots.length) {
            setSlotMsg('Select a time.');
            if (!slotsBox) return;
            slotsBox.innerHTML = slots
              .map(function (slot) {
                return (
                  '<button type="button" class="bp-mod-slot" data-starts="' +
                  esc(slot.starts_at) +
                  '">' +
                  esc(slot.label) +
                  '</button>'
                );
              })
              .join('');
            return;
          }
          var maxDate = form.date.max || '';
          return findNextOpenDay(addDaysYmd(date, 1), serviceId, maxDate).then(function (next) {
            if (!next) {
              setSlotMsg(j.data && j.data.closed ? 'Closed this day.' : 'No open times on this day.');
              return;
            }
            var nice = next.date;
            try {
              var nd = new Date(next.date + 'T12:00:00');
              nice = nd.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
            } catch (e) {
              /* keep ymd */
            }
            setSlotMsg('Next opening: ' + nice + '. Jumping to that date…', 'ok');
            form.date.value = next.date;
            loadSlots();
          });
        })
        .catch(function (e) {
          setSlotMsg(e.message || 'Could not load times', 'err');
        });
    }

    form.addEventListener('change', function (ev) {
      if (ev.target && (ev.target.name === 'date' || ev.target.name === 'service_id')) loadSlots();
    });
    form.addEventListener('click', function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest('[data-starts]') : null;
      if (!btn || !form.contains(btn)) return;
      selectedSlot = btn.getAttribute('data-starts') || '';
      if (startsInput) startsInput.value = selectedSlot;
      var all = form.querySelectorAll('.bp-mod-slot');
      for (var i = 0; i < all.length; i++) all[i].classList.toggle('is-selected', all[i] === btn);
      setSlotMsg('Selected ' + (btn.textContent || '') + '.');
    });
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (bookMsg) {
        bookMsg.textContent = '';
        bookMsg.className = 'bp-mod-book-msg';
      }
      if (!selectedSlot) {
        if (bookMsg) {
          bookMsg.textContent = 'Please choose an available time.';
          bookMsg.className = 'bp-mod-book-msg err';
        }
        return;
      }
      var email = String(form.customer_email.value || '').trim();
      var phone = String(form.customer_phone.value || '').trim();
      if (!email && !phone) {
        if (bookMsg) {
          bookMsg.textContent = 'Email or phone is required.';
          bookMsg.className = 'bp-mod-book-msg err';
        }
        return;
      }
      if (submitBtn) submitBtn.disabled = true;
      if (bookMsg) bookMsg.textContent = 'Submitting…';
      (async function () {
        try {
          var captchaToken = await captcha.getToken();
          var body = {
            service_id: Number(form.service_id.value),
            starts_at: selectedSlot,
            customer_name: form.customer_name.value,
            customer_email: email,
            customer_phone: phone,
            notes: form.notes.value,
            captchaToken: captchaToken,
          };
          var r = await fetch((base || '') + '/api/v1/modules/public/' + encodeURIComponent(token) + '/book', {
            method: 'POST',
            credentials: 'omit',
            headers: jsonHeaders(),
            body: JSON.stringify(body),
          });
          var j = await r.json();
          if (!r.ok || !j || !j.ok) throw new Error((j && j.error) || 'Booking failed');
          var msg = (j.data && j.data.message) || 'Appointment requested.';
          el.innerHTML =
            (shouldShowTitle(el) ? '<h2 class="bp-mod-title">' + esc(data.title || 'Bookings') + '</h2>' : '') +
            '<div class="bp-mod-empty-card"><p class="bp-mod-empty-kicker">Booked</p>' +
            '<p class="bp-mod-empty-title">' +
            esc(msg) +
            '</p>' +
            '<p class="bp-mod-empty-text">' +
            esc((j.data.appointment && j.data.appointment.starts_at) || '') +
            '</p></div>';
        } catch (e) {
          if (bookMsg) {
            bookMsg.textContent = e.message || 'Booking failed';
            bookMsg.className = 'bp-mod-book-msg err';
          }
          if (captcha.reset) captcha.reset();
        } finally {
          if (submitBtn) submitBtn.disabled = false;
        }
      })();
    });
    loadSlots();
  }

  function fmtMoney(cents) {
    var n = (Number(cents) || 0) / 100;
    return (
      '$' +
      n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    );
  }

  function renderEstimate(el, data, prefixHtml) {
    var est = data.estimate || {};
    var cfg = est.config || {};
    var options = Array.isArray(est.options) ? est.options : [];
    var mode = cfg.display_mode || 'exact';
    var hiddenMode = mode === 'hidden';
    var html = prefixHtml || '';
    if (cfg.title) html += '<p class="bp-est-service">' + esc(cfg.title) + '</p>';
    if (cfg.intro) html += '<p class="bp-mod-lede">' + esc(cfg.intro) + '</p>';
    html += '<form class="bp-mod-book bp-mod-est" data-bp-est="1">';
    if (cfg.service_label) {
      html +=
        '<p class="bp-est-service">' +
        esc(cfg.service_label) +
        (hiddenMode ? '' : ' · base ' + esc(cfg.base_price_label || fmtMoney(cfg.base_price_cents))) +
        '</p>';
    }
    if (options.length) {
      html += '<div class="bp-est-options">';
      for (var i = 0; i < options.length; i++) {
        var o = options[i];
        var priceTag = hiddenMode
          ? ''
          : '<span class="bp-est-opt-price">+' + esc(o.price_label || fmtMoney(o.price_cents)) + '</span>';
        if (o.input_type === 'quantity') {
          html +=
            '<div class="bp-est-opt-row"><label for="bp-est-q-' +
            esc(o.id) +
            '"><span>' +
            esc(o.label) +
            '</span>' +
            priceTag +
            '</label>' +
            '<input id="bp-est-q-' +
            esc(o.id) +
            '" class="bp-est-qty" type="number" min="0" max="99" step="1" value="0" data-est-qty="' +
            esc(o.id) +
            '" data-est-price="' +
            esc(hiddenMode ? 0 : o.price_cents || 0) +
            '" /></div>';
        } else if (o.input_type === 'select') {
          var choices = Array.isArray(o.choices) ? o.choices : [];
          html +=
            '<div class="bp-est-opt-row"><label for="bp-est-s-' +
            esc(o.id) +
            '">' +
            esc(o.label) +
            '</label><select id="bp-est-s-' +
            esc(o.id) +
            '" data-est-select="' +
            esc(o.id) +
            '">';
          for (var ci = 0; ci < choices.length; ci++) {
            var ch = choices[ci];
            html +=
              '<option value="' +
              ci +
              '" data-est-price="' +
              esc(hiddenMode ? 0 : ch.price_cents || 0) +
              '">' +
              esc(ch.label) +
              (hiddenMode ? '' : ' · +' + esc(ch.price_label || fmtMoney(ch.price_cents))) +
              '</option>';
          }
          html += '</select></div>';
        } else {
          html +=
            '<label class="bp-est-opt"><input type="checkbox" data-est-check="' +
            esc(o.id) +
            '" data-est-price="' +
            esc(hiddenMode ? 0 : o.price_cents || 0) +
            '" /> <span>' +
            esc(o.label) +
            '</span>' +
            priceTag +
            '</label>';
        }
      }
      html += '</div>';
    }
    if (hiddenMode) {
      html +=
        '<div class="bp-est-total"><span class="bp-est-total-label">Pick your options, leave your details below, and we will send your estimate.</span></div>';
    } else {
      html +=
        '<div class="bp-est-total"><span class="bp-est-total-label">' +
        (mode === 'range' ? 'Estimated range' : 'Estimated total') +
        '</span><span class="bp-est-total-value" data-est-total-value></span></div>';
    }
    if (cfg.disclaimer) html += '<p class="bp-est-disclaimer">' + esc(cfg.disclaimer) + '</p>';
    html +=
      '<div class="bp-mod-book-row"><label>Your name</label><input name="name" required autocomplete="name" /></div>' +
      '<div class="bp-mod-book-row"><label>Email</label><input name="email" type="email" autocomplete="email" /></div>' +
      '<div class="bp-mod-book-row"><label>Phone</label><input name="phone" type="tel" autocomplete="tel" /></div>' +
      '<div class="bp-mod-book-row"><label>Anything we should know? (optional)</label><textarea name="notes" rows="3"></textarea></div>' +
      '<div class="bp-mod-captcha" data-bp-captcha hidden></div>' +
      '<button type="submit" class="bp-mod-btn">' +
      esc(cfg.submit_label || 'Send my estimate') +
      '</button>' +
      '<p class="bp-mod-book-msg" data-est-msg></p>' +
      '</form>';
    el.innerHTML = html;
    bindEstimateForm(el, data);
  }

  function bindEstimateForm(el, data) {
    var form = el.querySelector('[data-bp-est]');
    if (!form) return;
    var est = data.estimate || {};
    var cfg = est.config || {};
    var mode = cfg.display_mode || 'exact';
    var hiddenMode = mode === 'hidden';
    var token = el.getAttribute(TOKEN_ATTR) || '';
    var base = apiBase(el);
    var msg = form.querySelector('[data-est-msg]');
    var totalValue = form.querySelector('[data-est-total-value]');
    var submitBtn = form.querySelector('button[type="submit"]');
    var captchaBox = form.querySelector('[data-bp-captcha]');
    var captcha = {
      enabled: false,
      getToken: async function () {
        return '';
      },
      reset: function () {},
    };

    (async function () {
      try {
        if (base) await loadScript(base + '/js/captcha.js?v=mod5');
        if (window.ScoutCaptcha && captchaBox) {
          captcha = await window.ScoutCaptcha.mount(captchaBox, { apiBase: base });
        }
      } catch (e) {
        /* captcha optional when disabled server-side */
      }
    })();

    function computeTotal() {
      var total = Number(cfg.base_price_cents) || 0;
      var checks = form.querySelectorAll('[data-est-check]');
      for (var i = 0; i < checks.length; i++) {
        if (checks[i].checked) total += Number(checks[i].getAttribute('data-est-price')) || 0;
      }
      var qtys = form.querySelectorAll('[data-est-qty]');
      for (var q = 0; q < qtys.length; q++) {
        var qty = Math.floor(Number(qtys[q].value) || 0);
        if (qty < 0) qty = 0;
        if (qty > 99) qty = 99;
        total += qty * (Number(qtys[q].getAttribute('data-est-price')) || 0);
      }
      var sels = form.querySelectorAll('[data-est-select]');
      for (var s = 0; s < sels.length; s++) {
        var opt = sels[s].options[sels[s].selectedIndex];
        if (opt) total += Number(opt.getAttribute('data-est-price')) || 0;
      }
      return total;
    }

    function refreshTotal() {
      if (hiddenMode || !totalValue) return;
      var total = computeTotal();
      if (mode === 'range') {
        var p = Math.min(100, Math.max(0, Number(cfg.range_percent) || 0));
        var low = Math.floor((total * (100 - p)) / 100);
        var high = Math.ceil((total * (100 + p)) / 100);
        totalValue.textContent = fmtMoney(low) + ' – ' + fmtMoney(high);
      } else {
        totalValue.textContent = fmtMoney(total);
      }
    }

    function collectSelections() {
      var out = [];
      var checks = form.querySelectorAll('[data-est-check]');
      for (var i = 0; i < checks.length; i++) {
        if (checks[i].checked) {
          out.push({ option_id: Number(checks[i].getAttribute('data-est-check')), checked: true });
        }
      }
      var qtys = form.querySelectorAll('[data-est-qty]');
      for (var q = 0; q < qtys.length; q++) {
        var qty = Math.floor(Number(qtys[q].value) || 0);
        if (qty > 0) {
          out.push({ option_id: Number(qtys[q].getAttribute('data-est-qty')), quantity: Math.min(99, qty) });
        }
      }
      var sels = form.querySelectorAll('[data-est-select]');
      for (var s = 0; s < sels.length; s++) {
        out.push({ option_id: Number(sels[s].getAttribute('data-est-select')), choice_index: sels[s].selectedIndex });
      }
      return out;
    }

    form.addEventListener('change', refreshTotal);
    form.addEventListener('input', refreshTotal);
    refreshTotal();

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (msg) {
        msg.textContent = '';
        msg.className = 'bp-mod-book-msg';
      }
      var name = String(form.querySelector('[name="name"]').value || '').trim();
      var email = String(form.querySelector('[name="email"]').value || '').trim();
      var phone = String(form.querySelector('[name="phone"]').value || '').trim();
      var notes = String(form.querySelector('[name="notes"]').value || '');
      if (!name) {
        if (msg) {
          msg.textContent = 'Please tell us your name.';
          msg.className = 'bp-mod-book-msg err';
        }
        return;
      }
      if (!email && !phone) {
        if (msg) {
          msg.textContent = 'Email or phone is required so we can send your estimate.';
          msg.className = 'bp-mod-book-msg err';
        }
        return;
      }
      if (submitBtn) submitBtn.disabled = true;
      if (msg) msg.textContent = 'Sending…';
      (async function () {
        try {
          var captchaToken = await captcha.getToken();
          var body = {
            name: name,
            email: email,
            phone: phone,
            notes: notes,
            selections: collectSelections(),
            captchaToken: captchaToken,
          };
          var r = await fetch((base || '') + '/api/v1/modules/public/' + encodeURIComponent(token) + '/estimate', {
            method: 'POST',
            credentials: 'omit',
            headers: jsonHeaders(),
            body: JSON.stringify(body),
          });
          var j = await r.json();
          if (!r.ok || !j || !j.ok) throw new Error((j && j.error) || 'Could not send your request');
          var req = (j.data && j.data.request) || {};
          var detail = '';
          if (req.range_low_label && req.range_high_label) {
            detail = 'Estimated range: ' + req.range_low_label + ' – ' + req.range_high_label + '. ';
          } else if (req.estimate_label) {
            detail = 'Your estimate: ' + req.estimate_label + '. ';
          }
          el.innerHTML =
            (shouldShowTitle(el) ? '<h2 class="bp-mod-title">' + esc(data.title || 'Instant Estimate') + '</h2>' : '') +
            '<div class="bp-mod-empty-card"><p class="bp-mod-empty-kicker">Request sent</p>' +
            '<p class="bp-mod-empty-title">' +
            esc((j.data && j.data.message) || 'Thanks — your request is in.') +
            '</p>' +
            '<p class="bp-mod-empty-text">' +
            esc(detail + 'Final price is confirmed after the business reviews your project.') +
            '</p></div>';
        } catch (e) {
          if (msg) {
            msg.textContent = (e.message || 'Could not send your request') + ' — please try again.';
            msg.className = 'bp-mod-book-msg err';
          }
          if (captcha.reset) captcha.reset();
        } finally {
          if (submitBtn) submitBtn.disabled = false;
        }
      })();
    });
  }

  function renderItem(el, data) {
    var type = data.module_type;
    var it = data.item;
    var html = '<a class="bp-mod-back" href="' + esc(listHref()) + '">← Back</a>';
    if (type === 'offers') {
      html +=
        '<article class="bp-mod-detail">' +
        (it.image_url ? '<img class="bp-mod-hero" src="' + esc(it.image_url) + '" alt="" />' : '') +
        '<h1>' +
        esc(it.title) +
        '</h1>' +
        (it.description ? '<div class="bp-mod-content"><p>' + esc(it.description) + '</p></div>' : '') +
        (it.code ? '<p style="margin-top:14px"><span class="bp-mod-offer-code">' + esc(it.code) + '</span></p>' : '') +
        (it.expires_at ? '<p class="bp-mod-meta" style="margin-top:10px">Expires ' + esc(it.expires_at) + '</p>' : '') +
        (it.terms ? '<p class="bp-mod-offer-terms" style="margin-top:8px">' + esc(it.terms) + '</p>' : '') +
        '</article>';
      el.innerHTML = html;
      return;
    }
    if (type === 'menu') {
      html +=
        '<article class="bp-mod-detail"><h1>' +
        esc(it.name) +
        '</h1>' +
        (it.category_name ? '<p class="bp-mod-meta">' + esc(it.category_name) + '</p>' : '') +
        '<div class="bp-mod-menu" style="margin-top:14px">' +
        menuRowHtml(it) +
        '</div></article>';
      el.innerHTML = html;
      return;
    }
    if (type === 'careers') {
      var cmeta = [it.employment_type, it.location].filter(Boolean).join(' · ');
      html +=
        '<article class="bp-mod-detail"><h1>' +
        esc(it.title) +
        '</h1>' +
        (cmeta ? '<p class="bp-mod-meta">' + esc(cmeta) + '</p>' : '') +
        (it.description ? '<div class="bp-mod-job-desc">' + esc(it.description) + '</div>' : '') +
        careersApplyHtml(it) +
        '</article>';
      el.innerHTML = html;
      return;
    }
    if (type === 'video') {
      html +=
        '<article class="bp-mod-detail"><h1>' +
        esc(it.title) +
        '</h1>' +
        '<div class="bp-mod-video" style="margin-top:14px">' +
        videoCardHtml(it) +
        '</div></article>';
      el.innerHTML = html;
      wireVideoFacades(el);
      return;
    }
    if (type === 'blog') {
      html +=
        '<article class="bp-mod-detail">' +
        (it.cover_image ? '<img class="bp-mod-hero" src="' + esc(it.cover_image) + '" alt="" />' : '') +
        '<h1>' +
        esc(it.title) +
        '</h1>' +
        '<p class="bp-mod-meta">' +
        esc(dateLabel(it.published_at || it.created_at)) +
        '</p>' +
        '<div class="bp-mod-content">' +
        (it.body_html || '') +
        '</div></article>';
    } else if (type === 'ecommerce') {
      html +=
        '<article class="bp-mod-detail">' +
        (it.image_url ? '<img class="bp-mod-hero" src="' + esc(it.image_url) + '" alt="" />' : '') +
        '<h1>' +
        esc(it.name) +
        '</h1>' +
        '<p class="bp-mod-price">' +
        esc(it.price_label || '') +
        '</p>' +
        '<div class="bp-mod-content"><p>' +
        esc(it.description || '') +
        '</p></div>' +
        (it.checkout_url
          ? '<p style="margin-top:16px"><a class="bp-mod-btn" href="' +
            esc(it.checkout_url) +
            '" target="_blank" rel="noopener">Buy now</a></p>'
          : it.stripe_checkout
            ? '<p style="margin-top:16px"><button type="button" class="bp-mod-btn" data-bp-buy="' +
              esc(it.id) +
              '">Buy now</button></p>'
            : '') +
        '</article>';
    } else if (type === 'courses') {
      html +=
        '<article class="bp-mod-detail">' +
        (it.cover_image ? '<img class="bp-mod-hero" src="' + esc(it.cover_image) + '" alt="" />' : '') +
        '<h1>' +
        esc(it.title) +
        '</h1>' +
        '<p class="bp-mod-desc">' +
        esc(it.description || '') +
        '</p>' +
        (it.enrollment_url
          ? '<p style="margin-top:12px"><a class="bp-mod-btn" href="' +
            esc(it.enrollment_url) +
            '" target="_blank" rel="noopener">Enroll</a></p>'
          : '') +
        '<ul class="bp-mod-lessons">';
      var lessons = it.lessons || [];
      for (var i = 0; i < lessons.length; i++) {
        var les = lessons[i];
        html +=
          '<li><strong>' +
          esc(les.title) +
          '</strong>' +
          (les.lesson_url ? ' · <a href="' + esc(les.lesson_url) + '" target="_blank" rel="noopener">Open</a>' : '') +
          (les.body_html ? '<div class="bp-mod-content" style="margin-top:8px">' + les.body_html + '</div>' : '') +
          '</li>';
      }
      html += '</ul></article>';
    } else if (type === 'gallery') {
      html += renderAlbumDetail(it, true);
    } else if (type === 'directory') {
      html +=
        '<article class="bp-mod-detail">' +
        (it.image_url ? '<img class="bp-mod-hero" src="' + esc(it.image_url) + '" alt="" />' : '') +
        '<h1>' +
        esc(it.name) +
        '</h1>' +
        (it.category ? '<p class="bp-mod-meta">' + esc(it.category) + '</p>' : '') +
        '<p class="bp-mod-desc">' +
        esc(it.description || '') +
        '</p>' +
        (it.website_url
          ? '<p><a class="bp-mod-btn" href="' + esc(it.website_url) + '" target="_blank" rel="noopener">Visit</a></p>'
          : '') +
        (it.contact_email ? '<p class="bp-mod-meta">' + esc(it.contact_email) + '</p>' : '') +
        (it.contact_phone ? '<p class="bp-mod-meta">' + esc(it.contact_phone) + '</p>' : '') +
        '</article>';
    } else if (type === 'team') {
      html +=
        '<article class="bp-mod-detail">' +
        (it.image_url ? '<img class="bp-mod-hero" src="' + esc(it.image_url) + '" alt="" />' : '') +
        '<h1>' +
        esc(it.name) +
        '</h1>' +
        (it.role_title ? '<p class="bp-mod-meta">' + esc(it.role_title) + '</p>' : '') +
        '<div class="bp-mod-content"><p>' +
        esc(it.bio || '') +
        '</p></div>' +
        (it.email ? '<p class="bp-mod-meta">' + esc(it.email) + '</p>' : '') +
        (it.phone ? '<p class="bp-mod-meta">' + esc(it.phone) + '</p>' : '') +
        (it.social_url
          ? '<p><a class="bp-mod-btn ghost" href="' +
            esc(it.social_url) +
            '" target="_blank" rel="noopener">Profile</a></p>'
          : '') +
        '</article>';
    } else if (type === 'events') {
      html +=
        '<article class="bp-mod-detail">' +
        (it.image_url ? '<img class="bp-mod-hero" src="' + esc(it.image_url) + '" alt="" />' : '') +
        '<h1>' +
        esc(it.title) +
        '</h1>' +
        '<p class="bp-mod-meta">' +
        esc(dateLabel(it.starts_at) || it.starts_at || '') +
        (it.ends_at ? ' – ' + esc(dateLabel(it.ends_at) || it.ends_at) : '') +
        '</p>' +
        (it.location ? '<p class="bp-mod-meta">' + esc(it.location) + '</p>' : '') +
        '<div class="bp-mod-content"><p>' +
        esc(it.description || '') +
        '</p></div>' +
        (it.ticket_url
          ? '<p style="margin-top:16px"><a class="bp-mod-btn" href="' +
            esc(it.ticket_url) +
            '" target="_blank" rel="noopener">Tickets / RSVP</a></p>'
          : '') +
        '</article>';
    } else if (type === 'testimonials') {
      html +=
        '<article class="bp-mod-detail">' +
        starsHtml(it.rating) +
        '<p class="bp-mod-quote">“' +
        esc(it.quote) +
        '”</p>' +
        '<p class="bp-mod-meta"><strong>' +
        esc(it.author_name || 'Client') +
        '</strong>' +
        (it.author_title || it.author_company
          ? ' · ' + esc([it.author_title, it.author_company].filter(Boolean).join(', '))
          : '') +
        '</p></article>';
    } else if (type === 'faq') {
      html +=
        '<article class="bp-mod-detail"><h1>' +
        esc(it.question) +
        '</h1>' +
        '<div class="bp-mod-content">' +
        (it.answer_html || '') +
        '</div></article>';
    } else if (type === 'bookings') {
      html +=
        '<article class="bp-mod-detail"><h1>' +
        esc(it.name) +
        '</h1>' +
        '<p class="bp-mod-meta">' +
        esc(it.duration_label || '') +
        (it.price_label ? ' · ' + esc(it.price_label) : '') +
        '</p>' +
        '<p class="bp-mod-desc">' +
        esc(it.description || '') +
        '</p>' +
        '<p><a class="bp-mod-btn" href="' +
        esc(listHref()) +
        '">Book this service</a></p></article>';
    }
    el.innerHTML = html;
  }

  function wireShop(el, base, token) {
    if (el.__bpShopWired) return;
    el.__bpShopWired = true;
    function msg(text, isErr) {
      var box = el.querySelector('.bp-mod-shop-msg');
      if (!box) {
        box = document.createElement('p');
        box.className = 'bp-mod-shop-msg';
        el.insertBefore(box, el.firstChild);
      }
      box.textContent = text;
      box.className = 'bp-mod-shop-msg bp-mod-book-msg' + (isErr ? ' err' : '');
    }
    el.addEventListener('click', function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest('[data-bp-buy]') : null;
      if (!btn || !el.contains(btn)) return;
      ev.preventDefault();
      var productId = btn.getAttribute('data-bp-buy');
      btn.disabled = true;
      var label = btn.textContent;
      btn.textContent = 'Redirecting…';
      var ret = new URL(window.location.href);
      ret.searchParams.delete('order');
      ret.searchParams.delete('session_id');
      fetch((base || '') + '/api/v1/modules/public/' + encodeURIComponent(token) + '/checkout', {
        method: 'POST',
        credentials: 'omit',
        headers: jsonHeaders(),
        body: JSON.stringify({ productId: Number(productId), returnUrl: ret.toString() }),
      })
        .then(function (r) {
          return r.json();
        })
        .then(function (j) {
          if (!j || !j.ok || !j.data || !j.data.url) throw new Error((j && j.error) || 'Checkout failed');
          window.location.href = j.data.url;
        })
        .catch(function (e) {
          btn.disabled = false;
          btn.textContent = label;
          msg(e.message || 'Checkout failed. Please try again.', true);
        });
    });
    // Post-checkout return notice.
    try {
      var q = new URLSearchParams(window.location.search);
      var order = q.get('order');
      var sid = q.get('session_id');
      if (order === 'cancelled') {
        msg('Checkout cancelled — your card was not charged.');
      } else if (order === 'success' && sid) {
        msg('Processing your payment…');
        fetch(
          (base || '') +
            '/api/v1/modules/public/' +
            encodeURIComponent(token) +
            '/order-status?session_id=' +
            encodeURIComponent(sid),
          { credentials: 'omit' }
        )
          .then(function (r) {
            return r.json();
          })
          .then(function (j) {
            if (j && j.ok && j.data && j.data.status === 'paid') {
              msg('Payment received — thank you for your order!');
            } else if (j && j.ok && j.data && (j.data.status === 'failed' || j.data.status === 'expired')) {
              msg('That payment did not complete. Please try again.', true);
            } else {
              msg('Payment is processing — you will get an email receipt from Stripe.');
            }
          })
          .catch(function () {
            msg('Payment is processing — you will get an email receipt from Stripe.');
          });
      }
    } catch (e) {
      /* ignore */
    }
  }

  /* ── Membership UI: login wall, members page, gated page bodies ── */

  function memberCaptcha(box, base) {
    var captcha = {
      enabled: false,
      getToken: async function () {
        return '';
      },
      reset: function () {},
    };
    return (async function () {
      try {
        if (base) await loadScript(base + '/js/captcha.js?v=mod5');
        if (window.ScoutCaptcha && box) {
          captcha = await window.ScoutCaptcha.mount(box, { apiBase: base });
        }
      } catch (e) {
        /* captcha optional when disabled server-side */
      }
      return captcha;
    })();
  }

  function memberLoginFormHtml() {
    return (
      '<form class="bp-mod-book" data-bp-member-login>' +
      '<div class="bp-mod-book-row"><label>Email</label><input name="email" type="email" required autocomplete="email" /></div>' +
      '<div class="bp-mod-book-row"><label>Password</label><input name="password" type="password" required autocomplete="current-password" /></div>' +
      '<div class="bp-mod-captcha" data-bp-captcha hidden></div>' +
      '<button type="submit" class="bp-mod-btn">Log in</button>' +
      '<p class="bp-mod-book-msg" data-bp-member-msg></p>' +
      '</form>'
    );
  }

  function memberPost(base, token, pathSuffix, body, headers) {
    return fetch((base || '') + '/api/v1/modules/public/' + encodeURIComponent(token) + pathSuffix, {
      method: 'POST',
      credentials: 'omit',
      headers: headers || jsonHeaders(),
      body: JSON.stringify(body || {}),
    }).then(function (r) {
      return r.json().then(function (j) {
        return { status: r.status, j: j };
      });
    });
  }

  function bindMemberLogin(root, membersToken, onSuccess) {
    var form = root.querySelector('[data-bp-member-login]');
    if (!form) return;
    var base = apiBase(root);
    var msg = form.querySelector('[data-bp-member-msg]');
    var submitBtn = form.querySelector('button[type="submit"]');
    var captchaPromise = memberCaptcha(form.querySelector('[data-bp-captcha]'), base);
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var email = String(form.querySelector('[name="email"]').value || '').trim();
      var password = String(form.querySelector('[name="password"]').value || '');
      if (!email || !password) {
        if (msg) {
          msg.textContent = 'Enter your email and password.';
          msg.className = 'bp-mod-book-msg err';
        }
        return;
      }
      if (submitBtn) submitBtn.disabled = true;
      if (msg) {
        msg.textContent = 'Logging in…';
        msg.className = 'bp-mod-book-msg';
      }
      (async function () {
        var captcha = await captchaPromise;
        try {
          var captchaToken = await captcha.getToken();
          var res = await memberPost(base, membersToken, '/members/login', {
            email: email,
            password: password,
            captchaToken: captchaToken,
          });
          if (!res.j || !res.j.ok) throw new Error((res.j && res.j.error) || 'Login failed');
          var session = res.j.data && res.j.data.session;
          if (session && session.token) saveMemberSession(membersToken, session.token);
          if (onSuccess) onSuccess();
        } catch (e) {
          if (msg) {
            msg.textContent = e.message || 'Login failed — please try again.';
            msg.className = 'bp-mod-book-msg err';
          }
          if (captcha.reset) captcha.reset();
        } finally {
          if (submitBtn) submitBtn.disabled = false;
        }
      })();
    });
  }

  function bindMemberSignup(root, membersToken, onDone) {
    var form = root.querySelector('[data-bp-member-signup]');
    if (!form) return;
    var base = apiBase(root);
    var msg = form.querySelector('[data-bp-member-msg]');
    var submitBtn = form.querySelector('button[type="submit"]');
    var captchaPromise = memberCaptcha(form.querySelector('[data-bp-captcha]'), base);
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var name = String(form.querySelector('[name="name"]').value || '').trim();
      var email = String(form.querySelector('[name="email"]').value || '').trim();
      var password = String(form.querySelector('[name="password"]').value || '');
      if (!name || !email || password.length < 8) {
        if (msg) {
          msg.textContent = 'Add your name, a valid email, and a password of at least 8 characters.';
          msg.className = 'bp-mod-book-msg err';
        }
        return;
      }
      if (submitBtn) submitBtn.disabled = true;
      if (msg) {
        msg.textContent = 'Creating your account…';
        msg.className = 'bp-mod-book-msg';
      }
      (async function () {
        var captcha = await captchaPromise;
        try {
          var captchaToken = await captcha.getToken();
          var res = await memberPost(base, membersToken, '/members/signup', {
            name: name,
            email: email,
            password: password,
            captchaToken: captchaToken,
          });
          if (!res.j || !res.j.ok) throw new Error((res.j && res.j.error) || 'Signup failed');
          var data = res.j.data || {};
          if (data.pending) {
            form.innerHTML =
              '<p class="bp-mod-gate-title">Thanks — you’re nearly there</p>' +
              '<p class="bp-mod-gate-text">Your account is waiting for approval. We will let you know when it is ready to use.</p>';
            return;
          }
          if (data.session && data.session.token) saveMemberSession(membersToken, data.session.token);
          if (onDone) onDone();
        } catch (e) {
          if (msg) {
            msg.textContent = e.message || 'Signup failed — please try again.';
            msg.className = 'bp-mod-book-msg err';
          }
          if (captcha.reset) captcha.reset();
        } finally {
          if (submitBtn) submitBtn.disabled = false;
        }
      })();
    });
  }

  function bindMemberForgot(root, membersToken) {
    var form = root.querySelector('[data-bp-member-forgot]');
    if (!form) return;
    var base = apiBase(root);
    var msg = form.querySelector('[data-bp-member-msg]');
    var submitBtn = form.querySelector('button[type="submit"]');
    var captchaPromise = memberCaptcha(form.querySelector('[data-bp-captcha]'), base);
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var email = String(form.querySelector('[name="email"]').value || '').trim();
      if (!email) return;
      if (submitBtn) submitBtn.disabled = true;
      if (msg) {
        msg.textContent = 'Sending…';
        msg.className = 'bp-mod-book-msg';
      }
      (async function () {
        var captcha = await captchaPromise;
        try {
          var captchaToken = await captcha.getToken();
          var res = await memberPost(base, membersToken, '/members/forgot', {
            email: email,
            captchaToken: captchaToken,
          });
          if (!res.j || !res.j.ok) throw new Error((res.j && res.j.error) || 'Request failed');
          if (msg) {
            msg.textContent =
              (res.j.data && res.j.data.message) || 'If an account exists for that email, a reset link is on its way.';
            msg.className = 'bp-mod-book-msg';
          }
        } catch (e) {
          if (msg) {
            msg.textContent = e.message || 'Request failed — please try again.';
            msg.className = 'bp-mod-book-msg err';
          }
          if (captcha.reset) captcha.reset();
        } finally {
          if (submitBtn) submitBtn.disabled = false;
        }
      })();
    });
  }

  /* Membership plans (tiers): join cards on the members page. */
  function tierCardsHtml(m) {
    var tiers = Array.isArray(m.tiers) ? m.tiers : [];
    if (!tiers.length) return '';
    var ent = m.entitlement || null;
    var loggedIn = !!m.member;
    var cards = tiers
      .map(function (t) {
        var isCurrent = ent && ent.tier_id != null && Number(ent.tier_id) === Number(t.id);
        var price = t.free
          ? '<div class="bp-mod-tier-price">Free</div>'
          : '<div class="bp-mod-tier-price">' + esc(t.price_label || '') + ' <span>/ ' + esc(t.interval) + '</span></div>';
        var action;
        if (isCurrent) {
          action = '<p class="bp-mod-tier-current">This is your current plan' + (ent && ent.source === 'comp' ? ' (on the house)' : '') + '.</p>';
        } else if (!loggedIn) {
          action = '<p class="bp-mod-gate-text">Log in or create an account to join.</p>';
        } else if (!t.free && !t.joinable) {
          action = '<p class="bp-mod-gate-text">Paid sign-up is not available yet — check back soon.</p>';
        } else {
          action =
            '<button type="button" class="bp-mod-btn" data-bp-tier-join="' +
            esc(t.id) +
            '" data-bp-tier-free="' +
            (t.free ? '1' : '0') +
            '">' +
            (t.free ? 'Join free' : 'Join') +
            '</button>';
        }
        return (
          '<div class="bp-mod-tier"><h4>' +
          esc(t.name) +
          '</h4>' +
          price +
          (t.description ? '<p class="bp-mod-tier-desc">' + esc(t.description) + '</p>' : '<p class="bp-mod-tier-desc"></p>') +
          action +
          '<p class="bp-mod-book-msg" data-bp-tier-msg></p>' +
          '</div>'
        );
      })
      .join('');
    return '<h3 class="bp-mod-tiers-head">Membership plans</h3><div class="bp-mod-tier-grid">' + cards + '</div>';
  }

  function bindTierJoins(el, base, token) {
    var buttons = el.querySelectorAll('[data-bp-tier-join]');
    for (var i = 0; i < buttons.length; i++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          var tierId = btn.getAttribute('data-bp-tier-join');
          var free = btn.getAttribute('data-bp-tier-free') === '1';
          var card = btn.closest('.bp-mod-tier');
          var msg = card ? card.querySelector('[data-bp-tier-msg]') : null;
          btn.disabled = true;
          if (msg) {
            msg.textContent = free ? 'Joining…' : 'Taking you to secure checkout…';
            msg.className = 'bp-mod-book-msg';
          }
          var path = free ? '/members/join' : '/members/checkout';
          var body = free
            ? { tier_id: Number(tierId) }
            : { tier_id: Number(tierId), returnUrl: String(window.location.href || '').split('#')[0] };
          memberPost(base, token, path, body)
            .then(function (res) {
              var j = res.j || {};
              if (!j.ok) throw new Error(j.error || 'Something went wrong — please try again.');
              if (!free) {
                if (j.data && j.data.url) {
                  window.location.href = j.data.url;
                  return;
                }
                throw new Error('Checkout is unavailable right now.');
              }
              mountOne(el);
            })
            .catch(function (e) {
              btn.disabled = false;
              if (msg) {
                msg.textContent = e.message || 'Something went wrong — please try again.';
                msg.className = 'bp-mod-book-msg err';
              }
            });
        });
      })(buttons[i]);
    }
  }

  function membershipReturnNote() {
    try {
      var q = new URLSearchParams(window.location.search || '');
      if (q.get('membership') === 'success') {
        return '<p class="bp-mod-book-msg ok">Thanks — your payment went through. Your membership activates as soon as the payment is confirmed (usually a few seconds); refresh if it does not update.</p>';
      }
      if (q.get('membership') === 'cancelled') {
        return '<p class="bp-mod-book-msg">Checkout was cancelled — no charge was made.</p>';
      }
    } catch (e) {
      /* ignore */
    }
    return '';
  }

  function renderMembers(el, data, prefixHtml) {
    var m = data.members || {};
    var cfg = m.config || {};
    var token = el.getAttribute(TOKEN_ATTR) || '';
    var base = apiBase(el);
    var html = prefixHtml || '';
    html += membershipReturnNote();
    if (m.member) {
      var ent = m.entitlement || null;
      var planLine = 'Free member';
      if (ent && ent.source === 'comp') planLine = 'Plan: ' + (ent.tier_name || 'Membership') + ' (comp — on the house)';
      else if (ent && ent.tier_id != null) planLine = 'Plan: ' + (ent.tier_name || 'Membership');
      if (ent && ent.cancel_at_period_end && ent.current_period_end) {
        planLine += ' · cancels ' + esc(String(ent.current_period_end).slice(0, 10));
      } else if (ent && ent.current_period_end) {
        planLine += ' · renews ' + esc(String(ent.current_period_end).slice(0, 10));
      }
      html +=
        '<div class="bp-mod-member-card">' +
        '<p class="bp-mod-gate-title">You’re signed in</p>' +
        '<p class="bp-mod-gate-text">' +
        esc(m.member.name || m.member.email) +
        ' · ' +
        esc(m.member.email) +
        '</p>' +
        '<p class="bp-mod-gate-text">' +
        esc(planLine) +
        '</p>' +
        '<button type="button" class="bp-mod-btn ghost" data-bp-member-logout>Log out</button>' +
        '<p class="bp-mod-book-msg" data-bp-member-msg></p>' +
        '</div>';
      html += tierCardsHtml(m);
      el.innerHTML = html;
      var btn = el.querySelector('[data-bp-member-logout]');
      if (btn) {
        btn.addEventListener('click', function () {
          var headers = jsonHeaders(); // carries the current session header
          saveMemberSession(token, '');
          memberPost(base, token, '/members/logout', {}, headers).catch(function () {});
          mountOne(el);
        });
      }
      bindTierJoins(el, base, token);
      return;
    }
    var approval = cfg.signup_mode === 'approval';
    html +=
      '<div class="bp-mod-member-grid">' +
      '<div class="bp-mod-member-col"><h3>Log in</h3>' +
      memberLoginFormHtml() +
      '<details class="bp-mod-forgot"><summary>Forgot your password?</summary>' +
      '<form data-bp-member-forgot>' +
      '<div class="bp-mod-book-row"><label>Email</label><input name="email" type="email" required autocomplete="email" /></div>' +
      '<div class="bp-mod-captcha" data-bp-captcha hidden></div>' +
      '<button type="submit" class="bp-mod-btn ghost">Email me a reset link</button>' +
      '<p class="bp-mod-book-msg" data-bp-member-msg></p>' +
      '</form></details>' +
      '</div>' +
      '<div class="bp-mod-member-col"><h3>Create an account</h3>' +
      '<form class="bp-mod-book" data-bp-member-signup>' +
      '<div class="bp-mod-book-row"><label>Your name</label><input name="name" required autocomplete="name" /></div>' +
      '<div class="bp-mod-book-row"><label>Email</label><input name="email" type="email" required autocomplete="email" /></div>' +
      '<div class="bp-mod-book-row"><label>Password</label><input name="password" type="password" required minlength="8" autocomplete="new-password" /></div>' +
      (approval ? '<p class="bp-mod-gate-text">Accounts are approved by the owner — you will be able to log in once yours is approved.</p>' : '') +
      '<div class="bp-mod-captcha" data-bp-captcha hidden></div>' +
      '<button type="submit" class="bp-mod-btn">Create my account</button>' +
      '<p class="bp-mod-book-msg" data-bp-member-msg></p>' +
      '</form>' +
      '</div>' +
      '</div>';
    html += tierCardsHtml(m);
    el.innerHTML = html;
    bindMemberLogin(el, token, function () {
      mountOne(el);
    });
    bindMemberSignup(el, token, function () {
      mountOne(el);
    });
    bindMemberForgot(el, token);
    bindTierJoins(el, base, token);
  }

  /**
   * Wall body shared by module mounts and gated pages. Two flavors:
   * needs 'login' (anonymous) shows the login form; needs
   * 'subscription' means the visitor IS logged in but their plan does
   * not cover this page — no login form, just the way to the plans.
   */
  function gateWallHtml(gate) {
    var title = esc(gate.wall_headline || 'This page is for members only');
    if (gate.needs === 'subscription') {
      var who = gate.member
        ? '<p class="bp-mod-gate-text">You’re logged in as ' + esc(gate.member.email || '') + ', but this page needs ' +
          (gate.access_tier_name ? 'the <strong>' + esc(gate.access_tier_name) + '</strong> plan' : 'a paid membership') +
          '.</p>'
        : '<p class="bp-mod-gate-text">This page is for paid members.</p>';
      return (
        '<div class="bp-mod-gate">' +
        '<p class="bp-mod-gate-title">' +
        title +
        '</p>' +
        who +
        (gate.members_page
          ? '<p><a class="bp-mod-btn" href="' + esc(gate.members_page) + '">See membership plans</a></p>'
          : '') +
        '</div>'
      );
    }
    return (
      '<div class="bp-mod-gate">' +
      '<p class="bp-mod-gate-title">' +
      title +
      '</p>' +
      '<p class="bp-mod-gate-text">Log in to keep going.</p>' +
      memberLoginFormHtml() +
      (gate.members_page
        ? '<p class="bp-mod-gate-alt">New here? <a href="' + esc(gate.members_page) + '">Create your account</a></p>'
        : '') +
      '</div>'
    );
  }

  /** Locked wall for a module mounted on a gated page (no content ships). */
  function renderLocked(el, data) {
    var gate = data.gate || {};
    var html = '';
    if (shouldShowTitle(el)) html += '<h2 class="bp-mod-title">' + esc(data.title || '') + '</h2>';
    html += gateWallHtml(gate);
    el.innerHTML = html;
    if (gate.needs !== 'subscription') {
      bindMemberLogin(el, gate.members_token || '', function () {
        mountOne(el);
      });
    }
  }

  /** Locked wall replacing a gated page's exported shell body. */
  function renderGateWall(el, gate) {
    el.classList.add('bitpype-module-embed');
    el.innerHTML = gateWallHtml(gate || {});
    if (!gate || gate.needs !== 'subscription') {
      bindMemberLogin(el, (gate && gate.members_token) || '', function () {
        mountGate(el);
      });
    }
  }

  /**
   * Gate mount on an exported shell page: fetch the real body with the
   * member session; inject it and mount any modules inside. Without a
   * session the server answers 401 and only the wall renders.
   */
  function mountGate(el) {
    ensureStyles();
    el.classList.add('bitpype-module-embed');
    var token = el.getAttribute('data-bitpype-module-token') || '';
    var base = el.getAttribute('data-bitpype-api') || apiBase(el);
    var slug = el.getAttribute('data-bitpype-page-slug') || pageSlugHere();
    if (!token) {
      el.innerHTML = '<p class="bp-mod-err">This page is unavailable.</p>';
      return;
    }
    el.innerHTML = '<p class="bp-mod-loading">Loading…</p>';
    fetch(
      (base || '') + '/api/v1/modules/public/' + encodeURIComponent(token) + '/page/' + encodeURIComponent(slug),
      { credentials: 'omit', headers: authHeaders() }
    )
      .then(function (r) {
        return r.json().then(function (j) {
          return { status: r.status, j: j };
        });
      })
      .then(function (res) {
        var j = res.j;
        if (res.status === 401 || (j && j.code === 'MEMBER_LOCKED')) {
          renderGateWall(el, (j && j.gate) || {});
          return;
        }
        if (!j || !j.ok) throw new Error((j && j.error) || 'Failed to load');
        el.innerHTML = (j.data && j.data.html) || '';
        var mounts = el.querySelectorAll('[data-bitpype-module][data-bitpype-module-token]');
        for (var i = 0; i < mounts.length; i++) mountOne(mounts[i]);
        wireVideoFacades(el);
      })
      .catch(function (e) {
        el.innerHTML = '<p class="bp-mod-err">' + esc(e.message || 'Failed to load page') + '</p>';
      });
  }

  function mountOne(el) {
    var token = el.getAttribute(TOKEN_ATTR) || '';
    if (!token) {
      el.innerHTML = '<p class="bp-mod-err">Missing module token.</p>';
      return;
    }
    ensureStyles();
    polishHost(el);
    el.classList.add('bitpype-module-inpage');
    if (document.body && document.body.children.length <= 2 && el.parentElement === document.body) {
      el.classList.add('bitpype-module-standalone');
    }
    el.innerHTML = '<p class="bp-mod-loading">Loading…</p>';
    var base = apiBase(el);
    var item = currentItemKey();
    var path =
      (base || '') +
      '/api/v1/modules/public/' +
      encodeURIComponent(token) +
      (item ? '?slug=' + encodeURIComponent(item) + '&' : '?') +
      pageQuery();
    fetch(path, { credentials: 'omit', headers: authHeaders() })
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        if (!j || !j.ok) throw new Error((j && j.error) || 'Failed to load');
        var data = j.data;
        if (data.locked) {
          renderLocked(el, data);
          return;
        }
        if (data.item) renderItem(el, data);
        else renderList(el, data);
        if (data.module_type === 'ecommerce') wireShop(el, base, token);
      })
      .catch(function (e) {
        el.innerHTML = '<p class="bp-mod-err">' + esc(e.message || 'Failed to load module') + '</p>';
      });
  }

  function boot() {
    ensureStyles();
    var nodes = document.querySelectorAll('[data-bitpype-module][data-bitpype-module-token]');
    for (var i = 0; i < nodes.length; i++) mountOne(nodes[i]);
    var gates = document.querySelectorAll('[data-bitpype-member-gate]');
    for (var g = 0; g < gates.length; g++) mountGate(gates[g]);
  }

  window.BitpypeModules = {
    __booted: true,
    boot: boot,
    mount: mountOne,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
