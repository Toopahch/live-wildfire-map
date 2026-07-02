// =============================================================================
//  news-admin — tiny moderation API (Deno / TypeScript)
//
//  Powers admin.html. Lets you list recent news (including hidden), see WHY each
//  article matched and its confidence score, hide/unhide an article, and block a
//  source domain so it never appears again.
//
//  Security: every request must send  x-admin-token: <ADMIN_TOKEN>  matching the
//  function's ADMIN_TOKEN env var. The service-role key stays here on the server
//  and is never exposed to the browser.
//
//  Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADMIN_TOKEN
// =============================================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ADMIN_TOKEN = Deno.env.get("ADMIN_TOKEN") ?? "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-admin-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const sb = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

async function sbFetch(path: string, init: RequestInit = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { ...sb, ...(init.headers ?? {}) },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  if (!ADMIN_TOKEN || req.headers.get("x-admin-token") !== ADMIN_TOKEN) {
    return json({ error: "Unauthorized" }, 401);
  }

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Bad JSON" }, 400); }
  const action = body.action;

  try {
    switch (action) {
      case "list": {
        // Newest first, including hidden, with confidence + match reason.
        const limit = Math.min(200, body.limit ?? 80);
        const res = await sbFetch(
          `fire_news?select=id,fire_id,fire_name,title,source_name,domain,article_url,` +
          `published_at,confidence_score,match_reason,is_official_source,is_hidden,fetched_at` +
          `&order=fetched_at.desc&limit=${limit}`,
        );
        return json({ rows: await res.json() });
      }
      case "hide":
      case "unhide": {
        if (!body.id) return json({ error: "id required" }, 400);
        await sbFetch(`fire_news?id=eq.${body.id}`, {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ is_hidden: action === "hide" }),
        });
        return json({ ok: true });
      }
      case "block_source": {
        const domain = (body.domain ?? "").toLowerCase().replace(/^www\./, "");
        if (!domain) return json({ error: "domain required" }, 400);
        // Add to block-list AND hide everything already stored from it.
        await sbFetch(`blocked_sources`, {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify({ domain, reason: body.reason ?? "blocked by admin" }),
        });
        await sbFetch(`fire_news?domain=eq.${encodeURIComponent(domain)}`, {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ is_hidden: true }),
        });
        return json({ ok: true });
      }
      case "unblock_source": {
        const domain = (body.domain ?? "").toLowerCase().replace(/^www\./, "");
        await sbFetch(`blocked_sources?domain=eq.${encodeURIComponent(domain)}`, { method: "DELETE" });
        return json({ ok: true });
      }
      case "blocked": {
        const res = await sbFetch(`blocked_sources?select=*&order=created_at.desc`);
        return json({ rows: await res.json() });
      }
      default:
        return json({ error: "Unknown action" }, 400);
    }
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { ...cors, "Content-Type": "application/json" },
  });
}
