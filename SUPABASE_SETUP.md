# Setting up the "Latest News" backend (free, ~20 minutes)

This wires up the cached fire-news system: a Supabase database + a scheduled job
that searches news for active fires and saves the results, which the website then
reads. **Everything here is on Supabase's free tier — $0.**

> You only do this once. Nothing here touches a credit card.

---

## What you'll end up with
- A `fire_news` table holding cached, deduplicated, scored news per fire.
- A scheduled function `syncFireNews` that refreshes it twice a day, automatically.
- The map's **"Latest News & Updates"** panel reading from it.
- An `admin.html` page to hide articles or block bad sources.

---

## Step 1 — Create a free Supabase project
1. Go to **https://supabase.com** → **Start your project** → sign in with GitHub.
2. **New project**. Pick a name, a strong database password (save it), and a region near you.
3. Wait ~2 minutes for it to provision.

## Step 2 — Create the database tables
1. In your project, open **SQL Editor** (left sidebar) → **New query**.
2. Open `supabase/schema.sql` from this project, copy **all** of it, paste, click **Run**.
3. You should see "Success". (Check **Table Editor** — you'll see `fire_news`, `fires`, `blocked_sources`, `news_sync_meta`.)

## Step 3 — Get your keys
1. Open **Project Settings → API**.
2. Copy the **Project URL** (e.g. `https://abcdefgh.supabase.co`).
3. Copy the **`anon` `public`** key.  ⚠️ **Do NOT** copy the `service_role` key into the website — it's secret and the function gets it automatically.
4. Open `config.js` and fill in the `supabase` block:
   ```js
   supabase: {
     url: 'https://abcdefgh.supabase.co',
     anonKey: 'eyJhbGciOi...your anon key...'
   },
   ```

## Step 4 — Deploy the two Edge Functions
You can deploy from the dashboard (no tools to install):

1. Left sidebar → **Edge Functions** → **Create a function**.
2. Name it exactly **`sync-fire-news`**. Paste the entire contents of
   `supabase/functions/sync-fire-news/index.ts`. Click **Deploy**.
3. Create a second function named exactly **`news-admin`** and paste
   `supabase/functions/news-admin/index.ts`. **Deploy**.

> `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided to functions
> automatically — you do **not** set those.

### Set the two secrets you DO need
Edge Functions → **Manage secrets** → add:
- `CRON_SECRET` → any long random string (used to lock the sync endpoint).
- `ADMIN_TOKEN` → any long random string (your admin password for `admin.html`).

*(Prefer the CLI? `supabase functions deploy sync-fire-news` etc. works too — same result.)*

## Step 5 — Run it once to confirm it works
In **SQL Editor**, run this (replace `<PROJECT_REF>` and `<CRON_SECRET>`):
```sql
select net.http_post(
  url := 'https://<PROJECT_REF>.functions.supabase.co/sync-fire-news',
  headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<CRON_SECRET>'),
  body := '{}'::jsonb
);
```
Wait ~1–2 minutes, then open **Table Editor → fire_news**. You should see rows.
(You can also watch **Edge Functions → sync-fire-news → Logs**.)

## Step 6 — Schedule it to run automatically
1. **Database → Extensions**: enable **`pg_cron`** and **`pg_net`**.
2. **SQL Editor**: open `supabase/cron.sql`, replace `<PROJECT_REF>` and `<CRON_SECRET>`, **Run**.
   This schedules the sync for **06:00 and 18:00 UTC** daily. Done — it's now autonomous.

## Step 7 — Use the admin page
Open `admin.html` in your browser. Enter:
- **Functions base URL**: `https://<PROJECT_REF>.functions.supabase.co`
- **Admin token**: the `ADMIN_TOKEN` you set in Step 4.

Click **Load news** to review articles, see each one's confidence score and *why it
matched*, **Hide** irrelevant ones, or **Block source** to ban a domain forever.

---

## Good to know
- **Cost:** $0 on the free tier for this workload (well under all free limits).
- **Free projects pause after ~1 week of inactivity** — the twice-daily cron keeps
  yours awake, so in practice it stays live.
- **News source:** official updates come from **InciWeb** (stable, official); general
  news comes from **Google News RSS** (free, no key — an unofficial endpoint that
  could change someday, in which case official InciWeb updates still work).
- **Tuning:** edit the constants at the top of `sync-fire-news/index.ts`
  (`RECENCY_DAYS`, `MIN_CONFIDENCE`, `MAX_FIRES`) and redeploy.
- **Safety:** news is shown for situational awareness only; the panel reminds users
  to follow local authorities for evacuation and emergency information.
