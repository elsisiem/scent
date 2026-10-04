import { describe, expect, it } from "vitest";
import { handleMcp } from "../src/lib/mcp";

// Minimal D1 stub: every rate-limit upsert returns the next count for its key.
function env() {
  const n: Record<string, number> = {};
  return {
    TOKEN_SECRET: "s",
    PUBLIC_BASE_URL: "https://x",
    DB: { prepare: () => ({ bind: (k: string) => ({ first: async () => ({ n: (n[k] = (n[k] ?? 0) + 1) }) }) }) },
  } as any;
}
const post = (body: unknown) => new Request("https://x/mcp", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });

describe("mcp", () => {
  it("lists both tools and initialises", async () => {
    const e = env();
    const l: any = await (await handleMcp(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }), e, "1.1.1.1")).json();
    expect(l.result.tools.map((t: any) => t.name)).toEqual(["scent_lookup", "scent_report"]);
    const i: any = await (await handleMcp(post({ jsonrpc: "2.0", id: 2, method: "initialize", params: {} }), e, "1.1.1.1")).json();
    expect(i.result.serverInfo.name).toBe("scent");
  });
  it("answers a bad domain as a tool error, not a crash", async () => {
    const r: any = await (await handleMcp(post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "scent_lookup", arguments: { domain: "127.0.0.1" } } }), env(), "1.1.1.1")).json();
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toMatch(/bad_domain/);
  });
  it("meters only tools/call and answers over-limit as a JSON-RPC result", async () => {
    const e = env();
    for (let i = 0; i < 400; i++) expect((await handleMcp(post({ jsonrpc: "2.0", id: i, method: "ping" }), e, "1.2.3.4")).status).toBe(200);
    let last: any;
    for (let i = 0; i < 301; i++) last = await (await handleMcp(post({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "scent_report", arguments: {} } }), e, "1.2.3.4")).json();
    expect(last.result.isError).toBe(true);
    expect(last.result.content[0].text).toMatch(/rate_limited/);
  });
  it("caps batch and body size", async () => {
    const e = env();
    expect((await handleMcp(post(Array.from({ length: 11 }, (_, id) => ({ jsonrpc: "2.0", id, method: "ping" }))), e, "ip")).status).toBe(400);
    expect((await handleMcp(post("x".repeat(300_000)), e, "ip")).status).toBe(413);
  });
});
