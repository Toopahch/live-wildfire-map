// =============================================================================
//  syncFireNews — scheduled Edge Function (Deno / TypeScript)
//
//  Runs on a schedule (see cron.sql). For every currently-active wildfire it:
//    1. Pulls official updates from InciWeb (one RSS feed → matched to fires).
//    2. Searches Google News RSS for the fire (name + location + wildfire terms).
//    3. Carefully filters/scores results (a generic "Bridge Fire" only counts if
//       the article also names the state/county/agency of THIS fire).
//    4. Deduplicates by URL and near-identical headline.
//    5. Saves new, non-blocked articles to Supabase.
//
//  No API keys, no paid services. Everything below is free + public.
//  Secrets come from Edge Function env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//  and (optional) CRON_SECRET to lock the endpoint down.
// =============================================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";

// ── Tunables (safe defaults; raise cautiously to respect free RSS rate limits) ─
const RECENCY_DAYS = 14;      // only keep articles newer than this
const MIN_CONFIDENCE = 45;    // articles below this score are discarded
const MAX_FIRES = 40;         // newsworthy fires searched per run (Google)
const MIN_ACRES = 25;         // ignore tiny fires for Google search
const MAX_ITEMS_PER_FIRE = 18;
const TIME_BUDGET_MS = 110_000;
const GOOGLE_DELAY_MS = 350;  // gap between Google News queries

const NIFC_URL =
  "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/" +
  "WFIGS_Incident_Locations_Current/FeatureServer/0/query";
const INCIWEB_RSS = "https://inciweb.wildfire.gov/incidents/rss.xml";

const US_STATES: Record<string, string> = {
  AL:"Alabama",AK:"Alaska",AZ:"Arizona",AR:"Arkansas",CA:"California",CO:"Colorado",
  CT:"Connecticut",DE:"Delaware",FL:"Florida",GA:"Georgia",HI:"Hawaii",ID:"Idaho",
  IL:"Illinois",IN:"Indiana",IA:"Iowa",KS:"Kansas",KY:"Kentucky",LA:"Louisiana",
  ME:"Maine",MD:"Maryland",MA:"Massachusetts",MI:"Michigan",MN:"Minnesota",MS:"Mississippi",
  MO:"Missouri",MT:"Montana",NE:"Nebraska",NV:"Nevada",NH:"New Hampshire",NJ:"New Jersey",
  NM:"New Mexico",NY:"New York",NC:"North Carolina",ND:"North Dakota",OH:"Ohio",OK:"Oklahoma",
  OR:"Oregon",PA:"Pennsylvania",RI:"Rhode Island",SC:"South Carolina",SD:"South Dakota",
  TN:"Tennessee",TX:"Texas",UT:"Utah",VT:"Vermont",VA:"Virginia",WA:"Washington",
  WV:"West Virginia",WI:"Wisconsin",WY:"Wyoming",PR:"Puerto Rico",DC:"District of Columbia",
};

interface Fire {
  fire_id: string; name: string; state: string; stateName: string;
  county: string | null; lat: number; lon: number;
  acres: number | null; contained: number | null; discovered: number | null;
}
interface Item {
  title: string; link: string; pubDate: number | null;
  description: string; sourceName: string | null; sourceUrl: string | null;
}

/* ───────────────────────────── small utilities ──────────────────────────── */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function decodeEntities(s: string): string {
  return s.replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}
const stripHtml = (s: string) => decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

function tag(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"));
  return m ? decodeEntities(m[1]).trim() : null;
}

function parseRss(xml: string): Item[] {
  return xml.split("<item>").slice(1).map((chunk) => {
    const block = chunk.split("</item>")[0];
    const src = block.match(/<source[^>]*url="([^"]*)"[^>]*>([^<]*)<\/source>/i);
    const pd = tag(block, "pubDate");
    return {
      title: tag(block, "title") ?? "",
      link: tag(block, "link") ?? "",
      pubDate: pd ? Date.parse(pd) || null : null,
      description: tag(block, "description") ?? "",
      sourceUrl: src ? src[1] : null,
      sourceName: src ? decodeEntities(src[2]).trim() : null,
    };
  });
}

function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); }
  catch { return ""; }
}

/** Normalize a fire / incident name for comparison (drop unit codes + "fire"). */
function normName(name: string): string {
  return name.toLowerCase()
    .replace(/\b(wildfire|fire|complex|incident)\b/g, " ")
    .replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}
function normTitle(title: string): string {
  return title.toLowerCase().replace(/\s+-\s+[^-]+$/, "") // drop trailing " - Source"
    .replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

/* ───────────────────────── source classification ────────────────────────── */

function classifySource(domain: string): { isOfficial: boolean; type: string } {
  const d = domain;
  if (d.includes("inciweb")) return { isOfficial: true, type: "inciweb" };
  if (/(^|\.)nifc\.gov$/.test(d)) return { isOfficial: true, type: "nifc" };
  if (/(^|\.)fire\.ca\.gov$/.test(d) || d.includes("readyforwildfire"))
    return { isOfficial: true, type: "calfire" };
  if (/(^|\.)fs\.usda\.gov$/.test(d) || /(^|\.)fs\.fed\.us$/.test(d))
    return { isOfficial: true, type: "usfs" };
  if (/(^|\.)blm\.gov$/.test(d)) return { isOfficial: true, type: "blm" };
  if (/(^|\.)nps\.gov$/.test(d)) return { isOfficial: true, type: "nps" };
  if (/(^|\.)weather\.gov$/.test(d) || /(^|\.)noaa\.gov$/.test(d))
    return { isOfficial: true, type: "nws" };
  if (d.endsWith(".gov") || d.endsWith(".us"))   // county/state/sheriff/OEM sites
    return { isOfficial: true, type: "gov" };
  return { isOfficial: false, type: "news" };
}

/* ───────────────────────── relevance + confidence ───────────────────────── */

const WILDFIRE_TERMS = ["wildfire", "evacuat", "containment", "contained", "acres",
  "smoke", "blaze", "burn", "firefighter", "perimeter", "red flag"];

/**
 * Score how well an article matches a fire. Returns null to REJECT.
 * The core safety rule: the fire's name must appear AND there must be at least
 * one location corroborator (state/county/agency) — otherwise a generic name
 * like "Bridge Fire" could match the wrong fire in another state.
 */
function scoreArticle(fire: Fire, title: string, body: string, domain: string):
  { score: number; reason: string } | null {
  const hayTitle = title.toLowerCase();
  const hay = (title + " " + body).toLowerCase();
  const reasons: string[] = [];
  let score = 0;

  const nm = fire.name.toLowerCase().trim();
  if (nm.length < 2) return null;
  const phrase = `${nm} fire`;
  const namePhraseInTitle = hayTitle.includes(phrase);
  const namePhraseInBody = hay.includes(phrase);
  if (!namePhraseInTitle && !namePhraseInBody) return null; // must name the fire

  if (namePhraseInTitle) { score += 35; reasons.push(`Title names "${fire.name} Fire"`); }
  else { score += 18; reasons.push(`Mentions "${fire.name} Fire"`); }

  // Location corroboration (need ≥1).
  let located = false;
  if (fire.county && hay.includes(fire.county.toLowerCase())) {
    score += 22; located = true; reasons.push(`${fire.county} County`);
  }
  if (fire.stateName && hay.includes(fire.stateName.toLowerCase())) {
    score += 16; located = true; reasons.push(fire.stateName);
  } else if (fire.state && new RegExp(`\\b${fire.state.toLowerCase()}\\b`).test(hay)) {
    score += 8; located = true; reasons.push(fire.state);
  }
  if (!located) return null; // generic-name guard

  // Wildfire context + freshness.
  const terms = WILDFIRE_TERMS.filter((t) => hay.includes(t));
  if (terms.length) { score += Math.min(15, terms.length * 5); reasons.push(terms.slice(0, 3).join(", ")); }

  const cls = classifySource(domain);
  if (cls.isOfficial) { score += 10; reasons.push("official source"); }

  return { score: Math.max(0, Math.min(100, score)), reason: reasons.join("; ") };
}

/* ──────────────────────────── Supabase REST I/O ─────────────────────────── */

const sbHeaders = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

async function sbGet(path: string): Promise<any[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbHeaders });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json();
}
async function sbUpsert(table: string, rows: any[], onConflict: string) {
  if (!rows.length) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: "POST",
    headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows),
  });
  if (!res.ok && res.status !== 409) console.warn(`upsert ${table}: ${res.status} ${await res.text()}`);
}
/** Insert news rows, skipping anything that violates a unique index. */
async function insertNews(rows: any[]) {
  for (const row of rows) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/fire_news`, {
      method: "POST",
      headers: { ...sbHeaders, Prefer: "return=minimal" },
      body: JSON.stringify(row),
    });
    if (!res.ok && res.status !== 409) console.warn(`insert news: ${res.status}`);
  }
}

/* ──────────────────────────── data gathering ───────────────────────────── */

function normIrwin(v: string | null): string | null {
  return v ? v.toUpperCase().replace(/[{}]/g, "") : null;
}

async function getActiveFires(): Promise<Fire[]> {
  const u = new URL(NIFC_URL);
  u.searchParams.set("where", "IncidentTypeCategory='WF'");
  u.searchParams.set("outFields",
    "IncidentName,IncidentSize,PercentContained,POOState,POOCounty,FireDiscoveryDateTime,IrwinID");
  u.searchParams.set("orderByFields", "IncidentSize DESC");
  u.searchParams.set("resultRecordCount", "2000");
  u.searchParams.set("returnGeometry", "true");
  u.searchParams.set("outSR", "4326");
  u.searchParams.set("f", "geojson");

  const data = await (await fetch(u.toString())).json();
  const fires: Fire[] = [];
  for (const f of (data.features ?? [])) {
    const p = f.properties ?? {};
    const id = normIrwin(p.IrwinID);
    const g = f.geometry;
    if (!id || !g || g.type !== "Point") continue;
    const st = (p.POOState ?? "").replace(/^US-/, "").toUpperCase();
    fires.push({
      fire_id: id,
      name: titleCase(p.IncidentName ?? ""),
      state: st,
      stateName: US_STATES[st] ?? st,
      county: p.POOCounty ? titleCase(p.POOCounty) : null,
      lat: g.coordinates[1], lon: g.coordinates[0],
      acres: typeof p.IncidentSize === "number" ? p.IncidentSize : null,
      contained: typeof p.PercentContained === "number" ? p.PercentContained : null,
      discovered: p.FireDiscoveryDateTime ?? null,
    });
  }
  return fires;
}

function titleCase(s: string): string {
  return (s || "").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

const recentEnough = (ms: number | null) =>
  ms == null ? true : (Date.now() - ms) <= RECENCY_DAYS * 864e5;

/* ───────────────────────────── InciWeb (official) ──────────────────────── */

async function inciwebRows(fires: Fire[]): Promise<any[]> {
  const byName = new Map<string, Fire>();
  for (const f of fires) byName.set(normName(f.name), f);

  let xml: string;
  try { xml = await (await fetch(INCIWEB_RSS)).text(); }
  catch (e) { console.warn("InciWeb fetch failed:", e); return []; }

  // InciWeb titles are prefixed with a unit code, e.g. "AZGID Steamboat Fire".
  const stripUnit = (t: string) => t.replace(/^[A-Z0-9]{2,6}\s+/, "");

  const rows: any[] = [];
  for (const it of parseRss(xml)) {
    const rawTitle = stripHtml(it.title);
    const fire = byName.get(normName(stripUnit(rawTitle))) ?? byName.get(normName(rawTitle));
    if (!fire) continue; // only keep InciWeb incidents that match an active fire
    const body = stripHtml(it.description);
    // Corroborate the state to avoid same-name collisions across regions.
    if (fire.stateName && !body.toLowerCase().includes(fire.stateName.toLowerCase())) continue;

    const overview = (body.split(/incident overview:/i)[1] ?? body).trim().slice(0, 320);
    rows.push({
      fire_id: fire.fire_id, fire_name: fire.name,
      title: `${fire.name} Fire — official InciWeb update`,
      summary: overview || `Official incident page for the ${fire.name} Fire on InciWeb.`,
      source_name: "InciWeb", source_url: "https://inciweb.wildfire.gov",
      article_url: it.link, image_url: null,
      published_at: it.pubDate ? new Date(it.pubDate).toISOString() : null,
      confidence_score: 100, match_reason: `Official InciWeb incident matched by name + ${fire.stateName}`,
      is_official_source: true, is_hidden: false,
      domain: "inciweb.wildfire.gov", source_type: "inciweb",
      norm_title: normTitle(fire.name + " fire inciweb"),
    });
  }
  return rows;
}

/* ───────────────────────────── Google News (per fire) ──────────────────── */

async function googleRowsForFire(fire: Fire, blocked: Set<string>): Promise<any[]> {
  const loc = fire.county ? `${fire.county} ${fire.stateName}` : fire.stateName;
  const q = `"${fire.name} Fire" ${loc} (wildfire OR evacuation OR containment OR acres OR smoke)`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;

  let xml: string;
  try { xml = await (await fetch(url)).text(); }
  catch (e) { console.warn(`Google fetch failed for ${fire.name}:`, e); return []; }

  const seenTitles = new Set<string>();
  const rows: any[] = [];
  for (const it of parseRss(xml).slice(0, MAX_ITEMS_PER_FIRE)) {
    if (!recentEnough(it.pubDate)) continue;
    const title = stripHtml(it.title).replace(/\s+-\s+[^-]+$/, "").trim();
    const body = stripHtml(it.description);
    const domain = it.sourceUrl ? domainOf(it.sourceUrl) : domainOf(it.link);
    if (blocked.has(domain)) continue;

    const verdict = scoreArticle(fire, title, body, domain);
    if (!verdict || verdict.score < MIN_CONFIDENCE) continue;

    const nt = normTitle(title);
    if (seenTitles.has(nt)) continue;          // in-batch dedup
    seenTitles.add(nt);

    const cls = classifySource(domain);
    rows.push({
      fire_id: fire.fire_id, fire_name: fire.name,
      title,
      summary: body.slice(0, 320) || null,
      source_name: it.sourceName ?? domain,
      source_url: it.sourceUrl ?? null,
      article_url: it.link, image_url: null,
      published_at: it.pubDate ? new Date(it.pubDate).toISOString() : null,
      confidence_score: verdict.score, match_reason: verdict.reason,
      is_official_source: cls.isOfficial, is_hidden: false,
      domain, source_type: cls.type, norm_title: nt,
    });
  }
  return rows;
}

/* ─────────────────────────────────── handler ───────────────────────────── */

Deno.serve(async (req) => {
  // Lock the endpoint: cron must present the secret (if one is configured).
  if (CRON_SECRET && req.headers.get("x-cron-secret") !== CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const started = Date.now();
  let added = 0, checked = 0;
  try {
    const fires = await getActiveFires();

    // Keep the fires snapshot current (also powers a future sitemap).
    await sbUpsert("fires", fires.map((f) => ({
      fire_id: f.fire_id, fire_name: f.name, state: f.state, county: f.county,
      latitude: f.lat, longitude: f.lon, acres: f.acres,
      percent_contained: f.contained,
      discovered_at: f.discovered ? new Date(f.discovered).toISOString() : null,
      is_active: true, last_seen_at: new Date().toISOString(),
    })), "fire_id");

    const blockedRows = await sbGet("blocked_sources?select=domain").catch(() => []);
    const blocked = new Set<string>(blockedRows.map((r: any) => r.domain));

    // 1) Official InciWeb updates (one feed, matched to fires).
    const official = await inciwebRows(fires);
    await dedupeAndInsert(official); added += official.length;

    // 2) Per-fire Google News, for the most newsworthy fires only.
    const candidates = fires
      .filter((f) => (f.acres ?? 0) >= MIN_ACRES && (f.contained == null || f.contained < 100))
      .slice(0, MAX_FIRES);

    for (const fire of candidates) {
      if (Date.now() - started > TIME_BUDGET_MS) { console.log("time budget reached"); break; }
      checked++;
      const rows = await googleRowsForFire(fire, blocked);
      added += await dedupeAndInsert(rows);
      await sbUpsert("fires", [{ fire_id: fire.fire_id, news_checked_at: new Date().toISOString() }], "fire_id");
      await sleep(GOOGLE_DELAY_MS);
    }

    await sbUpsert("news_sync_meta", [{
      id: true, last_run_at: new Date().toISOString(),
      fires_checked: checked, articles_added: added, status: "ok",
    }], "id");

    return Response.json({ ok: true, fires: fires.length, checked, added,
      ms: Date.now() - started });
  } catch (err) {
    console.error("syncFireNews failed:", err);
    await sbUpsert("news_sync_meta", [{ id: true, last_run_at: new Date().toISOString(),
      status: "error" }], "id").catch(() => {});
    return Response.json({ ok: false, error: String(err) }, { status: 500 });
  }
});

/** Skip URLs / titles we already stored for the fire, then insert the rest. */
async function dedupeAndInsert(rows: any[]): Promise<number> {
  if (!rows.length) return 0;
  const fireIds = [...new Set(rows.map((r) => r.fire_id))];
  const existing = await sbGet(
    `fire_news?fire_id=in.(${fireIds.map((i) => `"${i}"`).join(",")})&select=fire_id,article_url,norm_title`,
  ).catch(() => []);
  const seen = new Set(existing.map((e: any) => `${e.fire_id}|${e.article_url}`));
  const seenT = new Set(existing.map((e: any) => `${e.fire_id}|${e.norm_title}`));

  const fresh = rows.filter((r) => {
    const k = `${r.fire_id}|${r.article_url}`, kt = `${r.fire_id}|${r.norm_title}`;
    if (seen.has(k) || seenT.has(kt)) return false;
    seen.add(k); seenT.add(kt); return true;
  });
  await insertNews(fresh);
  return fresh.length;
}
