// https://swapaya.com/i/<item id> — the page a shared Swapaya listing opens.
//
// Cloudflare Worker (static assets + this script; config in /wrangler.jsonc). Every file of the site
// is served as a static asset BEFORE this script runs, so it only sees /i/… and paths that match no
// file. Spec: design/specs/30-share-links.md in the app repo (github.com/digvijays386/YouSwapper).
// Who sees this page:
//   · members with the app never do — Android App Links / iOS Universal Links open the app instead,
//     using the two files in /.well-known (keep those in step with the app's signing keys and team);
//   · everyone else gets one photo, the title, the lister's first name and rough area, and ONE button
//     to the right store for their phone, picked here from the User-Agent (the page runs no JS);
//   · chat apps (WhatsApp, iMessage, Telegram…) read the OG tags and draw a card with the photo.
//
// Data comes from ONE anon RPC, public_listing (migration 051), which answers for Live listings only
// and returns nothing else about the member. Never a price, a surname, a distance or a map.
//
// Environment ("vars" in /wrangler.jsonc — public values, so they live in the repo, not the dashboard):
//   SUPABASE_URL       https://<project>.supabase.co
//   SUPABASE_ANON_KEY  the public anon key the app ships (the same one the waitlist form uses)
//   IMAGE_TRANSFORMS   "on" once Images → Transformations is enabled for the zone (spec 30 §6.6);
//                      anything else serves the original photo.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// items.photos is owner-writable text, so a path is validated before it becomes a URL.
const PHOTO_PATH = /^[A-Za-z0-9/_.-]+$/;
const SITE = 'https://swapaya.com';

// Store links — keep in step with /app/index.html here. (The app itself no longer carries store
// links: it shares https://swapaya.com/i/<id> and lets this page pick the store.)
const APP_STORE = 'https://apps.apple.com/gb/app/swapaya/id6796486365';
const APPLE_APP_ID = '6796486365';
const APPLE_PT = ''; // App Store Connect provider token; blank = no campaign tag (same as /app)
const PLAY = 'https://play.google.com/store/apps/details?id=com.swapaya.app';
const ANDROID_PACKAGE = 'com.swapaya.app';

export default {
  async fetch(request, env) {
    const segments = new URL(request.url).pathname.split('/').filter((s) => s);
    // Anything outside /i/ matched no file of the site: a plain 404, with no call to Supabase.
    if (segments[0] !== 'i') return notFound(request);
    return listingResponse(request, env, segments.slice(1));
  },
};

async function listingResponse(request, env, path) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
  }
  const id = itemId(path);
  const result = id ? await fetchListing(env, id) : { state: 'gone' };
  const device = deviceOf(request.headers.get('user-agent') || '');

  let status, html;
  if (result.state === 'live') {
    status = 200;
    html = itemPage(result.listing, id, device, env);
  } else if (result.state === 'error') {
    status = 503;
    html = messagePage(COPY.errorTitle, COPY.errorBody, id, device);
  } else {
    status = 404;
    html = messagePage(COPY.goneTitle, COPY.goneBody, id, device);
  }
  return new Response(request.method === 'HEAD' ? null : html, {
    status,
    headers: responseHeaders(env, status),
  });
}

// The segments after /i/ ("<id>", with or without a trailing slash) → the lower-case id; else null.
function itemId(segments) {
  if (segments.length !== 1) return null;
  const id = segments[0].toLowerCase();
  return UUID.test(id) ? id : null;
}

// A mistyped address anywhere on the site. Small, noindex, and the same look as the listing page.
function notFound(request) {
  const head = `
<title>${esc(COPY.siteTitle)}</title>`;
  const body = `
<main class="card">
  <div class="text">
    <h1>${esc(COPY.notFoundTitle)}</h1>
    <p class="meta"><a href="/">${esc(COPY.notFoundLink)}</a></p>
  </div>
</main>`;
  return new Response(request.method === 'HEAD' ? null : shell(head, body), {
    status: 404,
    headers: responseHeaders({}, 404),
  });
}

async function fetchListing(env, id) {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return { state: 'error' };
  const headers = { apikey: env.SUPABASE_ANON_KEY, 'content-type': 'application/json' };
  // Legacy anon keys are JWTs and go in Authorization too; new publishable keys (sb_…) must not.
  if (!env.SUPABASE_ANON_KEY.startsWith('sb_')) headers.authorization = `Bearer ${env.SUPABASE_ANON_KEY}`;
  try {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/public_listing`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ p_item_id: id }),
    });
    if (!res.ok) return { state: 'error' };
    const rows = await res.json();
    return Array.isArray(rows) && rows[0] ? { state: 'live', listing: rows[0] } : { state: 'gone' };
  } catch {
    return { state: 'error' };
  }
}

function deviceOf(ua) {
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'other';
}

// ── links ───────────────────────────────────────────────────────────────────

function appStoreUrl() {
  return APPLE_PT ? `${APP_STORE}?pt=${APPLE_PT}&ct=share&mt=8` : APP_STORE;
}

// The referrer reaches the app through Play's Install Referrer API, so a new Android member lands on
// this listing after sign-up (spec 30 §9). Google Play reports the utm_ pair under Acquisition.
function playUrl(id) {
  const tags = 'utm_source=share&utm_campaign=item_link';
  const referrer = id ? `${tags}&swapaya_item=${id}` : tags;
  return `${PLAY}&${tags}&referrer=${encodeURIComponent(referrer)}`;
}

// Opens the app on this listing when it's installed (e.g. from inside Instagram's or TikTok's
// browser, where App Links don't fire), else Play.
function androidIntentUrl(id) {
  const path = id ? `/i/${id}` : '/';
  return `intent://swapaya.com${path}#Intent;scheme=https;package=${ANDROID_PACKAGE};`
    + `S.browser_fallback_url=${encodeURIComponent(playUrl(id))};end`;
}

function photoUrl(env, path, width) {
  if (!path || !PHOTO_PATH.test(path) || path.includes('..') || path.includes('//')) return '';
  const original = `${env.SUPABASE_URL}/storage/v1/object/public/item-photos/${path}`;
  if (env.IMAGE_TRANSFORMS !== 'on') return original;
  return `${SITE}/cdn-cgi/image/width=${width},quality=70,format=jpeg/${original}`;
}

// ── copy ────────────────────────────────────────────────────────────────────
// Never a pronoun for a member ("Mia is swapping this", never "she").

const COPY = {
  iosButton: 'Get Swapaya to swap for this',
  androidButton: 'Swap for this in Swapaya',
  getIos: 'Get it on iPhone',
  getAndroid: 'Get it on Android',
  pitch: 'Swap the things you don’t use for things you’ll love — with people near you. No prices, no fees.',
  about: 'What’s Swapaya?',
  goneTitle: 'This listing isn’t available any more',
  goneBody: 'It may have been swapped already. There’s plenty more to swap near you on Swapaya.',
  errorTitle: 'We couldn’t load this listing just now',
  errorBody: 'Try again in a minute — or open Swapaya and find it there.',
  notFoundTitle: 'This page isn’t here',
  notFoundLink: 'Go to swapaya.com',
  siteTitle: 'Swapaya — Snap it. Swap it.',
};

function byline(name, area) {
  if (name && area) return `${name} · near ${area}`;
  return name || (area ? `Near ${area}` : '');
}

function description(name, area) {
  if (name && area) return `${name} is swapping this near ${area}.`;
  if (name) return `${name} is swapping this on Swapaya.`;
  if (area) return `Up for swap near ${area}.`;
  return 'Up for swap on Swapaya.';
}

// ── pages ───────────────────────────────────────────────────────────────────

function itemPage(listing, id, device, env) {
  const title = clean(listing.title) || 'A swap on Swapaya';
  const name = clean(listing.first_name);
  const area = clean(listing.area);
  const link = `${SITE}/i/${id}`;
  const card = photoUrl(env, listing.photo, 1200);
  const hero = photoUrl(env, listing.photo, 900);
  const meta = byline(name, area);

  const head = `
<title>${esc(title)} · Swapaya</title>
<meta name="description" content="${esc(description(name, area))}" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="Swapaya" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(description(name, area))}" />
<meta property="og:url" content="${esc(link)}" />
${card ? `<meta property="og:image" content="${esc(card)}" />
<meta property="og:image:alt" content="${esc(title)}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:image" content="${esc(card)}" />` : '<meta name="twitter:card" content="summary" />'}
<link rel="canonical" href="${esc(link)}" />
<meta name="apple-itunes-app" content="app-id=${APPLE_APP_ID}, app-argument=${esc(link)}" />`;

  const body = `
<main class="card">
  ${hero ? `<img class="photo" src="${esc(hero)}" alt="${esc(title)}" />` : '<div class="photo none" aria-hidden="true"></div>'}
  <div class="text">
    <h1>${esc(title)}</h1>
    ${meta ? `<p class="meta">${esc(meta)}</p>` : ''}
    ${buttons(id, device)}
  </div>
</main>
<p class="pitch">${esc(COPY.pitch)} <a href="/">${esc(COPY.about)}</a></p>`;

  return shell(head, body);
}

function messagePage(heading, text, id, device) {
  const head = `
<title>${esc(COPY.siteTitle)}</title>
<meta property="og:type" content="website" />
<meta property="og:site_name" content="Swapaya" />
<meta property="og:title" content="${esc(COPY.siteTitle)}" />
<meta property="og:description" content="${esc(COPY.goneBody)}" />
<meta property="og:image" content="${SITE}/og.png" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="apple-itunes-app" content="app-id=${APPLE_APP_ID}" />`;

  const body = `
<main class="card">
  <div class="text">
    <h1>${esc(heading)}</h1>
    <p class="meta">${esc(text)}</p>
    ${buttons(id, device)}
  </div>
</main>
<p class="pitch">${esc(COPY.pitch)} <a href="/">${esc(COPY.about)}</a></p>`;

  return shell(head, body);
}

// One button for a phone; both stores for anything else.
function buttons(id, device) {
  if (device === 'ios') return `<a class="btn" href="${esc(appStoreUrl())}">${esc(COPY.iosButton)}</a>`;
  if (device === 'android') return `<a class="btn" href="${esc(androidIntentUrl(id))}">${esc(COPY.androidButton)}</a>`;
  return `<div class="pair">
      <a class="btn" href="${esc(appStoreUrl())}">${esc(COPY.getIos)}</a>
      <a class="btn ghost" href="${esc(playUrl(id))}">${esc(COPY.getAndroid)}</a>
    </div>`;
}

// The site's design kit (index.html), with system fonts so the page stays a few KB.
function shell(head, body) {
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<meta name="theme-color" content="#FAF4E8" />
<link rel="icon" href="/favicon.ico" sizes="32x32" />
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />${head}
<style>
:root{--cream:#FAF4E8;--surface:#FFFFFF;--accent:#FA7D1B;--accent-press:#DA660C;--on-accent:#2E2A24;
  --green:#3A6B4F;--sage:#D4E4D4;--ink:#2E2A24;--body-ink:#4A5A4F;--muted:#8A8A82;--line:#EBE2D2;
  --shadow-card:0 18px 34px -26px rgba(46,42,36,.42);--shadow-cta:0 12px 22px -12px rgba(250,125,27,.6);
  --head:ui-rounded,'SF Pro Rounded','Nunito',system-ui,sans-serif;
  --body:system-ui,-apple-system,'Segoe UI',Roboto,'Inter',sans-serif}
@media (prefers-color-scheme:dark){:root{--cream:#141E18;--surface:#1E2C24;--green:#7FBF9A;--sage:#22332A;
  --ink:#F2EFE7;--body-ink:#C2CFC6;--muted:#93A398;--line:rgba(255,255,255,.10);
  --shadow-card:0 20px 38px -26px rgba(0,0,0,.75)}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:var(--cream);color:var(--ink);font:16px/1.55 var(--body);
  padding:20px 16px 40px;display:flex;flex-direction:column;align-items:center}
.brand{display:flex;align-items:center;gap:8px;text-decoration:none;color:var(--green);
  font:800 22px/1 var(--head);letter-spacing:-.02em;margin:4px 0 18px}
.brand img{width:30px;height:30px;border-radius:8px}
.card{width:100%;max-width:440px;background:var(--surface);border-radius:22px;overflow:hidden;
  box-shadow:var(--shadow-card);border:1px solid var(--line)}
.photo{display:block;width:100%;aspect-ratio:4/3;object-fit:cover;background:var(--sage)}
.text{padding:20px 20px 22px}
h1{margin:0;font:800 24px/1.2 var(--head);letter-spacing:-.01em;overflow-wrap:anywhere}
.meta{margin:8px 0 0;color:var(--body-ink)}
.btn{display:flex;align-items:center;justify-content:center;min-height:52px;margin-top:20px;padding:14px 22px;
  border-radius:999px;background:var(--accent);color:var(--on-accent);font:800 16px/1.2 var(--head);
  text-align:center;text-decoration:none;box-shadow:var(--shadow-cta)}
.btn:active{transform:translateY(1px)}
.btn:hover{background:var(--accent-press);color:#fff}
.btn.ghost{background:transparent;color:var(--green);border:1.8px solid var(--green);box-shadow:none}
.btn.ghost:hover{background:transparent;color:var(--green)}
.pair .btn+.btn{margin-top:10px}
.pitch{max-width:440px;margin:20px 0 0;color:var(--muted);font-size:14.5px;text-align:center}
.pitch a{color:var(--green);font-weight:700}
</style>
</head>
<body>
<a class="brand" href="/"><img src="/favicon.svg" alt="" />Swapaya</a>${body}
</body>
</html>`;
}

function responseHeaders(env, status) {
  const img = env.SUPABASE_URL ? ` ${new URL(env.SUPABASE_URL).origin}` : '';
  return {
    'content-type': 'text/html; charset=utf-8',
    // A removed listing renders for at most a minute (spec 30 §6.5); an outage is never cached.
    'cache-control': status === 503 ? 'no-store' : 'public, max-age=60',
    // The button depends on the phone, so no cache may hand an iPhone page to Android.
    vary: 'User-Agent',
    'x-robots-tag': 'noindex',
    'content-security-policy': `default-src 'none'; img-src 'self'${img}; style-src 'unsafe-inline'; `
      + `base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    'referrer-policy': 'strict-origin-when-cross-origin',
    'x-content-type-options': 'nosniff',
  };
}

// Member text, collapsed to one line before it is escaped.
function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

// Every member string goes through this — text and attributes alike (spec 30 §6.4).
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
