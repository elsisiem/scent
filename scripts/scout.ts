// Scouts lay the first trails. For each domain: ask Scent, then REALLY try the routes it names (plain GET, markdown mode,
// the API spec / llms.txt / feed / MCP endpoint) and file an honest report for each, as source "scout" (weighted lower than agents).
// Results reflect the network this runs from (a residential or office IP), which is exactly what many local agents see.
//   BASE=https://scent.elsisi.workers.dev npm run scout -- github.com stripe.com     (or no args: scripts/domains.txt)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { detectWall } from "../src/lib/probe";
import { BASE, secret, sleep } from "./lib";

const ADMIN = secret("ADMIN_SECRET");
if (!ADMIN) throw new Error("ADMIN_SECRET missing (env or .dev.vars)");
const UA = "Mozilla/5.0 (compatible; scent-scout/0.1; +https://scent.elsisi.workers.dev)";

const domains = process.argv.slice(2).length ? process.argv.slice(2) : readFileSync(join(process.cwd(), "scripts", "domains.txt"), "utf8").split(String.fromCharCode(10)).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

type Attempt = { outcome: string; note?: string };

function classify(status: number, headers: Headers, body: string): Attempt {
  const wall = detectWall(status, headers, body);
  if (wall === "captcha") return { outcome: "captcha", note: `plain GET returned a captcha page (HTTP ${status})` };
  if (wall === "rate_limited") return { outcome: "rate_limited", note: "plain GET returned HTTP 429" };
  if (wall === "login_wall") return { outcome: "login_wall", note: "plain GET returned HTTP 401" };
  if (wall) return { outcome: "blocked", note: `plain GET stopped by ${wall.replace(/_/g, " ")} (HTTP ${status})` };
  if (status === 402) return { outcome: "paywall", note: "plain GET returned HTTP 402" };
  if (status >= 400) return { outcome: "broken", note: `plain GET returned HTTP ${status}` };
  const text = body.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (text.length < 300) return { outcome: "empty", note: "page loaded but has almost no text without JavaScript" };
  return { outcome: "success" };
}

async function tryGet(url: string, accept = "*/*", init: RequestInit = {}): Promise<{ status: number; headers: Headers; body: string } | null> {
  try {
    const r = await fetch(url, { ...init, redirect: "follow", headers: { "user-agent": UA, accept, ...(init.headers as any) }, signal: AbortSignal.timeout(10_000) });
    return { status: r.status, headers: r.headers, body: (await r.text()).slice(0, 200_000) };
  } catch {
    return null;
  }
}

async function mark(domain: string, route: string, a: Attempt, extra: Record<string, unknown> = {}) {
  const r = await fetch(`${BASE}/v1/trails`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-scout-secret": ADMIN! },
    body: JSON.stringify({ domain, route, outcome: a.outcome, ...(a.note ? { note: a.note } : {}), tool: "scent-scout", ...extra }),
  });
  const j: any = await r.json().catch(() => ({}));
  console.log(`   ${r.ok ? "marked" : "REFUSED"} ${route.padEnd(8)} ${a.outcome.padEnd(12)} ${r.ok ? "" : j.message ?? r.status}`);
}

for (const d of domains) {
  console.log(`\n${d}`);
  const lr = await fetch(`${BASE}/v1/scent/${d}`, { headers: { "x-scout-secret": ADMIN! } });
  if (!lr.ok) { console.log("   skip:", ((await lr.json().catch(() => ({}))) as any).message ?? lr.status); continue; }
  const card: any = await lr.json();
  const t0 = Date.now();

  // 1. what most agents try first: a plain GET
  const home = await tryGet(card.probe.origin + "/", "text/html,*/*;q=0.8");
  await mark(d, "http", home ? classify(home.status, home.headers, home.body) : { outcome: "broken", note: "plain GET failed to connect" }, { seconds: Math.round((Date.now() - t0) / 1000), steps: 1 });

  // 2. markdown mode, when the probe saw it
  if (card.probe.home.markdown) {
    const m = await tryGet(card.probe.origin + "/", "text/markdown");
    const ok = m && m.status === 200 && /markdown/i.test(m.headers.get("content-type") ?? "") && m.body.length > 200;
    await mark(d, "markdown", ok ? { outcome: "success" } : { outcome: "changed", note: "markdown mode seen by probe but not returned here" }, { steps: 1 });
  }
  // 3. the other doors
  const doors = card.probe.doors;
  if (doors.openapi) {
    const o = await tryGet(doors.openapi.url, "application/json");
    const ok = o && o.status === 200 && /"(openapi|swagger)"|^openapi:/m.test(o.body.slice(0, 2000));
    await mark(d, "api", ok ? { outcome: "success", note: doors.openapi.paths ? `OpenAPI spec lists ${doors.openapi.paths} paths` : undefined } : { outcome: o && (o.status === 401 || o.status === 403) ? "login_wall" : "broken" }, { steps: 1 });
  }
  if (doors.llms_txt) {
    const o = await tryGet(doors.llms_txt.url, "text/plain");
    await mark(d, "llms_txt", o && o.status === 200 && o.body.length > 40 ? { outcome: "success" } : { outcome: "broken" }, { steps: 1 });
  }
  if (card.probe.home.feeds[0]) {
    const o = await tryGet(card.probe.home.feeds[0], "application/rss+xml,application/atom+xml,*/*");
    await mark(d, "feed", o && o.status === 200 && /<(rss|feed|rdf)/i.test(o.body.slice(0, 2000)) ? { outcome: "success" } : { outcome: o && o.status >= 400 ? "broken" : "changed" }, { steps: 1 });
  }
  if (doors.mcp && /\/mcp\b/.test(doors.mcp.url)) {
    const o = await tryGet(doors.mcp.url, "application/json, text/event-stream", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "scent-scout", version: "0.1" } } }) });
    const ok = o && o.status === 200 && /jsonrpc|serverInfo/.test(o.body);
    await mark(d, "mcp", ok ? { outcome: "success", note: "MCP initialize answered without credentials" } : o && (o.status === 401 || o.status === 403) ? { outcome: "login_wall", note: `MCP endpoint answered HTTP ${o.status}` } : { outcome: "broken" }, { steps: 1 });
  }
  await sleep(400);
}
console.log("\ndone");
