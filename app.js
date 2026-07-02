/**
 * app.js — Live Wildfire Map
 * -----------------------------------------------------------------------------
 * A self-contained, framework-free dashboard that renders live U.S. wildfire
 * activity onto an interactive satellite map and auto-refreshes itself.
 *
 * Flow:  fetch live feeds → normalize → render(map + sidebar + stats) → repeat.
 * No backend, no build step. The browser is the whole runtime.
 */
'use strict';

(function () {
  const CFG = window.WF_CONFIG;

  /* ----------------------------- application state ----------------------- */
  const state = {
    fires: [],          // normalized incident records
    filter: 'active',   // active | contained | all
    search: '',
    sort: 'size',
    selectedId: null,
    lastUpdated: null,
    map: null,
    markerLayer: null,
    perimeterLayer: null,
    markers: new Map(), // id -> Leaflet marker
    perimeterCenters: new Map(), // fire id -> [lat,lon] centroid of its perimeter
    locatedAt: null,    // { lat, lon, label } when the user searches a place
    searchMarker: null, // the "your area" pin
    geocoding: false,
    timer: null,        // refresh interval
    countdownTimer: null,
    nextRefreshAt: 0,
    isLoading: false
  };

  /* ----------------------------- tiny DOM helpers ------------------------ */
  const $ = (id) => document.getElementById(id);
  const el = {
    statusPill: null, statusLabel: null, lastUpdated: null, countdown: null,
    refreshBtn: null, search: null, filter: null, sort: null,
    list: null, listCount: null, overlay: null, overlayText: null, retryBtn: null,
    statCount: null, statCountLabel: null, statAcres: null, statContained: null, statStates: null,
    locateBanner: null, locateText: null, locateClear: null
  };

  /* ====================================================================== *
   *  FORMATTING / DOMAIN HELPERS
   * ====================================================================== */

  const US_STATES = {
    AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',
    CT:'Connecticut',DE:'Delaware',FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',
    IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',
    ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',
    MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',
    NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',
    OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',
    TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',WA:'Washington',
    WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming',PR:'Puerto Rico',DC:'Washington, D.C.'
  };

  /** "US-CA" -> "CA" */
  const stateCode = (poo) => (poo || '').replace(/^US-/, '').toUpperCase();
  const stateName = (poo) => US_STATES[stateCode(poo)] || stateCode(poo) || 'Unknown';

  const fmtInt = (n) =>
    n == null ? '—' : Math.round(n).toLocaleString('en-US');

  function timeAgo(ms) {
    if (!ms) return 'unknown';
    const diff = Date.now() - ms;
    if (diff < 0) return 'just now';
    const m = Math.floor(diff / 6e4);
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    const d = Math.floor(h / 24);
    if (d < 30) return d + 'd ago';
    return Math.floor(d / 30) + 'mo ago';
  }

  function clockTime(d) {
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  const titleCase = (s) =>
    (s || '').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  /** Containment-driven color ramp (red → green). */
  function containColor(pct) {
    const p = pct == null ? 0 : pct;
    if (p >= 90) return '#34d399';
    if (p >= 60) return '#fbbf24';
    if (p >= 30) return '#fb923c';
    return '#ef4444';
  }

  /** Marker radius scales with the square root of area (perceptual area ∝ acres). */
  function acresToRadius(acres) {
    const a = Math.max(0, acres || 0);
    return Math.max(5, Math.min(40, 5 + Math.sqrt(a) * 0.17));
  }

  /* ====================================================================== *
   *  DATA LOADING
   * ====================================================================== */

  function buildUrl(cfg) {
    const u = new URL(cfg.url);
    Object.entries(cfg.params).forEach(([k, v]) => u.searchParams.set(k, v));
    return u.toString();
  }

  async function fetchJson(url) {
    // 'no-cache' revalidates with the origin instead of forbidding storage,
    // so unchanged multi-hundred-KB payloads can come back as cheap 304s.
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    // ArcGIS reports failures as HTTP 200 + {error:{...}} — treat those as errors
    // too, otherwise a feed hiccup would silently wipe the map to "0 fires".
    if (json && json.error) {
      throw new Error('Feed error ' + (json.error.code || '') + ': ' + (json.error.message || 'query failed'));
    }
    return json;
  }

  /** Normalize an ArcGIS GeoJSON incident feature into our flat record. */
  function normalize(feature) {
    const p = feature.properties || {};
    const g = feature.geometry || {};
    const coords = g.type === 'Point' ? g.coordinates : null;
    if (!coords) return null;
    const [lon, lat] = coords;
    if (!isFinite(lat) || !isFinite(lon)) return null;

    return {
      id: String(p.OBJECTID),
      name: titleCase(p.IncidentName) || 'Unnamed', // popup/card templates append " Fire"
      acres: typeof p.IncidentSize === 'number' ? p.IncidentSize : null,
      contained: typeof p.PercentContained === 'number' ? p.PercentContained : null,
      state: stateCode(p.POOState),
      stateName: stateName(p.POOState),
      county: p.POOCounty ? titleCase(p.POOCounty) : null,
      cause: p.FireCause || null,
      discovered: p.FireDiscoveryDateTime || null,
      note: p.IncidentShortDescription || null,
      irwin: normIrwin(p.IrwinID),
      lat, lon
    };
  }

  /** Normalize an IRWIN id for matching (uppercase, strip surrounding braces). */
  function normIrwin(v) {
    return v ? String(v).toUpperCase().replace(/[{}]/g, '') : null;
  }

  /**
   * Area-weighted centroid of a GeoJSON Polygon/MultiPolygon's largest ring,
   * returned as [lat, lon]. Used to seat the fire marker in the middle of the
   * burned area rather than at the point of origin. Falls back gracefully.
   */
  function polygonCentroid(geometry) {
    if (!geometry) return null;
    let rings;
    if (geometry.type === 'Polygon') rings = [geometry.coordinates[0]];
    else if (geometry.type === 'MultiPolygon') rings = geometry.coordinates.map((poly) => poly[0]);
    else return null;

    let best = null, bestArea = -1;
    for (const ring of rings) {
      if (!ring || ring.length < 3) continue;
      let area = 0, cx = 0, cy = 0;
      for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
        const [x0, y0] = ring[j], [x1, y1] = ring[i];
        const cross = x0 * y1 - x1 * y0;
        area += cross; cx += (x0 + x1) * cross; cy += (y0 + y1) * cross;
      }
      area *= 0.5;
      const mag = Math.abs(area);
      if (mag > bestArea) {
        if (mag < 1e-12) {
          // Degenerate ring → use the average vertex.
          let sx = 0, sy = 0;
          ring.forEach(([x, y]) => { sx += x; sy += y; });
          best = [sy / ring.length, sx / ring.length];
        } else {
          best = [cy / (6 * area), cx / (6 * area)]; // [lat, lon]
        }
        bestArea = mag;
      }
    }
    return best;
  }

  async function loadData() {
    // Incidents are required; perimeters are a best-effort enhancement.
    const [incRes, perRes] = await Promise.allSettled([
      fetchJson(buildUrl(CFG.incidents)),
      fetchJson(buildUrl(CFG.perimeters))
    ]);

    if (incRes.status !== 'fulfilled') {
      throw incRes.reason || new Error('Incident feed unavailable');
    }
    if (!Array.isArray(incRes.value.features)) {
      throw new Error('Incident feed returned no features');
    }

    const fires = incRes.value.features
      .map(normalize)
      .filter(Boolean)
      // keep records with a real footprint or a containment reading
      .filter((f) => f.acres != null || f.contained != null);

    const perimeters = perRes.status === 'fulfilled' ? perRes.value : null;
    return { fires, perimeters };
  }

  /* ====================================================================== *
   *  FILTERING / SORTING / STATS
   * ====================================================================== */

  function isActive(f) {
    return f.contained == null || f.contained < 100;
  }

  function visibleFires() {
    // When a place has been located, the text box held the place name — so we
    // drop text filtering and instead rank every fire by distance from there.
    const q = state.locatedAt ? '' : state.search.trim().toLowerCase();
    return state.fires.filter((f) => {
      if (state.filter === 'active' && !isActive(f)) return false;
      if (state.filter === 'contained' && isActive(f)) return false;
      if (q) {
        const hay = (f.name + ' ' + f.stateName + ' ' + f.state + ' ' + (f.county || '')).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function sortFires(list) {
    if (state.locatedAt) {
      return list.slice().sort((a, b) => fireDistanceMi(a) - fireDistanceMi(b));
    }
    const by = {
      size: (a, b) => (b.acres || 0) - (a.acres || 0),
      containment: (a, b) => (a.contained ?? 0) - (b.contained ?? 0),
      newest: (a, b) => (b.discovered || 0) - (a.discovered || 0),
      name: (a, b) => a.name.localeCompare(b.name)
    }[state.sort];
    return list.slice().sort(by);
  }

  function computeStats(list) {
    const acres = list.reduce((s, f) => s + (f.acres || 0), 0);
    const withC = list.filter((f) => f.contained != null);
    const avgC = withC.length
      ? Math.round(withC.reduce((s, f) => s + f.contained, 0) / withC.length)
      : null;
    const states = new Set(list.map((f) => f.state).filter(Boolean));
    return { count: list.length, acres, avgC, states: states.size };
  }

  /* ====================================================================== *
   *  MAP
   * ====================================================================== */

  function initMap() {
    const map = L.map('map', {
      center: CFG.initialView.center,
      zoom: CFG.initialView.zoom,
      zoomControl: true,
      worldCopyJump: true,
      attributionControl: true
    });
    map.zoomControl.setPosition('topright');

    const B = CFG.basemaps;
    const satellite = L.tileLayer(B.satellite.url, { attribution: B.satellite.attribution, maxZoom: B.satellite.maxZoom });
    const labels    = L.tileLayer(B.labels.url, { maxZoom: B.labels.maxZoom, pane: 'shadowPane' });
    const terrain   = L.tileLayer(B.terrain.url, { attribution: B.terrain.attribution, maxZoom: B.terrain.maxZoom });
    const dark      = L.tileLayer(B.dark.url, { attribution: B.dark.attribution, maxZoom: B.dark.maxZoom, subdomains: B.dark.subdomains });

    // Default: satellite imagery + place-name reference overlay
    const satelliteGroup = L.layerGroup([satellite, labels]);
    satelliteGroup.addTo(map);

    L.control.layers(
      { 'Satellite': satelliteGroup, 'Terrain': terrain, 'Dark': dark },
      {},
      { position: 'topright', collapsed: true }
    ).addTo(map);

    state.perimeterLayer = L.layerGroup().addTo(map);
    state.markerLayer = L.layerGroup().addTo(map);

    // On phones we don't use map popups (details show in the news sheet), so
    // immediately dismiss any that try to open — e.g. from a perimeter tap.
    map.on('popupopen', () => { if (isMobile()) map.closePopup(); });

    state.map = map;
  }

  function renderPerimeters(geojson) {
    state.perimeterLayer.clearLayers();
    state.perimeterCenters.clear();
    if (!geojson || !geojson.features) return;

    // Index incidents so each perimeter can be tied back to its fire record:
    // by IRWIN id first (a stable GUID), then by name as a fallback.
    const byIrwin = new Map();
    const byName = new Map();
    state.fires.forEach((f) => {
      if (f.irwin) byIrwin.set(f.irwin, f);
      const key = f.name.toLowerCase();
      if (!byName.has(key)) byName.set(key, f);
    });

    L.geoJSON(geojson, {
      style: (feat) => {
        const pct = feat.properties && feat.properties.attr_PercentContained;
        const c = containColor(typeof pct === 'number' ? pct : 0);
        return { color: c, weight: 1.4, opacity: 0.9, fillColor: c, fillOpacity: 0.14 };
      },
      onEachFeature: (feat, layer) => {
        const p = feat.properties || {};
        const fire =
          byIrwin.get(normIrwin(p.attr_IrwinID)) ||
          byName.get((p.attr_IncidentName || p.poly_IncidentName || '').toLowerCase());

        // Seat the fire marker at the perimeter's centroid (middle of the area).
        const center = polygonCentroid(feat.geometry);
        if (fire && center) state.perimeterCenters.set(fire.id, center);

        if (fire) {
          // Clicking anywhere inside the outline opens the same fire popup
          // and selects the matching card in the sidebar.
          layer.bindPopup(popupHtml(fire), {
            maxWidth: 300, minWidth: 240,
            // Keep the popup clear of the top controls and the right news panel.
            autoPanPaddingTopLeft: [24, 80],
            autoPanPaddingBottomRight: [372, 28]
          });
          layer.on('click', () => {
            highlightCard(fire.id);
            if (window.WildfireNews) window.WildfireNews.open(fire);
          });
        } else {
          const name = titleCase(p.attr_IncidentName || p.poly_IncidentName || 'Fire perimeter');
          const acres = p.poly_GISAcres || p.attr_IncidentSize;
          layer.bindTooltip(
            `${escapeHtml(name)} — ${fmtInt(acres)} acres`,
            { sticky: true, direction: 'top', opacity: 0.95 }
          );
        }
      }
    }).addTo(state.perimeterLayer);
  }

  /**
   * Build one marker per fire. Runs only when the DATA changes (each refresh,
   * after perimeter centroids are known) — filter/search/sort re-renders just
   * toggle which of these pooled markers are on the map, instead of tearing
   * down and recreating hundreds of SVG paths per keystroke.
   */
  function rebuildMarkers() {
    state.markerLayer.clearLayers();
    state.markers.clear();
    state.fires.forEach((f) => {
      const color = containColor(f.contained);
      const hot = isActive(f) && (f.acres || 0) > 1000 && (f.contained == null || f.contained < 50);

      const marker = L.circleMarker(fireLatLng(f), {
        radius: acresToRadius(f.acres),
        color: '#0b0e14',
        weight: 1.5,
        fillColor: color,
        fillOpacity: 0.85,
        className: 'fire-marker' + (hot ? ' fire-hot' : '')
      });

      marker.bindPopup(popupHtml(f), { maxWidth: 300, minWidth: 240, autoPan: false });
      marker.on('click', () => selectFire(f.id, { fromMap: true }));
      state.markers.set(f.id, marker);
    });
  }

  function renderMarkers(list) {
    state.markerLayer.clearLayers();
    // Ascending by acres → the largest fires are added last and sit on top.
    list.slice().sort((a, b) => (a.acres || 0) - (b.acres || 0)).forEach((f) => {
      const m = state.markers.get(f.id);
      if (m) m.addTo(state.markerLayer);
    });
  }

  function popupHtml(f) {
    const c = containColor(f.contained);
    const loc = [f.county ? f.county + ' County' : null, f.stateName].filter(Boolean).join(', ');
    const cause = f.cause ? titleCase(f.cause) : 'Under investigation';
    const cont = f.contained == null ? '—' : Math.round(f.contained) + '%';
    return `
      <div class="popup-name">${escapeHtml(f.name)} Fire</div>
      <div class="popup-loc">${escapeHtml(loc || 'United States')}</div>
      <div class="popup-grid">
        <div><div class="k">Size</div><div class="v" style="color:#ff8c42">${fmtInt(f.acres)}<span style="font-size:11px;color:var(--text-faint)"> acres</span></div></div>
        <div><div class="k">Contained</div><div class="v" style="color:${c}">${cont}</div></div>
        <div><div class="k">Cause</div><div class="v" style="font-size:13px;font-family:var(--font);font-weight:600">${escapeHtml(cause)}</div></div>
        <div><div class="k">Discovered</div><div class="v" style="font-size:13px;font-family:var(--font);font-weight:600">${escapeHtml(timeAgo(f.discovered))}</div></div>
      </div>
      <div class="popup-bar"><i style="width:${Math.max(2, f.contained || 0)}%;background:${c}"></i></div>
      ${f.note ? `<div class="popup-desc">${escapeHtml(f.note)}</div>` : ''}
    `;
  }

  /* ====================================================================== *
   *  SIDEBAR
   * ====================================================================== */

  function renderStats(stats) {
    const labels = { active: 'Active fires', contained: 'Contained fires', all: 'Total fires' };
    el.statCountLabel.textContent = labels[state.filter];
    el.statCount.textContent = fmtInt(stats.count);
    el.statAcres.textContent = fmtInt(stats.acres);
    el.statContained.textContent = stats.avgC == null ? '—' : stats.avgC + '%';
    el.statStates.textContent = fmtInt(stats.states);
  }

  // Tiny stroke icons matching the rest of the icon set (emoji render
  // inconsistently across platforms and get announced by screen readers).
  const IC = {
    pin:     '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-5.8 7-11a7 7 0 1 0-14 0c0 5.2 7 11 7 11z"/><circle cx="12" cy="10" r="2.6"/></svg>',
    compass: '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/></svg>',
    clock:   '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>'
  };
  const ic = (name) => `<span class="fc-ic" aria-hidden="true">${IC[name]}</span>`;

  function fireCardHtml(f) {
    const c = containColor(f.contained);
    const loc = [f.county, f.state].filter(Boolean).join(', ') || f.stateName;
    const cont = f.contained == null ? 'N/A' : Math.round(f.contained) + '%';
    const sel = f.id === state.selectedId ? ' is-selected' : '';
    const dist = fireDistanceMi(f);
    const second = dist != null
      ? `${ic('compass')} ${fmtInt(dist)} mi away`
      : `${ic('clock')} ${escapeHtml(timeAgo(f.discovered))}`;
    const acresText = f.acres != null ? `${fmtInt(f.acres)} acres` : '—';
    // A real <button> inside the <li>: native keyboard activation, and the
    // list keeps valid listitem semantics for screen readers.
    return `
      <li><button type="button" class="fire-card${sel}" data-id="${f.id}" style="--c:${c}">
        <div class="fc-top">
          <span class="fc-dot"></span>
          <span class="fc-name">${escapeHtml(f.name)}</span>
          <span class="fc-acres">${acresText}</span>
        </div>
        <div class="fc-meta">
          <span>${ic('pin')} ${escapeHtml(loc)}</span>
          <span>${second}</span>
        </div>
        <div class="fc-bar"><i style="width:${Math.max(2, f.contained || 0)}%"></i></div>
        <div class="fc-bar-label"><span>Containment</span><b>${cont}</b></div>
      </button></li>`;
  }

  function renderList(list) {
    // With a location lock the list is every fire sorted by distance — say so,
    // so "240 fires" under a "Near Sacramento" banner doesn't read as 240 nearby.
    el.listCount.textContent = state.locatedAt
      ? list.length + (list.length === 1 ? ' fire' : ' fires') + ' · nearest first'
      : list.length + (list.length === 1 ? ' fire' : ' fires');
    announce(list.length + (list.length === 1 ? ' fire shown' : ' fires shown'));

    if (!list.length) {
      const q = state.search.trim();
      const hint = el.statusPill.dataset.state === 'error' && !state.fires.length
        ? 'Live fire feed is unavailable — retry from the map.'
        : q && !state.locatedAt
          ? `No fires named “${escapeHtml(q)}”.<br/>Press <b>Enter</b> to search this place on the map.`
          : 'No fires match your filters.<br/>Try “All” or clear the search.';
      el.list.innerHTML = `<li class="empty-state">${hint}</li>`;
      return;
    }
    el.list.innerHTML = list.map(fireCardHtml).join('');
  }

  /** Announce short status lines to screen readers without re-reading the list. */
  function announce(msg) {
    const sr = $('sr-status');
    if (sr) sr.textContent = msg;
  }

  /* ====================================================================== *
   *  SELECTION
   * ====================================================================== */

  /** The marker location for a fire: its perimeter centroid if known, else POO. */
  function fireLatLng(f) {
    return state.perimeterCenters.get(f.id) || [f.lat, f.lon];
  }

  /** Mark a fire's sidebar card as selected (no map movement). */
  function highlightCard(id) {
    state.selectedId = id;
    el.list.querySelectorAll('.fire-card').forEach((card) =>
      card.classList.toggle('is-selected', card.dataset.id === id));
  }

  function selectFire(id, opts = {}) {
    highlightCard(id);
    const f = state.fires.find((x) => x.id === id);
    if (f && window.WildfireNews) window.WildfireNews.open(f);

    const card = el.list.querySelector(`.fire-card[data-id="${id}"]`);
    const motion = reduceMotion() ? 'auto' : 'smooth';
    if (card && !opts.fromMap) {
      // On phones the list sits above the map, so bring the map (and its news
      // sheet) into view; on desktop just keep the selected card visible.
      if (isMobile()) document.querySelector('.map-wrap')?.scrollIntoView({ behavior: motion, block: 'start' });
      else card.scrollIntoView({ block: 'nearest', behavior: motion });
    }

    if (f && state.map) {
      const targetZoom = Math.max(state.map.getZoom(), CFG.maxFlyZoom);
      // Bias the fire clear of the news panel: left of the side card on desktop,
      // above the bottom sheet on phones.
      const target = centerClearOfNews(fireLatLng(f), targetZoom);
      if (reduceMotion()) state.map.setView(target, targetZoom, { animate: false });
      else state.map.flyTo(target, targetZoom, { duration: 0.8 });
      // On phones the popup and the bottom sheet can't share the small screen, so
      // the fire's details live in the sheet instead (see news.js). Desktop opens
      // the popup beside the card.
      const marker = state.markers.get(id);
      if (marker && !isMobile()) marker.openPopup();
    }
  }

  const isMobile = () => window.innerWidth <= 680;
  const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /** Offset a fly target so the fire sits clear of the open news panel. */
  function centerClearOfNews(latlng, zoom) {
    const panel = document.getElementById('news-panel');
    if (!panel || panel.hidden) return latlng;
    const pt = state.map.project(L.latLng(latlng[0], latlng[1]), zoom);
    if (isMobile()) {
      // Lift the fire into the visible strip above the bottom sheet (~58% tall).
      pt.y += state.map.getSize().y * 0.58 / 2 + 10;
    } else {
      pt.x += (panel.offsetWidth + 28) / 2; // shift left of the side card
    }
    const c = state.map.unproject(pt, zoom);
    return [c.lat, c.lng];
  }

  /* ====================================================================== *
   *  LOCATION SEARCH — find fires near a city / ZIP / county / landmark
   * ====================================================================== */

  // Full state name → abbreviation (for tidy location labels).
  const STATE_ABBR = Object.fromEntries(
    Object.entries(US_STATES).map(([ab, full]) => [full.toLowerCase(), ab])
  );

  /** Great-circle distance in miles. */
  function haversineMi(lat1, lon1, lat2, lon2) {
    const R = 3958.8, toRad = Math.PI / 180;
    const dLat = (lat2 - lat1) * toRad, dLon = (lon2 - lon1) * toRad;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  /** Miles from the searched location to a fire (null if no location set). */
  function fireDistanceMi(f) {
    if (!state.locatedAt) return null;
    const [la, lo] = fireLatLng(f);
    return haversineMi(state.locatedAt.lat, state.locatedAt.lon, la, lo);
  }

  /** Build a short, friendly label from a Nominatim result. */
  function shortPlace(hit) {
    const a = hit.address || {};
    const place = a.city || a.town || a.village || a.hamlet || a.suburb ||
      a.county || a.state || hit.name || '';
    const st = a.state ? (STATE_ABBR[a.state.toLowerCase()] || a.state) : '';
    if (hit.type === 'postcode') {
      const zip = a.postcode || hit.name || '';
      const tail = [place, st].filter(Boolean).join(', ');
      return [zip, tail].filter(Boolean).join(' · ');
    }
    return [place, st].filter(Boolean).join(', ') ||
      (hit.display_name || '').split(',').slice(0, 2).join(',').trim();
  }

  function removeSearchMarker() {
    if (state.searchMarker) {
      state.map.removeLayer(state.searchMarker);
      state.searchMarker = null;
    }
  }

  function placeSearchMarker(lat, lon, label) {
    removeSearchMarker();
    const html =
      '<svg viewBox="0 0 24 24" width="30" height="30" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7z" fill="#38bdf8" stroke="#0b0e14" stroke-width="1.6"/>' +
      '<circle cx="12" cy="9" r="2.7" fill="#0b0e14"/></svg>';
    state.searchMarker = L.marker([lat, lon], {
      icon: L.divIcon({ className: 'search-pin-wrap', html, iconSize: [30, 30], iconAnchor: [15, 30] }),
      zIndexOffset: 1000, keyboard: false
      // Leaflet tooltips render via innerHTML — escape the geocoder-supplied
      // place name (OSM data is publicly editable, i.e. untrusted).
    }).addTo(state.map).bindTooltip(escapeHtml(label), { direction: 'top', offset: [0, -26], opacity: 0.95 });
  }

  function setBanner(html, isError) {
    el.locateText.innerHTML = html;
    el.locateBanner.classList.toggle('is-error', !!isError);
    el.locateBanner.hidden = false;
  }

  /** Keep the banner in sync with the current located state (called by render). */
  function updateLocateBanner(list) {
    if (!state.locatedAt) {
      if (!state.geocoding) el.locateBanner.hidden = true;
      return;
    }
    const nearest = list && list[0];
    const extra = nearest
      ? ` · nearest fire <b>${fmtInt(fireDistanceMi(nearest))} mi</b>`
      : ' · no active fires nearby';
    setBanner(`Near <b>${escapeHtml(state.locatedAt.label)}</b>${extra}`, false);
  }

  function clearLocation() {
    state.locatedAt = null;
    removeSearchMarker();
    el.locateBanner.hidden = true;
    render();
  }

  /** Geocode a free-text query and re-center the dashboard on that area. */
  async function geocodeAndLocate(query) {
    const q = (query || '').trim();
    if (!q || state.geocoding) return;
    state.geocoding = true;
    const myReq = state.geocodeReq = (state.geocodeReq || 0) + 1;
    el.search.parentElement.classList.add('is-loading');
    setBanner(`Locating “${escapeHtml(q)}”…`, false);

    try {
      const u = new URL(CFG.geocode.url);
      u.searchParams.set('format', 'jsonv2');
      u.searchParams.set('limit', '1');
      u.searchParams.set('countrycodes', 'us');
      u.searchParams.set('addressdetails', '1');
      u.searchParams.set('q', q);

      const res = await fetch(u.toString(), { headers: { Accept: 'application/json' }, cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const arr = await res.json();
      // A newer search/keystroke superseded this request — drop the result.
      if (myReq !== state.geocodeReq) return;
      const hit = Array.isArray(arr) && arr[0];

      if (!hit) {
        state.locatedAt = null;
        removeSearchMarker();
        setBanner(`Couldn’t find “${escapeHtml(q)}”. Try a city, ZIP, or county.`, true);
        return;
      }

      const lat = parseFloat(hit.lat), lon = parseFloat(hit.lon);
      state.locatedAt = { lat, lon, label: shortPlace(hit) };
      placeSearchMarker(lat, lon, state.locatedAt.label);

      // Fit to the place's own bounds so a ZIP zooms in and a state zooms out.
      const bb = hit.boundingbox;
      if (bb && bb.length === 4) {
        const bounds = L.latLngBounds([[+bb[0], +bb[2]], [+bb[1], +bb[3]]]);
        state.map.flyToBounds(bounds, { padding: [40, 40], maxZoom: 11, duration: 0.9 });
      } else {
        state.map.flyTo([lat, lon], 9, { duration: 0.9 });
      }
      render();
    } catch (err) {
      console.warn('[geocode] failed:', err);
      setBanner('Location search is unavailable right now. Please try again.', true);
    } finally {
      state.geocoding = false;
      el.search.parentElement.classList.remove('is-loading');
    }
  }

  /* ====================================================================== *
   *  RENDER ORCHESTRATION
   * ====================================================================== */

  function render() {
    const list = sortFires(visibleFires());
    renderStats(computeStats(list));
    renderList(list);
    renderMarkers(list);
    updateLocateBanner(list);
  }

  /* ====================================================================== *
   *  REFRESH LIFECYCLE
   * ====================================================================== */

  function setStatus(stateName_, label) {
    el.statusPill.dataset.state = stateName_;
    el.statusLabel.textContent = label;
  }

  async function refresh(opts = {}) {
    if (state.isLoading) return;
    state.isLoading = true;
    el.refreshBtn.classList.add('spinning');
    setStatus('loading', 'Updating…');

    try {
      // Remember what the user was looking at so the refresh doesn't yank it away.
      const openPopupId = !isMobile() && state.selectedId &&
        state.markers.get(state.selectedId)?.isPopupOpen() ? state.selectedId : null;
      const focusedCardId = document.activeElement?.closest?.('.fire-card')?.dataset?.id || null;

      const { fires, perimeters } = await loadData();
      state.fires = fires;
      state.lastUpdated = new Date();

      if (perimeters) renderPerimeters(perimeters);
      rebuildMarkers(); // after perimeters so markers seat at fresh centroids
      render();
      smokeRefresh(); // best-effort; never blocks the fire dashboard

      // Restore the open popup / keyboard focus that the re-render replaced.
      if (openPopupId) state.markers.get(openPopupId)?.openPopup();
      if (focusedCardId) el.list.querySelector(`.fire-card[data-id="${focusedCardId}"]`)?.focus();

      el.lastUpdated.textContent = clockTime(state.lastUpdated);
      setStatus('live', 'Live');
      hideOverlay();
      maybeDeepLinkSearch();
    } catch (err) {
      console.error('[WildfireWatch] refresh failed:', err);
      setStatus('error', 'Feed error');
      if (!state.fires.length) showError();
    } finally {
      state.isLoading = false;
      el.refreshBtn.classList.remove('spinning');
      scheduleNext();
    }
  }

  function scheduleNext() {
    clearInterval(state.timer);
    state.nextRefreshAt = Date.now() + CFG.refreshIntervalMs;
    // Skip cycles while the tab is hidden — the visibilitychange handler
    // catches up the moment the user returns, so nothing goes stale.
    state.timer = setInterval(() => { if (!document.hidden) refresh(); }, CFG.refreshIntervalMs);
  }

  /**
   * Honor a ?q= deep link (WebSite SearchAction). Runs once after the first
   * successful load: if the term matched no fire names, treat it as a place
   * (ZIP / city) and geocode it, so shared search URLs actually work.
   */
  let deepLinkDone = false;
  function maybeDeepLinkSearch() {
    if (deepLinkDone) return;
    deepLinkDone = true;
    if (state.search && !state.locatedAt && !visibleFires().length) {
      geocodeAndLocate(state.search);
    }
  }

  function tickCountdown() {
    if (!state.nextRefreshAt) { el.countdown.textContent = '—'; return; }
    const left = Math.max(0, state.nextRefreshAt - Date.now());
    const m = Math.floor(left / 6e4);
    const s = Math.floor((left % 6e4) / 1000);
    el.countdown.textContent = `${m}:${String(s).padStart(2, '0')}`;
  }

  /* ====================================================================== *
   *  OVERLAY
   * ====================================================================== */

  function hideOverlay() { el.overlay.classList.add('hidden'); }
  function showError() {
    el.overlay.classList.remove('hidden');
    el.overlayText.textContent = 'Could not reach the live fire feed.';
    el.retryBtn.hidden = false;
    // Keep the sidebar honest too — shimmering skeletons would imply "still
    // loading" and an empty filter message would blame the user's filters.
    el.list.innerHTML = '<li class="empty-state">Live fire feed is unreachable right now.<br/>Use “Try again” on the map.</li>';
    el.listCount.textContent = '—';
  }

  /* ====================================================================== *
   *  EVENT WIRING
   * ====================================================================== */

  function bindEvents() {
    el.refreshBtn.addEventListener('click', () => refresh({ manual: true }));
    el.retryBtn.addEventListener('click', () => {
      el.retryBtn.hidden = true;
      el.overlayText.textContent = 'Loading live fire data…';
      refresh();
    });

    let searchDebounce;
    el.search.addEventListener('input', (e) => {
      clearTimeout(searchDebounce);
      const v = e.target.value;
      searchDebounce = setTimeout(() => {
        state.search = v;
        // Typing a new query drops any active location lock and resumes
        // ordinary text filtering by fire / county / state. Bumping the
        // geocode token also invalidates any slow in-flight geocode so it
        // can't re-apply a stale location after the user moved on.
        if (state.locatedAt) { state.locatedAt = null; removeSearchMarker(); }
        state.geocodeReq = (state.geocodeReq || 0) + 1;
        render();
      }, 160);
    });

    // Enter = treat the text as a place (ZIP, city, county, landmark) and locate it.
    el.search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        clearTimeout(searchDebounce); // don't let a trailing keystroke clear the lock
        state.search = el.search.value; // keep the text filter consistent if geocoding fails
        geocodeAndLocate(el.search.value);
      }
    });

    el.locateClear.addEventListener('click', () => {
      el.search.value = '';
      state.search = '';
      clearLocation();
      el.search.focus();
    });

    el.filter.addEventListener('click', (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      el.filter.querySelectorAll('.seg-btn').forEach((b) => {
        b.classList.toggle('is-active', b === btn);
        b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
      });
      state.filter = btn.dataset.filter;
      render();
    });

    el.sort.addEventListener('change', (e) => { state.sort = e.target.value; render(); });

    // Card selection (event-delegated; cards are real buttons, so Enter/Space
    // arrive here as click events with no extra keyboard handling needed).
    el.list.addEventListener('click', (e) => {
      const card = e.target.closest('.fire-card');
      if (card) selectFire(card.dataset.id);
    });

    // Clicking empty map space clears the reading context: close the news
    // panel along with the popup Leaflet already dismisses.
    state.map.on('click', () => { if (window.WildfireNews) window.WildfireNews.close(); });
    // And when the news panel is closed from its own X / Escape / back button,
    // retire the popup too so the two never sit in contradictory half-states.
    document.addEventListener('wf:news-closed', () => state.map.closePopup());

    // Pause the refresh clock when the tab is hidden; catch up on return.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && state.nextRefreshAt && Date.now() >= state.nextRefreshAt) refresh();
    });
  }

  /* ====================================================================== *
   *  SMOKE — current extent (HMS) + forecast drift (HRRR-Smoke) + wind
   * ====================================================================== */

  const smoke = {
    layers: { current: null, forecast: null, wind: null },
    on: { current: true, forecast: false, wind: false },
    frames: [],            // hourly forecast timestamps (epoch ms)
    index: 0,
    selectedTime: null,    // timestamp the user is viewing (preserved across re-syncs)
    userMovedSlider: false,
    playing: false,
    playTimer: null,
    windMoveHandler: null,
    windDebounce: null,
    windReqId: 0,          // guards against out-of-order wind responses
    dom: {}
  };

  // HMS density → translucent gray styling (kept subtle so fires stay readable).
  const SMOKE_STYLE = {
    Light:  { color: '#d8d2c4', weight: 0.6, fillColor: '#d8d2c4', fillOpacity: 0.12 },
    Medium: { color: '#9c8f78', weight: 0.7, fillColor: '#9c8f78', fillOpacity: 0.22 },
    Heavy:  { color: '#5c5346', weight: 0.9, fillColor: '#3f3a30', fillOpacity: 0.40 }
  };

  /** One-time setup: panes, the forecast WMS layer, DOM refs, and control wiring. */
  function smokeInit() {
    const S = CFG.smoke;

    // Dedicated panes so smoke draws beneath the fire markers/perimeters (overlayPane=400).
    state.map.createPane('smoke-forecast');
    state.map.getPane('smoke-forecast').style.zIndex = 250;
    state.map.getPane('smoke-forecast').style.pointerEvents = 'none';
    state.map.createPane('smoke-current');
    state.map.getPane('smoke-current').style.zIndex = 350;
    // Wind arrows sit above the smoke but below the fire markers, and never
    // intercept clicks (so fires/perimeters stay clickable through them).
    state.map.createPane('wind');
    state.map.getPane('wind').style.zIndex = 390;
    state.map.getPane('wind').style.pointerEvents = 'none';

    smoke.dom = {
      panel: $('smoke-panel'),
      tgCurrent: $('tg-current'), tgForecast: $('tg-forecast'), tgWind: $('tg-wind'),
      legendForecast: $('legend-forecast'), bar: $('forecast-bar'), play: $('fb-play'),
      slider: $('fb-slider'), valid: $('fb-valid'), rel: $('fb-rel')
    };

    // On phones the Smoke & Air panel collapses to a small chip to free up the
    // map. The header is a real <button>, so keyboard users can expand it too.
    const spHead = smoke.dom.panel.querySelector('.sp-head');
    const syncSpHead = () => spHead.setAttribute('aria-expanded',
      String(!smoke.dom.panel.classList.contains('collapsed')));
    if (window.innerWidth <= 680) smoke.dom.panel.classList.add('collapsed');
    syncSpHead();
    spHead.addEventListener('click', () => {
      if (window.innerWidth <= 680) {
        smoke.dom.panel.classList.toggle('collapsed');
        syncSpHead();
      }
    });

    // Time-enabled, transparent forecast raster (added to the map only when toggled on).
    smoke.layers.forecast = L.tileLayer.wms(S.forecast.wmsUrl, {
      layers: S.forecast.layer,
      format: 'image/png',
      transparent: true,
      version: '1.3.0',
      crs: L.CRS.EPSG3857,
      opacity: S.forecast.opacity,
      pane: 'smoke-forecast',
      attribution: 'Smoke forecast &copy; NOAA HRRR-Smoke'
    });
    smoke.layers.wind = L.layerGroup();

    smoke.dom.tgCurrent.addEventListener('change', (e) => toggleCurrentSmoke(e.target.checked));
    smoke.dom.tgForecast.addEventListener('change', (e) => toggleForecast(e.target.checked));
    smoke.dom.tgWind.addEventListener('change', (e) => toggleWind(e.target.checked));

    smoke.dom.slider.addEventListener('input', (e) => {
      smoke.userMovedSlider = true;
      pauseForecast();
      setForecastFrame(parseInt(e.target.value, 10));
    });
    smoke.dom.play.addEventListener('click', () => (smoke.playing ? pauseForecast() : playForecast()));
  }

  /** Re-pull smoke data each refresh cycle (guarded — never affects the main feed).
      Each feed is fetched only while its layer is actually on; the toggles
      lazy-load on demand, so switched-off layers cost zero network. */
  function smokeRefresh() {
    if (smoke.on.current) loadCurrentSmoke();
    if (smoke.on.forecast) loadForecastMeta();
    if (smoke.on.wind) loadWind();
  }

  /** Surface per-layer feed trouble in the toggle's own subtitle (and recovery). */
  function setToggleNote(input, msg) {
    const small = input.closest('.sp-toggle')?.querySelector('small');
    if (!small) return;
    if (!small.dataset.orig) small.dataset.orig = small.textContent;
    small.textContent = msg || small.dataset.orig;
    small.classList.toggle('is-warn', !!msg);
  }

  /* --------------------------- current smoke (HMS) ----------------------- */

  async function loadCurrentSmoke() {
    try {
      const data = await fetchJson(buildUrl(CFG.smoke.current));
      const layer = L.geoJSON(data, {
        pane: 'smoke-current',
        style: (f) => SMOKE_STYLE[f.properties && f.properties.Density] || SMOKE_STYLE.Light,
        onEachFeature: (f, lyr) => {
          const p = f.properties || {};
          lyr.bindTooltip(
            `${escapeHtml(p.Density || 'Smoke')} smoke${p.Satellite ? ' · ' + escapeHtml(p.Satellite) : ''}`,
            { sticky: true, opacity: 0.95 }
          );
        }
      });
      if (smoke.layers.current && state.map.hasLayer(smoke.layers.current)) {
        state.map.removeLayer(smoke.layers.current);
      }
      smoke.layers.current = layer;
      if (smoke.on.current) layer.addTo(state.map);
      setToggleNote(smoke.dom.tgCurrent, null);
    } catch (err) {
      console.warn('[smoke] current smoke load failed:', err);
      setToggleNote(smoke.dom.tgCurrent, 'Unavailable — retrying soon');
    }
  }

  function toggleCurrentSmoke(on) {
    smoke.on.current = on;
    const l = smoke.layers.current;
    if (on) {
      if (l) l.addTo(state.map);
      else loadCurrentSmoke(); // wasn't loaded while off — fetch on demand
    } else if (l && state.map.hasLayer(l)) {
      state.map.removeLayer(l);
    }
  }

  /* --------------------------- forecast (HRRR-Smoke) --------------------- */

  async function loadForecastMeta() {
    try {
      const meta = await fetchJson(CFG.smoke.forecast.metaUrl);
      const te = meta.timeInfo && meta.timeInfo.timeExtent;
      if (!te || te.length < 2) return;
      const [start, end] = te;
      const step = CFG.smoke.forecast.frameStepMs;
      const frames = [];
      for (let t = start; t <= end; t += step) frames.push(t);
      if (!frames.length) return;

      smoke.frames = frames;
      smoke.dom.slider.min = '0';
      smoke.dom.slider.max = String(frames.length - 1);

      // Preserve what the user is looking at (scrubbed to OR playing through);
      // otherwise track "now".
      const keep = (smoke.userMovedSlider || smoke.playing) && smoke.selectedTime;
      setForecastFrame(nearestFrameIndex(keep ? smoke.selectedTime : Date.now()));
      setToggleNote(smoke.dom.tgForecast, null);
    } catch (err) {
      console.warn('[smoke] forecast meta load failed:', err);
      setToggleNote(smoke.dom.tgForecast, 'Unavailable — retrying soon');
      if (smoke.on.forecast && !smoke.frames.length) {
        smoke.dom.valid.textContent = 'Forecast unavailable';
        smoke.dom.rel.textContent = '—';
      }
    }
  }

  function nearestFrameIndex(t) {
    let best = 0, bestDiff = Infinity;
    smoke.frames.forEach((f, i) => {
      const d = Math.abs(f - t);
      if (d < bestDiff) { bestDiff = d; best = i; }
    });
    return best;
  }

  function setForecastFrame(i) {
    if (!smoke.frames.length) return;
    i = Math.max(0, Math.min(smoke.frames.length - 1, i));
    smoke.index = i;
    const t = smoke.frames[i];
    smoke.selectedTime = t;

    // Labels/slider update instantly, but the WMS tile reload is debounced:
    // setParams() re-requests every visible tile, and a drag across 48 frames
    // would otherwise hammer the NOAA server with dozens of tile storms.
    const iso = new Date(t).toISOString().slice(0, 19) + 'Z';
    clearTimeout(smoke.wmsDebounce);
    smoke.wmsDebounce = setTimeout(() => {
      if (smoke.layers.forecast) smoke.layers.forecast.setParams({ time: iso });
    }, 120);

    smoke.dom.slider.value = String(i);
    const pct = smoke.frames.length > 1 ? (i / (smoke.frames.length - 1)) * 100 : 0;
    smoke.dom.slider.style.setProperty('--fill', pct.toFixed(1) + '%');
    smoke.dom.valid.textContent = new Date(t).toLocaleString('en-US',
      { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    smoke.dom.rel.textContent = forecastRelLabel(t);
    smoke.dom.slider.setAttribute('aria-valuetext',
      smoke.dom.valid.textContent + ' (' + smoke.dom.rel.textContent + ')');
  }

  function forecastRelLabel(t) {
    const h = Math.round((t - Date.now()) / 36e5);
    if (h === 0) return 'Now';
    return (h > 0 ? '+' : '−') + Math.abs(h) + 'h';
  }

  function toggleForecast(on) {
    smoke.on.forecast = on;
    smoke.dom.legendForecast.hidden = !on;
    smoke.dom.bar.classList.toggle('is-visible', on);
    const l = smoke.layers.forecast;
    if (on) {
      if (!smoke.frames.length) loadForecastMeta();
      else setForecastFrame(smoke.index);
      l.addTo(state.map);
    } else {
      pauseForecast();
      if (state.map.hasLayer(l)) state.map.removeLayer(l);
    }
  }

  function playForecast() {
    if (!smoke.frames.length) return;
    smoke.playing = true;
    smoke.dom.play.querySelector('.ic-play').hidden = true;
    smoke.dom.play.querySelector('.ic-pause').hidden = false;
    smoke.dom.play.setAttribute('aria-label', 'Pause forecast');
    smoke.dom.play.title = 'Pause forecast';
    smoke.playTimer = setInterval(() => {
      let next = smoke.index + 1;
      if (next >= smoke.frames.length) next = 0;
      setForecastFrame(next);
    }, CFG.smoke.forecast.animationMs);
  }

  function pauseForecast() {
    smoke.playing = false;
    clearInterval(smoke.playTimer);
    if (smoke.dom.play) {
      smoke.dom.play.querySelector('.ic-play').hidden = false;
      smoke.dom.play.querySelector('.ic-pause').hidden = true;
      smoke.dom.play.setAttribute('aria-label', 'Play forecast');
      smoke.dom.play.title = 'Play forecast';
    }
  }

  /* --------------------------- wind (drift direction) ------------------- */

  function toggleWind(on) {
    smoke.on.wind = on;
    if (on) {
      smoke.layers.wind.addTo(state.map);
      loadWind();
      smoke.windMoveHandler = () => {
        clearTimeout(smoke.windDebounce);
        smoke.windDebounce = setTimeout(loadWind, 450);
      };
      state.map.on('moveend', smoke.windMoveHandler);
    } else {
      if (smoke.windMoveHandler) state.map.off('moveend', smoke.windMoveHandler);
      smoke.layers.wind.clearLayers();
      if (state.map.hasLayer(smoke.layers.wind)) state.map.removeLayer(smoke.layers.wind);
    }
  }

  /** A uniform lat/lon grid across the visible map, evenly spaced on screen. */
  function buildWindGrid() {
    const W = CFG.smoke.wind;
    const size = state.map.getSize();
    const b = state.map.getBounds();
    let west = b.getWest(), east = b.getEast();
    const south = Math.max(-89, b.getSouth()), north = Math.min(89, b.getNorth());
    if (east < west) east += 360; // view crosses the antimeridian

    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const cols = clamp(Math.round(size.x / W.spacingPx), W.minCols, W.maxCols);
    const rows = clamp(Math.round(size.y / W.spacingPx), W.minRows, W.maxRows);

    const pts = [];
    for (let r = 0; r < rows; r++) {
      const lat = north - (r + 0.5) / rows * (north - south);
      for (let c = 0; c < cols; c++) {
        let lon = west + (c + 0.5) / cols * (east - west);
        lon = ((lon + 180) % 360 + 360) % 360 - 180; // normalize to [-180,180]
        pts.push({ lat, lon });
      }
    }
    return pts;
  }

  /** Sample current 10 m wind across the view and draw a field of drift arrows. */
  async function loadWind() {
    if (!smoke.on.wind || !state.map) return;
    const grid = buildWindGrid();
    if (!grid.length) return;
    const reqId = ++smoke.windReqId;
    try {
      const u = new URL(CFG.smoke.wind.url);
      u.searchParams.set('latitude', grid.map((p) => p.lat.toFixed(3)).join(','));
      u.searchParams.set('longitude', grid.map((p) => p.lon.toFixed(3)).join(','));
      u.searchParams.set('current', 'wind_speed_10m,wind_direction_10m');
      u.searchParams.set('wind_speed_unit', 'mph');

      const data = await fetchJson(u.toString());
      // Ignore if the view moved (newer request) or wind was switched off meanwhile.
      if (reqId !== smoke.windReqId || !smoke.on.wind) return;

      const arr = Array.isArray(data) ? data : [data];
      const points = [];
      for (let i = 0; i < grid.length && i < arr.length; i++) {
        const cur = arr[i] && arr[i].current;
        const dir = cur && cur.wind_direction_10m;
        if (typeof dir !== 'number') continue;
        points.push({ lat: grid[i].lat, lon: grid[i].lon, dir, spd: cur.wind_speed_10m || 0 });
      }
      renderWind(points);
      setToggleNote(smoke.dom.tgWind, null);
    } catch (err) {
      console.warn('[smoke] wind load failed:', err);
      setToggleNote(smoke.dom.tgWind, 'Unavailable — retrying soon');
    }
  }

  function renderWind(points) {
    smoke.layers.wind.clearLayers();
    points.forEach((p) => {
      const heading = (p.dir + 180) % 360;   // wind blows TOWARD here = smoke drift
      const rot = heading - 90;               // arrow art points east (0deg) by default
      const spd = p.spd || 0;
      const col = spd >= 20 ? '#ff7a6b' : spd >= 10 ? '#ffd166' : '#bfefff';
      const op = spd < 1.5 ? 0.45 : 0.96;
      const html =
        `<div class="wind-arrow" style="transform:rotate(${rot.toFixed(0)}deg);opacity:${op}">` +
        `<svg viewBox="0 0 28 28" width="26" height="26">` +
        `<path d="M4 14h15M14.5 8l6.5 6-6.5 6" fill="none" stroke="${col}" stroke-width="2.6" ` +
        `stroke-linecap="round" stroke-linejoin="round"/></svg></div>`;
      L.marker([p.lat, p.lon], {
        pane: 'wind',
        icon: L.divIcon({ className: 'wind-arrow-icon', html, iconSize: [26, 26], iconAnchor: [13, 13] }),
        interactive: false, keyboard: false
      }).addTo(smoke.layers.wind);
    });
  }

  /* ====================================================================== *
   *  BOOTSTRAP
   * ====================================================================== */

  function cacheDom() {
    el.statusPill = $('status-pill');
    el.statusLabel = $('status-label');
    el.lastUpdated = $('last-updated');
    el.countdown = $('countdown');
    el.refreshBtn = $('refresh-btn');
    el.search = $('search');
    el.filter = $('filter');
    el.sort = $('sort');
    el.list = $('fire-list');
    el.listCount = $('list-count');
    el.overlay = $('overlay');
    el.overlayText = $('overlay-text');
    el.retryBtn = $('retry-btn');
    el.statCount = $('stat-count');
    el.statCountLabel = $('stat-count-label');
    el.statAcres = $('stat-acres');
    el.statContained = $('stat-contained');
    el.statStates = $('stat-states');
    el.locateBanner = $('locate-banner');
    el.locateText = $('locate-text');
    el.locateClear = $('locate-clear');
  }

  function start() {
    cacheDom();
    initMap();
    bindEvents();
    smokeInit();
    // Honor a ?q= deep link (used by the WebSite SearchAction) — pre-fill and
    // filter the fire list by the term so the search URL actually does something.
    const q = new URLSearchParams(location.search).get('q');
    if (q) { el.search.value = q; state.search = q; }
    refresh();
    state.countdownTimer = setInterval(tickCountdown, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
