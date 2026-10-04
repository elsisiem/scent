import { Hono, type Context } from "hono";
import type { Env } from "./types";
import { normalizeDomain } from "./lib/domain";
import { handleMcp } from "./lib/mcp";
import { openapi } from "./lib/openapi";
import { renderText } from "./lib/recommend";
import { feed, lookup, prune, report, stats } from "./lib/service";
import { HOUR, ipKey, overLimit } from "./lib/util";

type C = Context<{ Bindings: Env }>;
const app = new Hono<{ Bindings: Env }>();

const BODY_CAP = 64 * 1024;
const clientIp = (c: C) => c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0].trim() ?? "local";
const err = (c: C, status: number, error: string, message: string) =>
  c.json({ error, message }, status as 400, status === 429 ? { "retry-after": "3600" } : undefined);

const PAGE_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

// CORS + security headers on every response (including ones built from ASSETS).
app.use("*", async (c, next) => {
  if (c.req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type, accept, mcp-session-id, mcp-protocol-version",
        "access-control-max-age": "86400",
      },
    });
  }
  await next();
  const set = (h: Headers) => {
    h.set("access-control-allow-origin", "*");
    h.set("x-content-type-options", "nosniff");
    h.set("referrer-policy", "no-referrer");
    if (/text\/html/.test(h.get("content-type") ?? "")) {
      h.set("content-security-policy", PAGE_CSP);
      h.set("x-frame-options", "DENY");
    }
  };
  try {
    set(c.res.headers);
  } catch {
    const r = new Response(c.res.body, c.res); // immutable headers on asset responses: rebuild
    set(r.headers);
    c.res = r;
  }
});

async function readJson(c: C): Promise<{ ok: true; body: any } | { ok: false; res: Response }> {
  const len = Number(c.req.header("content-length") ?? 0);
  if (len > BODY_CAP) return { ok: false, res: err(c, 413, "too_large", "Body exceeds 64 KB.") };
  const text = await c.req.text();
  if (text.length > BODY_CAP) return { ok: false, res: err(c, 413, "too_large", "Body exceeds 64 KB.") };
  try {
    return { ok: true, body: JSON.parse(text || "{}") };
  } catch {
    return { ok: false, res: err(c, 400, "invalid_json", "Body must be valid JSON.") };
  }
}

app.get("/healthz", (c) => c.json({ ok: true }));

// ---------- agent API ----------

async function doLookup(c: C, domain: string) {
  const ip = clientIp(c);
  if (await overLimit(c.env, `look:${await ipKey(ip, c.env.TOKEN_SECRET)}`, 600, HOUR)) return err(c, 429, "rate_limited", "Too many lookups (600/hour in beta).");
  const r = await lookup(c.env, domain, ip, { fresh: c.req.query("fresh") === "1" || c.req.query("fresh") === "true" });
  if (!r.ok) return err(c, r.status, r.error, r.message);
  const wantsText = c.req.query("format") === "text" || (!c.req.query("format") && /text\/plain/.test(c.req.header("accept") ?? "") && !/json/.test(c.req.header("accept") ?? ""));
  if (wantsText) return c.body(renderText(r.card), 200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  return c.json(r.card, 200, { "cache-control": "no-store" });
}
app.get("/v1/scent/:domain", (c) => doLookup(c, c.req.param("domain")));
app.get("/v1/scent", (c) => doLookup(c, c.req.query("domain") ?? ""));

app.post("/v1/trails", async (c) => {
  const b = await readJson(c);
  if (!b.ok) return b.res;
  const secret = c.env.ADMIN_SECRET;
  const scout = !!secret && c.req.header("x-scout-secret") === secret;
  const r = await report(c.env, b.body, clientIp(c), scout);
  return r.ok ? c.json(r.ack) : err(c, r.status, r.error, r.message);
});

app.get("/v1/feed", async (c) => c.json({ items: await feed(c.env, parseInt(c.req.query("limit") ?? "20", 10) || 20) }, 200, { "cache-control": "public, max-age=10" }));
app.get("/v1/stats", async (c) => c.json(await stats(c.env), 200, { "cache-control": "public, max-age=30" }));

// ---------- human page for one domain ----------

app.get("/d/:domain", async (c) => {
  const d = normalizeDomain(c.req.param("domain"));
  if (!d) return c.html("<!doctype html><meta name=viewport content='width=device-width'><title>Scent</title><body style='font-family:system-ui;text-align:center;padding:4rem 1rem'><h1>That is not a domain</h1><p><a href='/'>Back to the colony</a></p>", 404);
  const u = new URL(c.req.url);
  u.pathname = "/d.html";
  let r = await c.env.ASSETS.fetch(new Request(u.toString(), { headers: c.req.raw.headers }));
  if (r.status >= 300 && r.status < 400 && r.headers.get("location")) r = await c.env.ASSETS.fetch(new Request(new URL(r.headers.get("location")!, u).toString()));
  return new Response(r.body, { status: r.status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" } });
});

// ---------- agent docs + MCP ----------

const asset = (path: string, type: string) => async (c: C) => {
  const u = new URL(c.req.url);
  u.pathname = path;
  const r = await c.env.ASSETS.fetch(new Request(u.toString()));
  return new Response(r.body, { status: r.status, headers: { "content-type": type, "cache-control": "public, max-age=300" } });
};
app.get("/llms.txt", asset("/llms.txt", "text/plain; charset=utf-8"));
app.get("/agents.md", asset("/llms.txt", "text/markdown; charset=utf-8"));
app.get("/openapi.json", (c) => c.json(openapi, 200, { "cache-control": "public, max-age=300" }));
app.get("/.well-known/mcp.json", (c) => c.json({ name: "scent", description: "Shared trail map of the agent web: sniff before you browse, mark after.", endpoint: `${c.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/mcp`, transport: "streamable-http" }));
app.all("/mcp", (c) => handleMcp(c.req.raw, c.env, clientIp(c)));

app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

app.onError((e, c) => {
  console.log("unhandled", e.name, e.message);
  return err(c, 500, "internal", "Something went wrong.");
});

export default {
  fetch: app.fetch,
  async scheduled(_e: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(prune(env));
  },
} satisfies ExportedHandler<Env>;
