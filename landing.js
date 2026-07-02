/* =============================================================================
   landing.js — progressive enhancement for the SEO landing pages.
   The pages are fully readable without JS (text + stats are server-generated).
   This script (1) refreshes the live numbers, and (2) lazy-loads the interactive
   Leaflet map only when it scrolls into view — keeping Core Web Vitals fast.
   ========================================================================== */
(function () {
  'use strict';
  var B = document.body.dataset;
  var STATE = (B.state || 'US').toUpperCase();       // 'US' or a 2-letter abbr
  var VIEW = { lat: +B.lat || 39.5, lon: +B.lon || -98.35, zoom: +B.zoom || 4 };
  var NIFC = 'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/' +
    'WFIGS_Incident_Locations_Current/FeatureServer/0/query';

  // State pages filter server-side (POOState) so they never download the whole
  // national feed, and the stats path skips geometry entirely — the map query
  // is the only one that pays for coordinates.
  function whereClause() {
    var w = "IncidentTypeCategory='WF'";
    if (STATE !== 'US') w += " AND POOState='US-" + STATE + "'";
    return w;
  }
  function query(withGeometry) {
    var u = new URL(NIFC);
    u.searchParams.set('where', whereClause());
    u.searchParams.set('outFields', 'IncidentName,IncidentSize,PercentContained,POOState,POOCounty');
    u.searchParams.set('returnGeometry', withGeometry ? 'true' : 'false');
    if (withGeometry) u.searchParams.set('geometryPrecision', '4');
    u.searchParams.set('outSR', '4326');
    u.searchParams.set('resultRecordCount', '2000');
    u.searchParams.set('f', 'geojson');
    return fetch(u.toString())
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (j) {
        // ArcGIS reports failures as 200 + {error} — never treat that as "0 fires".
        if (!j || j.error || !Array.isArray(j.features)) throw new Error('feed error');
        return j.features.filter(inState);
      });
  }
  var dataPromise = null, statsPromise = null;
  function getFires() { // with geometry — for the map and near-me distances
    if (!dataPromise) {
      dataPromise = query(true).catch(function (e) { dataPromise = null; throw e; });
    }
    return dataPromise;
  }
  function getStats() { // attributes only — a fraction of the payload
    if (!statsPromise) {
      statsPromise = query(false).catch(function (e) { statsPromise = null; throw e; });
    }
    return statsPromise;
  }
  function inState(f) {
    var p = f.properties || {};
    if (p.IncidentSize == null) return false;
    if (STATE === 'US') return true;
    return (p.POOState || '').replace(/^US-/, '').toUpperCase() === STATE;
  }
  function titleCase(s) {
    return String(s || '').toLowerCase().replace(/\b\w/g, function (c) { return c.toUpperCase(); }).trim();
  }
  var isActive = function (p) { return p.PercentContained == null || p.PercentContained < 100; };
  var fmt = function (n) { return n == null ? '—' : Math.round(n).toLocaleString('en-US'); };

  /* --------------------------- live stat hydration --------------------------- */
  function hydrate(features) {
    var active = features.filter(function (f) { return isActive(f.properties); });
    var acres = 0, cSum = 0, cN = 0, counties = {};
    active.forEach(function (f) {
      var p = f.properties;
      acres += p.IncidentSize || 0;
      if (p.PercentContained != null) { cSum += p.PercentContained; cN++; }
      if (p.POOCounty) counties[p.POOCounty] = 1;
    });
    set('.js-count', fmt(active.length));
    set('.js-acres', fmt(acres));
    set('.js-contained', cN ? Math.round(cSum / cN) + '%' : '—');
    set('.js-scope', STATE === 'US' ? fmt(countStates(active)) : fmt(Object.keys(counties).length));
    var t = new Date();
    set('.js-updated', t.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }));
  }
  function countStates(list) { var s = {}; list.forEach(function (f) { var st = f.properties.POOState; if (st) s[st] = 1; }); return Object.keys(s).length; }
  function set(sel, val) { document.querySelectorAll(sel).forEach(function (el) { el.textContent = val; }); }

  /* --------------------------- lazy interactive map -------------------------- */
  var mapLoaded = false;
  var mapRef = null; // live Leaflet instance once initialized (for recentering)
  function loadAssets() {
    return new Promise(function (resolve, reject) {
      addCss('https://unpkg.com/leaflet@1.9.4/dist/leaflet.css');
      addCss('https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css');
      addCss('https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css');
      addJs('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js', function () {
        addJs('https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js', resolve, reject);
      }, reject);
    });
  }
  function addCss(href) { var l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href; document.head.appendChild(l); }
  function addJs(src, cb, onerr) { var s = document.createElement('script'); s.src = src; s.onload = cb; s.onerror = onerr || null; document.head.appendChild(s); }

  function initMap() {
    if (mapLoaded) return; mapLoaded = true;
    var ph = document.querySelector('.map-ph');
    var phBtn = ph && ph.querySelector('.btn');
    if (phBtn) phBtn.textContent = 'Loading map…'; // immediate click feedback
    loadAssets().then(function () {
      if (ph) ph.remove();
      var map = L.map('map', { scrollWheelZoom: false }).setView([VIEW.lat, VIEW.lon], VIEW.zoom);
      mapRef = map;
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        { attribution: 'Imagery &copy; Esri', maxZoom: 18 }).addTo(map);
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
        { maxZoom: 18 }).addTo(map);
      map.on('click', function () { map.scrollWheelZoom.enable(); });
      getFires().then(function (features) {
        var cluster = L.markerClusterGroup({ maxClusterRadius: 45, chunkedLoading: true });
        var bounds = [];
        features.forEach(function (f) {
          var g = f.geometry, p = f.properties;
          if (!g || g.type !== 'Point') return;
          var lat = g.coordinates[1], lon = g.coordinates[0];
          var pct = p.PercentContained, col = pct >= 90 ? '#34d399' : pct >= 60 ? '#fbbf24' : pct >= 30 ? '#fb923c' : '#ef4444';
          var r = Math.max(5, Math.min(34, 5 + Math.sqrt(p.IncidentSize || 0) * 0.16));
          var m = L.circleMarker([lat, lon], { radius: r, color: '#0b0e14', weight: 1.2, fillColor: col, fillOpacity: .85 });
          m.bindPopup('<b>' + esc(titleCase(p.IncidentName)) + ' Fire</b><br>' + fmt(p.IncidentSize) + ' acres · ' +
            (pct == null ? '—' : Math.round(pct) + '%') + ' contained' + (p.POOCounty ? '<br>' + esc(titleCase(p.POOCounty)) + ' County' : ''));
          cluster.addLayer(m); bounds.push([lat, lon]);
        });
        map.addLayer(cluster);
        if (bounds.length && STATE !== 'US') map.fitBounds(bounds, { padding: [40, 40], maxZoom: 9 });
      }).catch(function () { /* basemap still useful; stats keep server values */ });
    }).catch(function () {
      // CDN failed — let the user retry instead of leaving a dead button.
      mapLoaded = false;
      if (phBtn) phBtn.textContent = 'Couldn’t load the map — tap to retry';
    });
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  /* --------------------------- "near me" (geolocation) ----------------------- */
  function findNearMe() {
    var out = document.getElementById('near-results');
    if (!navigator.geolocation) { if (out) out.innerHTML = '<p>Location is not available in this browser. Use the interactive map to search your ZIP or city.</p>'; return; }
    if (out) { out.style.minHeight = '220px'; out.innerHTML = '<p>Locating you…</p>'; } // reserve space → no layout shift
    navigator.geolocation.getCurrentPosition(function (pos) {
      var la = pos.coords.latitude, lo = pos.coords.longitude;
      VIEW.lat = la; VIEW.lon = lo; VIEW.zoom = 7;
      getFires().then(function (features) {
        // Only ACTIVE fires — a fully contained incident isn't a nearby risk.
        var near = features.filter(function (f) { return isActive(f.properties); }).map(function (f) {
          var g = f.geometry; if (!g) return null;
          return { p: f.properties, mi: haversine(la, lo, g.coordinates[1], g.coordinates[0]) };
        }).filter(Boolean).sort(function (a, b) { return a.mi - b.mi; }).slice(0, 8);
        if (out) out.innerHTML = near.length
          ? '<ul class="firelist">' + near.map(function (n, i) {
              var pc = n.p.PercentContained;
              return '<li><span class="rank">' + (i + 1) + '</span><span><span class="fname">' + esc(titleCase(n.p.IncidentName)) +
                ' Fire</span> <span class="floc">' + esc(n.p.POOCounty ? titleCase(n.p.POOCounty) + ' County' : '') + '</span></span>' +
                '<span class="facres">' + fmt(n.p.IncidentSize) + ' acres</span>' +
                '<span class="fcont">' + (pc == null ? '' : Math.round(pc) + '% contained · ') + Math.round(n.mi) + ' mi away</span></li>';
            }).join('') + '</ul>'
          : '<p>No active wildfires found near your location right now.</p>';
        // Recenter the map on the user (works whether it's loaded yet or not).
        if (mapRef) mapRef.setView([la, lo], 7);
        else initMap();
      }).catch(function () {
        if (out) out.innerHTML = '<p>Couldn’t load live fire data right now. Please try again in a minute.</p>';
      });
    }, function () { if (out) out.innerHTML = '<p>Couldn’t get your location. Use the interactive map to search your ZIP or city.</p>'; });
  }
  function haversine(a, b, c, d) { var R = 3958.8, t = Math.PI / 180, x = (c - a) * t, y = (d - b) * t; var h = Math.sin(x / 2) * Math.sin(x / 2) + Math.cos(a * t) * Math.cos(c * t) * Math.sin(y / 2) * Math.sin(y / 2); return 2 * R * Math.asin(Math.sqrt(h)); }

  /* --------------------------------- wire up --------------------------------- */
  // Stats are already server-rendered; refresh them at idle so we never block
  // paint — via the geometry-free query (a fraction of the payload). On any
  // failure the baked-in server numbers simply stay put.
  var idle = window.requestIdleCallback || function (cb) { return setTimeout(cb, 250); };
  idle(function () { getStats().then(hydrate).catch(function () {}); });

  var embed = document.querySelector('.map-embed');
  if (embed) {
    var ph = embed.querySelector('.map-ph');
    if (ph) ph.addEventListener('click', initMap);
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (ents) {
        ents.forEach(function (e) { if (e.isIntersecting) { initMap(); io.disconnect(); } });
      }, { rootMargin: '200px' });
      io.observe(embed);
    } else { initMap(); }
  }
  var nm = document.getElementById('find-near-me');
  if (nm) nm.addEventListener('click', findNearMe);
})();
