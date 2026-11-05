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
      '.bitpype-module-embed .bp-mod-cat-scope{',
      'margin:1.6rem 0 0.9rem;font-size:1.15rem;',
      '}',
      '.bitpype-module-embed .bp-mod-cat-scope:first-of-type{margin-top:0;}',
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
      '.bitpype-module-embed .bp-mod-variants{display:flex;flex-wrap:wrap;gap:0.75rem;margin:0.9rem 0 0.2rem;}',
      '.bitpype-module-embed .bp-mod-variant-axis{display:flex;flex-direction:column;gap:0.3rem;font-size:0.85rem;font-weight:700;color:var(--bp-mod-muted);}',
      '.bitpype-module-embed .bp-mod-variant-axis select{',
      'font:inherit;font-weight:600;color:var(--bp-mod-ink);padding:0.5rem 0.7rem;border-radius:0.7rem;',
      'border:1.5px solid var(--bp-mod-line);background:var(--bp-mod-paper);min-width:10rem;',
      '}',
      '.bitpype-module-embed .bp-mod-variant-note{color:var(--bp-mod-muted);font-size:0.9rem;margin:0.4rem 0 0;}',
      '.bitpype-module-embed .bp-mod-btn[disabled]{opacity:0.55;cursor:not-allowed;filter:none;}',
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
      '.bitpype-module-embed .bp-mod-book-row{',
      'display:grid;gap:0.45rem;',
      // Batch 135 finisher: internal-padding floor — the audit found
      // booking rows shipping flush (0px) on live sites.
      'padding-left:var(--bp-space-card-pad,16px);padding-right:var(--bp-space-card-pad,16px);',
      '}',
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
      '.bitpype-module-embed .bp-mod-check{display:flex;align-items:center;gap:0.55rem;font-weight:400 !important;cursor:pointer;}',
      '.bitpype-module-embed .bp-mod-check input{width:auto !important;}',
      '.bitpype-module-embed .bp-sms-policy-note{margin:0;font-size:0.8rem;line-height:1.5;color:var(--bp-mod-muted);}',
      '.bitpype-module-embed .bp-sms-policy-note a{color:inherit;text-decoration:underline;}',
      '.bitpype-module-embed .bp-mod-book-msg{margin:0;color:var(--bp-mod-muted);}',
      '.bitpype-module-embed .bp-mod-book-msg.ok{color:var(--bp-mod-accent);}',
      '.bitpype-module-embed .bp-mod-book-msg.err{color:#9b2c2c;}',
      '.bitpype-module-embed .bp-mod-captcha{margin:0.35rem 0 0.65rem;}',
      '.bitpype-module-embed .bp-mod-captcha iframe{display:block;}',
      // Photo Capture (Batch 125): file picker + preview + approved grid.
      '.bitpype-module-embed .bp-mod-photo-preview{display:none;margin:0.35rem 0 0.65rem;}',
      '.bitpype-module-embed .bp-mod-photo-preview img{max-width:100%;max-height:260px;border-radius:0.85rem;display:block;}',
      '.bitpype-module-embed .bp-mod-photo-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(180px,100%),1fr));gap:1rem;margin-top:1.1rem;}',
      '.bitpype-module-embed .bp-mod-photo-cell{margin:0;}',
      '.bitpype-module-embed .bp-mod-photo-cell img{width:100%;height:180px;object-fit:cover;border-radius:0.85rem;display:block;}',
      '.bitpype-module-embed .bp-mod-photo-cell figcaption{margin-top:0.4rem;font-size:0.88rem;color:var(--bp-mod-muted);line-height:1.45;}',
      '@media (prefers-reduced-motion:reduce){',
      '.bitpype-module-embed .bp-mod-card{transition:none;}',
      '.bitpype-module-embed .bp-mod-card:hover{transform:none;}',
      '}',
      // Batch 142 — the ONE cart element lives in the site nav/header
      // chrome (Ely: "Checkout element should be at the top, better if
      // it's in the nav"), replacing Batch 128's in-body .bp-mod-cartbar.
      // The element is NOT inside a .bitpype-module-embed — it is
      // appended into the page chrome — so these rules are deliberately
      // UNSCOPED. Horizontal padding is 1rem (16px): the Batch 135
      // spacing floor for its own text, never flush.
      '.bp-nav-cart{',
      'display:inline-flex;align-items:center;gap:0.45rem;margin-left:auto;flex:none;',
      'padding:0.55rem 1rem;min-height:2.75rem;box-sizing:border-box;white-space:nowrap;',
      'border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:999px;',
      'font:inherit;font-size:0.95rem;font-weight:700;line-height:1.2;',
      'color:inherit;text-decoration:none;background:transparent;cursor:pointer;',
      '}',
      '.bp-nav-cart:hover{text-decoration:underline;}',
      '@media (max-width:700px){',
      '.bp-nav-cart{font-size:0.9rem;padding:0.5rem 1rem;}',
      '}',
      '.bitpype-module-embed .bp-mod-cartline{',
      'display:flex;align-items:center;gap:0.8rem;padding:0.7rem 0;border-top:1px solid var(--bp-mod-line);flex-wrap:wrap;',
      '}',
      '.bitpype-module-embed .bp-mod-cart-thumb{width:52px;height:52px;object-fit:cover;border-radius:0.6rem;flex:none;display:block;}',
      '.bitpype-module-embed .bp-mod-cart-thumb-empty{',
      'background:linear-gradient(145deg,var(--bp-mod-secondary),var(--bp-mod-accent));opacity:0.35;',
      '}',
      '.bitpype-module-embed .bp-mod-cartline-main{flex:1;font-weight:600;min-width:8rem;}',
      '.bitpype-module-embed .bp-mod-cartline-qty{display:inline-flex;align-items:center;gap:0.3rem;}',
      '.bitpype-module-embed .bp-mod-qtybtn{',
      'appearance:none;border:1.5px solid var(--bp-mod-line);background:transparent;color:var(--bp-mod-ink);',
      'border-radius:999px;width:1.7rem;height:1.7rem;cursor:pointer;font:inherit;line-height:1;padding:0;',
      'display:inline-flex;align-items:center;justify-content:center;',
      '}',
      '.bitpype-module-embed .bp-mod-cart-total{font-size:1.05rem;margin:1rem 0 0;}',
      '.bitpype-module-embed .bp-mod-variant{display:inline-flex;align-items:center;gap:0.4rem;font-weight:600;margin:0 0.5rem 0.35rem 0;}',
      '.bitpype-module-embed .bp-mod-variant select{',
      'border:1px solid var(--bp-mod-line);border-radius:0.6rem;padding:0.35rem 0.5rem;font:inherit;',
      'background:var(--bp-mod-paper);color:var(--bp-mod-ink);',
      '}',
      '.bitpype-module-embed .bp-mod-photo-sale{display:flex;align-items:center;gap:0.6rem;margin:0.6rem 0 0;flex-wrap:wrap;}',
      '.bitpype-module-embed .bp-mod-photo-sale .bp-mod-btn{margin-top:0;}',
      '.bitpype-module-embed .bp-mod-notice{',
      'border:1px solid var(--bp-mod-line);border-radius:0.85rem;padding:0.7rem 0.9rem;margin:0 0 1rem;',
      'background:color-mix(in srgb,var(--bp-mod-paper) 94%,var(--bp-mod-ink));',
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
      // Google Reviews
      '.bitpype-module-embed .bp-mod-googlereviews{display:flex;flex-direction:column;gap:1.1rem;}',
      '.bitpype-module-embed .bp-mod-gr-summary{display:flex;align-items:center;gap:0.9rem;flex-wrap:wrap;border:1px solid var(--bp-mod-line);border-radius:1.1rem;background:var(--bp-mod-paper);padding:1.1rem 1.25rem;}',
      '.bitpype-module-embed .bp-mod-gr-score{font-size:1.9rem;font-weight:800;line-height:1;color:var(--bp-mod-ink,#1c1917);}',
      '.bitpype-module-embed .bp-mod-gr-stars{font-size:1.15rem;letter-spacing:0.12em;color:#f59e0b;line-height:1;}',
      '.bitpype-module-embed .bp-mod-gr-count{color:var(--bp-mod-muted);font-size:0.92rem;}',
      '.bitpype-module-embed .bp-mod-gr-count a{color:var(--bp-mod-accent);font-weight:700;text-decoration:none;}',
      '.bitpype-module-embed .bp-mod-gr-count a:hover{text-decoration:underline;}',
      '.bitpype-module-embed .bp-mod-gr-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:1.1rem;}',
      '.bitpype-module-embed .bp-mod-gr-card{border:1px solid var(--bp-mod-line);border-radius:1.1rem;background:var(--bp-mod-paper);padding:1.1rem 1.2rem 1.2rem;display:flex;flex-direction:column;gap:0.55rem;}',
      '.bitpype-module-embed .bp-mod-gr-head{display:flex;align-items:center;gap:0.65rem;}',
      '.bitpype-module-embed .bp-mod-gr-avatar{width:38px;height:38px;border-radius:999px;object-fit:cover;flex:none;}',
      '.bitpype-module-embed .bp-mod-gr-avatar-fallback{width:38px;height:38px;border-radius:999px;flex:none;display:flex;align-items:center;justify-content:center;background:var(--bp-mod-accent);color:#fff;font-weight:800;font-size:1rem;}',
      '.bitpype-module-embed .bp-mod-gr-author{font-weight:700;line-height:1.25;}',
      '.bitpype-module-embed .bp-mod-gr-author a{color:inherit;text-decoration:none;}',
      '.bitpype-module-embed .bp-mod-gr-author a:hover{text-decoration:underline;}',
      '.bitpype-module-embed .bp-mod-gr-when{color:var(--bp-mod-muted);font-size:0.84rem;line-height:1.3;}',
      '.bitpype-module-embed .bp-mod-gr-cardstars{font-size:0.95rem;letter-spacing:0.12em;color:#f59e0b;line-height:1;}',
      '.bitpype-module-embed .bp-mod-gr-text{margin:0;line-height:1.55;font-size:0.96rem;}',
      '.bitpype-module-embed .bp-mod-gr-attrib{margin:0;color:var(--bp-mod-muted);font-size:0.84rem;}',
      '.bitpype-module-embed .bp-mod-gr-attrib a{color:var(--bp-mod-accent);font-weight:700;text-decoration:none;}',
      '.bitpype-module-embed .bp-mod-gr-attrib a:hover{text-decoration:underline;}',
      // QR Code
      '.bitpype-module-embed .bp-mod-qrcode{display:flex;flex-direction:column;align-items:center;gap:0.9rem;text-align:center;}',
      '.bitpype-module-embed .bp-mod-qr-img{width:min(280px,72vw);height:auto;aspect-ratio:1;border-radius:0.9rem;background:#fff;}',
      '.bitpype-module-embed .bp-mod-qr-caption{margin:0;font-weight:700;font-size:1.05rem;line-height:1.4;color:var(--bp-mod-ink,#1c1917);}',
      '.bitpype-module-embed .bp-mod-qr-caption a{color:var(--bp-mod-accent);text-decoration:none;}',
      '.bitpype-module-embed .bp-mod-qr-caption a:hover{text-decoration:underline;}',
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
      // Data Tables (Batch 88)
      '.bitpype-module-embed .bp-mod-dt-toolbar{display:flex;gap:0.75rem;align-items:center;flex-wrap:wrap;margin:0 0 1rem;}',
      '.bitpype-module-embed .bp-mod-dt-search{flex:1;min-width:180px;padding:0.65rem 0.9rem;border:1px solid var(--bp-mod-line);border-radius:0.7rem;background:var(--bp-mod-paper);color:inherit;font:inherit;}',
      '.bitpype-module-embed .bp-mod-dt-pagesize{display:inline-flex;gap:0.45rem;align-items:center;color:var(--bp-mod-muted);font-size:0.92rem;}',
      '.bitpype-module-embed .bp-mod-dt-pagesize select{padding:0.5rem 0.6rem;border:1px solid var(--bp-mod-line);border-radius:0.7rem;background:var(--bp-mod-paper);color:inherit;font:inherit;}',
      '.bitpype-module-embed .bp-mod-dt-tablewrap{overflow-x:auto;border:1px solid var(--bp-mod-line);border-radius:1.1rem;background:var(--bp-mod-paper);}',
      '.bitpype-module-embed .bp-mod-dt-table{width:100%;border-collapse:collapse;}',
      '.bitpype-module-embed .bp-mod-dt-table th,.bitpype-module-embed .bp-mod-dt-table td{padding:0.8rem 1rem;text-align:left;vertical-align:top;}',
      '.bitpype-module-embed .bp-mod-dt-table thead th{border-bottom:2px solid var(--bp-mod-line);white-space:nowrap;}',
      '.bitpype-module-embed .bp-mod-dt-table tbody tr+tr td{border-top:1px solid var(--bp-mod-line);}',
      '.bitpype-module-embed .bp-mod-dt-sort{background:none;border:0;font:inherit;font-weight:700;cursor:pointer;color:inherit;display:inline-flex;gap:0.35rem;align-items:center;padding:0;}',
      '.bitpype-module-embed .bp-mod-dt-sort:hover{color:var(--bp-mod-accent);}',
      '.bitpype-module-embed .bp-mod-dt-arrow{font-size:0.8em;color:var(--bp-mod-accent);}',
      '.bitpype-module-embed .bp-mod-dt-none{color:var(--bp-mod-muted);padding:1.1rem 1.2rem;margin:0;}',
      '.bitpype-module-embed .bp-mod-dt-pager{display:flex;gap:0.75rem;align-items:center;flex-wrap:wrap;margin-top:1rem;}',
      '.bitpype-module-embed .bp-mod-dt-pageinfo{color:var(--bp-mod-muted);font-size:0.92rem;}',
      '.bitpype-module-embed .bp-mod-dt-wall{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:1.1rem;}',
      '.bitpype-module-embed .bp-mod-dt-card{border:1px solid var(--bp-mod-line);border-radius:1.1rem;background:var(--bp-mod-paper);padding:1.1rem 1.2rem 1.2rem;display:flex;flex-direction:column;gap:0.55rem;}',
      '.bitpype-module-embed .bp-mod-dt-card-head{display:flex;align-items:center;gap:0.65rem;}',
      '.bitpype-module-embed .bp-mod-dt-avatar{width:42px;height:42px;border-radius:999px;object-fit:cover;flex:none;}',
      '.bitpype-module-embed .bp-mod-dt-avatar-fallback{width:42px;height:42px;border-radius:999px;flex:none;display:flex;align-items:center;justify-content:center;background:var(--bp-mod-accent);color:#fff;font-weight:800;font-size:1.05rem;}',
      '.bitpype-module-embed .bp-mod-dt-card-title{font-weight:700;line-height:1.25;margin:0;}',
      '.bitpype-module-embed .bp-mod-dt-card-meta{color:var(--bp-mod-muted);font-size:0.84rem;line-height:1.3;margin:0;}',
      '.bitpype-module-embed .bp-mod-dt-card-body{margin:0;line-height:1.55;}',
      '.bitpype-module-embed .bp-mod-dt-card-link{color:var(--bp-mod-accent);font-weight:700;text-decoration:none;}',
      '.bitpype-module-embed .bp-mod-dt-card-link:hover{text-decoration:underline;}',
      '.bitpype-module-embed .bp-mod-dt-badge{display:inline-block;border:1px solid var(--bp-mod-line);border-radius:999px;padding:0.08rem 0.6rem;font-size:0.78rem;font-weight:700;margin-left:auto;flex:none;}',
      '.bitpype-module-embed .bp-mod-dt-results{display:flex;flex-direction:column;gap:1.35rem;max-width:44rem;}',
      '.bitpype-module-embed .bp-mod-dt-result-title{font-size:1.15rem;font-weight:600;color:var(--bp-mod-accent);text-decoration:none;line-height:1.3;}',
      'a.bp-mod-dt-result-title:hover{text-decoration:underline;}',
      '.bitpype-module-embed .bp-mod-dt-result-url{color:var(--bp-mod-muted);font-size:0.85rem;margin:0.15rem 0 0;overflow-wrap:anywhere;}',
      '.bitpype-module-embed .bp-mod-dt-result-snippet{margin:0.25rem 0 0;line-height:1.55;}',
      '.bitpype-module-embed .bp-mod-dt-result-meta{color:var(--bp-mod-muted);font-size:0.85rem;margin:0.25rem 0 0;}',
      '.bitpype-module-embed .bp-mod-dt-list{display:flex;flex-direction:column;}',
      '.bitpype-module-embed .bp-mod-dt-row{display:flex;gap:1rem;align-items:flex-start;padding:1rem 0.25rem;border-top:1px solid var(--bp-mod-line);}',
      '.bitpype-module-embed .bp-mod-dt-row:first-child{border-top:0;}',
      '.bitpype-module-embed .bp-mod-dt-thumb{width:56px;height:56px;border-radius:0.8rem;object-fit:cover;flex:none;}',
      '.bitpype-module-embed .bp-mod-dt-row-main{flex:1;min-width:0;}',
      '.bitpype-module-embed .bp-mod-dt-row-title{font-weight:700;margin:0;line-height:1.3;}',
      '.bitpype-module-embed .bp-mod-dt-row-title a{color:inherit;text-decoration:none;}',
      '.bitpype-module-embed .bp-mod-dt-row-title a:hover{color:var(--bp-mod-accent);}',
      '.bitpype-module-embed .bp-mod-dt-row-body{margin:0.3rem 0 0;line-height:1.55;}',
      '.bitpype-module-embed .bp-mod-dt-row-side{color:var(--bp-mod-muted);font-size:0.88rem;text-align:right;flex:none;display:flex;flex-direction:column;gap:0.3rem;align-items:flex-end;}',
      '.bitpype-module-embed .bp-mod-dt-form{margin-top:1.9rem;border-top:1px solid var(--bp-mod-line);padding-top:1.5rem;max-width:36rem;}',
      '.bitpype-module-embed .bp-mod-chart{margin:0 0 2.25rem;}',
      '.bitpype-module-embed .bp-mod-chart:last-child{margin-bottom:0;}',
      '.bitpype-module-embed .bp-mod-chart-title{margin:0 0 0.75rem;font-size:1.15rem;letter-spacing:-0.01em;}',
      '.bitpype-module-embed .bp-mod-chart-svg{display:block;width:100%;height:auto;}',
      '.bitpype-module-embed .bp-mod-chart-legend{display:flex;flex-wrap:wrap;gap:0.4rem 1.1rem;margin:0.65rem 0 0;padding:0;list-style:none;font-size:0.9rem;color:var(--bp-mod-muted);}',
      '.bitpype-module-embed .bp-mod-chart-legend li{display:inline-flex;align-items:center;gap:0.45rem;}',
      '.bitpype-module-embed .bp-mod-chart-dot{width:0.8rem;height:0.8rem;border-radius:0.25rem;flex:none;display:inline-block;}',
      '.bitpype-module-embed .bp-chart-tick{fill:var(--bp-mod-muted);font-size:12px;}',
      '.bitpype-module-embed .bp-chart-val{fill:var(--bp-mod-ink);font-size:11px;font-weight:600;}',
      '.bitpype-module-embed .bp-chart-grid{stroke:var(--bp-mod-line);stroke-width:1;}',
      '.bitpype-module-embed .bp-chart-axis{stroke:var(--bp-mod-line);stroke-width:1.5;}',
      '.bitpype-module-embed .bp-mod-dt-form-title{margin:0 0 1rem;font-size:1.12rem;}',
      // Batch 135 finisher: unscoped internal-padding floor for the
      // newsletter card — server-rendered / non-embed mounts do not sit
      // under .bitpype-module-embed, and the audit found the card at
      // 0px there. The scoped card rule below (higher specificity)
      // still wins wherever it applies.
      '.bp-mod-news-card{padding:var(--bp-space-card-pad,16px);}',
      // Newsletter (Batch 118) — the signup card reuses the booking
      // form's field styling (the form also carries .bp-mod-book); these
      // rules add the card shell, heading and blurb.
      '.bitpype-module-embed .bp-mod-news-card{',
      'padding:clamp(1.4rem,3vw,2rem);border-radius:1.4rem;',
      'border:1px solid var(--bp-mod-line);',
      'background:',
      'linear-gradient(135deg,color-mix(in srgb,var(--bp-mod-accent) 10%,var(--bp-mod-paper)),var(--bp-mod-paper) 55%),',
      'var(--bp-mod-paper);',
      'box-shadow:0 18px 44px color-mix(in srgb,var(--bp-mod-ink) 7%,transparent);',
      'max-width:640px;',
      '}',
      '.bitpype-module-embed .bp-mod-news-heading{',
      'margin:0;font-size:1.35rem;letter-spacing:-0.02em;line-height:1.2;',
      'font-family:var(--ws-heading-font,inherit);',
      '}',
      '.bitpype-module-embed .bp-mod-news-blurb{margin:0.65rem 0 0;color:var(--bp-mod-muted);line-height:1.6;}',
      '.bitpype-module-embed .bp-mod-news-form{margin-top:1.1rem;}',
      // Comments (Batch 131) — thread list, like buttons, owner badge.
      // Comment bodies are plain text (white-space:pre-wrap does the
      // line breaks); nothing renders them as HTML.
      '.bitpype-module-embed .bp-mod-comments{max-width:720px;}',
      '.bitpype-module-embed .bp-mod-comments-head{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin:0 0 0.4rem;}',
      '.bitpype-module-embed .bp-mod-comments-list{margin:0.6rem 0 0;display:flex;flex-direction:column;gap:1.1rem;}',
      '.bitpype-module-embed .bp-mod-comment{border-top:1px solid var(--bp-mod-line);padding-top:0.9rem;}',
      '.bitpype-module-embed .bp-mod-comment-meta{display:flex;align-items:baseline;flex-wrap:wrap;gap:0.5rem;margin:0;}',
      '.bitpype-module-embed .bp-mod-comment-author{font-weight:700;}',
      '.bitpype-module-embed .bp-mod-owner-badge{font-size:0.72rem;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:var(--bp-mod-accent);border:1px solid var(--bp-mod-accent);border-radius:999px;padding:0.05rem 0.5rem;}',
      '.bitpype-module-embed .bp-mod-comment-date{color:var(--bp-mod-muted);font-size:0.85rem;}',
      '.bitpype-module-embed .bp-mod-comment-body{margin:0.35rem 0 0;white-space:pre-wrap;overflow-wrap:break-word;line-height:1.6;}',
      '.bitpype-module-embed .bp-mod-comment-actions{display:flex;align-items:center;gap:0.9rem;margin-top:0.45rem;}',
      '.bitpype-module-embed .bp-mod-replies{margin:0.8rem 0 0 1.1rem;padding-left:0.9rem;border-left:2px solid var(--bp-mod-line);display:flex;flex-direction:column;gap:0.9rem;}',
      '.bitpype-module-embed .bp-mod-replies .bp-mod-comment{border-top:none;padding-top:0;}',
      '.bitpype-module-embed .bp-mod-like-btn{display:inline-flex;align-items:center;gap:0.35rem;background:none;border:1px solid var(--bp-mod-line);border-radius:999px;padding:0.2rem 0.7rem;font:inherit;font-size:0.88rem;color:var(--bp-mod-muted);cursor:pointer;}',
      '.bitpype-module-embed .bp-mod-like-btn:hover{border-color:var(--bp-mod-accent);color:var(--bp-mod-accent);}',
      '.bitpype-module-embed .bp-mod-like-btn.liked{border-color:var(--bp-mod-accent);color:var(--bp-mod-accent);font-weight:700;}',
      '.bitpype-module-embed .bp-mod-like-btn .bp-mod-like-heart{font-size:0.95rem;line-height:1;}',
      '.bitpype-module-embed .bp-mod-reply-btn{background:none;border:none;padding:0;font:inherit;font-size:0.88rem;color:var(--bp-mod-accent);cursor:pointer;font-weight:600;}',
      '.bitpype-module-embed .bp-mod-comment-form{margin-top:1.2rem;}',
      '.bitpype-module-embed .bp-mod-reply-form{margin-top:0.7rem;}',
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
    if (type === 'googlereviews') {
      // No public empty state for Google Reviews — dormant or empty
      // configurations render nothing (never a placeholder).
      return { kicker: '', title: '', text: '' };
    }
    if (type === 'categories') {
      // No public empty state for Categories — a taxonomy with no
      // published categories renders nothing (dormant-empty).
      return { kicker: '', title: '', text: '' };
    }
    if (type === 'qrcode') {
      // No public empty state for QR Code — an unchosen or vanished
      // target renders nothing (never a broken image).
      return { kicker: '', title: '', text: '' };
    }
    if (type === 'video') {
      return { kicker: 'Videos', title: 'No videos yet', text: 'Videos will appear here when published.' };
    }
    if (type === 'datatables') {
      return { kicker: 'Data Table', title: 'Nothing here yet', text: 'Rows will appear here once they are added.' };
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

  /** The stored session plus the members token it belongs to (the key suffix). */
  function storedMemberSessionEntry() {
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(MEMBER_SESSION_PREFIX) === 0) {
          var v = localStorage.getItem(k);
          if (v) return { token: k.slice(MEMBER_SESSION_PREFIX.length), session: v };
        }
      }
    } catch (e) {
      /* storage unavailable */
    }
    return null;
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

  /* ── Batch 133 — universal detail page links ──
   * On exported sites (writeStaticPages stamps a bitpype-detail meta
   * into every page), list/card item links point at the item's detail
   * page — /detail/<type>/<key>, ONE typed target — instead of the
   * page-level ?bpItem= pattern. In-app surfaces (portal, standalone
   * viewer) carry no meta and keep the legacy links byte-for-byte.
   * Blog is the one exception on exported sites too: its static post
   * pages (Batch 32) ARE its detail pages, and the legacy link is
   * what resolves to them. activeDetailType is set synchronously by
   * renderList/renderItem before any card HTML is built. */
  var DETAIL_TYPES = [
    'blog',
    'ecommerce',
    'courses',
    'gallery',
    'directory',
    'faq',
    'testimonials',
    'team',
    'events',
    'bookings',
    'categories',
    'offers',
    'menu',
    'careers',
    'video',
  ];
  var activeDetailType = '';

  function detailEnabled() {
    try {
      return !!document.querySelector('meta[name="bitpype-detail"]');
    } catch (e) {
      return false;
    }
  }

  function detailHref(type, key) {
    return '/detail/' + encodeURIComponent(type) + '/' + encodeURIComponent(String(key));
  }

  function cardHref(key) {
    if (
      activeDetailType &&
      activeDetailType !== 'blog' &&
      DETAIL_TYPES.indexOf(activeDetailType) >= 0 &&
      detailEnabled()
    ) {
      return detailHref(activeDetailType, key);
    }
    return itemHref(key);
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

  function renderAlbumDetail(album, showBack, data) {
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
      // Batch 128: priced photos are FOR SALE through the site's
      // checkout (Ely: "I can SELL photos") — each priced photo gets
      // its price + an Add to cart button under the gallery grid.
      // Unpriced photos stay view-only; without a Checkout module
      // attached nothing changes at all.
      if (data && data.checkout_page) {
        var priced = imgs.filter(function (im) {
          return im.for_sale;
        });
        for (var j = 0; j < priced.length; j++) {
          var p = priced[j];
          html +=
            '<p class="bp-mod-photo-sale">' +
            (p.caption ? '<span>' + esc(p.caption) + '</span> ' : '') +
            '<span class="bp-mod-price">' +
            esc(p.price_label || '') +
            '</span> ' +
            '<button type="button" class="bp-mod-btn" data-bp-add-photo="' +
            esc(p.id) +
            '" data-bp-name="' +
            esc(p.caption || album.title || 'Photo') +
            '" data-bp-price="' +
            (Number(p.price_cents) || 0) +
            '" data-bp-image="' +
            esc(p.image_url || '') +
            '">Add to cart</button></p>';
        }
      }
    }
    html += '</div>';
    return html;
  }

  // Batch 124: a Categories-index card — one published category with
  // its image and the count of published items its view will show.
  function categoryCardHtml(it) {
    var key = it.slug || it.id;
    var count = Number(it.item_count) || 0;
    return (
      '<article class="bp-mod-card">' +
      coverHtml(cardHref(key), it.image_url, it.name) +
      '<div class="bp-mod-body"><h2><a href="' +
      esc(cardHref(key)) +
      '">' +
      esc(it.name) +
      '</a></h2>' +
      (it.description ? '<p class="bp-mod-desc">' + esc(String(it.description).slice(0, 140)) + '</p>' : '') +
      '<p class="bp-mod-meta">' +
      count +
      ' item' +
      (count === 1 ? '' : 's') +
      '</p></div></article>'
    );
  }

  // Batch 124: a card for one uniform shared-layer item (the shape
  // server/moduleShare.js returns) on a category view — the title
  // links to the item's own page whenever the payload carries one.
  function sharedItemCardHtml(it) {
    var titleHtml = it.link_url
      ? '<a href="' + esc(it.link_url) + '">' + esc(it.title) + '</a>'
      : esc(it.title);
    return (
      '<article class="bp-mod-card">' +
      (it.image_url
        ? it.link_url
          ? '<a class="bp-mod-cover" href="' +
            esc(it.link_url) +
            '" style="background-image:url(\'' +
            esc(it.image_url) +
            '\')"></a>'
          : '<div class="bp-mod-cover" style="background-image:url(\'' + esc(it.image_url) + '\')"></div>'
        : '') +
      '<div class="bp-mod-body"><h2>' +
      titleHtml +
      '</h2>' +
      (it.date ? '<p class="bp-mod-meta">' + esc(dateLabel(it.date) || String(it.date).slice(0, 10)) + '</p>' : '') +
      (it.description ? '<p class="bp-mod-desc">' + esc(String(it.description).slice(0, 140)) + '</p>' : '') +
      '</div></article>'
    );
  }

  function offerCardHtml(it) {
    var key = it.slug || it.id;
    var html = '<article class="bp-mod-offer">';
    if (it.image_url) {
      html +=
        '<a href="' + esc(cardHref(key)) + '"><img src="' + esc(it.image_url) + '" alt="' + esc(it.title) + '" loading="lazy"></a>';
    }
    html += '<div class="bp-mod-offer-body">';
    html += '<h2><a href="' + esc(cardHref(key)) + '">' + esc(it.title) + '</a></h2>';
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
        esc(cardHref(key)) +
        '"><img src="' +
        esc(it.image_url) +
        '" alt="' +
        esc(it.title) +
        '" loading="lazy"></a>';
    }
    html += '<div class="bp-mod-offer-row-body">';
    html += '<h2><a href="' + esc(cardHref(key)) + '">' + esc(it.title) + '</a></h2>';
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
    html += '<h2><a href="' + esc(cardHref(key)) + '">' + esc(it.title) + '</a></h2>';
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
    html += '<h2><a href="' + esc(cardHref(key)) + '">' + esc(it.title) + '</a></h2>';
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

  function grStarsHtml(rating) {
    var r = Math.max(0, Math.min(5, Math.round(Number(rating) || 0)));
    if (!r) return '';
    return '★'.repeat(r) + '☆'.repeat(5 - r);
  }

  function grTruncate(text, limit) {
    var s = String(text || '')
      .replace(/\s+/g, ' ')
      .trim();
    return s.length > limit ? s.slice(0, limit - 1).trimEnd() + '…' : s;
  }

  function googleReviewCardHtml(it) {
    var html = '<article class="bp-mod-gr-card">';
    html += '<div class="bp-mod-gr-head">';
    if (it.photo_uri) {
      html += '<img class="bp-mod-gr-avatar" src="' + esc(it.photo_uri) + '" alt="" loading="lazy">';
    } else {
      html +=
        '<span class="bp-mod-gr-avatar-fallback" aria-hidden="true">' +
        esc(String(it.author || 'G').slice(0, 1).toUpperCase()) +
        '</span>';
    }
    html += '<div>';
    html += '<p class="bp-mod-gr-author" style="margin:0">';
    if (it.author_uri) {
      html +=
        '<a href="' + esc(it.author_uri) + '" target="_blank" rel="noopener">' + esc(it.author || '') + '</a>';
    } else {
      html += esc(it.author || '');
    }
    html += '</p>';
    if (it.relative_time) html += '<p class="bp-mod-gr-when" style="margin:0">' + esc(it.relative_time) + '</p>';
    html += '</div></div>';
    var stars = grStarsHtml(it.rating);
    if (stars) {
      html +=
        '<p class="bp-mod-gr-cardstars" style="margin:0" aria-label="' +
        esc(it.rating) +
        ' of 5 stars">' +
        stars +
        '</p>';
    }
    if (it.text) html += '<p class="bp-mod-gr-text">' + esc(grTruncate(it.text, 320)) + '</p>';
    html += '</article>';
    return html;
  }

  function googleReviewsHtml(gr, items) {
    var html = '<div class="bp-mod-googlereviews">';
    var score = gr.rating != null ? Number(gr.rating) : null;
    html += '<div class="bp-mod-gr-summary">';
    if (score != null && isFinite(score)) {
      html += '<span class="bp-mod-gr-score">' + esc(score.toFixed(1)) + '</span>';
      html +=
        '<span class="bp-mod-gr-stars" aria-label="' +
        esc(score.toFixed(1)) +
        ' out of 5 stars">' +
        grStarsHtml(score) +
        '</span>';
    }
    var countText =
      (gr.total ? gr.total + (gr.total === 1 ? ' review' : ' reviews') + ' on Google' : 'Reviews on Google') +
      (gr.name ? ' · ' + gr.name : '');
    html += '<span class="bp-mod-gr-count">';
    if (gr.google_maps_uri) {
      html += '<a href="' + esc(gr.google_maps_uri) + '" target="_blank" rel="noopener">' + esc(countText) + '</a>';
    } else {
      html += esc(countText);
    }
    html += '</span></div>';
    html += '<div class="bp-mod-gr-grid">';
    for (var gi = 0; gi < items.length; gi++) {
      html += googleReviewCardHtml(items[gi]);
    }
    html += '</div>';
    // Google attribution: reviews are shown unaltered, credited to
    // their authors above, with the listing linked here.
    html += '<p class="bp-mod-gr-attrib">Reviews powered by ';
    if (gr.google_maps_uri) {
      html += '<a href="' + esc(gr.google_maps_uri) + '" target="_blank" rel="noopener">Google</a>';
    } else {
      html += 'Google';
    }
    html += '</p>';
    html += '</div>';
    return html;
  }

  function qrCodeHtml(qr) {
    // The image is server-rendered from the payload resolved at serve
    // time (the payload's own public route); the caption optionally
    // links to the same target the code encodes.
    var html = '<figure class="bp-mod-qrcode" style="margin:0">';
    html += '<img class="bp-mod-qr-img" src="' + esc(qr.image_url) + '" alt="' + esc(qr.name || 'QR code') + '" loading="lazy" />';
    if (qr.caption) {
      html += '<figcaption class="bp-mod-qr-caption">';
      if (qr.target_url) {
        html += '<a href="' + esc(qr.target_url) + '">' + esc(qr.caption) + '</a>';
      } else {
        html += esc(qr.caption);
      }
      html += '</figcaption>';
    }
    html += '</figure>';
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
    activeDetailType = type || '';
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
      // The call button displays the Twilio tracking number as its text
      // AND dials it, so calls are logged and forwarded to the business.
      // The business's own number is the forward-to destination only and
      // never renders here. (Pre-assignment the payload falls back to the
      // business's number as the only callable number that exists yet.)
      // Unconfigured (no number at all yet) renders nothing.
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
    if (type === 'datatables') {
      // Batch 88: handled before the generic empty check — the visitor
      // submit form renders even when the table has no rows yet.
      renderDataTable(el, data, html);
      return;
    }
    if (type === 'charts') {
      // Batch 90: handled before the generic empty check — the payload
      // carries computed charts (items stays empty by design).
      renderCharts(el, data, html);
      return;
    }
    if (type === 'newsletter') {
      // Batch 118: the signup block renders even with zero subscribers
      // (items stays empty by design — the list itself never ships).
      renderNewsletter(el, data);
      return;
    }
    if (type === 'photocapture') {
      // Batch 125: the capture form renders even with zero submissions;
      // the approved-photos grid joins it only when the owner enabled
      // it AND approved photos exist (payload items carry approved
      // photos only — pending/rejected never ship).
      renderPhotoCapture(el, data);
      return;
    }
    if (type === 'comments') {
      // Batch 131: the comments block — in page mode the thread rides
      // this payload; in item mode the thread arrives with the item
      // payload (renderItem). No thread here = dormant, renders
      // nothing (a block with comments off is equally silent).
      renderComments(el, data);
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
    if (type === 'categories' && !items.length) {
      // A Categories block with no published categories renders
      // nothing at all — dormant-empty, never a placeholder.
      el.innerHTML = '';
      return;
    }
    if (type === 'googlereviews') {
      // Dormant states (no platform key, no Place ID, nothing fetched,
      // or no reviews passing the filter) render nothing at all — the
      // payload omits the summary whenever there is nothing to show.
      var grData = data.googlereviews;
      if (!grData || !items.length) {
        el.innerHTML = '';
        return;
      }
      el.innerHTML = html + googleReviewsHtml(grData, items);
      return;
    }
    if (type === 'qrcode') {
      // One chosen code, resolved server-side at serve time; a code
      // whose target vanished arrives as no block at all and renders
      // nothing — never a broken image.
      var qrData = data.qrcode;
      if (!qrData || !qrData.image_url) {
        el.innerHTML = '';
        return;
      }
      el.innerHTML = html + qrCodeHtml(qrData);
      return;
    }
    if (!items.length) {
      el.innerHTML = html + renderEmpty(type);
      return;
    }
    if (type === 'gallery' && items.length === 1 && items[0].images) {
      el.innerHTML = html + renderAlbumDetail(items[0], false, data);
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
      // Batch 31 (C5): FAQPage JSON-LD from the payload's schema block,
      // built server-side from these same items.
      if (data.schema && data.schema['@type'] === 'FAQPage') {
        try {
          html +=
            '<script type="application/ld+json" data-bitpype-seo="faqpage">' +
            JSON.stringify(data.schema).replace(/</g, '\\u003c') +
            '</' +
            'script>';
        } catch (e) {
          /* schema is additive */
        }
      }
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
    if (type === 'categories') {
      // Batch 124: the taxonomy index — published categories grouped
      // by the module they belong to (their scope). Scope headings
      // show only when more than one scope is on display; the order
      // follows the payload's category_scopes when present.
      var scopeOrder = [];
      var scopeLabels = {};
      (Array.isArray(data.category_scopes) ? data.category_scopes : []).forEach(function (s) {
        if (s && s.scope && !scopeOrder.includes(s.scope)) {
          scopeOrder.push(s.scope);
          scopeLabels[s.scope] = s.label || s.scope;
        }
      });
      items.forEach(function (c) {
        if (c && c.scope && !scopeOrder.includes(c.scope)) scopeOrder.push(c.scope);
        if (c && c.scope && !scopeLabels[c.scope]) scopeLabels[c.scope] = c.scope_label || c.scope;
      });
      scopeOrder.forEach(function (scope) {
        var group = items.filter(function (c) {
          return c && c.scope === scope;
        });
        if (!group.length) return;
        if (scopeOrder.length > 1) {
          html += '<h3 class="bp-mod-cat-scope">' + esc(scopeLabels[scope] || scope) + '</h3>';
        }
        html += '<div class="bp-mod-grid">';
        group.forEach(function (c) {
          html += categoryCardHtml(c);
        });
        html += '</div>';
      });
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
          coverHtml(cardHref(key), it.cover_image, it.title) +
          '<div class="bp-mod-body"><h2><a href="' +
          esc(cardHref(key)) +
          '">' +
          esc(it.title) +
          '</a></h2>' +
          '<p class="bp-mod-meta">' +
          esc(dateLabel(it.published_at || it.created_at)) +
          '</p>' +
          (blogSet.show_excerpt && it.excerpt ? '<p class="bp-mod-excerpt">' + esc(it.excerpt) + '</p>' : '') +
          '</div></article>';
      } else if (type === 'ecommerce') {
        // Batch 127 + 128: with a Checkout module attached, a Stripe
        // product joins the shared cart (one checkout per site); the
        // button carries a DISPLAY snapshot (name/photo/price) for
        // the cart UI — the server re-prices every line from the
        // product row at checkout, always. A variant picker rides
        // along when the product has variants (unavailable options
        // disabled, the first available one preselected; a product
        // whose variants are ALL unavailable cannot be added).
        // Without a Checkout module, a variant product is bought on
        // its product page (options must be chosen first) — the
        // card links there instead of selling a default combination
        // sight unseen.
        var cartMode = !!(data.checkout_page && it.stripe_checkout);
        var variantPicker = '';
        var anyVariantAvailable = false;
        if (cartMode && Array.isArray(it.variants) && it.variants.length) {
          var seenAvailable = false;
          variantPicker =
            '<label class="bp-mod-variant">Option <select data-bp-variant-for="' +
            esc(it.id) +
            '">' +
            it.variants
              .map(function (v) {
                var attrs = '';
                if (!v.available) {
                  attrs += ' disabled';
                } else {
                  anyVariantAvailable = true;
                  if (!seenAvailable) {
                    attrs += ' selected';
                    seenAvailable = true;
                  }
                }
                return (
                  '<option value="' +
                  esc(v.id) +
                  '" data-label="' +
                  esc(v.label || '') +
                  '" data-price-cents="' +
                  (Number(v.price_cents) || 0) +
                  '"' +
                  attrs +
                  '>' +
                  esc(v.label || '') +
                  (v.price_label ? ' \u2014 ' + esc(v.price_label) : '') +
                  '</option>'
                );
              })
              .join('') +
            '</select></label>';
        }
        var buy = it.checkout_url
          ? '<a class="bp-mod-btn" href="' + esc(it.checkout_url) + '" target="_blank" rel="noopener">Buy</a>'
          : cartMode
            ? variantPicker +
              (Array.isArray(it.variants) && it.variants.length && !anyVariantAvailable
                ? '<button type="button" class="bp-mod-btn" disabled>Unavailable</button>'
                : '<button type="button" class="bp-mod-btn" data-bp-add="' +
                  esc(it.id) +
                  '" data-bp-name="' +
                  esc(it.name || '') +
                  '" data-bp-price="' +
                  (Number(it.price_cents) || 0) +
                  '" data-bp-currency="' +
                  esc(it.currency || 'USD') +
                  '" data-bp-image="' +
                  esc(it.image_url || '') +
                  '">Add to cart</button>')
            : it.has_variants
              ? '<a class="bp-mod-btn ghost" href="' + esc(cardHref(key)) + '">View</a>'
            : it.stripe_checkout
              ? '<button type="button" class="bp-mod-btn" data-bp-buy="' + esc(it.id) + '">Buy</button>'
              : '<a class="bp-mod-btn ghost" href="' + esc(cardHref(key)) + '">View</a>';
        html +=
          '<article class="bp-mod-card">' +
          coverHtml(cardHref(key), it.image_url, it.name) +
          '<div class="bp-mod-body"><h2><a href="' +
          esc(cardHref(key)) +
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
          coverHtml(cardHref(key), it.cover_image, it.title) +
          '<div class="bp-mod-body"><h2><a href="' +
          esc(cardHref(key)) +
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
          esc(cardHref(key)) +
          '">View course</a></div></article>';
      } else if (type === 'gallery') {
        var cover = (it.images && it.images[0] && it.images[0].image_url) || '';
        var count = (it.images || []).length;
        html +=
          '<article class="bp-mod-card">' +
          coverHtml(cardHref(key), cover, it.title) +
          '<div class="bp-mod-body"><h2><a href="' +
          esc(cardHref(key)) +
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
          coverHtml(cardHref(key), it.image_url, it.name) +
          '<div class="bp-mod-body"><h2><a href="' +
          esc(cardHref(key)) +
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
          coverHtml(cardHref(key), it.image_url, it.title) +
          '<div class="bp-mod-body"><h2><a href="' +
          esc(cardHref(key)) +
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

  // SMS policy consent line (Batch 77): the payload's sms_policy block
  // (server/smsPolicy.js) rendered as small print under the opt-in
  // checkbox — disclosure only, never an input, never required.
  function smsPolicyRow(data) {
    return data.sms_policy && data.sms_policy.html
      ? '<div class="bp-mod-book-row"><p class="bp-sms-policy-note">' + data.sms_policy.html + '</p></div>'
      : '';
  }

  function renderBookings(el, data, prefixHtml) {
    // Batch 129 — post-payment return for pay-at-booking: the visitor
    // lands back on this page with order=success&session_id=… after
    // paying through the shared checkout engine. Confirm via the
    // same lead-scoped order-status endpoint the shop uses; the
    // appointment itself converges through the webhook.
    var bq = null;
    try {
      bq = new URLSearchParams(window.location.search);
    } catch (e) {
      bq = null;
    }
    var bOrder = bq && bq.get('order');
    var bSid = bq && bq.get('session_id');
    if (bOrder === 'success' && bSid) {
      var bToken = el.getAttribute(TOKEN_ATTR) || '';
      var bBase = apiBase(el);
      el.innerHTML = (prefixHtml || '') + '<p class="bp-mod-loading">Confirming your payment…</p>';
      fetch(
        (bBase || '') +
          '/api/v1/modules/public/' +
          encodeURIComponent(bToken) +
          '/order-status?session_id=' +
          encodeURIComponent(bSid),
        { credentials: 'omit', headers: authHeaders() }
      )
        .then(function (r) {
          return r.json();
        })
        .then(function (j) {
          var paid = j && j.ok && j.data && j.data.status === 'paid';
          el.innerHTML =
            (prefixHtml || '') +
            '<div class="bp-mod-empty-card"><p class="bp-mod-empty-kicker">Booked</p>' +
            '<p class="bp-mod-empty-title">' +
            (paid
              ? 'Payment received — your appointment is booked.'
              : 'Payment is processing — your appointment will be confirmed as soon as it settles.') +
            '</p></div>';
        })
        .catch(function () {
          el.innerHTML =
            (prefixHtml || '') +
            '<div class="bp-mod-empty-card"><p class="bp-mod-empty-kicker">Booked</p>' +
            '<p class="bp-mod-empty-title">Payment is processing — your appointment will be confirmed as soon as it settles.</p></div>';
        });
      return;
    }
    if (bOrder === 'cancelled') {
      prefixHtml =
        (prefixHtml || '') +
        '<p class="bp-mod-err">That payment did not complete — the time slot was released. Please pick a time and try again.</p>';
    }
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
      // SMS opt-in (Batch 25): unchecked by default, never required.
      (data.sms_optin && data.sms_optin.label
        ? '<div class="bp-mod-book-row"><label class="bp-mod-check"><input type="checkbox" name="sms_optin_consent" /> ' +
          esc(data.sms_optin.label) +
          '</label></div>'
        : '') +
      smsPolicyRow(data) +
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
          var smsConsent = form.querySelector('[name="sms_optin_consent"]');
          var body = {
            service_id: Number(form.service_id.value),
            starts_at: selectedSlot,
            customer_name: form.customer_name.value,
            customer_email: email,
            customer_phone: phone,
            notes: form.notes.value,
            sms_optin_consent: !!(smsConsent && smsConsent.checked),
            captchaToken: captchaToken,
            // Batch 129: pay-at-booking returns to this page.
            return_url: window.location.href.split('#')[0],
          };
          var r = await fetch((base || '') + '/api/v1/modules/public/' + encodeURIComponent(token) + '/book', {
            method: 'POST',
            credentials: 'omit',
            headers: jsonHeaders(),
            body: JSON.stringify(body),
          });
          var j = await r.json();
          if (!r.ok || !j || !j.ok) throw new Error((j && j.error) || 'Booking failed');
          // Batch 129: a priced booking on a payments-connected site
          // answers with a checkout URL — hand the visitor to the
          // shared checkout engine; payment settles the appointment.
          if (j.data && j.data.payment && j.data.payment.url) {
            if (bookMsg) bookMsg.textContent = 'Taking you to secure payment…';
            window.location.href = j.data.payment.url;
            return;
          }
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

  /* ── Data Tables (Batch 88) ──
   * One dataset, four presentations (table / wall / results / list)
   * chosen per instance in its config, plus an optional visitor
   * submit form. State lives on el._bpDt; search / sort / paging are
   * client-side over the served rows (published only — the server
   * never sends pending submissions). */
  function dtDateLabel(v) {
    var s = String(v || '');
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) {
      try {
        return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString(undefined, {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        });
      } catch (e) {
        return s;
      }
    }
    return dateLabel(s);
  }

  function dtCellText(col, v) {
    if (v == null || v === '') return '';
    if (!col) return String(v);
    if (col.type === 'boolean') return v ? 'Yes' : 'No';
    if (col.type === 'currency') {
      var c = Number(v);
      return isNaN(c) ? String(v) : '$' + c.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    if (col.type === 'number') {
      var n = Number(v);
      return isNaN(n) ? String(v) : n.toLocaleString('en-US');
    }
    if (col.type === 'date') return dtDateLabel(v);
    if (col.type === 'link') {
      if (typeof v === 'object') return String(v.label || v.url || '');
      return String(v);
    }
    return String(v);
  }

  function dtLinkParts(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'object') {
      if (!v.url) return null;
      return { url: String(v.url), label: String(v.label || v.url) };
    }
    var s = String(v);
    return { url: s, label: s };
  }

  function dtCellHtml(col, v) {
    if (col && col.type === 'link') {
      var parts = dtLinkParts(v);
      if (!parts) return '';
      return '<a href="' + esc(parts.url) + '" target="_blank" rel="noopener">' + esc(parts.label) + '</a>';
    }
    return esc(dtCellText(col, v));
  }

  function dtImageUrl(v) {
    var parts = dtLinkParts(v);
    var url = parts ? parts.url : v == null ? '' : String(v);
    if (!url) return '';
    if (/^data:image\//i.test(url)) return url;
    if (/\.(png|jpe?g|gif|webp|svg|avif)(\?|#|$)/i.test(url)) return url;
    return '';
  }

  /* CHART-SVG-BEGIN — pure chart markup builders (Batch 90). These
   * functions are deliberately self-contained (own escaping, no DOM)
   * so the regression suite can extract and execute them in Node.
   * Charts render as inline SVG — no external chart library — so a
   * client site stays fully self-contained. */
  function chartEscText(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function chartNum(v) {
    var n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  function chartFmtNum(v) {
    var r = Math.round(chartNum(v) * 100) / 100;
    var neg = r < 0;
    var parts = String(Math.abs(r)).split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '-' : '') + parts.join('.');
  }
  function chartColorAt(colors, i) {
    var list = Array.isArray(colors) && colors.length ? colors : ['#0e7a68', '#e8873a', '#3a6ea8', '#b04a6e'];
    return list[i % list.length];
  }
  function chartTrunc(s, n) {
    var str = String(s == null ? '' : s);
    return str.length > n ? str.slice(0, n - 1) + '…' : str;
  }
  function chartDesc(chart) {
    var labels = Array.isArray(chart.labels) ? chart.labels : [];
    var series = Array.isArray(chart.series) ? chart.series : [];
    var first = series[0];
    var bits = [];
    if (first) {
      for (var i = 0; i < labels.length && i < 12; i++) {
        bits.push(String(labels[i]) + ': ' + chartFmtNum(first.values ? first.values[i] : 0));
      }
    }
    return (chart.chart_type || 'chart') + ' chart. ' + bits.join(', ');
  }
  function chartScale(values) {
    var min = 0;
    var max = 0;
    values.forEach(function (v) {
      var n = chartNum(v);
      if (n < min) min = n;
      if (n > max) max = n;
    });
    if (max - min < 1e-9) max = min + 1;
    return { min: min, max: max };
  }
  function chartPieSvg(chart, W, H) {
    var series = Array.isArray(chart.series) ? chart.series : [];
    var labels = Array.isArray(chart.labels) ? chart.labels : [];
    var values = series.length ? series[0].values || [] : [];
    var vals = labels.map(function (_, i) {
      return Math.max(0, chartNum(values[i]));
    });
    var total = vals.reduce(function (a, b) {
      return a + b;
    }, 0);
    var cx = W / 2;
    var cy = H / 2;
    var R = 148;
    var inner = chart.chart_type === 'doughnut' ? 86 : 0;
    var out = '';
    if (total <= 0) {
      return (
        '<text x="' + cx + '" y="' + cy + '" text-anchor="middle" class="bp-chart-tick">No data yet</text>'
      );
    }
    var nonZero = vals.filter(function (v) {
      return v > 0;
    }).length;
    if (nonZero === 1) {
      var only = vals.indexOf(Math.max.apply(null, vals));
      var col = chartColorAt(chart.colors, only);
      if (inner) {
        out +=
          '<path fill="' + col + '" fill-rule="evenodd" d="M ' + (cx - R) + ',' + cy +
          ' a ' + R + ',' + R + ' 0 1,0 ' + 2 * R + ',0 a ' + R + ',' + R + ' 0 1,0 ' + -2 * R + ',0' +
          ' M ' + (cx - inner) + ',' + cy +
          ' a ' + inner + ',' + inner + ' 0 1,0 ' + 2 * inner + ',0 a ' + inner + ',' + inner + ' 0 1,0 ' + -2 * inner + ',0"/>';
      } else {
        out += '<circle cx="' + cx + '" cy="' + cy + '" r="' + R + '" fill="' + col + '"/>';
      }
      return out;
    }
    var acc = -Math.PI / 2;
    vals.forEach(function (v, i) {
      if (v <= 0) return;
      var frac = v / total;
      var a0 = acc;
      var a1 = acc + frac * Math.PI * 2;
      acc = a1;
      var large = frac > 0.5 ? 1 : 0;
      var x0 = cx + R * Math.cos(a0);
      var y0 = cy + R * Math.sin(a0);
      var x1 = cx + R * Math.cos(a1);
      var y1 = cy + R * Math.sin(a1);
      var d;
      if (inner) {
        var ix0 = cx + inner * Math.cos(a0);
        var iy0 = cy + inner * Math.sin(a0);
        var ix1 = cx + inner * Math.cos(a1);
        var iy1 = cy + inner * Math.sin(a1);
        d =
          'M ' + x0.toFixed(2) + ',' + y0.toFixed(2) +
          ' A ' + R + ',' + R + ' 0 ' + large + ' 1 ' + x1.toFixed(2) + ',' + y1.toFixed(2) +
          ' L ' + ix1.toFixed(2) + ',' + iy1.toFixed(2) +
          ' A ' + inner + ',' + inner + ' 0 ' + large + ' 0 ' + ix0.toFixed(2) + ',' + iy0.toFixed(2) + ' Z';
      } else {
        d =
          'M ' + cx + ',' + cy +
          ' L ' + x0.toFixed(2) + ',' + y0.toFixed(2) +
          ' A ' + R + ',' + R + ' 0 ' + large + ' 1 ' + x1.toFixed(2) + ',' + y1.toFixed(2) + ' Z';
      }
      out += '<path d="' + d + '" fill="' + chartColorAt(chart.colors, i) + '"/>';
      if (chart.show_values && frac >= 0.05) {
        var mid = (a0 + a1) / 2;
        var lr = inner ? (R + inner) / 2 : R * 0.62;
        var lx = cx + lr * Math.cos(mid);
        var ly = cy + lr * Math.sin(mid);
        out +=
          '<text x="' + lx.toFixed(2) + '" y="' + ly.toFixed(2) + '" text-anchor="middle" dy="0.35em" class="bp-chart-val" fill="#fff">' +
          Math.round(frac * 100) + '%</text>';
      }
    });
    return out;
  }
  function chartCartesianSvg(chart, W) {
    var labels = Array.isArray(chart.labels) ? chart.labels : [];
    var series = Array.isArray(chart.series) ? chart.series : [];
    var type = chart.chart_type || 'bar';
    var all = [];
    series.forEach(function (s) {
      (s.values || []).forEach(function (v) {
        all.push(v);
      });
    });
    var scale = chartScale(all);
    var out = '';
    var i, j;
    if (type === 'hbar') {
      var rowH = series.length * 24 + 16;
      var Hh = 26 + labels.length * rowH + 34;
      var ml = 148, mr = 48, mt = 6, mb = 30;
      var pw = W - ml - mr;
      var ph = Hh - mt - mb;
      var xs = function (v) {
        return ml + ((chartNum(v) - scale.min) / (scale.max - scale.min)) * pw;
      };
      for (i = 0; i <= 4; i++) {
        var tv = scale.min + ((scale.max - scale.min) * i) / 4;
        var tx = xs(tv);
        out += '<line x1="' + tx.toFixed(1) + '" y1="' + mt + '" x2="' + tx.toFixed(1) + '" y2="' + (mt + ph) + '" class="bp-chart-grid"/>';
        out +=
          '<text x="' + tx.toFixed(1) + '" y="' + (mt + ph + 20) + '" text-anchor="middle" class="bp-chart-tick">' +
          chartEscText(chartFmtNum(tv)) + '</text>';
      }
      labels.forEach(function (label, li) {
        var gy = mt + li * rowH;
        out +=
          '<text x="' + (ml - 10) + '" y="' + (gy + rowH / 2) + '" text-anchor="end" dy="0.35em" class="bp-chart-tick">' +
          chartEscText(chartTrunc(label, 18)) + '</text>';
        series.forEach(function (s, si) {
          var v = chartNum(s.values ? s.values[li] : 0);
          var by = gy + 6 + si * 24;
          var x0 = xs(Math.min(0, v));
          var x1 = xs(Math.max(0, v));
          out +=
            '<rect x="' + x0.toFixed(1) + '" y="' + by + '" width="' + Math.max(1.5, x1 - x0).toFixed(1) +
            '" height="17" rx="3" fill="' + chartColorAt(chart.colors, si) + '"/>';
          if (chart.show_values) {
            var vx = v >= 0 ? x1 + 6 : x0 - 6;
            out +=
              '<text x="' + vx.toFixed(1) + '" y="' + (by + 8.5) + '" dy="0.35em" text-anchor="' + (v >= 0 ? 'start' : 'end') +
              '" class="bp-chart-val">' + chartEscText(chartFmtNum(v)) + '</text>';
          }
        });
      });
      return { svg: out, height: Hh };
    }
    var H = 380;
    var m = { l: 58, r: 14, t: 16, b: 54 };
    var plotW = W - m.l - m.r;
    var plotH = H - m.t - m.b;
    var ys = function (v) {
      return m.t + plotH - ((chartNum(v) - scale.min) / (scale.max - scale.min)) * plotH;
    };
    for (i = 0; i <= 4; i++) {
      var gv = scale.min + ((scale.max - scale.min) * i) / 4;
      var gy2 = ys(gv);
      out +=
        '<line x1="' + m.l + '" y1="' + gy2.toFixed(1) + '" x2="' + (m.l + plotW) + '" y2="' + gy2.toFixed(1) +
        '" class="' + (Math.abs(gv) < 1e-9 ? 'bp-chart-axis' : 'bp-chart-grid') + '"/>';
      out +=
        '<text x="' + (m.l - 8) + '" y="' + gy2.toFixed(1) + '" text-anchor="end" dy="0.35em" class="bp-chart-tick">' +
        chartEscText(chartFmtNum(gv)) + '</text>';
    }
    var groupW = labels.length ? plotW / labels.length : plotW;
    labels.forEach(function (label, li) {
      var cxp = m.l + groupW * (li + 0.5);
      out +=
        '<text x="' + cxp.toFixed(1) + '" y="' + (m.t + plotH + 22) + '" text-anchor="middle" class="bp-chart-tick">' +
        chartEscText(chartTrunc(label, 12)) + '</text>';
    });
    if (type === 'bar') {
      var barArea = groupW * 0.72;
      var barW = series.length ? barArea / series.length : barArea;
      labels.forEach(function (_, li) {
        series.forEach(function (s, si) {
          var v = chartNum(s.values ? s.values[li] : 0);
          var bx = m.l + groupW * li + (groupW - barArea) / 2 + si * barW;
          var yTop = ys(Math.max(0, v));
          var yBot = ys(Math.min(0, v));
          out +=
            '<rect x="' + bx.toFixed(1) + '" y="' + yTop.toFixed(1) + '" width="' + Math.max(1.5, barW - 2).toFixed(1) +
            '" height="' + Math.max(1, yBot - yTop).toFixed(1) + '" rx="3" fill="' + chartColorAt(chart.colors, si) + '"/>';
          if (chart.show_values) {
            out +=
              '<text x="' + (bx + barW / 2).toFixed(1) + '" y="' + (yTop - 5).toFixed(1) + '" text-anchor="middle" class="bp-chart-val">' +
              chartEscText(chartFmtNum(v)) + '</text>';
          }
        });
      });
    } else {
      // line + area share the point geometry.
      series.forEach(function (s, si) {
        var pts = labels.map(function (_, li) {
          var px = labels.length > 1 ? m.l + groupW * (li + 0.5) : m.l + plotW / 2;
          return [px, ys(s.values ? s.values[li] : 0)];
        });
        var col = chartColorAt(chart.colors, si);
        if (type === 'area' && pts.length) {
          var baseY = ys(0);
          var d = 'M ' + pts[0][0].toFixed(1) + ',' + pts[0][1].toFixed(1);
          for (j = 1; j < pts.length; j++) d += ' L ' + pts[j][0].toFixed(1) + ',' + pts[j][1].toFixed(1);
          d += ' L ' + pts[pts.length - 1][0].toFixed(1) + ',' + baseY.toFixed(1) + ' L ' + pts[0][0].toFixed(1) + ',' + baseY.toFixed(1) + ' Z';
          out += '<path d="' + d + '" fill="' + col + '" fill-opacity="0.22" stroke="none"/>';
        }
        if (pts.length) {
          out +=
            '<polyline fill="none" stroke="' + col + '" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" points="' +
            pts.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ') + '"/>';
          pts.forEach(function (p, li) {
            out += '<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="3.5" fill="' + col + '"/>';
            if (chart.show_values) {
              out +=
                '<text x="' + p[0].toFixed(1) + '" y="' + (p[1] - 9).toFixed(1) + '" text-anchor="middle" class="bp-chart-val">' +
                chartEscText(chartFmtNum(s.values ? s.values[li] : 0)) + '</text>';
            }
          });
        }
      });
    }
    return { svg: out, height: H };
  }
  function chartSvgMarkup(chart) {
    var W = 720;
    var isPie = chart.chart_type === 'pie' || chart.chart_type === 'doughnut';
    var body;
    var H;
    if (isPie) {
      H = 380;
      body = chartPieSvg(chart, W, H);
    } else {
      var built = chartCartesianSvg(chart, W);
      body = built.svg;
      H = built.height;
    }
    return (
      '<svg class="bp-mod-chart-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' +
      chartEscText(chart.title || 'Chart') + '"><title>' + chartEscText(chart.title || 'Chart') + '</title><desc>' +
      chartEscText(chartDesc(chart)) + '</desc>' + body + '</svg>'
    );
  }
  function chartLegendHtml(chart) {
    if (chart.show_legend === false) return '';
    var labels = Array.isArray(chart.labels) ? chart.labels : [];
    var series = Array.isArray(chart.series) ? chart.series : [];
    var isPie = chart.chart_type === 'pie' || chart.chart_type === 'doughnut';
    var items = '';
    var i;
    if (isPie) {
      var values = series.length ? series[0].values || [] : [];
      var total = 0;
      for (i = 0; i < labels.length; i++) total += Math.max(0, chartNum(values[i]));
      for (i = 0; i < labels.length; i++) {
        var v = Math.max(0, chartNum(values[i]));
        items +=
          '<li><span class="bp-mod-chart-dot" style="background:' + chartColorAt(chart.colors, i) + '"></span>' +
          chartEscText(labels[i]) +
          (chart.show_values && total > 0
            ? ' — ' + chartEscText(chartFmtNum(v)) + ' (' + Math.round((v / total) * 100) + '%)'
            : '') +
          '</li>';
      }
    } else {
      if (series.length < 2) return '';
      for (i = 0; i < series.length; i++) {
        items +=
          '<li><span class="bp-mod-chart-dot" style="background:' + chartColorAt(chart.colors, i) + '"></span>' +
          chartEscText(series[i].name || 'Series ' + (i + 1)) + '</li>';
      }
    }
    return items ? '<ul class="bp-mod-chart-legend">' + items + '</ul>' : '';
  }
  /* CHART-SVG-END */

  // Batch 118 — Newsletter signup block. Built with DOM APIs only (no
  // innerHTML): the SEC-13 sink census pins the client surfaces, and a
  // form needs no markup strings anyway. The form carries .bp-mod-book
  // so its fields/buttons reuse the booking form's styling in the
  // site's own design tokens.
  function renderNewsletter(el, data) {
    var cfg = data.newsletter || {};
    var token = el.getAttribute(TOKEN_ATTR) || '';
    var base = apiBase(el);
    el.textContent = '';
    if (shouldShowTitle(el)) {
      var title = document.createElement('h2');
      title.className = 'bp-mod-title';
      title.textContent = data.title || 'Newsletter';
      el.appendChild(title);
    }
    var card = document.createElement('div');
    card.className = 'bp-mod-news-card';
    var heading = document.createElement('h3');
    heading.className = 'bp-mod-news-heading';
    heading.textContent = cfg.heading || 'Join our newsletter';
    card.appendChild(heading);
    if (cfg.blurb) {
      var blurb = document.createElement('p');
      blurb.className = 'bp-mod-news-blurb';
      blurb.textContent = cfg.blurb;
      card.appendChild(blurb);
    }
    var form = document.createElement('form');
    form.className = 'bp-mod-book bp-mod-news-form';
    form.setAttribute('data-bp-newsletter', '1');

    var nameRow = document.createElement('div');
    nameRow.className = 'bp-mod-book-row';
    var nameLabel = document.createElement('label');
    nameLabel.textContent = 'Name (optional)';
    var nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.name = 'name';
    nameInput.autocomplete = 'name';
    nameLabel.appendChild(nameInput);
    nameRow.appendChild(nameLabel);
    form.appendChild(nameRow);

    var emailRow = document.createElement('div');
    emailRow.className = 'bp-mod-book-row';
    var emailLabel = document.createElement('label');
    emailLabel.textContent = 'Email';
    var emailInput = document.createElement('input');
    emailInput.type = 'email';
    emailInput.name = 'email';
    emailInput.required = true;
    emailInput.autocomplete = 'email';
    emailLabel.appendChild(emailInput);
    emailRow.appendChild(emailLabel);
    form.appendChild(emailRow);

    var captchaBox = document.createElement('div');
    captchaBox.setAttribute('data-bp-captcha', '');
    form.appendChild(captchaBox);

    var msg = document.createElement('p');
    msg.className = 'bp-mod-book-msg';
    msg.setAttribute('data-nl-msg', '');
    form.appendChild(msg);

    var submitBtn = document.createElement('button');
    submitBtn.type = 'submit';
    submitBtn.className = 'bp-mod-btn';
    submitBtn.textContent = cfg.button_label || 'Subscribe';
    form.appendChild(submitBtn);

    card.appendChild(form);
    el.appendChild(card);

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

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var name = nameInput.value.trim();
      var email = emailInput.value.trim();
      if (!email) {
        msg.textContent = 'Please enter your email address.';
        msg.className = 'bp-mod-book-msg err';
        return;
      }
      submitBtn.disabled = true;
      msg.textContent = 'Signing you up…';
      msg.className = 'bp-mod-book-msg';
      (async function () {
        try {
          var captchaToken = await captcha.getToken();
          var r = await fetch((base || '') + '/api/v1/modules/public/' + encodeURIComponent(token) + '/newsletter/subscribe', {
            method: 'POST',
            credentials: 'omit',
            headers: jsonHeaders(),
            body: JSON.stringify({ name: name, email: email, captchaToken: captchaToken }),
          });
          var j = await r.json();
          if (!r.ok || !j || !j.ok) throw new Error((j && j.error) || 'Could not sign you up');
          card.textContent = '';
          var done = document.createElement('div');
          var kicker = document.createElement('p');
          kicker.className = 'bp-mod-empty-kicker';
          kicker.textContent = "You're in";
          var doneTitle = document.createElement('p');
          doneTitle.className = 'bp-mod-empty-title';
          doneTitle.textContent = (j.data && j.data.message) || 'Thanks — your signup was received.';
          var doneText = document.createElement('p');
          doneText.className = 'bp-mod-empty-text';
          doneText.textContent = 'Watch your inbox for the next issue.';
          done.appendChild(kicker);
          done.appendChild(doneTitle);
          done.appendChild(doneText);
          card.appendChild(done);
        } catch (e) {
          msg.textContent = (e.message || 'Could not sign you up') + ' — please try again.';
          msg.className = 'bp-mod-book-msg err';
          if (captcha.reset) captcha.reset();
        } finally {
          submitBtn.disabled = false;
        }
      })();
    });
  }

  // Batch 125 — Photo Capture. DOM APIs only, like the newsletter
  // form (SEC-13 sink census). The file input carries
  // capture="environment" so phones offer the camera first; the plain
  // file picker is always there as the fallback. The photo rides to
  // the server as a data URL and is stored by the platform's image
  // pipeline; the response is state-blind (the same thanks whatever
  // moderation decides), so the success copy comes from the server.
  function renderPhotoCapture(el, data) {
    var pc = data.photocapture || {};
    var cfg = pc.config || {};
    var token = el.getAttribute(TOKEN_ATTR) || '';
    var base = apiBase(el);
    el.textContent = '';
    if (shouldShowTitle(el)) {
      var title = document.createElement('h2');
      title.className = 'bp-mod-title';
      title.textContent = data.title || 'Photo Capture';
      el.appendChild(title);
    }
    var card = document.createElement('div');
    card.className = 'bp-mod-news-card';
    var heading = document.createElement('h3');
    heading.className = 'bp-mod-news-heading';
    heading.textContent = cfg.heading || 'Share your photo';
    card.appendChild(heading);
    if (cfg.intro) {
      var intro = document.createElement('p');
      intro.className = 'bp-mod-news-blurb';
      intro.textContent = cfg.intro;
      card.appendChild(intro);
    }
    var form = document.createElement('form');
    form.className = 'bp-mod-book bp-mod-photo-form';
    form.setAttribute('data-bp-photocapture', '1');

    function fieldRow(labelText, input, required) {
      var row = document.createElement('div');
      row.className = 'bp-mod-book-row';
      var label = document.createElement('label');
      label.textContent = labelText;
      if (required) input.required = true;
      label.appendChild(input);
      row.appendChild(label);
      return row;
    }

    var photoInput = document.createElement('input');
    photoInput.type = 'file';
    photoInput.name = 'photo';
    photoInput.accept = 'image/*';
    photoInput.setAttribute('capture', 'environment');
    form.appendChild(fieldRow('Your photo', photoInput, true));
    var preview = document.createElement('div');
    preview.className = 'bp-mod-photo-preview';
    var previewImg = document.createElement('img');
    previewImg.alt = 'Your photo';
    preview.appendChild(previewImg);
    form.appendChild(preview);

    var nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.name = 'name';
    nameInput.autocomplete = 'name';
    form.appendChild(fieldRow('Your name', nameInput, true));

    var emailInput = document.createElement('input');
    emailInput.type = 'email';
    emailInput.name = 'email';
    emailInput.autocomplete = 'email';
    form.appendChild(fieldRow('Email', emailInput, false));

    var phoneInput = document.createElement('input');
    phoneInput.type = 'tel';
    phoneInput.name = 'phone';
    phoneInput.autocomplete = 'tel';
    form.appendChild(fieldRow('Phone (email or phone — one is enough)', phoneInput, false));

    var messageInput = document.createElement('textarea');
    messageInput.name = 'message';
    messageInput.rows = 3;
    form.appendChild(fieldRow('Message (optional)', messageInput, false));

    var captchaBox = document.createElement('div');
    captchaBox.setAttribute('data-bp-captcha', '');
    form.appendChild(captchaBox);

    var msg = document.createElement('p');
    msg.className = 'bp-mod-book-msg';
    msg.setAttribute('data-pc-msg', '');
    form.appendChild(msg);

    var submitBtn = document.createElement('button');
    submitBtn.type = 'submit';
    submitBtn.className = 'bp-mod-btn';
    submitBtn.textContent = cfg.submit_label || 'Send photo';
    form.appendChild(submitBtn);

    card.appendChild(form);
    el.appendChild(card);

    var photoDataUrl = '';
    photoInput.addEventListener('change', function () {
      var file = photoInput.files && photoInput.files[0];
      photoDataUrl = '';
      preview.style.display = 'none';
      if (!file) return;
      if (file.size > 5.5 * 1024 * 1024) {
        msg.textContent = 'That photo is too large — please pick one under 5 MB.';
        msg.className = 'bp-mod-book-msg err';
        return;
      }
      var reader = new FileReader();
      reader.onload = function () {
        photoDataUrl = String(reader.result || '');
        if (photoDataUrl) {
          previewImg.src = photoDataUrl;
          preview.style.display = 'block';
        }
      };
      reader.readAsDataURL(file);
    });

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

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var name = nameInput.value.trim();
      var email = emailInput.value.trim();
      var phone = phoneInput.value.trim();
      var message = messageInput.value.trim();
      if (!photoDataUrl) {
        msg.textContent = 'Please take or choose a photo first.';
        msg.className = 'bp-mod-book-msg err';
        return;
      }
      if (!name) {
        msg.textContent = 'Please add your name.';
        msg.className = 'bp-mod-book-msg err';
        return;
      }
      if (!email && !phone) {
        msg.textContent = 'Please add an email address or a phone number.';
        msg.className = 'bp-mod-book-msg err';
        return;
      }
      submitBtn.disabled = true;
      msg.textContent = 'Sending your photo…';
      msg.className = 'bp-mod-book-msg';
      (async function () {
        try {
          var captchaToken = await captcha.getToken();
          var r = await fetch(
            (base || '') +
              '/api/v1/modules/public/' +
              encodeURIComponent(token) +
              '/photocapture?' +
              pageQuery(),
            {
              method: 'POST',
              credentials: 'omit',
              headers: jsonHeaders(),
              body: JSON.stringify({
                name: name,
                email: email,
                phone: phone,
                message: message,
                image: photoDataUrl,
                captchaToken: captchaToken,
              }),
            }
          );
          var j = await r.json();
          if (!r.ok || !j || !j.ok) throw new Error((j && j.error) || 'Could not send your photo');
          card.textContent = '';
          var done = document.createElement('div');
          var kicker = document.createElement('p');
          kicker.className = 'bp-mod-empty-kicker';
          kicker.textContent = 'Photo received';
          var doneTitle = document.createElement('p');
          doneTitle.className = 'bp-mod-empty-title';
          doneTitle.textContent = (j.data && j.data.message) || 'Thanks — your photo is in.';
          done.appendChild(kicker);
          done.appendChild(doneTitle);
          card.appendChild(done);
        } catch (e) {
          msg.textContent = (e.message || 'Could not send your photo') + ' — please try again.';
          msg.className = 'bp-mod-book-msg err';
          if (captcha.reset) captcha.reset();
        } finally {
          submitBtn.disabled = false;
        }
      })();
    });

    // Optional public grid of APPROVED photos (owner-enabled). Items
    // arrive approved-only from the server; with the grid off or no
    // approved photos yet, nothing renders here (dormant-empty).
    var items = Array.isArray(pc.items) ? pc.items : [];
    if (cfg.show_approved && items.length) {
      var grid = document.createElement('div');
      grid.className = 'bp-mod-photo-grid';
      items.forEach(function (it) {
        if (!it || !it.image_url) return;
        var cell = document.createElement('figure');
        cell.className = 'bp-mod-photo-cell';
        var img = document.createElement('img');
        img.src = String(it.image_url);
        img.alt = it.caption || it.name || 'Customer photo';
        img.loading = 'lazy';
        cell.appendChild(img);
        if (it.caption) {
          var cap = document.createElement('figcaption');
          cap.textContent = String(it.caption);
          cell.appendChild(cap);
        }
        grid.appendChild(cell);
      });
      if (grid.childNodes.length) el.appendChild(grid);
    }
  }

  /* ── Comments (Batch 131) ──────────────────────────────────────
   * One block, two bindings (server config target_mode): 'page' —
   * the thread belongs to the page itself (guestbook-style); 'item'
   * — the thread belongs to the item the page is showing (a blog
   * post, product, event, album…), resolved server-side through the
   * shared module layer, so the like count painted here is THE
   * item's count from the one likes store.
   *
   * Everything a visitor wrote is rendered with textContent only —
   * comment bodies are plain text end to end, never HTML.
   *
   * Visitor identity for likes is a first-party random token kept in
   * localStorage ('bp_visitor_token'); only its hash ever reaches
   * the server's store. It is minted lazily — on the first like or
   * comment — so a read-only visit stores nothing. */
  var VISITOR_TOKEN_KEY = 'bp_visitor_token';

  function peekVisitorToken() {
    try {
      return window.localStorage.getItem(VISITOR_TOKEN_KEY) || '';
    } catch (e) {
      return '';
    }
  }

  function visitorToken() {
    var existing = peekVisitorToken();
    if (existing) return existing;
    var token = '';
    try {
      var bytes = new Uint8Array(16);
      if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
      else for (var i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
      token = Array.prototype.map
        .call(bytes, function (b) {
          return ('0' + b.toString(16)).slice(-2);
        })
        .join('');
      window.localStorage.setItem(VISITOR_TOKEN_KEY, token);
    } catch (e) {
      /* storage unavailable — likes still count under the server-side fallback bucket */
    }
    return token;
  }

  function renderComments(el, data) {
    var block = data.comments || {};
    var cfg = block.config || {};
    var thread = block.thread || null;
    var token = el.getAttribute(TOKEN_ATTR) || '';
    var base = apiBase(el);
    el.textContent = '';
    if (!cfg.comments_enabled || !thread || !thread.target) return; // dormant
    var target = thread.target;

    var wrap = document.createElement('div');
    wrap.className = 'bp-mod-comments';
    el.appendChild(wrap);

    var head = document.createElement('div');
    head.className = 'bp-mod-comments-head';
    var heading = document.createElement('h3');
    heading.className = 'bp-mod-news-heading';
    heading.textContent = cfg.heading || data.title || 'Comments';
    head.appendChild(heading);
    wrap.appendChild(head);

    var captcha = {
      enabled: false,
      getToken: async function () {
        return '';
      },
      reset: function () {},
    };

    function likeButton(targetType, targetId, count) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'bp-mod-like-btn';
      btn.setAttribute('data-bp-like-type', String(targetType));
      btn.setAttribute('data-bp-like-id', String(targetId));
      var heart = document.createElement('span');
      heart.className = 'bp-mod-like-heart';
      heart.textContent = '♥';
      var num = document.createElement('span');
      num.className = 'bp-mod-like-count';
      num.textContent = String(count || 0);
      btn.appendChild(heart);
      btn.appendChild(num);
      btn.setAttribute('aria-label', 'Like');
      btn.addEventListener('click', function () {
        btn.disabled = true;
        (async function () {
          try {
            var r = await fetch(
              (base || '') + '/api/v1/modules/public/' + encodeURIComponent(token) + '/comments/like?' + pageQuery(),
              {
                method: 'POST',
                credentials: 'omit',
                headers: jsonHeaders(),
                body: JSON.stringify({
                  target_type: targetType,
                  target_id: targetId,
                  visitor_token: visitorToken(),
                }),
              }
            );
            var j = await r.json();
            if (!r.ok || !j || !j.ok) throw new Error((j && j.error) || 'Could not save your like');
            num.textContent = String(j.data.count || 0);
            btn.classList.toggle('liked', !!j.data.liked);
          } catch (e) {
            /* a failed like leaves the painted state untouched */
          } finally {
            btn.disabled = false;
          }
        })();
      });
      return btn;
    }

    // The item's own like — the count from the one shared store.
    if (cfg.allow_likes && cfg.allow_item_like) {
      head.appendChild(likeButton(target.target_type, target.target_id, thread.like_count));
    }

    var list = document.createElement('div');
    list.className = 'bp-mod-comments-list';
    wrap.appendChild(list);

    function commentForm(parentId) {
      var form = document.createElement('form');
      form.className = 'bp-mod-book bp-mod-comment-form';
      if (parentId != null) form.classList.add('bp-mod-reply-form');
      function fieldRow(labelText, input, required) {
        var row = document.createElement('div');
        row.className = 'bp-mod-book-row';
        var label = document.createElement('label');
        label.textContent = labelText;
        if (required) input.required = true;
        label.appendChild(input);
        row.appendChild(label);
        return row;
      }
      var nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.name = 'name';
      nameInput.autocomplete = 'name';
      nameInput.maxLength = 80;
      form.appendChild(fieldRow('Your name', nameInput, true));
      var emailInput = document.createElement('input');
      emailInput.type = 'email';
      emailInput.name = 'email';
      emailInput.autocomplete = 'email';
      emailInput.maxLength = 240;
      form.appendChild(fieldRow('Email (never shown publicly)', emailInput, true));
      var bodyInput = document.createElement('textarea');
      bodyInput.name = 'body';
      bodyInput.rows = parentId != null ? 2 : 3;
      bodyInput.maxLength = 2000;
      form.appendChild(fieldRow(parentId != null ? 'Your reply' : 'Your comment', bodyInput, true));
      var captchaBox = null;
      if (parentId == null) {
        captchaBox = document.createElement('div');
        captchaBox.setAttribute('data-bp-captcha', '');
        form.appendChild(captchaBox);
      }
      var msg = document.createElement('p');
      msg.className = 'bp-mod-book-msg';
      form.appendChild(msg);
      var submitBtn = document.createElement('button');
      submitBtn.type = 'submit';
      submitBtn.className = 'bp-mod-btn';
      submitBtn.textContent = parentId != null ? 'Reply' : 'Post comment';
      form.appendChild(submitBtn);
      if (captchaBox) {
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
      }
      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var name = nameInput.value.trim();
        var email = emailInput.value.trim();
        var body = bodyInput.value.trim();
        if (!name || !email || !body) {
          msg.textContent = 'Please add your name, email and a comment.';
          msg.className = 'bp-mod-book-msg err';
          return;
        }
        submitBtn.disabled = true;
        msg.textContent = 'Posting…';
        msg.className = 'bp-mod-book-msg';
        (async function () {
          try {
            var captchaToken = await captcha.getToken();
            var r = await fetch(
              (base || '') + '/api/v1/modules/public/' + encodeURIComponent(token) + '/comments?' + pageQuery(),
              {
                method: 'POST',
                credentials: 'omit',
                headers: jsonHeaders(),
                body: JSON.stringify({
                  target_type: target.target_type,
                  target_id: target.target_id,
                  parent_id: parentId,
                  name: name,
                  email: email,
                  body: body,
                  // Detail-surface posts (the holder carries the
                  // marker from mountDetailComments) post against the
                  // detail item's own target, not the block binding.
                  detail: el.getAttribute('data-bp-detail-comments') === '1' ? 1 : undefined,
                  visitor_token: visitorToken(),
                  captchaToken: captchaToken,
                }),
              }
            );
            var j = await r.json();
            if (!r.ok || !j || !j.ok) throw new Error((j && j.error) || 'Could not post your comment');
            if (captcha.reset) captcha.reset();
            if (j.data && j.data.thread) {
              // Published immediately — re-render on the server's
              // refreshed thread (counts included).
              renderComments(el, {
                module_type: 'comments',
                title: data.title,
                comments: { config: cfg, thread: j.data.thread },
              });
            } else {
              // Held for moderation: the form stays in place showing
              // the note (the comment is invisible until approved).
              bodyInput.value = '';
              msg.textContent = (j.data && j.data.message) || 'Thanks — your comment is awaiting approval.';
              msg.className = 'bp-mod-book-msg ok';
            }
          } catch (e) {
            msg.textContent = (e.message || 'Could not post your comment') + ' — please try again.';
            msg.className = 'bp-mod-book-msg err';
            if (captcha.reset) captcha.reset();
          } finally {
            submitBtn.disabled = false;
          }
        })();
      });
      return form;
    }

    function paintComment(c) {
      var art = document.createElement('article');
      art.className = 'bp-mod-comment';
      art.setAttribute('data-bp-comment-id', String(c.id));
      var meta = document.createElement('p');
      meta.className = 'bp-mod-comment-meta';
      var author = document.createElement('span');
      author.className = 'bp-mod-comment-author';
      author.textContent = c.author_name || 'Anonymous';
      meta.appendChild(author);
      if (c.is_owner) {
        var badge = document.createElement('span');
        badge.className = 'bp-mod-owner-badge';
        badge.textContent = 'Owner';
        meta.appendChild(badge);
      }
      if (c.created_at) {
        var date = document.createElement('span');
        date.className = 'bp-mod-comment-date';
        date.textContent = dateLabel(c.created_at);
        meta.appendChild(date);
      }
      art.appendChild(meta);
      var body = document.createElement('p');
      body.className = 'bp-mod-comment-body';
      body.textContent = c.body || '';
      art.appendChild(body);
      var actions = document.createElement('div');
      actions.className = 'bp-mod-comment-actions';
      if (cfg.allow_likes) actions.appendChild(likeButton('comment', c.id, c.like_count));
      var replySlot = document.createElement('div');
      if (cfg.comments_enabled) {
        var replyBtn = document.createElement('button');
        replyBtn.type = 'button';
        replyBtn.className = 'bp-mod-reply-btn';
        replyBtn.textContent = 'Reply';
        replyBtn.addEventListener('click', function () {
          if (replySlot.firstChild) {
            replySlot.textContent = '';
            replyBtn.textContent = 'Reply';
            return;
          }
          var form = commentForm(c.id);
          replySlot.appendChild(form);
          replyBtn.textContent = 'Cancel';
        });
        actions.appendChild(replyBtn);
      }
      art.appendChild(actions);
      art.appendChild(replySlot);
      var replies = Array.isArray(c.replies) ? c.replies : [];
      if (replies.length) {
        var box = document.createElement('div');
        box.className = 'bp-mod-replies';
        replies.forEach(function (r) {
          box.appendChild(paintComment(r));
        });
        art.appendChild(box);
      }
      return art;
    }

    var comments = Array.isArray(thread.comments) ? thread.comments : [];
    comments.forEach(function (c) {
      list.appendChild(paintComment(c));
    });
    if (!comments.length) {
      var empty = document.createElement('p');
      empty.className = 'bp-mod-meta';
      empty.textContent = 'No comments yet — be the first to share your thoughts.';
      list.appendChild(empty);
    }

    if (cfg.comments_enabled) wrap.appendChild(commentForm(null));

    // Paint the caller's own pressed like-buttons (counts already
    // ride the payload; this only marks state).
    var mine = peekVisitorToken();
    if (mine && cfg.allow_likes) {
      var ids = [];
      wrap.querySelectorAll('[data-bp-comment-id]').forEach(function (node) {
        ids.push(node.getAttribute('data-bp-comment-id'));
      });
      (async function () {
        try {
          var u =
            (base || '') +
            '/api/v1/modules/public/' +
            encodeURIComponent(token) +
            '/comments/state?' +
            pageQuery() +
            '&target_type=' +
            encodeURIComponent(target.target_type) +
            '&target_id=' +
            encodeURIComponent(target.target_id) +
            '&comments=' +
            encodeURIComponent(ids.join(',')) +
            '&v=' +
            encodeURIComponent(mine);
          var r = await fetch(u, { credentials: 'omit', headers: authHeaders() });
          var j = await r.json();
          if (!j || !j.ok) return;
          var likedIds = (j.data && j.data.liked_comment_ids) || [];
          wrap.querySelectorAll('.bp-mod-like-btn').forEach(function (btn) {
            var t = btn.getAttribute('data-bp-like-type');
            var id = btn.getAttribute('data-bp-like-id');
            if (t === 'comment' && likedIds.indexOf(Number(id)) >= 0) btn.classList.add('liked');
            if (t !== 'comment' && j.data.item_liked) btn.classList.add('liked');
          });
        } catch (e) {
          /* state is cosmetic — counts are already correct */
        }
      })();
    }
  }

  function renderCharts(el, data, prefixHtml) {
    var payload = data.charts || {};
    var charts = Array.isArray(payload.charts) ? payload.charts : [];
    var html = '';
    var rendered = 0;
    charts.forEach(function (chart) {
      var labels = Array.isArray(chart.labels) ? chart.labels : [];
      var series = Array.isArray(chart.series) ? chart.series : [];
      if (!labels.length || !series.length) return;
      rendered++;
      html += '<section class="bp-mod-chart">';
      if (chart.title) html += '<h3 class="bp-mod-chart-title">' + esc(chart.title) + '</h3>';
      html += chartSvgMarkup(chart);
      html += chartLegendHtml(chart);
      html += '</section>';
    });
    if (!rendered) {
      // Nothing configured with data yet — render nothing (the
      // dormant-module pattern, like Google Reviews / Social Feed).
      el.innerHTML = '';
      return;
    }
    el.innerHTML = prefixHtml + html;
  }

  function renderDataTable(el, data, prefixHtml) {
    var dt = data.datatable || {};
    var columns = Array.isArray(dt.columns) ? dt.columns : [];
    var colByKey = {};
    columns.forEach(function (c) {
      colByKey[c.key] = c;
    });
    var state = {
      rows: Array.isArray(data.items) ? data.items : [],
      columns: columns,
      colByKey: colByKey,
      template: dt.template || 'table',
      roles: dt.roles || {},
      submit: dt.submit || { enabled: false, mode: 'off', fields: [] },
      query: '',
      sortKey: null,
      sortDir: 1,
      page: 1,
      pageSize: 10,
    };
    el._bpDt = state;

    function roleVal(row, role) {
      var key = state.roles[role];
      if (!key || !row.values) return null;
      return row.values[key];
    }
    function roleText(row, role) {
      var key = state.roles[role];
      if (!key) return '';
      return dtCellText(state.colByKey[key], row.values ? row.values[key] : null);
    }
    function titleText(row) {
      var t = roleText(row, 'title');
      if (t) return t;
      for (var i = 0; i < state.columns.length; i++) {
        var v = dtCellText(state.columns[i], row.values ? row.values[state.columns[i].key] : null);
        if (v) return v;
      }
      return '';
    }
    function linkParts(row) {
      var key = state.roles.link;
      if (!key || !row.values) return null;
      return dtLinkParts(row.values[key]);
    }
    function badgeHtml(row) {
      var b = roleText(row, 'badge');
      return b ? '<span class="bp-mod-dt-badge">' + esc(b) + '</span>' : '';
    }
    function filteredRows() {
      var rows = state.rows.slice();
      if (state.query) {
        var q = state.query.toLowerCase();
        rows = rows.filter(function (row) {
          return state.columns
            .map(function (c) {
              return dtCellText(c, row.values ? row.values[c.key] : null);
            })
            .join(' ')
            .toLowerCase()
            .includes(q);
        });
      }
      if (state.sortKey) {
        var col = state.colByKey[state.sortKey];
        var numeric = col && (col.type === 'number' || col.type === 'currency');
        rows.sort(function (a, b) {
          var av = a.values ? a.values[state.sortKey] : null;
          var bv = b.values ? b.values[state.sortKey] : null;
          if (av == null || av === '') return 1;
          if (bv == null || bv === '') return -1;
          var cmp;
          if (numeric) cmp = (Number(av) || 0) - (Number(bv) || 0);
          else cmp = dtCellText(col, av).localeCompare(dtCellText(col, bv));
          return cmp * state.sortDir;
        });
      }
      return rows;
    }
    function tableHtml(rows) {
      var head = state.columns
        .map(function (c) {
          var arrow =
            state.sortKey === c.key ? '<span class="bp-mod-dt-arrow">' + (state.sortDir === 1 ? '↑' : '↓') + '</span>' : '';
          return (
            '<th><button type="button" class="bp-mod-dt-sort" data-dt-sort="' +
            esc(c.key) +
            '">' +
            esc(c.label || c.key) +
            arrow +
            '</button></th>'
          );
        })
        .join('');
      var body = rows
        .map(function (row) {
          return (
            '<tr>' +
            state.columns
              .map(function (c) {
                return '<td>' + dtCellHtml(c, row.values ? row.values[c.key] : null) + '</td>';
              })
              .join('') +
            '</tr>'
          );
        })
        .join('');
      if (!rows.length) {
        body =
          '<tr><td colspan="' +
          Math.max(1, state.columns.length) +
          '"><p class="bp-mod-dt-none">No rows match your search.</p></td></tr>';
      }
      return (
        '<div class="bp-mod-dt-tablewrap"><table class="bp-mod-dt-table"><thead><tr>' +
        head +
        '</tr></thead><tbody>' +
        body +
        '</tbody></table></div>'
      );
    }
    function wallHtml(rows) {
      if (!rows.length) return '<p class="bp-mod-dt-none">No rows match your search.</p>';
      return (
        '<div class="bp-mod-dt-wall">' +
        rows
          .map(function (row) {
            var img = dtImageUrl(roleVal(row, 'image'));
            var title = titleText(row);
            var avatar = img
              ? '<img class="bp-mod-dt-avatar" src="' + esc(img) + '" alt="" loading="lazy" />'
              : '<span class="bp-mod-dt-avatar-fallback" aria-hidden="true">' +
                esc(String(title || '?').trim().charAt(0).toUpperCase() || '?') +
                '</span>';
            var meta = roleText(row, 'meta');
            var body = roleText(row, 'body');
            var link = linkParts(row);
            return (
              '<article class="bp-mod-dt-card"><div class="bp-mod-dt-card-head">' +
              avatar +
              '<div><p class="bp-mod-dt-card-title">' +
              esc(title) +
              '</p>' +
              (meta ? '<p class="bp-mod-dt-card-meta">' + esc(meta) + '</p>' : '') +
              '</div>' +
              badgeHtml(row) +
              '</div>' +
              (body ? '<p class="bp-mod-dt-card-body">' + esc(body) + '</p>' : '') +
              (link
                ? '<p style="margin:0"><a class="bp-mod-dt-card-link" href="' +
                  esc(link.url) +
                  '" target="_blank" rel="noopener">' +
                  esc(link.label) +
                  '</a></p>'
                : '') +
              '</article>'
            );
          })
          .join('') +
        '</div>'
      );
    }
    function resultsHtml(rows) {
      if (!rows.length) return '<p class="bp-mod-dt-none">No rows match your search.</p>';
      return (
        '<div class="bp-mod-dt-results">' +
        rows
          .map(function (row) {
            var link = linkParts(row);
            var title = titleText(row);
            var body = roleText(row, 'body');
            var meta = roleText(row, 'meta');
            var badge = roleText(row, 'badge');
            var titleHtml = link
              ? '<a class="bp-mod-dt-result-title" href="' + esc(link.url) + '" target="_blank" rel="noopener">' + esc(title) + '</a>'
              : '<span class="bp-mod-dt-result-title">' + esc(title) + '</span>';
            var urlLine = link
              ? '<p class="bp-mod-dt-result-url">' + esc(link.url.replace(/^https?:\/\//i, '')) + '</p>'
              : '';
            var metaBits = [meta, badge].filter(Boolean).join(' · ');
            return (
              '<div class="bp-mod-dt-result">' +
              titleHtml +
              urlLine +
              (body ? '<p class="bp-mod-dt-result-snippet">' + esc(body) + '</p>' : '') +
              (metaBits ? '<p class="bp-mod-dt-result-meta">' + esc(metaBits) + '</p>' : '') +
              '</div>'
            );
          })
          .join('') +
        '</div>'
      );
    }
    function listHtml(rows) {
      if (!rows.length) return '<p class="bp-mod-dt-none">No rows match your search.</p>';
      return (
        '<div class="bp-mod-dt-list">' +
        rows
          .map(function (row) {
            var img = dtImageUrl(roleVal(row, 'image'));
            var title = titleText(row);
            var body = roleText(row, 'body');
            var meta = roleText(row, 'meta');
            var link = linkParts(row);
            var titleInner = link
              ? '<a href="' + esc(link.url) + '" target="_blank" rel="noopener">' + esc(title) + '</a>'
              : esc(title);
            return (
              '<div class="bp-mod-dt-row">' +
              (img ? '<img class="bp-mod-dt-thumb" src="' + esc(img) + '" alt="" loading="lazy" />' : '') +
              '<div class="bp-mod-dt-row-main"><p class="bp-mod-dt-row-title">' +
              titleInner +
              '</p>' +
              (body ? '<p class="bp-mod-dt-row-body">' + esc(body) + '</p>' : '') +
              '</div>' +
              (meta || roleText(row, 'badge')
                ? '<div class="bp-mod-dt-row-side">' +
                  (meta ? '<span>' + esc(meta) + '</span>' : '') +
                  badgeHtml(row) +
                  '</div>'
                : '') +
              '</div>'
            );
          })
          .join('') +
        '</div>'
      );
    }
    function bodyHtml(rows) {
      if (!state.rows.length) return renderEmpty('datatables');
      if (state.template === 'wall') return wallHtml(rows);
      if (state.template === 'results') return resultsHtml(rows);
      if (state.template === 'list') return listHtml(rows);
      return tableHtml(rows);
    }
    function submitFormHtml() {
      var sub = state.submit;
      if (!sub.enabled || !Array.isArray(sub.fields) || !sub.fields.length) return '';
      var rows = sub.fields
        .map(function (col) {
          var input;
          if (col.type === 'text' && state.roles.body === col.key) {
            input = '<textarea data-dt-field="' + esc(col.key) + '" rows="3"></textarea>';
          } else if (col.type === 'boolean') {
            input =
              '<select data-dt-field="' + esc(col.key) + '"><option value=""></option><option value="Yes">Yes</option><option value="No">No</option></select>';
          } else if (col.type === 'date') {
            input = '<input data-dt-field="' + esc(col.key) + '" type="date" />';
          } else if (col.type === 'number' || col.type === 'currency') {
            input = '<input data-dt-field="' + esc(col.key) + '" type="number" step="any" />';
          } else if (col.type === 'link') {
            input = '<input data-dt-field="' + esc(col.key) + '" type="url" placeholder="https://…" />';
          } else {
            input = '<input data-dt-field="' + esc(col.key) + '" type="text" />';
          }
          return '<div class="bp-mod-book-row"><label>' + esc(col.label || col.key) + '</label>' + input + '</div>';
        })
        .join('');
      return (
        '<form class="bp-mod-book bp-mod-dt-form" data-dt-form>' +
        '<h3 class="bp-mod-dt-form-title">Submit an entry</h3>' +
        rows +
        '<div class="bp-mod-captcha" data-dt-captcha hidden></div>' +
        '<button type="submit" class="bp-mod-btn">Submit</button>' +
        '<p class="bp-mod-book-msg" data-dt-msg></p>' +
        '</form>'
      );
    }

    el.innerHTML =
      (prefixHtml || '') +
      '<div class="bp-mod-dt">' +
      '<div class="bp-mod-dt-toolbar">' +
      '<input type="search" class="bp-mod-dt-search" data-dt-search placeholder="Search…" aria-label="Search this table" />' +
      '<label class="bp-mod-dt-pagesize">Show <select data-dt-size><option value="10">10</option><option value="25">25</option><option value="50">50</option></select></label>' +
      '</div>' +
      '<div data-dt-body></div>' +
      '<div class="bp-mod-dt-pager">' +
      '<button type="button" class="bp-mod-btn ghost" data-dt-prev>← Prev</button>' +
      '<span class="bp-mod-dt-pageinfo" data-dt-pageinfo></span>' +
      '<button type="button" class="bp-mod-btn ghost" data-dt-next>Next →</button>' +
      '</div>' +
      submitFormHtml() +
      '</div>';

    var bodyBox = el.querySelector('[data-dt-body]');
    var pageInfo = el.querySelector('[data-dt-pageinfo]');
    var prevBtn = el.querySelector('[data-dt-prev]');
    var nextBtn = el.querySelector('[data-dt-next]');

    function paint() {
      var all = filteredRows();
      var pages = Math.max(1, Math.ceil(all.length / state.pageSize));
      if (state.page > pages) state.page = pages;
      if (state.page < 1) state.page = 1;
      var start = (state.page - 1) * state.pageSize;
      var pageRows = all.slice(start, start + state.pageSize);
      if (bodyBox) bodyBox.innerHTML = bodyHtml(pageRows);
      if (pageInfo) {
        pageInfo.textContent = state.rows.length
          ? 'Page ' + state.page + ' of ' + pages + ' · ' + all.length + (all.length === 1 ? ' row' : ' rows')
          : '';
      }
      if (prevBtn) prevBtn.disabled = state.page <= 1;
      if (nextBtn) nextBtn.disabled = state.page >= pages;
    }

    var searchInput = el.querySelector('[data-dt-search]');
    if (searchInput) {
      searchInput.addEventListener('input', function () {
        state.query = String(searchInput.value || '').trim();
        state.page = 1;
        paint();
      });
    }
    var sizeSel = el.querySelector('[data-dt-size]');
    if (sizeSel) {
      sizeSel.addEventListener('change', function () {
        state.pageSize = Number(sizeSel.value) || 10;
        state.page = 1;
        paint();
      });
    }
    if (prevBtn) {
      prevBtn.addEventListener('click', function () {
        if (state.page > 1) {
          state.page -= 1;
          paint();
        }
      });
    }
    if (nextBtn) {
      nextBtn.addEventListener('click', function () {
        state.page += 1;
        paint();
      });
    }
    if (bodyBox) {
      bodyBox.addEventListener('click', function (ev) {
        var btn = ev.target && ev.target.closest ? ev.target.closest('[data-dt-sort]') : null;
        if (!btn) return;
        var key = btn.getAttribute('data-dt-sort');
        if (state.sortKey === key) state.sortDir = state.sortDir === 1 ? -1 : 1;
        else {
          state.sortKey = key;
          state.sortDir = 1;
        }
        state.page = 1;
        paint();
      });
    }
    paint();
    bindDataTableForm(el, data);
  }

  function bindDataTableForm(el, data) {
    var form = el.querySelector('[data-dt-form]');
    if (!form) return;
    var token = el.getAttribute(TOKEN_ATTR) || '';
    var base = apiBase(el);
    var msg = form.querySelector('[data-dt-msg]');
    var captchaBox = form.querySelector('[data-dt-captcha]');
    var submitBtn = form.querySelector('button[type="submit"]');
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

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var values = {};
      form.querySelectorAll('[data-dt-field]').forEach(function (input) {
        values[input.getAttribute('data-dt-field')] = input.value;
      });
      if (submitBtn) submitBtn.disabled = true;
      if (msg) {
        msg.textContent = 'Submitting…';
        msg.className = 'bp-mod-book-msg';
      }
      (async function () {
        try {
          var captchaToken = await captcha.getToken();
          var r = await fetch((base || '') + '/api/v1/modules/public/' + encodeURIComponent(token) + '/submit', {
            method: 'POST',
            credentials: 'omit',
            headers: jsonHeaders(),
            body: JSON.stringify({ values: values, captchaToken: captchaToken }),
          });
          var j = await r.json();
          if (!r.ok || !j || !j.ok) throw new Error((j && j.error) || 'Submission failed');
          var mode = j.data && j.data.mode;
          if (msg) {
            msg.textContent = (j.data && j.data.message) || 'Thanks — your submission was received.';
            msg.className = 'bp-mod-book-msg ok';
          }
          form.reset();
          if (captcha.reset) captcha.reset();
          if (mode === 'live') {
            // The new row is already published — refetch the payload
            // and repaint so the visitor sees it in place.
            try {
              var path =
                (base || '') + '/api/v1/modules/public/' + encodeURIComponent(token) + '?' + pageQuery();
              var rr = await fetch(path, { credentials: 'omit', headers: authHeaders() });
              var jj = await rr.json();
              if (jj && jj.ok && jj.data && el._bpDt) {
                el._bpDt.rows = Array.isArray(jj.data.items) ? jj.data.items : el._bpDt.rows;
                renderDataTable(el, jj.data, shouldShowTitle(el) ? '<h2 class="bp-mod-title">' + esc(jj.data.title || jj.data.module_type) + '</h2>' : '');
                var newMsg = el.querySelector('[data-dt-msg]');
                if (newMsg) {
                  newMsg.textContent = (j.data && j.data.message) || 'Thanks — your submission is live.';
                  newMsg.className = 'bp-mod-book-msg ok';
                }
              }
            } catch (e2) {
              /* the submission landed; a stale view is not an error */
            }
          }
        } catch (e) {
          if (msg) {
            msg.textContent = e.message || 'Submission failed';
            msg.className = 'bp-mod-book-msg err';
          }
          if (captcha.reset) captcha.reset();
        } finally {
          if (submitBtn) submitBtn.disabled = false;
        }
      })();
    });
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
      // SMS opt-in (Batch 25): unchecked by default, never required.
      (data.sms_optin && data.sms_optin.label
        ? '<div class="bp-mod-book-row"><label class="bp-mod-check"><input type="checkbox" name="sms_optin_consent" /> ' +
          esc(data.sms_optin.label) +
          '</label></div>'
        : '') +
      smsPolicyRow(data) +
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
          var smsConsent = form.querySelector('[name="sms_optin_consent"]');
          var body = {
            name: name,
            email: email,
            phone: phone,
            notes: notes,
            sms_optin_consent: !!(smsConsent && smsConsent.checked),
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
    activeDetailType = type || '';
    var it = data.item;
    if (type === 'comments') {
      // Batch 131: the item payload IS the thread context
      // (data.comments.thread for the resolved target). The block
      // sits under the item's own detail view — no Back link here.
      renderComments(el, data);
      return;
    }
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
    if (type === 'categories') {
      // Batch 124: one category — its assigned items as uniform
      // shared-layer cards linking to each item's own page.
      var catItems = Array.isArray(data.category_items) ? data.category_items : [];
      html +=
        '<article class="bp-mod-detail">' +
        (it.image_url ? '<img class="bp-mod-hero" src="' + esc(it.image_url) + '" alt="" />' : '') +
        '<h1>' +
        esc(it.name) +
        '</h1>' +
        (it.scope_label ? '<p class="bp-mod-meta">' + esc(it.scope_label) + '</p>' : '') +
        (it.description ? '<div class="bp-mod-content"><p>' + esc(it.description) + '</p></div>' : '') +
        '</article>';
      if (catItems.length) {
        html += '<div class="bp-mod-grid" style="margin-top:1.25rem">';
        catItems.forEach(function (ci) {
          html += sharedItemCardHtml(ci);
        });
        html += '</div>';
      } else {
        html += '<p class="bp-mod-meta" style="margin-top:1rem">Nothing published here yet.</p>';
      }
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
      // Batch 127: variant products render one selector per option
      // axis; wireVariantPicker (below) keeps the price, the buy
      // button's variant and its availability in sync with the pick.
      var variantHtml = '';
      if (it.has_variants && it.options && it.options.length) {
        variantHtml = '<div class="bp-mod-variants">';
        for (var ax = 0; ax < it.options.length; ax++) {
          var axis = it.options[ax];
          variantHtml +=
            '<label class="bp-mod-variant-axis"><span>' + esc(axis.name) + '</span><select data-bp-axis="' + ax + '">';
          for (var av = 0; av < (axis.values || []).length; av++) {
            variantHtml +=
              '<option value="' + esc(axis.values[av]) + '">' + esc(axis.values[av]) + '</option>';
          }
          variantHtml += '</select></label>';
        }
        variantHtml += '</div><p class="bp-mod-variant-note" data-bp-variant-note hidden></p>';
      }
      html +=
        '<article class="bp-mod-detail">' +
        (it.image_url ? '<img class="bp-mod-hero" src="' + esc(it.image_url) + '" alt="" />' : '') +
        '<h1>' +
        esc(it.name) +
        '</h1>' +
        '<p class="bp-mod-price" data-bp-variant-price>' +
        esc(it.price_label || '') +
        '</p>' +
        variantHtml +
        '<div class="bp-mod-content"><p>' +
        esc(it.description || '') +
        '</p></div>' +
        (it.checkout_url
          ? '<p style="margin-top:16px"><a class="bp-mod-btn" href="' +
            esc(it.checkout_url) +
            '" target="_blank" rel="noopener">Buy now</a></p>'
          : data.checkout_page && it.stripe_checkout
            ? '<p style="margin-top:16px">' +
              '<button type="button" class="bp-mod-btn" data-bp-add="' +
              esc(it.id) +
              '" data-bp-name="' +
              esc(it.name || '') +
              '" data-bp-price="' +
              (Number(it.price_cents) || 0) +
              '" data-bp-currency="' +
              esc(it.currency || 'USD') +
              '" data-bp-image="' +
              esc(it.image_url || '') +
              '">Add to cart</button></p>'
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
      html += renderAlbumDetail(it, true, data);
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
      // Batch 122 — shared gallery: the album this event is linked to
      // through the shared module layer (moduleShare ref, role
      // 'album'). The payload only carries shared_gallery when the
      // album is published and has photos; anything else renders as
      // nothing (dormant-empty discipline, never an error).
      var evGal = '';
      var sg = it.shared_gallery;
      if (sg && sg.images && sg.images.length) {
        evGal =
          '<h2 style="margin:22px 0 10px">' +
          esc(sg.album_title || 'Photos') +
          '</h2><div class="bp-mod-gallery">';
        for (var gi = 0; gi < sg.images.length; gi++) {
          var gim = sg.images[gi];
          evGal +=
            '<a href="' +
            esc(gim.image_url) +
            '" target="_blank" rel="noopener" style="background-image:url(\'' +
            esc(gim.image_url) +
            '\')" title="' +
            esc(gim.caption || '') +
            '"></a>';
        }
        evGal += '</div>';
      }
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
        evGal +
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
    // Batch 127: variant selectors on a product page get their live
    // wiring after the detail HTML lands.
    if (type === 'ecommerce' && it && it.has_variants) wireVariantPicker(el, it);
  }

  // Batch 127: keep a variant product's price, buy-button variant and
  // availability in sync with the axis selectors. Every combination
  // exists as a variant row; an unavailable combination disables the
  // buy button rather than selling something the shop turned off.
  function wireVariantPicker(el, it) {
    var selects = el.querySelectorAll('[data-bp-axis]');
    if (!selects.length) return;
    var priceEl = el.querySelector('[data-bp-variant-price]');
    var noteEl = el.querySelector('[data-bp-variant-note]');
    var btn = el.querySelector('[data-bp-buy]');
    // Batch 128: on a Checkout-attached shop the purchase button is
    // the cart's Add button instead of Buy \u2014 the axis selectors
    // still own the selection, so the resolved variant is synced
    // onto the Add button (the cart's click handler reads these
    // attributes) and it disables for unavailable combinations,
    // exactly like the Buy button.
    var addBtn = el.querySelector('[data-bp-add]');
    function currentVariant() {
      var values = [];
      for (var i = 0; i < selects.length; i++) values.push(selects[i].value);
      var variants = it.variants || [];
      for (var j = 0; j < variants.length; j++) {
        var v = variants[j];
        var match = v.values && v.values.length === values.length;
        for (var k = 0; match && k < values.length; k++) {
          if (String(v.values[k]) !== values[k]) match = false;
        }
        if (match) return v;
      }
      return null;
    }
    function apply() {
      var v = currentVariant();
      if (!v) {
        if (btn) {
          btn.removeAttribute('data-bp-variant');
          btn.disabled = true;
        }
        if (addBtn) {
          addBtn.removeAttribute('data-bp-variant');
          addBtn.disabled = true;
        }
        return;
      }
      if (priceEl) priceEl.textContent = v.price_label || it.price_label || '';
      if (btn) {
        btn.setAttribute('data-bp-variant', String(v.id));
        btn.disabled = !v.available;
        btn.textContent = v.available ? 'Buy now' : 'Unavailable';
      }
      if (addBtn) {
        addBtn.setAttribute('data-bp-variant', String(v.id));
        addBtn.setAttribute('data-bp-variant-label', v.label || '');
        addBtn.setAttribute('data-bp-variant-price', String(Number(v.price_cents) || 0));
        addBtn.disabled = !v.available;
      }
      if (noteEl) {
        noteEl.hidden = !!v.available;
        noteEl.textContent = v.available ? '' : 'This combination is currently unavailable.';
      }
    }
    for (var s = 0; s < selects.length; s++) selects[s].addEventListener('change', apply);
    var firstAvailable = null;
    var firstAny = null;
    var all = it.variants || [];
    for (var m = 0; m < all.length; m++) {
      if (!firstAny) firstAny = all[m];
      if (!firstAvailable && all[m].available) firstAvailable = all[m];
    }
    var dflt = firstAvailable || firstAny;
    if (dflt && dflt.values) {
      for (var d = 0; d < selects.length && d < dflt.values.length; d++) selects[d].value = dflt.values[d];
    }
    apply();
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
      // Batch 127: a variant product's buy button carries the chosen
      // variant (set by wireVariantPicker); the server re-validates
      // it and prices from the variant row, never from the page.
      var payload = { productId: Number(productId), returnUrl: ret.toString() };
      var variantId = btn.getAttribute('data-bp-variant');
      if (variantId) payload.variantId = Number(variantId);
      fetch((base || '') + '/api/v1/modules/public/' + encodeURIComponent(token) + '/checkout', {
        method: 'POST',
        credentials: 'omit',
        headers: jsonHeaders(),
        body: JSON.stringify(payload),
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

  /* ── Batch 128 — the shared cart + the Checkout module surface ──
   * One cart per site, owned by the lead's Checkout module and keyed
   * by ITS public token: the Shop and Gallery embeds add to it, the
   * Checkout embed reviews and charges it. Cart lines snapshot
   * DISPLAY data (name/photo/price) for this UI only — the server
   * re-prices every line from the source module's own rows when the
   * session is created, so a tampered snapshot buys nothing. */

  function cartStorageKey(checkoutToken) {
    return 'bp-cart-' + String(checkoutToken || '');
  }
  function readCart(checkoutToken) {
    try {
      var raw = window.localStorage.getItem(cartStorageKey(checkoutToken));
      var lines = raw ? JSON.parse(raw) : [];
      return Array.isArray(lines) ? lines : [];
    } catch (e) {
      return [];
    }
  }
  function writeCart(checkoutToken, lines) {
    try {
      window.localStorage.setItem(cartStorageKey(checkoutToken), JSON.stringify((lines || []).slice(0, 50)));
    } catch (e) {
      /* storage unavailable — the cart just won't persist */
    }
  }
  function cartTotals(lines) {
    var count = 0;
    var total = 0;
    var currency = 'USD';
    (lines || []).forEach(function (l) {
      count += Number(l.qty) || 0;
      total += (Number(l.price_cents) || 0) * (Number(l.qty) || 0);
      if (l.currency) currency = l.currency;
    });
    return { count: count, total: total, currency: currency };
  }
  function cartMoney(cents, currency) {
    return (currency && currency !== 'USD' ? currency + ' ' : '$') + ((Number(cents) || 0) / 100).toFixed(2);
  }
  function cartThumb(url) {
    // A photoless line gets a clean placeholder block — never a
    // broken-image icon or a layout hole.
    return url
      ? '<img class="bp-mod-cart-thumb" src="' + esc(url) + '" alt="" />'
      : '<span class="bp-mod-cart-thumb bp-mod-cart-thumb-empty" aria-hidden="true"></span>';
  }
  function addLineToCart(checkoutToken, line) {
    var lines = readCart(checkoutToken);
    var found = null;
    lines.forEach(function (l) {
      if (
        l.source === line.source &&
        Number(l.itemId) === Number(line.itemId) &&
        (l.variantId || null) === (line.variantId || null)
      )
        found = l;
    });
    if (found) found.qty = Math.min(99, (Number(found.qty) || 1) + (Number(line.qty) || 1));
    else lines.push(line);
    writeCart(checkoutToken, lines);
    return lines;
  }

  /* ── Batch 142 — the cart element moves INTO the site nav ──
   * Ely (2026-11-04): "Checkout element should be at the top, better
   * if it's in the nav." This replaces Batch 128's in-body cart bar
   * (renderCartBar / .bp-mod-cartbar, removed): there is now exactly
   * ONE cart element per page — a nav-level link [data-bp-nav-cart]
   * showing the live count + total, pointing at the site's checkout
   * page (the same target the old bar's "Go to checkout" used).
   *
   * GATING (checkout-applies-to-all): the element exists only when
   * Checkout is attached and active for the lead. Two signals carry
   * that one server truth (siteCheckoutPresence): the Batch 128
   * selling signal (checkout_token + checkout_page, shop/gallery
   * payloads) and, since the 142 extension, the sitewide stamp
   * site_checkout on EVERY public payload — plain pages included.
   * No signal → no element, no dead link; the Checkout page self-registers.
   *
   * EMPTY STATE (decided, pinned by the batch142 suite): the element
   * is VISIBLE from the moment the signal arrives, showing the honest
   * empty state "Cart · 0 items — $0.00". A nav element that pops in
   * only after the first add would shift the header layout mid-shop
   * and could not be discovered before buying; a permanent nav slot
   * is what "element in the nav" means. (The old bar, by contrast,
   * hid itself while empty.)
   *
   * CHROME DETECTION — sites render chrome two ways and both reduce
   * to the same DOM shapes by the time this script runs:
   *   (a) delivered nav SECTIONS — the renderer stamps
   *       data-ws-section-type="nav" on the section root; freestyle
   *       chrome wraps authored header HTML in .ws-nav-chrome, and
   *       structured chrome renders <nav class="nav"><div
   *       class="nav-inner">…;
   *   (b) theme.partials headerHtml — raw header HTML prepended to
   *       the body (nav sections are stripped when a partial header
   *       exists), typically <header>…<nav>… and often carrying the
   *       data-bitpype-mobile-nav hamburger container.
   * findNavCartTarget() walks those shapes in priority order and
   * returns a BAR container (e.g. .nav-inner / .bp-nav-bar), else
   * the header/nav element itself. It NEVER returns a collapsible
   * link panel (.bp-nav-panel, .nav-links, .nav-panel): at ≤700px
   * those panels are display:none behind the hamburger (platform
   * mobile CSS hides .nav-links anchors outright), and a cart
   * hidden behind a hamburger defeats the order — the cart is
   * appended as a sibling of the panel, inside the always-visible
   * bar. Managed module nav links (data-bitpype-module-nav) are NOT
   * used as an anchor and nothing here injects a second module-nav
   * item: the cart is a distinct chrome element, appended once,
   * deduped by its own attribute.
   *
   * NO-CHROME PAGES (e.g. Batch 133 detail shells on sites whose
   * chrome is nav sections — Batch 141 adds chrome there later):
   * findNavCartTarget() returns null and updateNavCart() simply
   * does nothing — no error, no duplicate, no stray floating
   * element. When chrome exists (partials sites already give the
   * detail shell a header), the same code lands the cart in it. */
  var NAV_CART_ATTR = 'data-bp-nav-cart';
  var navCartState = null;

  function isCollapsibleNavPanel(el) {
    if (!el || !el.classList) return false;
    return (
      el.classList.contains('bp-nav-panel') ||
      el.classList.contains('nav-links') ||
      el.classList.contains('nav-panel')
    );
  }

  function navCartBarIn(root) {
    if (!root || !root.querySelector) return null;
    var sels = ['.nav-inner', '.bp-nav-bar', '.nav-bar', '.header-bar', '.header-inner', '.top-bar', '.topbar'];
    for (var i = 0; i < sels.length; i++) {
      var el = root.querySelector(sels[i]);
      if (el && !isCollapsibleNavPanel(el)) return el;
    }
    return null;
  }

  function findNavCartTarget() {
    var roots = [];
    var seen = [];
    function push(el) {
      if (el && seen.indexOf(el) < 0) {
        seen.push(el);
        roots.push(el);
      }
    }
    push(document.querySelector('[data-ws-section-type="nav"]'));
    push(document.querySelector('.ws-nav-chrome'));
    push(document.querySelector('[data-bitpype-mobile-nav]'));
    var headers = document.querySelectorAll('header');
    for (var h = 0; h < headers.length; h++) {
      if (headers[h].classList && headers[h].classList.contains('hero')) continue;
      push(headers[h]);
      break;
    }
    var navs = document.querySelectorAll('nav');
    for (var n = 0; n < navs.length; n++) {
      if (!isCollapsibleNavPanel(navs[n])) {
        push(navs[n]);
        break;
      }
    }
    for (var r = 0; r < roots.length; r++) {
      var root = roots[r];
      var bar = navCartBarIn(root);
      if (bar) return bar;
      if (root.tagName === 'HEADER' || root.tagName === 'NAV') return root;
      // Wrapper chrome (nav section / .ws-nav-chrome / mobile-nav
      // container): descend to its header/nav element, never into
      // the collapsible panel inside it.
      var inners = root.querySelectorAll('header, nav');
      for (var k = 0; k < inners.length; k++) {
        if (isCollapsibleNavPanel(inners[k])) continue;
        var innerBar = navCartBarIn(inners[k]);
        return innerBar || inners[k];
      }
    }
    return null;
  }

  function registerNavCart(checkoutToken, checkoutPage) {
    if (!checkoutToken || !checkoutPage) return;
    // One cart per site: every signal on a real page names the SAME
    // checkout embed; a conflicting second signal never replaces it
    // and never creates a second element.
    if (navCartState && navCartState.token !== String(checkoutToken)) return;
    navCartState = { token: String(checkoutToken), page: String(checkoutPage) };
    updateNavCart();
  }

  function updateNavCart() {
    if (!navCartState) return;
    var all = document.querySelectorAll('[' + NAV_CART_ATTR + ']');
    for (var i = 1; i < all.length; i++) {
      if (all[i].parentNode) all[i].parentNode.removeChild(all[i]);
    }
    var link = all[0] || null;
    if (!link) {
      var target = findNavCartTarget();
      if (!target) return; // no recognizable nav — degrade silently
      link = document.createElement('a');
      link.setAttribute(NAV_CART_ATTR, '1');
      link.className = 'bp-nav-cart';
      target.appendChild(link);
    }
    var t = cartTotals(readCart(navCartState.token));
    var summary = t.count + (t.count === 1 ? ' item' : ' items') + ' — ' + cartMoney(t.total, t.currency);
    link.setAttribute('href', navCartState.page);
    link.setAttribute('aria-label', 'Cart, ' + summary + '. Go to checkout.');
    link.innerHTML =
      '<span class="bp-nav-cart-label">Cart</span>' +
      '<span class="bp-nav-cart-summary" data-bp-nav-cart-summary>' +
      esc(summary) +
      '</span>';
  }



  function wireSellableAdds(el, data) {
    if (!data || !data.checkout_page || !data.checkout_token) return;
    // Batch 142: the payload's checkout signal also registers the
    // nav cart — this is one of the paths by which a page learns the
    // site has Checkout attached.
    registerNavCart(data.checkout_token, data.checkout_page);
    el.querySelectorAll('[data-bp-add], [data-bp-add-photo]').forEach(function (btn) {
      if (btn.dataset.bpWired) return;
      btn.dataset.bpWired = '1';
      var isPhoto = btn.hasAttribute('data-bp-add-photo');
      // A photo already in the cart can't be added twice (sold ×1).
      if (isPhoto) {
        var existing = readCart(data.checkout_token).some(function (l) {
          return l.source === 'gallery' && Number(l.itemId) === Number(btn.getAttribute('data-bp-add-photo'));
        });
        if (existing) {
          btn.disabled = true;
          btn.textContent = 'In your cart ✓';
          return;
        }
      }
      btn.addEventListener('click', function () {
        var line = {
          source: isPhoto ? 'gallery' : 'ecommerce',
          itemId: Number(btn.getAttribute(isPhoto ? 'data-bp-add-photo' : 'data-bp-add')),
          variantId: null,
          variantLabel: '',
          name: btn.getAttribute('data-bp-name') || 'Item',
          image_url: btn.getAttribute('data-bp-image') || '',
          price_cents: Number(btn.getAttribute('data-bp-price')) || 0,
          currency: btn.getAttribute('data-bp-currency') || 'USD',
          qty: 1,
        };
        // A variant picker rides beside the product's add button;
        // its selection sets the line's variant identity + label.
        var card = btn.closest('article') || btn.parentElement;
        var sel = card ? card.querySelector('[data-bp-variant-for="' + line.itemId + '"]') : null;
        if (!sel) sel = el.querySelector('[data-bp-variant-for="' + line.itemId + '"]');
        if (sel && sel.selectedOptions && sel.selectedOptions[0]) {
          var opt = sel.selectedOptions[0];
          line.variantId = Number(opt.value) || null;
          line.variantLabel = opt.getAttribute('data-label') || '';
          if (opt.getAttribute('data-price-cents') != null)
            line.price_cents = Number(opt.getAttribute('data-price-cents')) || line.price_cents;
        }
        // Product DETAIL pages choose variants with the Batch 127
        // axis selectors (no flattened picker); wireVariantPicker
        // keeps the resolved variant on the button itself.
        if (!line.variantId && btn.getAttribute('data-bp-variant')) {
          line.variantId = Number(btn.getAttribute('data-bp-variant')) || null;
          line.variantLabel = btn.getAttribute('data-bp-variant-label') || '';
          if (btn.getAttribute('data-bp-variant-price') != null)
            line.price_cents = Number(btn.getAttribute('data-bp-variant-price')) || line.price_cents;
        }
        addLineToCart(data.checkout_token, line);
        updateNavCart();
        if (isPhoto) {
          btn.disabled = true;
          btn.textContent = 'In your cart ✓';
        } else {
          var label = btn.textContent;
          btn.textContent = 'Added ✓';
          setTimeout(function () {
            btn.textContent = label;
          }, 1200);
        }
      });
    });
  }

  function renderCheckout(el, data, base, token) {
    // Batch 142: the Checkout module's own page registers the nav
    // cart from its OWN embed token (the cart's storage key) + its
    // target page slug — the checkout payload itself carries no
    // checkout_token/checkout_page fields (those ride the selling
    // modules' payloads and point back here).
    var coSlug =
      data.embed && data.embed.target_page_slug ? String(data.embed.target_page_slug).replace(/^\/+/, '') : 'checkout';
    registerNavCart(token, '/' + coSlug);
    var co = data.checkout || {};
    var configured = !!(co.cart && co.cart.configured);
    var continueLinks =
      (co.shop_page ? '<a class="bp-mod-btn ghost" href="' + esc(co.shop_page) + '">Continue shopping</a> ' : '') +
      (co.gallery_page ? '<a class="bp-mod-btn ghost" href="' + esc(co.gallery_page) + '">Browse the gallery</a>' : '');

    function reviewHtml() {
      var lines = readCart(token);
      if (!lines.length) {
        return (
          '<h2>Your cart is empty</h2><p>Add something from the shop or the gallery and it will show up here.</p><p>' +
          continueLinks +
          '</p>'
        );
      }
      var t = cartTotals(lines);
      var rows = lines
        .map(function (l, i) {
          return (
            '<div class="bp-mod-cartline">' +
            cartThumb(l.image_url) +
            '<span class="bp-mod-cartline-main">' +
            esc(l.name || 'Item') +
            (l.variantLabel ? ' <span class="bp-mod-meta">' + esc(l.variantLabel) + '</span>' : '') +
            (l.source === 'gallery' ? ' <span class="bp-mod-meta">Photo</span>' : '') +
            '</span>' +
            (l.source === 'gallery'
              ? '<span class="bp-mod-cartline-qty">× 1</span>'
              : '<span class="bp-mod-cartline-qty"><button type="button" class="bp-mod-qtybtn" data-bp-dec="' +
                i +
                '">−</button> ' +
                (Number(l.qty) || 1) +
                ' <button type="button" class="bp-mod-qtybtn" data-bp-inc="' +
                i +
                '">+</button></span>') +
            '<span class="bp-mod-cartline-total">' +
            cartMoney((Number(l.price_cents) || 0) * (Number(l.qty) || 1), l.currency) +
            '</span>' +
            '<button type="button" class="bp-mod-qtybtn" data-bp-remove="' +
            i +
            '" aria-label="Remove item">×</button></div>'
          );
        })
        .join('');
      return (
        '<h2>Review your order</h2>' +
        rows +
        '<p class="bp-mod-cart-total">Total: <strong>' +
        cartMoney(t.total, t.currency) +
        '</strong></p>' +
        (configured
          ? '<p><button type="button" class="bp-mod-btn" data-bp-pay>Pay with card</button></p>'
          : '<p class="bp-mod-err">This shop isn\'t set up to take payments yet — please check back soon.</p>') +
        '<p class="bp-mod-book-msg" data-bp-checkout-msg></p>' +
        '<p>' +
        continueLinks +
        '</p>'
      );
    }

    function wireReview() {
      el.querySelectorAll('[data-bp-inc]').forEach(function (b) {
        b.addEventListener('click', function () {
          var lines = readCart(token);
          var l = lines[Number(b.getAttribute('data-bp-inc'))];
          if (l) {
            l.qty = Math.min(99, (Number(l.qty) || 1) + 1);
            writeCart(token, lines);
          }
          draw();
        });
      });
      el.querySelectorAll('[data-bp-dec]').forEach(function (b) {
        b.addEventListener('click', function () {
          var lines = readCart(token);
          var l = lines[Number(b.getAttribute('data-bp-dec'))];
          if (l) {
            l.qty = Math.max(1, (Number(l.qty) || 1) - 1);
            writeCart(token, lines);
          }
          draw();
        });
      });
      el.querySelectorAll('[data-bp-remove]').forEach(function (b) {
        b.addEventListener('click', function () {
          var lines = readCart(token);
          lines.splice(Number(b.getAttribute('data-bp-remove')), 1);
          writeCart(token, lines);
          draw();
        });
      });
      var pay = el.querySelector('[data-bp-pay]');
      if (pay) {
        pay.addEventListener('click', function () {
          var msg = el.querySelector('[data-bp-checkout-msg]');
          var lines = readCart(token);
          if (!lines.length) return;
          pay.disabled = true;
          pay.textContent = 'Opening secure checkout…';
          var ret = new URL(window.location.href);
          ret.searchParams.delete('order');
          ret.searchParams.delete('session_id');
          fetch((base || '') + '/api/v1/modules/public/' + encodeURIComponent(token) + '/checkout-cart', {
            method: 'POST',
            credentials: 'omit',
            headers: jsonHeaders(),
            body: JSON.stringify({
              items: lines.map(function (l) {
                return {
                  source: l.source,
                  itemId: l.itemId,
                  quantity: l.qty,
                  variantId: l.variantId || undefined,
                };
              }),
              returnUrl: ret.toString(),
            }),
          })
            .then(function (r) {
              return r.json();
            })
            .then(function (j) {
              if (!j || !j.ok || !j.data || !j.data.url) throw new Error((j && j.error) || 'Checkout failed');
              window.location.href = j.data.url;
            })
            .catch(function (e) {
              pay.disabled = false;
              pay.textContent = 'Pay with card';
              if (msg) msg.textContent = e.message || 'Checkout failed. Please try again.';
            });
        });
      }
    }

    function draw() {
      el.innerHTML = reviewHtml();
      wireReview();
      // Batch 142: qty +/- and remove on the review surface change
      // the cart — the nav element reflects them live too.
      updateNavCart();
    }

    function successHtml(status) {
      var items = status.items || [];
      var rows = items
        .map(function (it) {
          return (
            '<div class="bp-mod-cartline">' +
            cartThumb(it.imageUrl) +
            '<span class="bp-mod-cartline-main">' +
            esc(it.name || 'Item') +
            (it.variantLabel ? ' <span class="bp-mod-meta">' + esc(it.variantLabel) + '</span>' : '') +
            '</span>' +
            '<span class="bp-mod-cartline-qty">× ' +
            (Number(it.quantity) || 1) +
            '</span>' +
            '<span class="bp-mod-cartline-total">' +
            cartMoney(it.lineTotalCents, it.currency) +
            '</span>' +
            // Delivery for a purchased photo: the buyer gets the full
            // photo right here — the download IS the delivery, and the
            // order record names exactly which photo was sold.
            (it.source === 'gallery' && it.imageUrl
              ? '<a class="bp-mod-btn ghost" href="' + esc(it.imageUrl) + '" download>Download photo</a>'
              : '') +
            '</div>'
          );
        })
        .join('');
      return (
        '<h2>' +
        esc((co.config && co.config.success_message) || 'Thank you for your order!') +
        '</h2>' +
        '<p>Payment received — Stripe emailed your receipt.</p>' +
        rows +
        '<p>' +
        continueLinks +
        '</p>'
      );
    }

    // Post-payment returns land back on this page (the Pay button's
    // own page), carrying order=success|cancelled&session_id=…
    var q = null;
    try {
      q = new URLSearchParams(window.location.search);
    } catch (e) {
      q = null;
    }
    var orderState = q && q.get('order');
    var sid = q && q.get('session_id');
    if (orderState === 'success' && sid) {
      el.innerHTML = '<p class="bp-mod-loading">Confirming your payment…</p>';
      fetch(
        (base || '') +
          '/api/v1/modules/public/' +
          encodeURIComponent(token) +
          '/order-status?session_id=' +
          encodeURIComponent(sid),
        { credentials: 'omit', headers: authHeaders() }
      )
        .then(function (r) {
          return r.json();
        })
        .then(function (j) {
          if (j && j.ok && j.data && j.data.status === 'paid') {
            writeCart(token, []);
            el.innerHTML = successHtml(j.data);
          } else if (j && j.ok && j.data && (j.data.status === 'failed' || j.data.status === 'expired')) {
            draw();
            el.insertAdjacentHTML(
              'afterbegin',
              '<p class="bp-mod-err">That payment did not complete — your card was not charged. Your cart is saved below.</p>'
            );
          } else {
            el.innerHTML =
              '<h2>Payment is processing</h2><p>You will get an email receipt from Stripe once it settles.</p><p>' +
              continueLinks +
              '</p>';
          }
        })
        .catch(function () {
          el.innerHTML =
            '<h2>Payment is processing</h2><p>You will get an email receipt from Stripe once it settles.</p><p>' +
            continueLinks +
            '</p>';
        });
      return;
    }
    draw();
    if (orderState === 'cancelled') {
      el.insertAdjacentHTML(
        'afterbegin',
        '<p class="bp-mod-notice">Checkout cancelled — your card was not charged. Your cart is saved below.</p>'
      );
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
          wireMemberNavLogout();
          return;
        }
        if (!j || !j.ok) throw new Error((j && j.error) || 'Failed to load');
        el.innerHTML = (j.data && j.data.html) || '';
        var mounts = el.querySelectorAll('[data-bitpype-module][data-bitpype-module-token]');
        for (var i = 0; i < mounts.length; i++) mountOne(mounts[i]);
        wireVideoFacades(el);
        wireMemberNavLogout();
      })
      .catch(function (e) {
        el.innerHTML = '<p class="bp-mod-err">' + esc(e.message || 'Failed to load page') + '</p>';
      });
  }

  /** Canonical static post URL for a legacy ?bpItem= redirect (Batch 32). */
  function staticBlogPostUrl(data, slug) {
    var stem = pathStem((data && data.embed && data.embed.target_page_slug) || '');
    if (!stem || stem === 'home' || stem === 'index') {
      stem = pathStem(location.pathname);
    }
    if (!stem || stem === 'home' || stem === 'index') stem = 'blog';
    return '/' + stem + '/' + encodeURIComponent(slug);
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
    // Batch 32: static blog exports server-render the post cards into
    // the mount (data-bitpype-static-blog="1") with real post URLs.
    // Keep that snapshot — never wipe it for the ?bpItem= pattern. A
    // legacy ?bpItem=<slug> link resolves its post below and redirects
    // to the canonical static post page (the CDN redirect layer cannot
    // match query strings, so this client redirect is the least-bad
    // landing; if resolution fails the snapshot simply stays).
    var staticBlog = el.getAttribute('data-bitpype-static-blog') === '1';
    var item = currentItemKey();
    if (staticBlog && !item) return;
    if (!staticBlog) el.innerHTML = '<p class="bp-mod-loading">Loading…</p>';
    var base = apiBase(el);
    var urlFor = function (slug) {
      return (
        (base || '') +
        '/api/v1/modules/public/' +
        encodeURIComponent(token) +
        (slug ? '?slug=' + encodeURIComponent(slug) + '&' : '?') +
        pageQuery()
      );
    };
    var handlePayload = function (j) {
      if (!j || !j.ok) throw new Error((j && j.error) || 'Failed to load');
      var data = j.data;
      if (data.locked) {
        registerNavCartFromPayload(data); renderLocked(el, data);
        return;
      }
      if (staticBlog) {
        if (data.module_type === 'blog' && data.item && data.item.slug) {
          location.replace(staticBlogPostUrl(data, data.item.slug));
        }
        return;
      }
      // Batch 142 (+ extension): ANY payload registers the nav cart
      // — from the selling signal (shop/gallery lists + item
      // payloads) or from the sitewide site_checkout stamp every
      // payload for a checkout site now carries (plain pages too).
      registerNavCartFromPayload(data);
      if (data.item) renderItem(el, data);
      else if (data.module_type === 'checkout') renderCheckout(el, data, base, token);
      else renderList(el, data);
      if (data.module_type === 'ecommerce') wireShop(el, base, token);
      // Batch 128: shop + gallery embeds feed the shared cart when a
      // Checkout module is attached (payload carries its page+token).
      if (data.module_type === 'ecommerce' || data.module_type === 'gallery') {
        wireSellableAdds(el, data);
        updateNavCart();
      }
      wireMemberNavLogout();
    };
    var loadPayload = function (slug) {
      return fetch(urlFor(slug), { credentials: 'omit', headers: authHeaders() }).then(function (r) {
        return r.json();
      });
    };
    loadPayload(item)
      .then(function (j) {
        // Batch 130: ?bpItem= is a PAGE-level param shared by every
        // embed on the page, so any embed is routinely handed a slug
        // that belongs to another module (or a stale/bad link). When
        // the item lookup answers NOT_FOUND, fall back to this
        // module's own list payload and render that — the same
        // never-dead-end rule the staticBlog snapshot follows above —
        // instead of painting an "Item not found" error card into a
        // module the visitor never asked to open an item in. A bad
        // slug on the OWNING embed lands on its list the same way.
        // Every other outcome keeps the original path: locked
        // payloads arrive ok:true and render the wall in
        // handlePayload; a NOT_FOUND on the list fetch itself (bad
        // token, detached shop) and any network/5xx failure still
        // throw into the error card below.
        if (item && !staticBlog && j && !j.ok && j.code === 'NOT_FOUND') {
          return loadPayload('').then(handlePayload);
        }
        return handlePayload(j);
      })
      .catch(function (e) {
        if (staticBlog) return; // snapshot stays — never dead-end
        el.innerHTML = '<p class="bp-mod-err">' + esc(e.message || 'Failed to load module') + '</p>';
      });
  }

  /* ── Member nav logout (Batch 82) ──
   * The members page card has always carried a Log out button; the site's
   * top nav did not, so a signed-in member browsing the site had no way
   * out short of returning to the members page. When a member session
   * exists, mirror a Log out link into the top nav right after the
   * Members link, cloned from that link so it inherits the site's own
   * nav styling (classes + <li> wrapping). The click runs the exact
   * members-page logout flow — capture the session headers first, clear
   * the stored session, POST /members/logout on the same route — then
   * re-mounts the page so gated content locks again. Signed out, nothing
   * is added: the nav renders exactly as before. */
  var MEMBER_NAV_LOGOUT_ATTR = 'data-bp-member-nav-logout';

  function memberNavItems() {
    // Managed module nav: the attr sits on the anchor, or on its <li>.
    var managed = document.querySelectorAll('[data-bitpype-module-nav="members"]');
    if (managed.length) return Array.prototype.slice.call(managed);
    // Structured-nav fallback: the members page is a plain page anchor
    // (default slug) inside the site chrome.
    var out = [];
    var chrome = document.querySelectorAll('nav a, header a');
    for (var i = 0; i < chrome.length; i++) {
      var href = String(chrome[i].getAttribute('href') || '').trim();
      var stem = href
        .replace(/^#/, '')
        .replace(/^\//, '')
        .replace(/\.html?$/i, '')
        .split('/')
        .pop();
      if (stem === 'members') out.push(chrome[i]);
    }
    return out;
  }

  function removeMemberNavLogout() {
    var olds = document.querySelectorAll('[' + MEMBER_NAV_LOGOUT_ATTR + ']');
    for (var i = 0; i < olds.length; i++) {
      if (olds[i].parentNode) olds[i].parentNode.removeChild(olds[i]);
    }
  }

  function memberNavLogoutNode(rowItem, anchor) {
    var a = document.createElement('a');
    a.setAttribute('href', '#');
    var cls = anchor.getAttribute('class');
    if (cls) a.setAttribute('class', cls);
    a.textContent = 'Log out';
    if (!rowItem || rowItem.tagName !== 'LI') {
      a.setAttribute(MEMBER_NAV_LOGOUT_ATTR, '1');
      return a;
    }
    var wrap = document.createElement('li');
    var liCls = rowItem.getAttribute('class');
    if (liCls) wrap.setAttribute('class', liCls);
    wrap.setAttribute(MEMBER_NAV_LOGOUT_ATTR, '1');
    wrap.appendChild(a);
    return wrap;
  }

  function wireMemberNavLogout() {
    var entry = storedMemberSessionEntry();
    removeMemberNavLogout();
    if (!entry) return;
    var items = memberNavItems();
    for (var i = 0; i < items.length; i++) {
      (function (item) {
        // Row item = the element occupying the nav row: the <li> when the
        // members link is list-wrapped, else the element itself.
        var anchor = item.tagName === 'A' ? item : item.querySelector('a');
        if (!anchor) return;
        var rowItem =
          item.tagName === 'LI'
            ? item
            : anchor.parentNode && anchor.parentNode.tagName === 'LI'
              ? anchor.parentNode
              : item;
        if (!rowItem.parentNode) return;
        var node = memberNavLogoutNode(rowItem, anchor);
        rowItem.parentNode.insertBefore(node, rowItem.nextSibling);
        var clickTarget = node.tagName === 'A' ? node : node.querySelector('a');
        if (!clickTarget) return;
        clickTarget.addEventListener('click', function (ev) {
          ev.preventDefault();
          var headers = jsonHeaders(); // session header captured BEFORE clearing — same order as the members-page button
          saveMemberSession(entry.token, '');
          memberPost(apiBase(clickTarget), entry.token, '/members/logout', {}, headers).catch(function () {});
          removeMemberNavLogout();
          mountAll();
        });
      })(items[i]);
    }
  }

  /* ── Batch 133 — universal detail page ──
   * The exported item.html (detail shell) carries ONE detail root + a JSON config
   * (type → public embed token + list page). The URL names exactly
   * ONE typed target — /detail/<type>/<key> — so the Batch 130
   * cross-embed ?bpItem= ambiguity cannot occur here: resolution goes
   * through the type's own public item path, published-only and
   * lead-scoped, and anything draft/foreign/missing lands on a proper
   * full-page not-found state (site chrome + link back to the list),
   * never an error card inside another page. Rendering reuses
   * renderItem wholesale — the same per-type detail layouts (variant
   * selectors, event shared gallery, album view, …) the list pages
   * have always used. */

  function parseDetailPath() {
    var m = /^\/detail\/([a-z]+)\/([^/]+)\/?$/.exec(location.pathname || '');
    if (!m) return null;
    try {
      return { type: m[1], key: decodeURIComponent(m[2]) };
    } catch (e) {
      return { type: m[1], key: m[2] };
    }
  }

  function detailConfig() {
    try {
      var node = document.getElementById('bp-detail-config');
      if (node) return JSON.parse(node.textContent || '{}') || {};
    } catch (e) {
      /* fall through */
    }
    return {};
  }

  function renderDetailNotFound(root, listPath) {
    root.innerHTML =
      '<article class="bp-mod-detail"><h1>Item not found</h1>' +
      '<p class="bp-mod-desc">This item is not available. It may have been removed, or the link may be out of date.</p>' +
      '<p style="margin-top:16px"><a class="bp-mod-btn" href="' +
      esc(listPath || '/') +
      '">Back to the list</a></p></article>';
    document.title = 'Item not found';
  }

  function setMetaTag(selector, attr, name, value) {
    if (!value) return;
    var node = document.head.querySelector(selector);
    if (!node) {
      node = document.createElement('meta');
      node.setAttribute(attr, name);
      document.head.appendChild(node);
    }
    node.setAttribute('content', value);
  }

  function detailApplyMeta(data) {
    var it = (data && data.item) || {};
    var title = it.title || it.name || it.question || '';
    if (!title) return;
    document.title = String(title);
    var desc = String(it.excerpt || it.description || it.bio || it.quote || '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300);
    var img = it.cover_image || it.image_url || '';
    setMetaTag('meta[name="description"]', 'name', 'description', desc);
    setMetaTag('meta[property="og:title"]', 'property', 'og:title', String(title));
    setMetaTag('meta[property="og:description"]', 'property', 'og:description', desc);
    setMetaTag('meta[property="og:image"]', 'property', 'og:image', img);
    try {
      var canon = document.head.querySelector('link[rel="canonical"]');
      if (!canon) {
        canon = document.createElement('link');
        canon.setAttribute('rel', 'canonical');
        document.head.appendChild(canon);
      }
      canon.setAttribute('href', location.origin + location.pathname);
    } catch (e) {
      /* canonical is best-effort */
    }
  }

  /* ══ BATCH 133 CHECKOUT WIRE POINT ══════════════════════════════
   * The detail page does NOT build a second cart. When the site has
   * the Batch 128 Checkout module attached, the item payload carries
   * checkout_token + checkout_page (128's getPublicModule* fields)
   * and the detail page's sell action feeds 128's cart: the SAME
   * localStorage key ('bp-cart-' + checkout token), the SAME generic
   * line shape 128's wireSellableAdds emits ({source, itemId,
   * variantId, variantLabel, name, image_url, price_cents, currency,
   * qty}), the SAME merge rule (source + itemId + variantId, qty cap
   * 99, 50-line cap). The server re-prices every line at session
   * creation, so the display snapshot here buys nothing by itself.
   * WIRED by the Batch 133 finisher (post-129 rebase): detailAddToCart
   * delegates to 128's addLineToCart directly (same file, above).
   * Without Checkout attached, none of this runs: the legacy single
   * Buy path (wireShop) applies exactly as before. */
  function detailAddToCart(checkoutToken, line) {
    // Batch 133 finisher wiring (post-129 rebase): the stub body is
    // gone — this delegates to Batch 128's real cart functions above
    // (readCart/writeCart/addLineToCart, same file): same storage
    // key, same merge rule, same caps, one cart implementation.
    return addLineToCart(checkoutToken, line);
  }

  function wireDetailCheckout(root, data) {
    var btn = root.querySelector('[data-bp-buy]');
    var it = data.item || {};
    if (!btn) return; // checkout_url products keep their own link
    btn.addEventListener('click', function (ev) {
      ev.preventDefault();
      var line = {
        source: 'ecommerce',
        itemId: Number(it.id),
        variantId: null,
        variantLabel: '',
        name: it.name || 'Item',
        image_url: it.image_url || '',
        price_cents: Number(it.price_from_cents != null ? it.price_from_cents : it.price_cents) || 0,
        currency: it.currency || 'USD',
        qty: 1,
      };
      // The Batch 127 axis selectors keep the resolved variant on the
      // buy button (data-bp-variant); price + label come from the
      // payload's own variant rows, never from the DOM.
      var variantId = btn.getAttribute('data-bp-variant');
      if (variantId) {
        line.variantId = Number(variantId) || null;
        var variants = Array.isArray(it.variants) ? it.variants : [];
        for (var i = 0; i < variants.length; i++) {
          if (Number(variants[i].id) === line.variantId) {
            line.variantLabel = variants[i].label || '';
            if (variants[i].price_cents != null) line.price_cents = Number(variants[i].price_cents) || 0;
            break;
          }
        }
      }
      detailAddToCart(data.checkout_token, line);
      // Batch 142: the detail page feeds the ONE nav cart, exactly
      // like the shop grid — no in-body bar on the detail root. On a
      // detail shell without site chrome, updateNavCart() finds no
      // nav target and does nothing; the button's "Added ✓" state
      // below is the visitor's confirmation there.
      registerNavCart(data.checkout_token, data.checkout_page);
      updateNavCart();
      var label = btn.textContent;
      btn.textContent = 'Added ✓';
      setTimeout(function () {
        btn.textContent = label;
      }, 1200);
    });
  }

  /* Batch 133 wire point (gallery): priced-photo adds on the album
   * detail view plug in here. Batch 128's gallery payload is what
   * marks a photo sellable (price_cents + data-bp-add-photo buttons
   * in renderAlbumDetail). WIRED by the finisher at the post-129
   * rebase: delegates to 128's wireSellableAdds itself (a photo
   * already in the cart cannot be added twice). */
  function detailPhotoSellableHook(root, data) {
    // Batch 133 finisher wiring: Batch 128's own wireSellableAdds
    // binds the album detail's [data-bp-add-photo] buttons (priced
    // photos, sold x1, already-in-cart state) to the shared cart —
    // the exact code path the gallery list uses, no second copy.
    if (data && data.checkout_token && data.checkout_page) wireSellableAdds(root, data);
  }

  /* Batch 131 finisher — the detail page's comments block. The
   * holder is a fresh embed element carrying the COMMENTS module's
   * token (posts/likes/state all ride the comments routes) plus the
   * detail marker renderComments forwards as detail=1, so a post
   * lands on this item's own target. No detail_comments in the item
   * payload (no Comments module, comments off, unresolvable target)
   * = no block, silently. */
  function mountDetailComments(root, data, base) {
    var ctx = data && data.detail_comments;
    if (!ctx || !ctx.thread || !ctx.token) return;
    var holder = document.createElement('div');
    holder.className = 'bitpype-module-embed';
    holder.setAttribute(TOKEN_ATTR, ctx.token);
    holder.setAttribute('data-bp-detail-comments', '1');
    if (base) holder.setAttribute('data-bitpype-api', base);
    root.appendChild(holder);
    renderComments(holder, {
      module_type: 'comments',
      title: (ctx.config && ctx.config.heading) || 'Comments',
      comments: ctx,
    });
  }

  function mountDetail() {
    var root = document.querySelector('[data-bitpype-detail-root]');
    if (!root) return;
    ensureStyles();
    polishHost(root);
    root.classList.add('bitpype-module-inpage');
    var target = parseDetailPath();
    var cfg = detailConfig();
    var entry = target && cfg.types ? cfg.types[target.type] : null;
    var listPath = entry && entry.page ? '/' + entry.page : '/';
    if (!target || DETAIL_TYPES.indexOf(target.type) < 0 || !entry || !entry.token) {
      renderDetailNotFound(root, listPath);
      return;
    }
    var base = apiBase(root) || cfg.api || '';
    var url =
      (base || '') +
      '/api/v1/modules/public/' +
      encodeURIComponent(entry.token) +
      '?slug=' +
      encodeURIComponent(target.key) +
      '&' +
      pageQuery();
    fetch(url, { credentials: 'omit', headers: authHeaders() })
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        if (!j || !j.ok) {
          if (j && j.code === 'NOT_FOUND') {
            renderDetailNotFound(root, listPath);
            return;
          }
          throw new Error((j && j.error) || 'Failed to load');
        }
        var data = j.data;
        if (data.locked) {
          registerNavCartFromPayload(data); renderLocked(root, data);
          return;
        }
        if (!data.item) {
          renderDetailNotFound(root, listPath);
          return;
        }
        renderItem(root, data);
        // renderItem's back link (and the bookings CTA) point at the
        // current page by construction; on the detail page they must
        // land on the type's list page.
        var legacy = listHref();
        var anchors = root.querySelectorAll('a[href]');
        for (var i = 0; i < anchors.length; i++) {
          if (anchors[i].getAttribute('href') === legacy) anchors[i].setAttribute('href', listPath);
        }
        detailApplyMeta(data);
        // Batch 142 (+ extension): register the nav cart from the
        // item payload (selling signal or the sitewide stamp). If
        // this shell has no site chrome (nav-section sites — Batch
        // 141's gap), registration is inert: no element, no error.
        registerNavCartFromPayload(data);
        if (data.module_type === 'ecommerce') {
          if (data.checkout_token && data.checkout_page) wireDetailCheckout(root, data);
          else wireShop(root, base, entry.token);
        }
        detailPhotoSellableHook(root, data);
        wireMemberNavLogout();
        // Batch 131 mount point: the comments block attaches to item
        // detail pages HERE — inside the detail root, after the
        // rendered article, keyed by (data.module_type, item slug/id)
        // through the shared layer. WIRED by the Batch 131 finisher:
        // the thread rides the item payload as detail_comments (the
        // server attached it because this site has an active
        // Comments module); renderComments does the rest.
        mountDetailComments(root, data, base);
      })
      .catch(function (e) {
        root.innerHTML = '<p class="bp-mod-err">' + esc(e.message || 'Failed to load module') + '</p>';
      });
  }

  /* Batch 142 extension — register the nav cart from ANY payload.
   * The selling signal (checkout_token + checkout_page) wins when a
   * payload carries it; otherwise the sitewide stamp
   * (data.site_checkout = { page, token }, stamped server-side on
   * every public payload for a lead with Checkout attached+active)
   * registers the same element — this is what puts the cart in the
   * nav on plain content pages (home, About, a blog index) whose
   * only embeds are non-selling modules. Both signals name the same
   * checkout embed (one server resolver), so registerNavCart's
   * one-cart dedupe sees identical values and exactly one element
   * results however many payloads a page loads. The stamp's token
   * is the cart storage key — the live count/total on a plain page
   * read the SAME cart the shop page wrote. Defined here (after the
   * detail mount) purely so the SEC-13 census line pins above never
   * move; function declarations hoist, so the mount paths above can
   * call it. Known edge, accepted: a page with NO module embeds at
   * all never loads this script and still shows no cart. */
  function registerNavCartFromPayload(data) {
    if (!data) return;
    if (data.checkout_token && data.checkout_page) {
      registerNavCart(data.checkout_token, data.checkout_page);
      return;
    }
    var sc = data.site_checkout;
    if (sc && sc.token && sc.page) registerNavCart(sc.token, sc.page);
  }

  function mountAll() {
    var nodes = document.querySelectorAll('[data-bitpype-module][data-bitpype-module-token]');
    for (var i = 0; i < nodes.length; i++) mountOne(nodes[i]);
    var gates = document.querySelectorAll('[data-bitpype-member-gate]');
    for (var g = 0; g < gates.length; g++) mountGate(gates[g]);
  }

  function boot() {
    ensureStyles();
    mountAll();
    mountDetail();
    wireMemberNavLogout();
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
