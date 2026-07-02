/* =============================================================================
   seo/generate.mjs — static SEO page generator for Live Wildfire Map.
   Fetches live NIFC wildfire data and writes real, server-rendered HTML pages
   (crawlable text baked in) for the homepage-adjacent SEO landing pages, plus a
   fresh sitemap.xml.  Run:  node seo/generate.mjs

   Re-run on a schedule (e.g. a daily GitHub Action) to keep the baked-in numbers
   fresh; the pages ALSO hydrate live numbers client-side via landing.js.
   ========================================================================== */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { STATES } from './states.mjs';

// ⚠️  PRE-LAUNCH: replace with your real production domain (also update index.html).
const SITE_URL = 'https://livewildfiremap.com';
const OG_IMAGE = SITE_URL + '/og-image.png';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = new Date();
const TODAY = NOW.toISOString().slice(0, 10);
const NOW_ISO = NOW.toISOString();
const NOW_HUMAN = NOW.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const updatedTime = () => `<time class="js-updated" datetime="${NOW_ISO}">${NOW_HUMAN}</time>`;

const NIFC = 'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/' +
  'WFIGS_Incident_Locations_Current/FeatureServer/0/query';

const STATE_GEO = { CA:[37.2,-119.5,6],OR:[44,-120.5,6],WA:[47.4,-120.5,6],ID:[45,-114.5,6],
  MT:[47,-109.5,6],WY:[43,-107.5,6],CO:[39,-105.5,6],UT:[39.3,-111.7,6],NV:[39.5,-116.9,6],
  AZ:[34.3,-111.7,6],NM:[34.4,-106,6],TX:[31.5,-99,6],OK:[35.5,-97.5,6],AK:[64,-152,4],
  FL:[28,-82,6],NE:[41.5,-99.8,6] };

/* ----------------------------- helpers ----------------------------- */
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
  (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const fmt = (n) => n == null ? '—' : Math.round(n).toLocaleString('en-US');
const titleCase = (s) => (s || '').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).trim();
const pct = (p) => p == null ? '—' : Math.round(p) + '%';
const isActive = (p) => p.PercentContained == null || p.PercentContained < 100;

async function getFires() {
  const u = new URL(NIFC);
  u.searchParams.set('where', "IncidentTypeCategory='WF'");
  u.searchParams.set('outFields', 'IncidentName,IncidentSize,PercentContained,POOState,POOCounty');
  u.searchParams.set('orderByFields', 'IncidentSize DESC');
  u.searchParams.set('resultRecordCount', '2000');
  u.searchParams.set('returnGeometry', 'false');
  u.searchParams.set('f', 'json');
  const j = await (await fetch(u.toString())).json();
  return (j.features || []).map((f) => f.attributes)
    .filter((a) => a.IncidentSize != null && isActive(a));
}

function statsFor(fires) {
  const acres = fires.reduce((s, f) => s + (f.IncidentSize || 0), 0);
  const wC = fires.filter((f) => f.PercentContained != null);
  const avg = wC.length ? Math.round(wC.reduce((s, f) => s + f.PercentContained, 0) / wC.length) : null;
  const states = new Set(fires.map((f) => (f.POOState || '').replace(/^US-/, '')).filter(Boolean));
  const counties = new Set(fires.map((f) => f.POOCounty).filter(Boolean));
  const top = fires.slice().sort((a, b) => (b.IncidentSize || 0) - (a.IncidentSize || 0));
  return { count: fires.length, acres, avg, states: states.size, counties, top };
}
const stAbbr = (f) => (f.POOState || '').replace(/^US-/, '').toUpperCase();

/* ----------------------------- HTML partials ----------------------------- */
// Bump when landing.css / landing.js change, so long-lived HTTP caches refresh.
const ASSET_V = '2';

function page({ title, desc, path, jsonld, body, bodyAttrs = '', noindex = false }) {
  const canonical = SITE_URL + path;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}"/>
<link rel="canonical" href="${canonical}"/>
<meta name="robots" content="${noindex ? 'noindex, follow' : 'index, follow, max-image-preview:large'}"/>
<meta name="theme-color" content="#0b0e14"/>
<meta name="color-scheme" content="dark"/>
<meta property="og:type" content="website"/>
<meta property="og:site_name" content="Live Wildfire Map"/>
<meta property="og:title" content="${esc(title)}"/>
<meta property="og:description" content="${esc(desc)}"/>
<meta property="og:url" content="${canonical}"/>
<meta property="og:image" content="${OG_IMAGE}"/>
<meta property="og:image:width" content="1200"/>
<meta property="og:image:height" content="630"/>
<meta property="og:image:alt" content="Live Wildfire Map — real-time map of active U.S. wildfires"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:title" content="${esc(title)}"/>
<meta name="twitter:description" content="${esc(desc)}"/>
<meta name="twitter:image" content="${OG_IMAGE}"/>
<link rel="icon" type="image/svg+xml" href="/logo.svg"/>
<link rel="apple-touch-icon" href="/apple-touch-icon.png"/>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link rel="dns-prefetch" href="https://unpkg.com"/>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet"/>
<link rel="stylesheet" href="/landing.css?v=${ASSET_V}"/>
${jsonld.map((j) => `<script type="application/ld+json">${JSON.stringify(j)}</script>`).join('\n')}
</head>
<body${bodyAttrs}>
<a class="skip-link" href="#main">Skip to content</a>
${siteHeader(path)}
<main class="wrap" id="main">
${body}
</main>
${siteFooter()}
<script src="/landing.js?v=${ASSET_V}" defer></script>
</body>
</html>`;
}

function siteHeader(current) {
  const nav = [
    ['/', '<span class="lit">Live</span> Map'],   // → the interactive map (homepage)
    ['/current-wildfires/', 'Current Wildfires'],
    ['/wildfire-map/', 'Wildfire Map'],
    ['/wildfires-near-me/', 'Near Me'],
  ];
  return `<header class="site-header"><div class="wrap">
<a class="brand" href="/"><img src="/logo.svg" alt="Live Wildfire Map logo" width="30" height="30"/><span><span class="lit">Live</span> Wildfire Map</span></a>
<nav class="site-nav" aria-label="Primary">
${nav.map(([h, t]) => `<a href="${h}"${current === h ? ' aria-current="page"' : ''}>${t}</a>`).join('')}
</nav></div></header>`;
}

function crumbs(items) {
  return `<nav class="crumbs" aria-label="Breadcrumb">${items.map((it, i) =>
    (i ? '<span>›</span>' : '') + (it.href ? `<a href="${it.href}">${esc(it.name)}</a>` : esc(it.name))
  ).join('')}</nav>`;
}
function breadcrumbSchema(items) {
  return { '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, name: it.name,
      item: SITE_URL + (it.href || '') })) };
}

function statsBar(cells) {
  return `<div class="stats">${cells.map((c) =>
    `<article class="stat" data-tone="${c.tone}"><span class="v ${c.cls}">${c.v}</span><span class="l">${c.l}</span></article>`
  ).join('')}</div>`;
}

/** Strip dispatch parentheticals like "Quarry 2 (13)" from consumer-facing names. */
const cleanName = (s) => titleCase(s).replace(/\s*\(\d+\)\s*$/, '');
/** Fires meaningful enough to appear in a "largest fires" list. */
const listable = (fires) => fires.filter((f) => (f.IncidentSize || 0) >= 10);

function fireList(fires, n) {
  const sized = listable(fires);
  if (!sized.length) return '<p>No sizable active wildfires are currently being tracked here.</p>';
  return `<ol class="firelist">${sized.slice(0, n).map((f, i) => {
    const loc = [f.POOCounty ? titleCase(f.POOCounty) + ' County' : null, stAbbr(f)].filter(Boolean).join(', ');
    const cont = f.PercentContained == null
      ? 'containment not yet reported'
      : pct(f.PercentContained) + ' contained';
    return `<li><span class="rank">${i + 1}</span><span><span class="fname">${esc(cleanName(f.IncidentName))} Fire</span> <span class="floc">${esc(loc)}</span></span><span class="facres">${fmt(f.IncidentSize)} acres</span><span class="fcont">${cont}</span></li>`;
  }).join('')}</ol>`;
}

function mapEmbed(label) {
  return `<div class="map-embed"><div id="map" role="region" aria-label="Interactive wildfire map"></div>
<div class="map-ph"><svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="#ff8c42" stroke-width="1.6" aria-hidden="true"><path d="M9 20l-5.5 2.5V6L9 3.5m0 16.5l6 2.5m-6-2.5V3.5m6 19l5.5-2.5V2.5L15 5m0 17.5V5m0 0L9 3.5" stroke-linejoin="round"/></svg>
<p>${esc(label)}</p><button type="button" class="btn">Load interactive map</button></div></div>`;
}

function faqSection(faqs) {
  const html = `<section class="faq" id="faq"><h2>Frequently asked questions</h2>${faqs.map((f) =>
    `<details><summary>${esc(f.q)}</summary><div class="a">${f.a}</div></details>`).join('')}</section>`;
  const schema = { '@context': 'https://schema.org', '@type': 'FAQPage',
    mainEntity: faqs.map((f) => ({ '@type': 'Question', name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: stripTags(f.a) } })) };
  return { html, schema };
}
// Decode the entities esc() produced so the JSON-LD FAQ text matches the
// DECODED visible text exactly (Google requires an exact match). Decode &amp; last.
const decodeEnt = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const stripTags = (s) => decodeEnt(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

function safety(state) {
  const stateLinks = state
    ? [`<a href="${state.agencyUrl}" target="_blank" rel="noopener">${esc(state.agency)}</a>`,
       ...(state.resources || []).map(([u, l]) => `<a href="${u}" target="_blank" rel="noopener">${esc(l)}</a>`)]
    : [];
  return `<section class="safety"><h2>Safety &amp; official sources</h2>
<p><strong>This site is informational only and is not an emergency service.</strong> Wildfire conditions change rapidly. Always follow your local authorities and official evacuation orders. Do not rely on this map for life-safety decisions.</p>
<div class="sources">
${stateLinks.join('\n')}
<a href="https://inciweb.wildfire.gov/" target="_blank" rel="noopener">InciWeb (official incidents)</a>
<a href="https://www.nifc.gov/fire-information/nfn" target="_blank" rel="noopener">NIFC Fire Information</a>
<a href="https://www.airnow.gov/fires/" target="_blank" rel="noopener">AirNow fire &amp; smoke</a>
<a href="https://www.ready.gov/wildfires" target="_blank" rel="noopener">Ready.gov Wildfires</a>
<a href="https://www.weather.gov/fire/" target="_blank" rel="noopener">NWS Fire Weather</a>
</div></section>`;
}

function browseByState(activeByState) {
  return `<section id="states"><h2>Browse wildfire maps by state</h2>
<p>Explore current wildfire activity, acreage, and containment for wildfire-prone states.</p>
<div class="state-grid">${STATES.map((s) =>
  `<a href="/${s.slug}-wildfire-map/">${esc(s.name)} <span class="n">${activeByState[s.abbr] ? activeByState[s.abbr] + ' active' : '0 active'}</span></a>`
).join('')}</div></section>`;
}

function siteFooter() {
  const cols = [
    ['Wildfire maps', [['/wildfire-map/', 'Interactive map'], ['/current-wildfires/', 'Current wildfires'], ['/wildfires-near-me/', 'Wildfires near me'], ['/', 'Live dashboard']]],
    ['By state', STATES.slice(0, 8).map((s) => [`/${s.slug}-wildfire-map/`, s.name])],
    ['More states', STATES.slice(8).map((s) => [`/${s.slug}-wildfire-map/`, s.name])],
    ['About', [['/about/', 'About this site'], ['/about/#data', 'Data & methodology'], ['/about/#privacy', 'Privacy'], ['/about/#contact', 'Contact']]],
    ['Official sources', [['https://inciweb.wildfire.gov/', 'InciWeb'], ['https://www.nifc.gov/', 'NIFC'], ['https://www.airnow.gov/fires/', 'AirNow'], ['https://www.ready.gov/wildfires', 'Ready.gov']]],
  ];
  return `<footer class="site-footer"><div class="wrap">
<div class="foot-cols">${cols.map(([h, links]) =>
  `<div><h3>${h}</h3>${links.map(([href, t]) =>
    `<a href="${href}"${href.startsWith('http') ? ' target="_blank" rel="noopener"' : ''}>${esc(t)}</a>`).join('')}</div>`).join('')}</div>
<div class="foot-legal">
<p><strong>Live Wildfire Map</strong> is an informational wildfire tracker. Data is sourced from the National Interagency Fire Center (NIFC / WFIGS), NOAA, Open-Meteo, OpenStreetMap, and Esri, and may not reflect real-time conditions. It is not affiliated with any government agency. <a href="/about/">Learn how this site works</a>.</p>
<p>Always follow local authorities and official evacuation orders for emergency information. &copy; ${new Date().getFullYear()} Live Wildfire Map.</p>
</div></div></footer>`;
}

// Same @id as the homepage's Organization node so every page references ONE
// entity instead of minting 19 anonymous near-duplicates.
const orgSchema = { '@context': 'https://schema.org', '@type': 'Organization',
  '@id': SITE_URL + '/#organization', name: 'Live Wildfire Map',
  url: SITE_URL + '/', logo: SITE_URL + '/logo.svg',
  description: 'Real-time interactive map and tracker of active U.S. wildfires.' };

// ONE canonical Dataset (emitted only on /current-wildfires/) with a real
// machine-readable download URL — Google requires contentUrl to be a direct
// data link, not an HTML portal page.
const NIFC_GEOJSON = NIFC + "?where=IncidentTypeCategory%3D%27WF%27&outFields=IncidentName,IncidentSize,PercentContained,POOState,POOCounty&returnGeometry=true&outSR=4326&f=geojson";
function datasetSchema() {
  return { '@context': 'https://schema.org', '@type': 'Dataset',
    '@id': SITE_URL + '/current-wildfires/#dataset',
    name: 'Active U.S. Wildfire Incidents',
    description: 'Live active wildfire incident data for the United States including size in acres, percent containment, and location, sourced from the National Interagency Fire Center (NIFC) WFIGS feed.',
    creator: { '@type': 'Organization', name: 'National Interagency Fire Center', url: 'https://www.nifc.gov/' },
    publisher: { '@id': SITE_URL + '/#organization' },
    isAccessibleForFree: true, license: 'https://www.usa.gov/government-works',
    keywords: ['wildfire', 'active fires', 'containment', 'acres', 'evacuation'],
    dateModified: NOW_ISO, url: SITE_URL + '/current-wildfires/',
    sameAs: 'https://data-nifc.opendata.arcgis.com/',
    distribution: [{ '@type': 'DataDownload', encodingFormat: 'application/geo+json', contentUrl: NIFC_GEOJSON }] };
}

/* ----------------------------- page builders ----------------------------- */
function buildCurrentWildfires(nat, activeByState) {
  const t = listable(nat.top)[0];
  const tLoc = t ? [t.POOCounty ? titleCase(t.POOCounty) + ' County' : null, stAbbr(t)].filter(Boolean).join(', ') : '';
  const tCont = t && t.PercentContained != null ? ` (${pct(t.PercentContained)} contained)` : '';
  const faqs = [
    { q: 'How many wildfires are burning in the U.S. right now?', a: `As of the latest update, roughly <b>${fmt(nat.count)} active wildfires</b> are being tracked across <b>${nat.states} states</b>, covering about <b>${fmt(nat.acres)} acres</b>. Figures update automatically from the NIFC feed.` },
    { q: 'What is the largest active wildfire right now?', a: t ? `The <b>${esc(cleanName(t.IncidentName))} Fire</b> in ${esc(tLoc)} is currently among the largest tracked fires at about <b>${fmt(t.IncidentSize)} acres</b>${tCont}.` : 'There are no large active wildfires being tracked at this time.' },
    { q: 'What does “percent contained” mean?', a: 'Containment measures how much of a fire’s perimeter has a control line around it — not how much of the fire is out. A fire that is 50% contained can still grow, and 100% contained means fully encircled, not extinguished.' },
    { q: 'Where does this wildfire data come from?', a: 'Fire locations, size, and containment come from the <a href="https://data-nifc.opendata.arcgis.com/" target="_blank" rel="noopener">National Interagency Fire Center (NIFC) WFIGS</a> feeds, with satellite imagery from Esri and smoke data from NOAA.' },
    { q: 'How often is the map updated?', a: 'The interactive map pulls live data on every visit and refreshes every few minutes. These summary pages refresh their numbers on load and are regenerated regularly.' },
  ];
  const faq = faqSection(faqs);
  const cr = [{ name: 'Home', href: '/' }, { name: 'Current wildfires', href: '/current-wildfires/' }];
  const body = `${crumbs(cr)}
<div class="hero"><h1>Current Wildfires in the United States</h1>
<p class="lede">A live map and summary of active wildfires burning across the U.S. right now — fire size in acres, containment, and the states and counties most affected.</p>
<p class="updated">Last updated ${updatedTime()} · Source: NIFC WFIGS</p></div>
${statsBar([
  { v: fmt(nat.count), l: 'Active wildfires', tone: 'hot', cls: 'js-count' },
  { v: fmt(nat.acres), l: 'Acres burning', tone: 'ember', cls: 'js-acres' },
  { v: nat.avg == null ? '—' : nat.avg + '%', l: 'Avg. contained', tone: 'cool', cls: 'js-contained' },
  { v: fmt(nat.states), l: 'States affected', tone: 'blue', cls: 'js-scope' },
])}
<section><h2>Largest active wildfires in the U.S.</h2>
<p>The biggest wildfires currently being tracked by acreage, with containment and location.</p>
${fireList(nat.top, 10)}</section>
<section><h2>Live U.S. wildfire map</h2>
<p>Zoom and pan the interactive satellite map to see every active wildfire, its perimeter, and containment. Markers are colored by containment and sized by fire area.</p>
${mapEmbed(`Satellite map of ${fmt(nat.count)} active U.S. wildfires`)}
<div class="cta-row"><a class="btn" href="/">Open the full live dashboard</a><a class="btn secondary" href="/wildfires-near-me/">Find wildfires near me</a></div></section>
${browseByState(activeByState)}
${faq.html}
${safety(null)}`;
  return page({
    title: `Current US Wildfires (${new Date().getFullYear()}) — Live Map & Containment`,
    desc: `Track ${fmt(nat.count)} active U.S. wildfires across ${nat.states} states — live map, acres burned, containment, and the counties affected. Updated from NIFC.`,
    path: '/current-wildfires/',
    jsonld: [orgSchema, breadcrumbSchema(cr), faq.schema, datasetSchema()],
    body, bodyAttrs: ' data-state="US" data-lat="39.5" data-lon="-98.35" data-zoom="4"',
  });
}

function buildWildfireMap(nat, activeByState) {
  const faqs = [
    { q: 'Is this wildfire map live?', a: 'Yes. The interactive map loads current wildfire data directly from the NIFC feed each time you open it and refreshes every few minutes automatically.' },
    { q: 'What do the marker colors and sizes mean?', a: 'Each marker is a wildfire. Color shows containment (red = under 30%, orange 30–60%, yellow 60–90%, green 90%+), and marker size reflects the fire’s area in acres. Shaded outlines are official fire perimeters.' },
    { q: 'Can I see wildfire smoke on the map?', a: 'Yes. The live dashboard includes a current smoke layer (NOAA HMS) and an hourly smoke forecast (HRRR-Smoke) you can play forward in time, plus wind direction.' },
    { q: 'Where does the wildfire data come from?', a: 'Incidents and perimeters come from NIFC WFIGS, satellite imagery from Esri, and smoke/weather from NOAA. See the sources listed on each page.' },
  ];
  const faq = faqSection(faqs);
  const cr = [{ name: 'Home', href: '/' }, { name: 'Wildfire map', href: '/wildfire-map/' }];
  const body = `${crumbs(cr)}
<div class="hero"><h1>Interactive U.S. Wildfire &amp; Smoke Map</h1>
<p class="lede">An interactive satellite map of every active wildfire in the United States, with real-time fire size, containment, official perimeters, a smoke forecast, and wind direction.</p>
<p class="updated">Tracking <b class="js-count">${fmt(nat.count)}</b> active fires · Last updated ${updatedTime()}</p></div>
${statsBar([
  { v: fmt(nat.count), l: 'Active wildfires', tone: 'hot', cls: 'js-count' },
  { v: fmt(nat.acres), l: 'Acres burning', tone: 'ember', cls: 'js-acres' },
  { v: nat.avg == null ? '—' : nat.avg + '%', l: 'Avg. contained', tone: 'cool', cls: 'js-contained' },
  { v: fmt(nat.states), l: 'States affected', tone: 'blue', cls: 'js-scope' },
])}
<section><h2>Explore the interactive map</h2>
<p>Pan and zoom the satellite map below to see active wildfires nationwide. For the full experience — smoke forecast, wind, search by ZIP or city, and per-fire news — open the live dashboard.</p>
${mapEmbed(`${fmt(nat.count)} active fires plotted live from NIFC data`)}
<div class="cta-row"><a class="btn" href="/">Open the full live dashboard</a><a class="btn secondary" href="/current-wildfires/">See current wildfires</a></div></section>
<section><h2>What you can do on the map</h2>
<h3>Track fire size &amp; containment</h3><p>Every active incident shows its size in acres and the percent contained, updated from official reporting.</p>
<h3>See the smoke forecast</h3><p>Toggle the current smoke layer and an hourly smoke forecast to see where smoke is headed, along with surface wind direction.</p>
<h3>Search your area</h3><p>Search any ZIP code, city, or county to jump to your area and see the nearest wildfires ranked by distance.</p></section>
${browseByState(activeByState)}
${faq.html}
${safety(null)}`;
  return page({
    title: 'Interactive Wildfire Map & Smoke Forecast — Live U.S. Fires',
    desc: `Interactive live map of ${fmt(nat.count)} active U.S. wildfires — fire size, containment, official perimeters, smoke forecast, and wind. Search by ZIP or city.`,
    path: '/wildfire-map/',
    // The WebApplication entity lives on the homepage (@id …/#webapp) — this
    // page just describes it, so no second conflicting app node here.
    jsonld: [orgSchema, breadcrumbSchema(cr), faq.schema],
    body, bodyAttrs: ' data-state="US" data-lat="39.5" data-lon="-98.35" data-zoom="4"',
  });
}

function buildNearMe(nat, activeByState) {
  // FAQ answers must be self-contained: they're served to Google as FAQPage
  // JSON-LD, where "the button above" is meaningless.
  const faqs = [
    { q: 'How do I find wildfires near me?', a: 'This page can check your exact area: allow location access (or search any ZIP code, city, or county on the live map) and the nearest active fires are listed by distance in miles, with their size and containment.' },
    { q: 'Are there wildfires near my location right now?', a: 'Yes or no depends on your area — the fastest way to check is a location or ZIP-code search on the live wildfire map, which ranks every active fire by distance from you. You can also browse current activity state by state.' },
    { q: 'How accurate is the location search?', a: 'Location search uses OpenStreetMap geocoding and works for ZIP codes, cities, counties, and landmarks across the United States. Fire positions come from official NIFC reporting.' },
  ];
  const faq = faqSection(faqs);
  const cr = [{ name: 'Home', href: '/' }, { name: 'Wildfires near me', href: '/wildfires-near-me/' }];
  const body = `${crumbs(cr)}
<div class="hero"><h1>Wildfires Near Me — Find Active Fires by Location</h1>
<p class="lede">Check for active wildfires near your location, ZIP code, or city. See the closest fires ranked by distance, plus their size and containment.</p>
<p class="updated"><b class="js-count">${fmt(nat.count)}</b> active wildfires nationwide · Last updated ${updatedTime()}</p></div>
<section><h2>Find wildfires near you</h2>
<p>Use your device location to instantly see the closest active wildfires, or search your ZIP code or city on the interactive map.</p>
<div class="cta-row"><button class="btn" id="find-near-me" type="button">Find wildfires near me</button><a class="btn secondary" href="/">Search by ZIP or city on the map</a></div>
<div id="near-results" aria-live="polite"></div>
${mapEmbed('Map of active fires near you')}</section>
<section><h2>Understanding wildfires near your location</h2>
<p>Knowing whether there’s a wildfire near you starts with distance, direction, and wind. A fire many miles away can still affect your air quality, while a closer fire may prompt evacuation warnings from local officials. Use the tools above to see the nearest active fires, then rely on your county and state authorities for any evacuation guidance.</p>
<h3>How close is “near”?</h3>
<p>There’s no single safe distance — it depends on terrain, fuels, and especially wind. Fast-moving grass and brush fires can travel miles in hours under red-flag conditions. If an active fire is within roughly 10–20 miles of you and winds are pushing it your way, monitor official alerts closely.</p>
<h3>What to do if a fire is nearby</h3>
<p>Sign up for your county’s emergency alerts, prepare a go-bag, know at least two evacuation routes, and follow evacuation orders immediately when they’re issued. This map is for situational awareness only and should never replace official emergency instructions.</p>
<h3>Smoke and air quality</h3>
<p>Even distant wildfires can send smoke into your area. Check the live smoke forecast on the interactive map and the official <a href="https://www.airnow.gov/fires/" target="_blank" rel="noopener">AirNow fire &amp; smoke map</a>, and limit outdoor activity when air quality is poor — especially for children, older adults, and anyone with respiratory conditions.</p>
<h3>Largest active wildfires in the U.S. right now</h3>
<p>The biggest fires currently being tracked nationwide, by acreage:</p>
${fireList(nat.top, 6)}</section>
${browseByState(activeByState)}
${faq.html}
${safety(null)}`;
  return page({
    title: 'Wildfires Near Me — Find Active Wildfires by ZIP Code or City',
    desc: 'Find active wildfires near you. Use your location or search any ZIP code, city, or county to see the closest fires by distance, with size and containment. Live U.S. data.',
    path: '/wildfires-near-me/',
    jsonld: [orgSchema, breadcrumbSchema(cr), faq.schema],
    body, bodyAttrs: ' data-state="US" data-lat="39.5" data-lon="-98.35" data-zoom="4"',
  });
}

function buildStatePage(st, fires, nat, activeByState) {
  const s = statsFor(fires);
  const geo = STATE_GEO[st.abbr] || [39.5, -98.35, 4];
  const t = listable(s.top)[0];
  const yr = new Date().getFullYear();
  const countiesBit = s.counties.size
    ? (s.counties.size === 1 ? ' in 1 county' : ` across ${s.counties.size} counties`)
    : '';
  const tCont = t && t.PercentContained != null ? ` (${pct(t.PercentContained)} contained)` : '';
  const faqs = [
    { q: `How many wildfires are burning in ${st.name} right now?`,
      a: s.count === 0
        ? `No active wildfires are currently being tracked in ${st.name}. This page updates automatically from the NIFC feed, so check back for current activity.`
        : `As of the latest update, about <b>${fmt(s.count)} active wildfire${s.count === 1 ? '' : 's'}</b> ${s.count === 1 ? 'is' : 'are'} being tracked in ${st.name}, covering roughly <b>${fmt(s.acres)} acres</b>${countiesBit}.` },
    { q: `What is the largest wildfire in ${st.name}?`, a: t ? `The <b>${esc(cleanName(t.IncidentName))} Fire</b>${t.POOCounty ? ` in ${esc(titleCase(t.POOCounty))} County` : ''} is currently the largest tracked fire in ${st.name} at about <b>${fmt(t.IncidentSize)} acres</b>${tCont}.` : `There are no large active wildfires being tracked in ${st.name} at this time.` },
    { q: `When is wildfire season in ${st.name}?`, a: `${st.name}’s wildfire season typically runs ${st.season}. Risk is highest during hot, dry, and windy stretches, so check current conditions and any local burn restrictions before outdoor activity.` },
    { q: `Where can I get official ${st.name} wildfire and evacuation information?`, a: `For official updates and evacuation orders, contact <a href="${st.agencyUrl}" target="_blank" rel="noopener">${esc(st.agency)}</a>, check <a href="https://inciweb.wildfire.gov/" target="_blank" rel="noopener">InciWeb</a>, and follow your county emergency management and local authorities.` },
  ];
  const faq = faqSection(faqs);
  const cr = [{ name: 'Home', href: '/' }, { name: 'Current wildfires', href: '/current-wildfires/' }, { name: st.name, href: `/${st.slug}-wildfire-map/` }];
  const hasList = listable(s.top).length > 0;
  const related = (st.related || [])
    .map((ab) => STATES.find((x) => x.abbr === ab)).filter(Boolean);
  const anchorStyles = [(x) => `${x.name} wildfire map`, (x) => `fires in ${x.name}`, (x) => `${x.name} wildfires`];
  const nearby = related.length
    ? `<p class="tight">Nearby: ${related.map((x, i) =>
        `<a href="/${x.slug}-wildfire-map/">${esc(anchorStyles[i % anchorStyles.length](x))}</a>`).join(' · ')}</p>`
    : '';
  const body = `${crumbs(cr)}
<div class="hero"><h1>${st.name} Wildfire Map — Active Fires, Acres &amp; Containment</h1>
<p class="lede">Live map and summary of active wildfires burning in ${st.name} right now, including fire size, containment, and the counties affected.</p>
<p class="updated">Last updated ${updatedTime()} · Source: NIFC WFIGS</p></div>
${statsBar([
  { v: fmt(s.count), l: `Active fires in ${st.abbr}`, tone: 'hot', cls: 'js-count' },
  { v: fmt(s.acres), l: 'Acres burning', tone: 'ember', cls: 'js-acres' },
  { v: s.avg == null ? '—' : s.avg + '%', l: 'Avg. contained', tone: 'cool', cls: 'js-contained' },
  { v: fmt(s.counties.size), l: 'Counties affected', tone: 'blue', cls: 'js-scope' },
])}
<section><h2>Wildfires in ${st.name} right now</h2>
<p>${esc(st.blurb)} Wildfire season here typically runs ${st.season}.</p>
${hasList ? `<h3>Largest active fires in ${st.name}</h3>
${fireList(s.top, 8)}` : `<p class="tight">No sizable active wildfires are currently being tracked in ${st.name} — this page refreshes automatically as conditions change.</p>`}
</section>
<section><h2>Where ${st.name} wildfires burn</h2>
<p>${esc(st.regions)}</p>
${nearby}</section>
<section><h2>Live ${st.name} wildfire map</h2>
<p>Explore active wildfires across ${st.name} on the interactive satellite map. For the smoke forecast, wind, and search tools, open the full dashboard.</p>
${mapEmbed(`${st.name} fires plotted live from NIFC data`)}
<div class="cta-row"><a class="btn" href="/">Open the full live dashboard</a><a class="btn secondary" href="/current-wildfires/">All U.S. wildfires</a></div></section>
${faq.html}
${safety(st)}
${browseByState(activeByState)}`;
  return page({
    title: `${st.name} Wildfire Map (${yr}) — Active Fires & Containment`,
    desc: s.count === 0
      ? `Live ${st.name} wildfire map — no active wildfires tracked right now. Auto-updating from NIFC with fire size, containment, and official ${st.agency} sources.`
      : `Live ${st.name} wildfire map: ${fmt(s.count)} active fire${s.count === 1 ? '' : 's'} burning across ~${fmt(s.acres)} acres. See size, containment, counties, and ${st.agency} sources.`,
    path: `/${st.slug}-wildfire-map/`,
    jsonld: [orgSchema, breadcrumbSchema(cr), faq.schema],
    body, bodyAttrs: ` data-state="${st.abbr}" data-lat="${geo[0]}" data-lon="${geo[1]}" data-zoom="${geo[2]}"`,
  });
}

function buildAbout(nat) {
  const cr = [{ name: 'Home', href: '/' }, { name: 'About', href: '/about/' }];
  const body = `${crumbs(cr)}
<div class="hero"><h1>About Live Wildfire Map</h1>
<p class="lede">What this site is, exactly where its data comes from, how often it updates, and what it can’t tell you.</p>
<p class="updated">Last updated ${updatedTime()}</p></div>
<section><h2>What this site is</h2>
<p>Live Wildfire Map is an independent, free wildfire tracker. It plots every active U.S. wildfire on an interactive satellite map — size in acres, percent contained, official perimeters, current smoke, an hourly smoke forecast, and surface wind — and refreshes itself automatically. There are no accounts, no paywalls, and no app to install.</p>
<p><strong>It is not an emergency service.</strong> It exists for situational awareness. For evacuation decisions, always rely on your county emergency management, local fire agencies, and official alerts.</p></section>
<section id="data"><h2>Data &amp; methodology</h2>
<p>Everything on the map comes from public, authoritative feeds, loaded directly in your browser:</p>
<p class="tight"><b>Fire locations, size &amp; containment</b> — the National Interagency Fire Center’s <a href="https://data-nifc.opendata.arcgis.com/" target="_blank" rel="noopener">WFIGS live incident feed</a>, the same interagency system used across federal and state fire management.</p>
<p class="tight"><b>Fire perimeters</b> — NIFC WFIGS interagency perimeter mapping.</p>
<p class="tight"><b>Current smoke</b> — <a href="https://www.ospo.noaa.gov/products/land/hms.html" target="_blank" rel="noopener">NOAA Hazard Mapping System</a> satellite smoke analysis.</p>
<p class="tight"><b>Smoke forecast</b> — NOAA’s HRRR-Smoke model (hourly, ~48 hours ahead).</p>
<p class="tight"><b>Wind</b> — <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a> 10&nbsp;m surface wind.</p>
<p class="tight"><b>Location search</b> — <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> Nominatim geocoding (&copy; OpenStreetMap contributors).</p>
<p class="tight"><b>Imagery</b> — Esri World Imagery.</p>
<p>The interactive map re-pulls live data about every 5 minutes while open. These summary pages are regenerated twice daily and additionally refresh their headline numbers in your browser on each visit.</p></section>
<section><h2>Known limitations — read this</h2>
<p>Official incident reporting always lags the fire itself: a fast-moving fire can be miles beyond its last mapped perimeter, and newly ignited fires may take hours to appear in the feed. Acreage and containment are updated by incident teams on their own schedules. Smoke forecasts are model output, not measurements. If what you see outside your window disagrees with this map, trust your eyes and your local authorities.</p></section>
<section id="privacy"><h2>Privacy</h2>
<p>This site has no accounts, sets no tracking cookies, and runs no ad or analytics trackers. If you use “find wildfires near me”, your location is read by your browser, used on your device to sort fires by distance, and never stored or transmitted to us. Data requests go directly from your browser to the public services listed above (NIFC, NOAA, Esri, Open-Meteo, OpenStreetMap, Google Fonts), which see your IP address as with any website you visit.</p></section>
<section id="contact"><h2>Contact &amp; corrections</h2>
<p>Spotted something wrong? Fire data issues (size, containment, location) originate in the official NIFC feed and are corrected there by incident teams. For problems with the site itself — a broken feature, a data mismatch, or a suggestion — email <a href="mailto:hello@livewildfiremap.com">hello@livewildfiremap.com</a>.</p></section>
${safety(null)}`;
  return page({
    title: 'About Live Wildfire Map — Data Sources & Methodology',
    desc: 'How Live Wildfire Map works: NIFC WFIGS fire data, NOAA smoke, Open-Meteo wind, update cadence, known limitations, privacy, and how to reach us.',
    path: '/about/',
    jsonld: [orgSchema, breadcrumbSchema(cr)],
    body,
  });
}

function build404() {
  const body = `
<div class="hero" style="text-align:center;padding-top:56px"><h1>Page not found</h1>
<p class="lede" style="margin:12px auto 0">The page you’re looking for doesn’t exist or may have moved. Try one of these instead:</p></div>
<div class="cta-row" style="justify-content:center">
<a class="btn" href="/">Live wildfire dashboard</a>
<a class="btn secondary" href="/current-wildfires/">Current wildfires</a>
<a class="btn secondary" href="/wildfires-near-me/">Wildfires near me</a>
</div>
<section style="border:none"><h2 style="text-align:center">Wildfire maps by state</h2>
<div class="state-grid" style="max-width:720px;margin:14px auto 0">
${STATES.map((s) => `<a href="/${s.slug}-wildfire-map/">${esc(s.name)}</a>`).join('\n')}
</div></section>`;
  return page({
    title: 'Page not found — Live Wildfire Map',
    desc: 'This page could not be found. Explore the live U.S. wildfire map, current wildfires, and wildfire maps by state.',
    path: '/404.html',
    jsonld: [orgSchema],
    body,
    noindex: true,
  });
}

/* ----------------------------- write + sitemap ----------------------------- */
function writePage(rel, html) {
  const dir = join(ROOT, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), html);
  console.log('  wrote', rel + '/index.html', '(' + Math.round(html.length / 1024) + ' KB)');
}

function writeSitemap(paths) {
  // lastmod is emitted ONLY for pages this generator actually rewrote — the
  // homepage isn't touched here, and a provably false lastmod teaches Google
  // to ignore the field sitewide.
  const urls = [{ loc: '/', pri: '1.0', freq: 'daily', mod: false },
    ...paths.map((p) => ({ loc: p, pri: p === '/about/' ? '0.5' : '0.8', freq: p === '/about/' ? 'monthly' : 'daily', mod: true }))];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${SITE_URL}${u.loc}</loc>${u.mod ? `<lastmod>${TODAY}</lastmod>` : ''}<changefreq>${u.freq}</changefreq><priority>${u.pri}</priority></url>`).join('\n')}
</urlset>
`;
  writeFileSync(join(ROOT, 'sitemap.xml'), xml);
  console.log('  wrote sitemap.xml (' + urls.length + ' urls)');
}

/* ----------------------------- main ----------------------------- */
(async function main() {
  console.log('Fetching live NIFC wildfire data…');
  const fires = await getFires();
  const nat = statsFor(fires);
  const byState = {};
  fires.forEach((f) => { const a = stAbbr(f); if (a) byState[a] = (byState[a] || 0) + 1; });
  console.log(`  ${nat.count} active fires, ${fmt(nat.acres)} acres, ${nat.states} states`);

  console.log('Generating pages…');
  writePage('current-wildfires', buildCurrentWildfires(nat, byState));
  writePage('wildfire-map', buildWildfireMap(nat, byState));
  writePage('wildfires-near-me', buildNearMe(nat, byState));
  writePage('about', buildAbout(nat));
  writeFileSync(join(ROOT, '404.html'), build404());
  console.log('  wrote 404.html');

  const paths = ['/current-wildfires/', '/wildfire-map/', '/wildfires-near-me/', '/about/'];
  for (const st of STATES) {
    const sf = fires.filter((f) => stAbbr(f) === st.abbr);
    writePage(`${st.slug}-wildfire-map`, buildStatePage(st, sf, nat, byState));
    paths.push(`/${st.slug}-wildfire-map/`);
  }
  writeSitemap(paths);
  console.log('Done. ' + (paths.length + 1) + ' URLs (incl. homepage).');
})().catch((e) => { console.error('Generation failed:', e); process.exit(1); });
