import type { Env } from "../types";

export const now = () => Date.now();
export const HOUR = 3600_000;
export const DAY = 24 * HOUR;
export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

const enc = new TextEncoder();

export async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** IPv6 callers rotate freely inside their /64, so bucket by its first four hextets. IPv4 (and IPv4-mapped IPv6) is kept whole. */
export function ipBucket(ip: string): string {
  const a = ip.trim().toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  if (!a.includes(":")) return a;
  const mapped = /^(?:0{0,4}:){2,5}(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (mapped) return mapped[1];
  const [head, tail] = a.split("::");
  const h = head ? head.split(":") : [];
  const t = tail === undefined ? [] : tail ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return a;
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

/** Privacy-preserving per-caller key: raw IPs are never stored. */
export const ipKey = (ip: string, secret: string) => sha256(ipBucket(ip) + secret);

/**
 * Fixed-window counter in D1 (rate_limits: k, n, reset_at), one atomic upsert.
 * Returns true when the caller is OVER the limit.
 */
export async function overLimit(env: Env, key: string, max: number, windowMs: number): Promise<boolean> {
  const t = now();
  const r = await env.DB.prepare(
    `INSERT INTO rate_limits (k,n,reset_at) VALUES (?1,1,?2)
     ON CONFLICT(k) DO UPDATE SET
       n = CASE WHEN reset_at <= ?3 THEN 1 ELSE n + 1 END,
       reset_at = CASE WHEN reset_at <= ?3 THEN ?2 ELSE reset_at END
     RETURNING n`,
  ).bind(key, t + windowMs, t).first<{ n: number }>();
  return (r?.n ?? 0) > max;
}

/** "3m ago", "5h ago", "2d ago" */
export function ago(ms: number, t = now()): string {
  const s = Math.max(0, Math.round((t - ms) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
