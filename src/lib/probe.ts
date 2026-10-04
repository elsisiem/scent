import { cleanThirdParty, cleanUrl } from "./guard";
import { publicHost } from "./domain";

/**
 * Probe a site for the doors an agent can use instead of a browser. Only fixed, well-known discovery paths plus one
 * homepage GET are requested, once per 6 hours per domain, with an honest User-Agent. Every response is validated
 * (an SPA that answers 200 + HTML to every path must not look like it has an OpenAPI spec).
 */

export const UA = "ScentProbe/0.1 (+https://scent.elsisi.workers.dev; reads public discovery files only)";
export const PROBE_TTL_MS = 6 * 3600_000;

type Fetch = typeof fetch;

export interface Door {
  url: string;
  /** How we found it when it is not at a well-known path. */
  via?: string;
  title?: string;
  version?: string;
  paths?: number;
  server?: string;
  bytes?: number;
}

export interface ProbeDoc {
  domain: string;
  origin: string;
  checked_at: number;
  elapsed_ms: number;
  reachable: boolean;
  home: {
    status: number | null;
    /** What a plain GET from Scent's probe saw. Your network may differ; the trail below tells you what agents saw. */
    bot_wall: string | null;
    js_shell: boolean;
    html_tokens_est: number | null;
    markdown: boolean;
    markdown_tokens_est: number | null;
    json_ld: boolean;
    feeds: string[];
  };
  robots: { found: boolean; blocks_all: boolean; ai_blocked: string[]; crawl_delay: number | null; sitemaps: string[] };
  doors: {
    mcp?: Door;
    openapi?: Door;
    llms_txt?: Door;
    llms_full?: Door;
    agent_card?: Door;
    api_catalog?: Door;
    sitemap?: Door;
    docs?: Door;
  };
}

interface Got {
  status: number;
  headers: Headers;
  text: string;
  bytes: number;
  url: string;
}

const TIMEOUT_MS = 4500;

async function readCapped(res: Response, cap: number, keep: number): Promise<{ text: string; bytes: number }> {
  if (!res.body) return { text: "", bytes: 0 };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let kept = 0;
  try {
    while (bytes < cap) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      bytes += value.byteLength;
      if (kept < keep) {
        const take = value.subarray(0, Math.min(value.byteLength, keep - kept));
        chunks.push(take);
        kept += take.byteLength;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(kept);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return { text: new TextDecoder().decode(out), bytes };
}

/** GET with manual redirects (max 3) so every hop is re-checked as a public https host. Null on network failure. */
export async function getUrl(
  f: Fetch,
  url: string,
  o: { accept?: string; method?: "GET" | "HEAD"; cap?: number; keep?: number } = {},
): Promise<Got | null> {
  let cur = url;
  for (let hop = 0; hop <= 3; hop++) {
    let u: URL;
    try {
      u = new URL(cur);
    } catch {
      return null;
    }
    if (u.protocol !== "https:" || u.username || u.password || u.port || !publicHost(u.hostname)) return null;
    let res: Response;
    try {
      res = await f(u.toString(), {
        method: o.method ?? "GET",
        redirect: "manual",
        headers: { "user-agent": UA, accept: o.accept ?? "*/*" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return null;
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      cur = new URL(res.headers.get("location")!, u).toString();
      res.body?.cancel().catch(() => {});
      continue;
    }
    const cap = o.cap ?? 300_000;
    const { text, bytes } = o.method === "HEAD" ? { text: "", bytes: 0 } : await readCapped(res, cap, o.keep ?? cap).catch(() => ({ text: "", bytes: 0 }));
    return { status: res.status, headers: res.headers, text, bytes, url: u.toString() };
  }
  return null;
}

const isHtml = (g: Got) => /html/i.test(g.headers.get("content-type") ?? "") || /^\s*<(?:!doctype|html|head|body)/i.test(g.text);
const okText = (g: Got | null): g is Got => !!g && g.status === 200 && !isHtml(g);

function json(g: Got | null): any | null {
  if (!g || g.status !== 200 || isHtml(g)) return null;
  try {
    const v = JSON.parse(g.text);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

// ---------- robots.txt ----------

const AI_BOTS = ["gptbot", "chatgpt-user", "oai-searchbot", "claudebot", "claude-web", "anthropic-ai", "perplexitybot", "google-extended", "ccbot", "bytespider", "applebot-extended", "amazonbot", "meta-externalagent"];

export function parseRobots(text: string): ProbeDoc["robots"] {
  type G = { agents: string[]; rules: { allow: boolean; path: string }[]; delay: number | null };
  const groups: G[] = [];
  const sitemaps: string[] = [];
  let cur: G | null = null;
  let lastAgent = false;
  for (const raw of text.split(/\r?\n/).slice(0, 2000)) {
    const m = /^\s*([A-Za-z-]+)\s*:\s*(.*?)\s*$/.exec(raw.replace(/#.*/, ""));
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2];
    if (key === "user-agent") {
      if (!cur || !lastAgent) groups.push((cur = { agents: [], rules: [], delay: null }));
      cur.agents.push(val.toLowerCase());
      lastAgent = true;
      continue;
    }
    lastAgent = false;
    if (key === "sitemap") {
      const s = cleanUrl(val);
      if (s && sitemaps.length < 5) sitemaps.push(s);
    } else if (cur && (key === "allow" || key === "disallow")) cur.rules.push({ allow: key === "allow", path: val });
    else if (cur && key === "crawl-delay") cur.delay = Number.isFinite(parseFloat(val)) ? parseFloat(val) : null;
  }
  // Longest matching rule wins; for "/" the question is only whether the bare root is disallowed.
  const closed = (g: G | undefined) => !!g && g.rules.some((r) => !r.allow && r.path === "/") && !g.rules.some((r) => r.allow && r.path === "/");
  const star = groups.find((g) => g.agents.includes("*"));
  return {
    found: true,
    blocks_all: closed(star),
    ai_blocked: AI_BOTS.filter((b) => closed(groups.find((g) => g.agents.includes(b)))),
    crawl_delay: star?.delay ?? null,
    sitemaps,
  };
}

const NO_ROBOTS: ProbeDoc["robots"] = { found: false, blocks_all: false, ai_blocked: [], crawl_delay: null, sitemaps: [] };

// ---------- homepage ----------

/** What kind of bot wall (if any) a plain GET ran into. */
export function detectWall(status: number, headers: Headers, body: string): string | null {
  const b = body.slice(0, 30_000).toLowerCase();
  const small = body.length < 20_000;
  if (headers.get("cf-mitigated") === "challenge") return "cloudflare_challenge";
  if (b.includes("just a moment") && (b.includes("challenge-platform") || b.includes("cf-chl") || b.includes("cf_chl"))) return "cloudflare_challenge";
  if ((status >= 400 || small) && (b.includes("px-captcha") || b.includes("perimeterx") || b.includes("_pxhd"))) return "perimeterx";
  if ((status >= 400 || small) && b.includes("datadome")) return "datadome";
  if (status >= 400 && (/reference\s*#\d/.test(b) || b.includes("akamai"))) return "akamai";
  if (small && (b.includes("g-recaptcha") || b.includes("h-captcha") || b.includes("hcaptcha") || b.includes("cf-turnstile") || b.includes("captcha"))) return "captcha";
  if (status === 429) return "rate_limited";
  if (status === 401) return "login_wall";
  if (status === 403 || status === 999) return "blocked";
  // Any other refusal (HN answers datacenter IPs with 419, for example). Kept as "http_<status>" so the card can say
  // "refused by status only": that says more about Scent's IP than about yours.
  if (status >= 400 && status !== 404 && status !== 410) return `http_${status}`;
  return null;
}

const stripTags = (h: string) => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>|<!--[\s\S]*?-->/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

export function analyzeHtml(html: string, base: string) {
  const textLen = stripTags(html).length;
  const jsShell = html.length > 0 && textLen < 400 && /id=["'](?:root|__next|app|__nuxt)["']|<noscript/i.test(html);
  const feeds: string[] = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/type=["']application\/(?:rss|atom)\+xml["']/i.test(tag)) continue;
    const href = /href=["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href) continue;
    try {
      const abs = cleanUrl(new URL(href.replace(/&amp;/g, "&"), base).toString());
      if (abs && !feeds.includes(abs) && feeds.length < 3) feeds.push(abs);
    } catch {}
  }
  return { jsShell, feeds, jsonLd: /application\/ld\+json/i.test(html) };
}

// ---------- doors ----------

function openapiDoor(g: Got | null, url: string): Door | undefined {
  if (!g || g.status !== 200 || isHtml(g)) return undefined;
  const head = g.text.trimStart();
  if (/^(?:openapi|swagger)\s*:/m.test(head.slice(0, 400)) && !head.startsWith("{")) return { url };
  const j = json(g);
  if (!j || !(j.openapi || j.swagger)) return undefined;
  const server = Array.isArray(j.servers) ? cleanUrl(j.servers[0]?.url) : undefined;
  return {
    url,
    title: cleanThirdParty(j.info?.title),
    version: cleanThirdParty(String(j.info?.version ?? ""), 20),
    paths: j.paths && typeof j.paths === "object" ? Object.keys(j.paths).length : undefined,
    server,
  };
}

function mcpDoor(g: Got | null, url: string): Door | undefined {
  const j = json(g);
  if (!j) return undefined;
  const endpoint = cleanUrl(j.endpoint) ?? cleanUrl(j.url) ?? cleanUrl(j.remotes?.[0]?.url) ?? cleanUrl(j.transport?.url);
  if (!endpoint && !j.serverInfo && !j.name && !j.tools) return undefined;
  return { url: endpoint ?? url, title: cleanThirdParty(j.name ?? j.serverInfo?.name), via: endpoint ? "server card" : undefined };
}

/** RFC 8288 Link headers that point at an API description. */
function linkedSpecs(h: Headers): string[] {
  const out: string[] = [];
  for (const m of (h.get("link") ?? "").matchAll(/<([^>]+)>\s*;([^,<]*)/g)) {
    if (/rel="?[^";]*(?:service-desc|api-catalog)/i.test(m[2])) {
      const u = cleanUrl(m[1]);
      if (u && !out.includes(u)) out.push(u);
    }
  }
  return out.slice(0, 2);
}

export interface ProbeExtras {
  /** Optional docs lookup (Exa) used when no OpenAPI spec or llms.txt was found. */
  findDocs?: (domain: string) => Promise<Door | undefined>;
}

export async function probeDomain(domain: string, f: Fetch = fetch, extras: ProbeExtras = {}): Promise<ProbeDoc> {
  const t0 = Date.now();
  const doc: ProbeDoc = {
    domain,
    origin: `https://${domain}`,
    checked_at: t0,
    elapsed_ms: 0,
    reachable: false,
    home: { status: null, bot_wall: null, js_shell: false, html_tokens_est: null, markdown: false, markdown_tokens_est: null, json_ld: false, feeds: [] },
    robots: NO_ROBOTS,
    doors: {},
  };

  // Round 1: the homepage, falling back to www. The final origin (after redirects) anchors every other path.
  let home = await getUrl(f, `https://${domain}/`, { accept: "text/html,*/*;q=0.8", cap: 1_000_000, keep: 200_000 });
  if (!home) home = await getUrl(f, `https://www.${domain}/`, { accept: "text/html,*/*;q=0.8", cap: 1_000_000, keep: 200_000 });
  if (home) {
    doc.reachable = true;
    doc.origin = new URL(home.url).origin;
    const a = analyzeHtml(home.text, home.url);
    doc.home = {
      status: home.status,
      bot_wall: detectWall(home.status, home.headers, home.text),
      js_shell: a.jsShell,
      html_tokens_est: Math.ceil(home.bytes / 4),
      markdown: false,
      markdown_tokens_est: null,
      json_ld: a.jsonLd,
      feeds: a.feeds,
    };
  }
  const o = doc.origin;
  const at = (p: string) => `${o}${p}`;

  // Round 2: everything else in parallel.
  const specLinks = home ? linkedSpecs(home.headers) : [];
  const specPaths = [...specLinks, at("/openapi.json"), at("/.well-known/openapi.json"), at("/swagger.json"), at("/api/openapi.json")];
  const [robots, llms, llmsFull, mcp1, mcp2, card1, card2, catalog, sitemap, md, ...specs] = await Promise.all([
    getUrl(f, at("/robots.txt"), { accept: "text/plain", cap: 200_000 }),
    getUrl(f, at("/llms.txt"), { accept: "text/plain,text/markdown", cap: 300_000 }),
    getUrl(f, at("/llms-full.txt"), { method: "HEAD" }),
    getUrl(f, at("/.well-known/mcp.json"), { accept: "application/json", cap: 100_000 }),
    getUrl(f, at("/.well-known/mcp/server-card.json"), { accept: "application/json", cap: 100_000 }),
    getUrl(f, at("/.well-known/agent-card.json"), { accept: "application/json", cap: 100_000 }),
    getUrl(f, at("/.well-known/agent.json"), { accept: "application/json", cap: 100_000 }),
    getUrl(f, at("/.well-known/api-catalog"), { accept: "application/linkset+json,application/json", cap: 100_000 }),
    getUrl(f, at("/sitemap.xml"), { method: "HEAD" }),
    getUrl(f, at("/"), { accept: "text/markdown, text/html;q=0.5", cap: 1_000_000, keep: 2000 }),
    ...specPaths.map((u) => getUrl(f, u, { accept: "application/json,application/yaml;q=0.9,*/*;q=0.5", cap: 3_000_000, keep: 3_000_000 })),
  ]);

  if (robots && robots.status === 200 && !isHtml(robots)) doc.robots = parseRobots(robots.text);
  if (robots || llms || mcp1 || md) doc.reachable = true;

  if (okText(llms) && llms.text.trim().length > 20) doc.doors.llms_txt = { url: at("/llms.txt"), bytes: llms.bytes };
  if (llmsFull && llmsFull.status === 200 && !/html/i.test(llmsFull.headers.get("content-type") ?? "")) doc.doors.llms_full = { url: at("/llms-full.txt") };

  if (md && md.status === 200 && /text\/markdown/i.test(md.headers.get("content-type") ?? "")) {
    doc.home.markdown = true;
    const hdr = parseInt(md.headers.get("x-markdown-tokens") ?? "", 10);
    doc.home.markdown_tokens_est = Number.isFinite(hdr) ? hdr : Math.ceil(md.bytes / 4);
  }

  const mcp = mcpDoor(mcp1, at("/.well-known/mcp.json")) ?? mcpDoor(mcp2, at("/.well-known/mcp/server-card.json"));
  if (mcp) doc.doors.mcp = mcp;
  else if (okText(llms)) {
    const m = /https:\/\/[^\s)"'<>\]]+\/mcp\b[^\s)"'<>\]]*/i.exec(llms.text);
    const u = m && cleanUrl(m[0]);
    if (u) doc.doors.mcp = { url: u, via: "linked from llms.txt" };
  }

  for (let i = 0; i < specs.length && !doc.doors.openapi; i++) {
    const d = openapiDoor(specs[i], specs[i]?.url ?? specPaths[i]);
    if (d) doc.doors.openapi = d;
  }

  const card = json(card1) ?? json(card2);
  if (card && (card.name || card.skills)) doc.doors.agent_card = { url: json(card1) ? at("/.well-known/agent-card.json") : at("/.well-known/agent.json"), title: cleanThirdParty(card.name) };

  const cat = json(catalog);
  if (cat && Array.isArray(cat.linkset)) {
    doc.doors.api_catalog = { url: at("/.well-known/api-catalog"), paths: cat.linkset.length };
    if (!doc.doors.openapi) {
      const href = cleanUrl(cat.linkset.flatMap((l: any) => l?.["service-desc"] ?? []).find((x: any) => x?.href)?.href);
      if (href) doc.doors.openapi = { url: href, via: "api-catalog" };
    }
  }

  const smUrl = doc.robots.sitemaps[0];
  if (smUrl) doc.doors.sitemap = { url: smUrl, via: "robots.txt" };
  else if (sitemap && sitemap.status === 200 && !/html/i.test(sitemap.headers.get("content-type") ?? "")) doc.doors.sitemap = { url: at("/sitemap.xml") };

  if (!doc.doors.openapi && !doc.doors.llms_txt && extras.findDocs) {
    try {
      const d = await extras.findDocs(domain);
      if (d) doc.doors.docs = d;
    } catch {}
  }

  doc.elapsed_ms = Date.now() - t0;
  return doc;
}
