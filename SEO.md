# SEO — how it works & pre-launch checklist

This site is a **static** vanilla-JS + Leaflet app (no framework/SSR). To give Google
crawlable, location-specific content, a small generator writes **real static HTML
pages** from live NIFC data.

## What gets generated
`node seo/generate.mjs` fetches live wildfire data and writes:

| URL | What it is |
|-----|-----------|
| `/current-wildfires/` | National summary: active count, acres, largest fires, FAQ, map (+ the canonical `Dataset` schema) |
| `/wildfire-map/` | The interactive map explainer + embed |
| `/wildfires-near-me/` | Geolocation + ZIP/city search landing page |
| `/about/` | Trust page: data sources & methodology, limitations, privacy, contact |
| `/{state}-wildfire-map/` | 16 state pages with per-state stats, unique regions copy, local resources, nearby-state links |
| `/404.html` | On-system not-found page (same header/footer/shell as everything else) |
| `/sitemap.xml` | All of the above + homepage (lastmod only on pages the generator rewrote) |

Each page has: unique `<title>`/description, self-referential canonical, Open Graph +
Twitter, one `<h1>` + `<h2>`/`<h3>` structure, **server-rendered** live stats + a
largest-fires list (crawlable text), a lazy-loaded interactive map, an FAQ (with
matching `FAQPage` JSON-LD), `BreadcrumbList` + `Dataset` + `Organization` schema,
data-source + "last updated" + a safety/evacuation disclaimer, and internal links.

`landing.js` also **hydrates the numbers live** in the browser, so users always see
current data even between regenerations.

## Keeping numbers fresh
Re-run the generator regularly so the crawlable HTML stays current:
- **Manual:** `node seo/generate.mjs`
- **Automatic:** `.github/workflows/seo-generate.yml` runs it twice daily and commits
  the result (works out of the box if you host on GitHub Pages).

## To add a state
Add an entry to `seo/states.mjs` (with a unique `blurb`, `agency`, `season`) and add a
center to `STATE_GEO` in `seo/generate.mjs`, then re-run the generator.

---

## ⚠️ Pre-launch checklist (do these before/at launch)

1. **Set your real domain.** Replace `livewildfiremap.com` in `seo/generate.mjs`
   (`SITE_URL`) and in `index.html` (canonical/OG/JSON-LD), then re-run the generator.
   Also update `robots.txt` and the `Sitemap:` line.
2. **Pick one canonical host format** and enforce it at the host:
   - HTTPS only (301 http→https), and one of www / non-www (301 the other).
   - Trailing slash: pages are generated as `folder/index.html` → served at `/folder/`.
     Ensure your host 301-redirects `/folder` → `/folder/` (GitHub Pages/Cloudflare do;
     on Netlify disable "Pretty URLs" or keep trailing slashes consistent).
3. **Confirm 404s return a real 404 status.** `404.html` is used automatically by
   GitHub Pages, Netlify, and Cloudflare Pages. Verify with `curl -I yoursite/nope`.
4. ~~Create an OG image.~~ **Done** — `/og-image.png` (1200×630) and
   `/apple-touch-icon.png` (180×180) exist and are referenced everywhere.
4b. **Set up the contact email.** `/about/` lists `hello@livewildfiremap.com` —
   configure that mailbox/forwarding at your registrar (or edit the address in
   `seo/generate.mjs` → `buildAbout()` and regenerate) so it actually delivers.
5. **Google Search Console:** add + verify the property (DNS or HTML file), then
   **Sitemaps → submit** `https://YOURDOMAIN/sitemap.xml`. Use **URL Inspection** on
   `/`, `/current-wildfires/`, and a state page → "Request indexing".
6. **Bing Webmaster Tools:** add the site + submit the sitemap (imports from GSC).
7. **PageSpeed Insights** (pagespeed.web.dev): test `/` and `/utah-wildfire-map/`.
   Aim for green CWV; the landing pages are text-first with a lazy map.
8. **Rich Results Test** (search.google.com/test/rich-results): test a state page and
   `/current-wildfires/` — confirm FAQ, Breadcrumb, and Dataset are detected with no errors.
9. **Mobile-Friendly / real-device check** for the map + landing pages.
10. **Re-run the generator** one final time right before launch so numbers are fresh.
