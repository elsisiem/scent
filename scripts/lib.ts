import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const BASE = (process.env.BASE || "https://scent.elsisi.workers.dev").replace(/\/$/, "");

/** Read a value from the environment, falling back to .dev.vars. Never logged. */
export function secret(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  const f = join(process.cwd(), ".dev.vars"); // scripts run from the repo root via npm
  return existsSync(f) ? readFileSync(f, "utf8").match(new RegExp(`^${name}=(.+)$`, "m"))?.[1]?.trim() : undefined;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---- Brainbase hosted agents (only used by brainbase-agent.ts) ----
const API = "https://api.brainbaselabs.com/v2";
const H = () => {
  const key = secret("BRAINBASE_API_KEY");
  if (!key) throw new Error("BRAINBASE_API_KEY missing (env or .dev.vars)");
  return { Authorization: `Bearer ${key}`, "content-type": "application/json" };
};

export async function startThread(instructions: string, input: string): Promise<{ thread_id: string; status: string }> {
  const r = await fetch(`${API}/threads`, { method: "POST", headers: H(), body: JSON.stringify({ agent: { harness: "claude_code", instructions }, input }) });
  if (!r.ok) throw new Error(`Brainbase create thread: HTTP ${r.status}`);
  return (await r.json()) as any;
}
export async function threadStatus(id: string): Promise<string> {
  return ((await (await fetch(`${API}/threads/${id}`, { headers: H() })).json()) as any).status;
}
export async function assistantMessages(id: string): Promise<string[]> {
  const msgs: any = await (await fetch(`${API}/threads/${id}/messages`, { headers: H() })).json();
  const out: string[] = [];
  for (const m of msgs.items || []) {
    if (m.role !== "assistant") continue;
    if (typeof m.content === "string" && m.content.trim()) out.push(m.content);
    for (const c of m.tool_calls || []) {
      try {
        out.push("$ " + (JSON.parse(c.function.arguments).command ?? "").slice(0, 400));
      } catch {}
    }
  }
  return out;
}
