/**
 * news.js — "Latest News & Updates" panel for the selected fire.
 * -----------------------------------------------------------------------------
 * Reads CACHED news from Supabase (written by the scheduled syncFireNews job) —
 * it never searches live on page load. Official sources are shown first, then
 * recent articles. Fails safe: any error just shows a fallback, never breaks the
 * map. Until Supabase is configured in config.js it shows a friendly empty state.
 */
'use strict';

window.WildfireNews = (function () {
  const SB = (window.WF_CONFIG && window.WF_CONFIG.supabase) || { url: '', anonKey: '' };
  const enabled = !!(SB.url && SB.anonKey);

  const cache = new Map();           // fireId -> { ts, rows }
  const TTL = 5 * 60 * 1000;
  let metaCheckedAt = undefined;     // last sync time (fetched once)
  let currentFireId = null;
  const el = {};

  /* ----------------------------- helpers ----------------------------- */
  const $ = (id) => document.getElementById(id);
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function timeAgo(iso) {
    if (!iso) return '';
    const diff = Date.now() - new Date(iso).getTime();
    if (isNaN(diff)) return '';
    const d = Math.floor(diff / 864e5);
    if (d <= 0) {
      const h = Math.floor(diff / 36e5);
      return h <= 0 ? 'just now' : h + 'h ago';
    }
    if (d < 30) return d + 'd ago';
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function domainLabel(row) {
    return row.source_name || (row.domain || '').replace(/^www\./, '') || 'Source';
  }
  /** Only ever link/load http(s) URLs — cached rows originate from third-party
      RSS feeds, so schemes like javascript: must never reach an href. */
  function safeUrl(u) {
    if (!u || typeof u !== 'string') return ''; // null would coerce to a relative "/null" URL
    try {
      const p = new URL(u, location.href);
      return (p.protocol === 'http:' || p.protocol === 'https:') ? p.href : '';
    } catch { return ''; }
  }

  /* ----------------------------- data ----------------------------- */
  async function sb(path) {
    const res = await fetch(`${SB.url}/rest/v1/${path}`, {
      headers: { apikey: SB.anonKey, Authorization: `Bearer ${SB.anonKey}` },
      cache: 'no-store'
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  async function fetchNews(fireId) {
    const hit = cache.get(fireId);
    if (hit && Date.now() - hit.ts < TTL) return hit.rows;
    const rows = await sb(
      `fire_news?fire_id=eq.${encodeURIComponent(fireId)}&is_hidden=eq.false` +
      `&select=title,summary,source_name,source_url,article_url,image_url,published_at,is_official_source,domain` +
      `&order=is_official_source.desc,published_at.desc.nullslast&limit=15`
    );
    cache.set(fireId, { ts: Date.now(), rows });
    return rows;
  }

  let metaTs = 0;
  async function fetchMeta() {
    // Same TTL as the news cache — this tab can live for hours on auto-refresh,
    // so "last checked" must not be frozen at its first value forever.
    if (metaCheckedAt !== undefined && Date.now() - metaTs < TTL) return metaCheckedAt;
    metaTs = Date.now();
    try {
      const r = await sb('news_sync_meta?select=last_run_at&limit=1');
      metaCheckedAt = (r[0] && r[0].last_run_at) || null;
    } catch { metaCheckedAt = null; }
    return metaCheckedAt;
  }

  /* ----------------------------- render ----------------------------- */
  function cardHtml(row) {
    const official = row.is_official_source;
    const iu = safeUrl(row.image_url);
    const href = safeUrl(row.article_url);
    // Real article image when the feed provides one (rare for RSS); otherwise a
    // source-logo tile via Google's favicon service — always available, and it
    // identifies the outlet at a glance. Broken images collapse to the tile.
    let dom = (row.domain || '').replace(/^www\./, '');
    if (!dom && href) { try { dom = new URL(href).hostname.replace(/^www\./, ''); } catch { /* noop */ } }
    const favicon = dom
      ? `<span class="nc-thumb nc-favicon${official ? ' is-official' : ''}"><img src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(dom)}&sz=64" alt="" loading="lazy" width="28" height="28" onerror="this.remove()"/></span>`
      : '';
    const img = iu
      ? `<img class="nc-thumb" src="${esc(iu)}" alt="" loading="lazy" onerror="this.remove()"/>`
      : favicon;
    return `
      <article class="news-card${official ? ' is-official' : ''}">
        ${img}
        <div class="nc-main">
          ${official ? '<span class="nc-badge">Official source</span>' : ''}
          <a class="nc-title" href="${esc(href || '#')}" target="_blank" rel="noopener noreferrer nofollow">
            ${esc(row.title)}
          </a>
          <div class="nc-meta">
            <span class="nc-src">${esc(domainLabel(row))}</span>
            ${row.published_at ? `<span class="nc-dot">·</span><time datetime="${esc(row.published_at)}">${esc(timeAgo(row.published_at))}</time>` : ''}
          </div>
          ${row.summary ? `<p class="nc-summary">${esc(row.summary)}</p>` : ''}
        </div>
      </article>`;
  }

  const OFFICIAL_LINKS = `<p class="news-official-links">
    <a href="https://inciweb.wildfire.gov/" target="_blank" rel="noopener">InciWeb</a> ·
    <a href="https://www.nifc.gov/fire-information/nfn" target="_blank" rel="noopener">NIFC</a> ·
    <a href="https://www.airnow.gov/fires/" target="_blank" rel="noopener">AirNow smoke</a></p>`;

  /** Honest empty state when the news backend simply isn't configured —
      never pretend a search ran and found nothing. */
  function renderDisabled() {
    el.body.innerHTML = `<div class="news-empty">
      <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.6">
        <path d="M4 19h16M4 5h16M8 9h8M8 13h6" stroke-linecap="round"/></svg>
      <p>Per-fire news updates aren’t available yet. For official incident information, check:</p>
      ${OFFICIAL_LINKS}</div>`;
  }

  function renderError(fire) {
    el.body.innerHTML = `<div class="news-empty">
      <p>Couldn’t load news updates — check your connection.</p>
      <button type="button" class="news-retry" id="news-retry">Try again</button></div>`;
    const btn = $('news-retry');
    if (btn) btn.addEventListener('click', () => loadInto(fire));
  }

  function renderRows(rows, fire) {
    if (!rows || !rows.length) {
      const isNew = fire && fire.discovered && (Date.now() - fire.discovered) < 2 * 864e5;
      const msg = isNew
        ? 'News may take time to appear for newly detected fires.'
        : 'No recent news found for this fire yet.';
      el.body.innerHTML = `<div class="news-empty">
        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.6">
          <path d="M4 19h16M4 5h16M8 9h8M8 13h6" stroke-linecap="round"/></svg>
        <p>${msg}</p>${OFFICIAL_LINKS}</div>`;
      return;
    }
    const official = rows.filter((r) => r.is_official_source);
    const press = rows.filter((r) => !r.is_official_source);
    let html = '';
    if (official.length) html += `<h3 class="news-group">Official updates</h3>` + official.map(cardHtml).join('');
    if (press.length) html += `<h3 class="news-group">In the news</h3>` + press.map(cardHtml).join('');
    el.body.innerHTML = html;
  }

  async function loadInto(fire) {
    el.checked.textContent = '';

    if (!enabled || !fire.irwin) {
      renderDisabled(); // no fake "Checking…" flash when nothing will be checked
      return;
    }
    el.body.innerHTML = `<div class="news-loading"><span class="spinner-sm"></span>Checking for updates…</div>`;
    try {
      const [rows, checked] = await Promise.all([fetchNews(fire.irwin), fetchMeta()]);
      if (currentFireId !== fire.irwin) return; // user switched fires meanwhile
      renderRows(rows, fire);
      el.checked.textContent = checked ? `Updates last checked ${timeAgo(checked)}` : '';
    } catch (err) {
      console.warn('[news] load failed:', err);
      if (currentFireId === fire.irwin) renderError(fire); // honest failure + retry
    }
  }

  /* ----------------------------- public API ----------------------------- */
  let lastTrigger = null;   // element to return focus to on close
  let historyPushed = false;

  function open(fire) {
    if (!fire) return;
    if (!el.panel) cacheDom();
    const wasOpen = el.panel.classList.contains('is-open');
    currentFireId = fire.irwin || fire.id || null;
    el.fire.textContent = (fire.name || 'This fire') + ' Fire';
    if (el.summary) el.summary.innerHTML = fireSummaryLine(fire); // values escaped in fireSummaryLine
    el.panel.hidden = false;
    document.querySelector('.map-wrap')?.classList.add('news-open');
    void el.panel.offsetHeight; // flush layout so the slide-in animates from the closed state
    el.panel.classList.add('is-open');
    // Focus management: remember what opened the panel, move focus into it so
    // screen-reader/keyboard users land on the new content (not on re-open —
    // switching fires shouldn't steal focus from the list).
    if (!wasOpen) {
      lastTrigger = document.activeElement;
      if (el.close) el.close.focus();
      // One history entry per open, so the phone back button closes the sheet
      // instead of leaving the site.
      if (!historyPushed) {
        try { history.pushState({ wfNews: true }, ''); historyPushed = true; } catch { /* sandboxed */ }
      }
    }
    loadInto(fire);
  }

  function close(opts = {}) {
    if (!el.panel || !el.panel.classList.contains('is-open')) return;
    el.panel.classList.remove('is-open');
    document.querySelector('.map-wrap')?.classList.remove('news-open');
    currentFireId = null;
    setTimeout(() => { if (!el.panel.classList.contains('is-open')) el.panel.hidden = true; }, 320);
    if (lastTrigger && document.contains(lastTrigger)) lastTrigger.focus();
    lastTrigger = null;
    // Consume the history entry we pushed (unless this close IS the back button).
    if (historyPushed && !opts.fromPopstate) {
      historyPushed = false;
      try { if (history.state && history.state.wfNews) history.back(); } catch { /* noop */ }
    } else {
      historyPushed = false;
    }
    document.dispatchEvent(new CustomEvent('wf:news-closed'));
  }

  /** Containment color ramp — same thresholds as the map markers/popup. */
  function containColor(pct) {
    const p = pct == null ? 0 : pct;
    if (p >= 90) return '#34d399';
    if (p >= 60) return '#fbbf24';
    if (p >= 30) return '#fb923c';
    return '#ef4444';
  }
  const titleCase = (s) => String(s || '').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

  /** Compact fire summary shown under the title — color-coded to match the
      desktop popup (ember acres, containment-ramp percentage, labeled cause). */
  function fireSummaryLine(fire) {
    const bits = [];
    if (fire.acres != null) {
      bits.push(`<b class="nps-acres">${Math.round(fire.acres).toLocaleString('en-US')} acres</b>`);
    }
    if (fire.contained != null) {
      bits.push(`<b style="color:${containColor(fire.contained)}">${Math.round(fire.contained)}% contained</b>`);
    }
    const loc = [fire.county, fire.state].filter(Boolean).join(', ') || fire.stateName;
    if (loc) bits.push(esc(loc));
    bits.push(`<span class="nps-cause">Cause:</span> ${esc(fire.cause ? titleCase(fire.cause) : 'Under investigation')}`);
    return bits.join('<span class="nps-dot"> · </span>');
  }

  function cacheDom() {
    el.panel = $('news-panel');
    el.fire = $('np-fire');
    el.summary = $('np-summary');
    el.body = $('np-body');
    el.checked = $('np-checked');
    el.close = $('np-close');
    if (el.panel) {
      el.panel.setAttribute('role', 'dialog');
      el.panel.setAttribute('aria-labelledby', 'np-fire');
    }
    if (el.close) el.close.addEventListener('click', () => close());
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    window.addEventListener('popstate', () => {
      if (el.panel && el.panel.classList.contains('is-open')) close({ fromPopstate: true });
    });
  }

  if (document.readyState !== 'loading') cacheDom();
  else document.addEventListener('DOMContentLoaded', cacheDom);

  return { open, close, _enabled: enabled };
})();
