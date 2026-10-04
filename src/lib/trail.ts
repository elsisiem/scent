import { DAY } from "./util";

export const ROUTES = ["mcp", "api", "markdown", "llms_txt", "feed", "http", "browser", "search", "other"] as const;
export const OUTCOMES = ["success", "partial", "blocked", "captcha", "login_wall", "paywall", "rate_limited", "broken", "empty", "changed"] as const;
export type Route = (typeof ROUTES)[number];
export type Outcome = (typeof OUTCOMES)[number];

/** A report loses half its weight every 10 days: trails evaporate unless agents keep walking them. */
export const HALF_LIFE_DAYS = 10;
/** One caller can only ever contribute this much weight per (domain, route), so a single noisy agent cannot own a trail. */
const REPORTER_CAP = 2;
const SCOUT_WEIGHT = 0.6;

export interface TrailRow {
  route: string;
  outcome: string;
  note: string | null;
  tool: string | null;
  reporter: string;
  source: string;
  steps: number | null;
  seconds: number | null;
  created_at: number;
}

export interface RouteTrail {
  route: string;
  reports: number;
  agents: number;
  weight: number;
  success_rate: number;
  last_seen: string;
  median_steps: number | null;
  median_seconds: number | null;
  failures: Record<string, number>;
}

export interface Trail {
  reports: number;
  agents: number;
  strength: number;
  label: "none" | "faint" | "fresh" | "strong";
  half_life_days: number;
  routes: RouteTrail[];
  obstacles: { outcome: string; share: number }[];
  notes: { note: string; route: string; outcome: string; tool: string | null; age_days: number }[];
  dots: { route: string; outcome: string; age_days: number; weight: number }[];
}

export const successValue = (outcome: string) => (outcome === "success" ? 1 : outcome === "partial" ? 0.5 : 0);
const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

export function computeTrail(rows: TrailRow[], t: number): Trail {
  // Newest (heaviest) first, so the per-reporter cap trims the oldest contributions.
  const sorted = [...rows].sort((a, b) => b.created_at - a.created_at);
  const used = new Map<string, number>();
  const by = new Map<string, { rows: (TrailRow & { w: number })[]; agents: Set<string> }>();
  const allAgents = new Set<string>();
  let strength = 0;
  const dots: Trail["dots"] = [];

  for (const r of sorted) {
    const ageDays = Math.max(0, (t - r.created_at) / DAY);
    let w = 0.5 ** (ageDays / HALF_LIFE_DAYS) * (r.source === "scout" ? SCOUT_WEIGHT : 1);
    const key = `${r.reporter}|${r.route}`;
    const room = Math.max(0, REPORTER_CAP - (used.get(key) ?? 0));
    w = Math.min(w, room);
    used.set(key, (used.get(key) ?? 0) + w);
    const g = by.get(r.route) ?? { rows: [], agents: new Set<string>() };
    g.rows.push({ ...r, w });
    if (w > 0) g.agents.add(r.reporter);
    by.set(r.route, g);
    if (w > 0) allAgents.add(r.reporter);
    strength += w;
    if (dots.length < 40) dots.push({ route: r.route, outcome: r.outcome, age_days: round(ageDays, 1), weight: round(w) });
  }

  const routes: RouteTrail[] = [...by.entries()].map(([route, g]) => {
    const W = g.rows.reduce((s, r) => s + r.w, 0);
    const ok = g.rows.reduce((s, r) => s + r.w * successValue(r.outcome), 0);
    const failures: Record<string, number> = {};
    for (const r of g.rows) if (successValue(r.outcome) < 1) failures[r.outcome] = (failures[r.outcome] ?? 0) + 1;
    return {
      route,
      reports: g.rows.length,
      agents: g.agents.size,
      weight: round(W),
      success_rate: W > 0 ? round(ok / W) : 0,
      last_seen: new Date(Math.max(...g.rows.map((r) => r.created_at))).toISOString(),
      median_steps: median(g.rows.filter((r) => r.outcome === "success" && r.steps != null).map((r) => r.steps!)),
      median_seconds: median(g.rows.filter((r) => r.outcome === "success" && r.seconds != null).map((r) => r.seconds!)),
      failures,
    };
  }).sort((a, b) => b.weight - a.weight);

  // Where do failures cluster? (weighted share of all failing reports)
  const obs = new Map<string, number>();
  let failW = 0;
  for (const g of by.values())
    for (const r of g.rows) if (successValue(r.outcome) < 1) {
      obs.set(r.outcome, (obs.get(r.outcome) ?? 0) + r.w);
      failW += r.w;
    }
  const obstacles = [...obs.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([outcome, v]) => ({ outcome, share: round(v / failW) }));

  const notes = sorted
    .filter((r) => r.note)
    .slice(0, 5)
    .map((r) => ({ note: r.note!, route: r.route, outcome: r.outcome, tool: r.tool, age_days: round((t - r.created_at) / DAY, 1) }));

  const label = strength < 0.3 ? "none" : strength < 2 ? "faint" : strength < 6 ? "fresh" : "strong";
  return { reports: rows.length, agents: allAgents.size, strength: round(strength), label, half_life_days: HALF_LIFE_DAYS, routes, obstacles, notes, dots };
}
