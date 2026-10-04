import type { Env } from "../types";
import { normalizeDomain } from "./domain";
import { TOOL_RE, cleanNote, cleanUrl, noteProblem } from "./guard";
import { PROBE_TTL_MS, probeDomain, type Door, type ProbeDoc } from "./probe";
import { buildCard, type Card } from "./recommend";
import { OUTCOMES, ROUTES, computeTrail, type TrailRow } from "./trail";
import { DAY, HOUR, ago, ipKey, now, overLimit } from "./util";

export type Fail = { ok: false; status: number; error: string; message: string };
const fail = (status: number, error: string, message: string): Fail => ({ ok: false, status, error, message });

const TRAIL_WINDOW_MS = 60 * DAY;
const PROBES_PER_HOUR = 40;
const REPORTS_PER_HOUR = 60;
const REPORTS_PER_DOMAIN_PER_DAY = 6;

async function exaDocs(env: Env, domain: string): Promise<Door | undefined> {
  if (!env.EXA_API_KEY) return undefined;
  const r = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": env.EXA_API_KEY },
    body: JSON.stringify({ query: `${domain} official developer API documentation`, includeDomains: [domain], numResults: 3 }),
    signal: AbortSignal.timeout(4000),
  });
  if (!r.ok) return undefined;
  const j: any = await r.json();
  const urls: string[] = (j.results ?? []).map((x: any) => cleanUrl(x?.url)).filter(Boolean);
  const url = urls.find((u) => /docs|developer|api/i.test(u)) ?? urls[0];
  return url ? { url, via: "exa search" } : undefined;
}

/** Cached probe, or a fresh one when stale / forced. Probing is rate limited per caller; stale data beats an error. */
async function getProbe(env: Env, domain: string, ih: string, fresh: boolean): Promise<{ ok: true; probe: ProbeDoc; cached: boolean } | Fail> {
  const row = await env.DB.prepare("SELECT doc, checked_at FROM probes WHERE domain = ?1").bind(domain).first<{ doc: string; checked_at: number }>();
  const t = now();
  const stale = row ? (JSON.parse(row.doc) as ProbeDoc) : null;
  if (stale && t - row!.checked_at < PROBE_TTL_MS && !(fresh && t - row!.checked_at > 5 * 60_000)) return { ok: true, probe: stale, cached: true };
  if (await overLimit(env, `probe:${ih}`, PROBES_PER_HOUR, HOUR)) {
    if (stale) return { ok: true, probe: stale, cached: true };
    return fail(429, "rate_limited", `Too many new-domain probes from your network (${PROBES_PER_HOUR}/hour). Retry later.`);
  }
  const probe = await probeDomain(domain, fetch, { findDocs: (d) => exaDocs(env, d) });
  await env.DB.prepare("INSERT INTO probes (domain, checked_at, reachable, doc) VALUES (?1,?2,?3,?4) ON CONFLICT(domain) DO UPDATE SET checked_at=?2, reachable=?3, doc=?4")
    .bind(domain, probe.checked_at, probe.reachable ? 1 : 0, JSON.stringify(probe)).run();
  return { ok: true, probe, cached: false };
}

async function trailRows(env: Env, domain: string): Promise<TrailRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT route, outcome, note, tool, reporter, source, steps, seconds, created_at FROM reports WHERE domain = ?1 AND created_at > ?2 ORDER BY created_at DESC LIMIT 300",
  ).bind(domain, now() - TRAIL_WINDOW_MS).all<TrailRow>();
  return results;
}

export async function lookup(env: Env, input: unknown, ip: string, opts: { fresh?: boolean } = {}): Promise<{ ok: true; card: Card } | Fail> {
  const domain = normalizeDomain(input);
  if (!domain) return fail(400, "bad_domain", "Give a public domain name such as github.com (no IPs, ports or internal hosts).");
  const p = await getProbe(env, domain, await ipKey(ip, env.TOKEN_SECRET), !!opts.fresh);
  if (!p.ok) return p;
  const t = now();
  const trail = computeTrail(await trailRows(env, domain), t);
  return { ok: true, card: buildCard(p.probe, trail, { base: env.PUBLIC_BASE_URL.replace(/\/$/, ""), cached: p.cached, t }) };
}

const int = (v: unknown, max: number): number | null | "bad" => {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= max ? n : "bad";
};

export async function report(env: Env, body: any, ip: string, scout = false): Promise<{ ok: true; ack: any } | Fail> {
  if (!body || typeof body !== "object") return fail(400, "invalid_body", "Send a JSON object.");
  const domain = normalizeDomain(body.domain);
  if (!domain) return fail(400, "bad_domain", "`domain` must be a public domain name such as github.com.");
  if (!(ROUTES as readonly string[]).includes(body.route)) return fail(422, "bad_route", `\`route\` must be one of: ${ROUTES.join(", ")}.`);
  if (!(OUTCOMES as readonly string[]).includes(body.outcome)) return fail(422, "bad_outcome", `\`outcome\` must be one of: ${OUTCOMES.join(", ")}.`);

  let note: string | null = null;
  if (body.note !== undefined && body.note !== null && body.note !== "") {
    if (typeof body.note !== "string") return fail(422, "bad_note", "`note` must be a string.");
    note = cleanNote(body.note);
    const problem = noteProblem(note);
    if (problem) return fail(422, "bad_note", `Note refused: ${problem}.`);
  }
  let tool: string | null = null;
  if (body.tool !== undefined && body.tool !== null && body.tool !== "") {
    if (typeof body.tool !== "string" || !TOOL_RE.test(body.tool)) return fail(422, "bad_tool", "`tool` is a short client name such as claude-code or playwright (letters, digits, . _ / - space).");
    tool = body.tool;
  }
  const steps = int(body.steps, 500), seconds = int(body.seconds, 3600), tokens = int(body.tokens, 5_000_000);
  if (steps === "bad" || seconds === "bad" || tokens === "bad") return fail(422, "bad_number", "`steps` (0-500), `seconds` (0-3600) and `tokens` (0-5000000) must be whole numbers.");

  const ih = await ipKey(ip, env.TOKEN_SECRET);
  if (!scout && (await overLimit(env, `rep:${ih}`, REPORTS_PER_HOUR, HOUR))) return fail(429, "rate_limited", `Too many reports (${REPORTS_PER_HOUR}/hour).`);

  // Only real sites get trails: the domain must have been probed and reachable.
  const p = await getProbe(env, domain, ih, false);
  if (!p.ok) return p;
  if (!p.probe.reachable) return fail(422, "unknown_domain", `${domain} did not answer Scent's probe, so it cannot hold a trail.`);

  const t = now();
  if (!scout) {
    const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM reports WHERE domain = ?1 AND reporter = ?2 AND created_at > ?3").bind(domain, ih, t - DAY).first<{ n: number }>();
    if ((c?.n ?? 0) >= REPORTS_PER_DOMAIN_PER_DAY) return fail(429, "rate_limited", `You already filed ${REPORTS_PER_DOMAIN_PER_DAY} reports for ${domain} in the last 24h. A trail needs many walkers, not one loud one.`);
  }
  const r = await env.DB.prepare(
    `INSERT OR IGNORE INTO reports (domain, route, outcome, note, tool, steps, seconds, tokens, reporter, source, bucket, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`,
  ).bind(domain, body.route, body.outcome, note, tool, steps, seconds, tokens, ih, scout ? "scout" : "agent", Math.floor(t / HOUR), t).run();

  const trail = computeTrail(await trailRows(env, domain), t);
  const rt = trail.routes.find((x) => x.route === body.route);
  return {
    ok: true,
    ack: {
      recorded: (r.meta?.changes ?? 0) > 0,
      deduped: (r.meta?.changes ?? 0) === 0,
      domain,
      trail: { label: trail.label, strength: trail.strength, agents: trail.agents, reports: trail.reports },
      route: rt ? { route: rt.route, success_rate: rt.success_rate, agents: rt.agents } : null,
      thanks: "Trail updated. Reports fade with a 10-day half-life, so keep walking it.",
    },
  };
}

export async function feed(env: Env, limit = 20) {
  const { results } = await env.DB.prepare("SELECT domain, route, outcome, tool, note, source, created_at FROM reports ORDER BY created_at DESC LIMIT ?1").bind(Math.min(50, Math.max(1, limit))).all<any>();
  const t = now();
  return results.map((r: any) => ({ domain: r.domain, route: r.route, outcome: r.outcome, tool: r.tool, note: r.note, source: r.source, at: new Date(r.created_at).toISOString(), age: ago(r.created_at, t) }));
}

export async function stats(env: Env) {
  const t = now();
  const [a, b, c] = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS domains FROM probes WHERE reachable = 1"),
    env.DB.prepare("SELECT COUNT(*) AS reports, COUNT(DISTINCT reporter) AS reporters, MAX(created_at) AS last FROM reports"),
    env.DB.prepare("SELECT COUNT(*) AS n FROM reports WHERE created_at > ?1").bind(t - DAY),
  ]);
  const x = a.results[0] as any, y = b.results[0] as any, z = c.results[0] as any;
  return { domains_mapped: x.domains, reports: y.reports, walkers: y.reporters, reports_24h: z.n, last_report_at: y.last ? new Date(y.last).toISOString() : null };
}

/** Cron: trails that nobody walked for 90 days are gone; so are old probes and spent rate-limit rows. */
export async function prune(env: Env) {
  const t = now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM reports WHERE created_at < ?1").bind(t - 90 * DAY),
    env.DB.prepare("DELETE FROM probes WHERE checked_at < ?1").bind(t - 14 * DAY),
    env.DB.prepare("DELETE FROM rate_limits WHERE reset_at < ?1").bind(t),
  ]);
}
