# 🔥 Live Wildfire Map — Interactive U.S. Fire Tracker

A real-time dashboard that tracks active wildfires across the United
States on an interactive **satellite map**. For every fire it shows **where it is,
how big it is, how much is contained, the cause, when it started, and the latest
incident note** — and it **updates itself automatically**, with no server or
maintenance required.

![Live Wildfire Map dashboard](https://img.shields.io/badge/status-live-brightgreen) ![No backend](https://img.shields.io/badge/backend-none-blue) ![Auto--updating](https://img.shields.io/badge/data-auto--refreshing-orange)

---

## ✨ Features

- **Interactive satellite map** (Esri World Imagery) with Terrain and Dark base layers.
- **Live fire markers** sized by burned area and color-coded by containment.
- **Mapped fire perimeters** for large, established incidents.
- **🌫️ Smoke — where it is & where it's headed:**
  - **Current smoke** — NOAA HMS analyst-drawn plume polygons (Light / Medium / Heavy), shown right now.
  - **Smoke forecast** — the operational **NOAA HRRR-Smoke** model as an animated overlay with an **hourly time scrubber** (Now → +48h) and a play button, so you can watch the plumes drift forward in time.
  - **Wind** — a field of drift arrows sampled on a uniform grid across the view, showing which way the smoke is headed everywhere you're looking.
  - Each is an independent toggle in the on-map **Smoke & Air** panel.
- **Detail popups** — size (acres), containment %, cause, time since discovery, and the official short description / update for each fire.
- **Smart sidebar** — summary stats (active fires, acres affected, average containment, states affected) plus a searchable, sortable list of every incident.
- **Filters & search** — Active / Contained / All, sort by size, containment, recency, or name.
- **🔎 Search your area** — type a **ZIP code, city, county, or landmark** and press **Enter**: the map flies to that spot, drops a "your area" pin, and re-ranks the fire list by **distance** (nearest first, with miles shown). Typing a fire/county name still filters the list live.
- **📰 Latest News & Updates** — click any fire to open a news panel beside the popup showing **official updates first** (InciWeb / agencies) then recent news, each with source, date, summary, and a link. Powered by a **cached Supabase backend** (a scheduled job searches news for active fires; the page never searches live). See **[SUPABASE_SETUP.md](SUPABASE_SETUP.md)** to enable it — it's free.
- **Auto-refresh** every 5 minutes with a live countdown, "last updated" stamp, and a status indicator. Click any fire to fly the map to it.
- **Fully responsive** — works on desktop and mobile.

---

## 🛰️ How it stays up to date (the "autonomous" part)

The map itself has **no backend and no database** — it is a static site that talks
directly to public government and imagery feeds **from the visitor's browser**.
(The optional news panel uses a free Supabase cache — see
[SUPABASE_SETUP.md](SUPABASE_SETUP.md); everything else works without it.)

| Data | Source | Notes |
|------|--------|-------|
| Active fire incidents (size, % contained, cause, location, updates) | **NIFC WFIGS** — National Interagency Fire Center, Wildland Fire Interagency Geospatial Services | Official U.S. wildfire data, updated continuously |
| Fire perimeters | **NIFC WFIGS Interagency Perimeters (Current)** | Mapped fire boundaries |
| Current smoke plumes | **NOAA HMS** (Hazard Mapping System) Smoke polygons | Analyst-drawn Light/Medium/Heavy density, updated daily |
| Smoke forecast | **NOAA HRRR-Smoke** (NDGD surface smoke) via NWS ImageServer/WMS | Hourly forecast to ~48h, updated with each model run |
| Surface wind (drift arrows) | **Open-Meteo** 10 m wind | Gridded across the view, key-free, CORS |
| Location search (ZIP / city / landmark) | **OpenStreetMap Nominatim** geocoder | Free, key-free, CORS |
| Official fire updates (news) | **InciWeb** RSS | Official, free, no key |
| General fire news | **Google News RSS** | Free, no key (unofficial endpoint) |
| News cache + scheduler | **Supabase** (Postgres + Edge Functions + pg_cron) | Free tier, $0 |
| Satellite & map imagery | **Esri** ArcGIS Online + CARTO | Free, key-free tile services |

Because the data is fetched live:

1. **Every visit pulls the newest data** the moment the page loads.
2. While the page is open, it **re-pulls every 5 minutes** automatically (configurable).
3. There is **nothing to run, schedule, or babysit** — host the files once and it keeps itself current.

No API keys are required. All endpoints are public and CORS-enabled.

---

## 🚀 Running it

### Locally (quickest look)
Any static file server works. For example, with Node installed:

```bash
npx http-server . -p 5179 -c-1 --cors
# then open http://localhost:5179
```

> Open `index.html` directly via `file://` will load the UI, but some browsers
> block cross-origin `fetch` from `file://`. Serving over `http://` (as above)
> avoids that.

### Publish it permanently (recommended — makes it truly self-running)
Drop these files onto any static host and you get a permanent, auto-updating URL:

- **GitHub Pages** — push the folder to a repo, enable Pages → done.
- **Netlify / Vercel / Cloudflare Pages** — drag-and-drop the folder, or connect the repo.
- **Any web server / S3 bucket** — just upload the files.

Once hosted, the page updates itself for every visitor with zero ongoing work.

---

## 🧩 Project structure

```
Live-Wildfire-Map/
├── index.html            # homepage: the interactive map app
├── styles.css            # design system (dark "operations console" theme)
├── config.js             # data sources, refresh interval, map settings — tune here
├── app.js                # fetch → normalize → render → auto-refresh engine
├── news.js               # cached "Latest News" panel
├── landing.css/.js       # styling + lazy map for the SEO landing pages
├── seo/generate.mjs      # builds static SEO pages from live data (see SEO.md)
├── sitemap.xml, robots.txt, 404.html
└── README.md
```

## 🔎 SEO landing pages

Because this is a static SPA, `seo/generate.mjs` writes **real static HTML pages**
(`/current-wildfires/`, `/wildfire-map/`, `/wildfires-near-me/`, and per-state maps
like `/utah-wildfire-map/`) with crawlable text, live stats, FAQs, schema, and internal
links — so Google can index location-specific wildfire content. See **[SEO.md](SEO.md)**
for how it works and the pre-launch checklist. Regenerate with `node seo/generate.mjs`.

## 🔧 Customizing

Everything tunable lives in **`config.js`**:

- `refreshIntervalMs` — how often to re-pull data (default 5 min).
- `initialView` — the map's starting center/zoom.
- `incidents.params.where` — the server-side query. For example, to focus on a
  single state, change it to `"IncidentTypeCategory='WF' AND POOState='US-CA'"`.
- `basemaps` — swap or add tile layers.

---

## 📌 Notes & accuracy

- Data reflects the official NIFC feed; figures (acreage, containment) update as
  incident teams report them and can lag real-world conditions slightly.
- The "Active" filter shows fires reported as **less than 100% contained**;
  "Contained" shows fully contained incidents still in the current dataset.
- Markers sit at the center of the mapped fire perimeter when one exists,
  otherwise at the fire's official Point of Origin.

---

*Built as a single-page, dependency-light app (vanilla JS + Leaflet). Data © NIFC.
Imagery © Esri, Maxar, Earthstar Geographics, and contributors.*
