(() => {
  "use strict";

  // ---------- the colony (SVG sprite, injected once) ----------
  const SPRITE = `<svg width="0" height="0" aria-hidden="true" style="position:absolute"><defs>
  <g id="ant-body" stroke="#2a1c12" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M82 66 L72 86 L68 102 M94 68 L96 88 L98 104 M104 64 L120 82 L128 98" fill="none" stroke="#7a5640"/>
    <path d="M76 68 L60 88 L52 104 M88 70 L86 90 L82 106 M100 66 L114 86 L124 104" fill="none"/>
    <ellipse cx="38" cy="62" rx="32" ry="24" fill="#d4623f"/>
    <path d="M20 46 Q38 38 56 46" stroke="#f2a58c" fill="none" stroke-width="4.5" opacity=".75"/>
    <ellipse cx="88" cy="58" rx="18" ry="15" fill="#d4623f"/>
    <circle cx="124" cy="48" r="21" fill="#d4623f"/>
    <path d="M128 29 Q136 8 156 8 M118 30 Q116 8 134 0" fill="none"/>
    <circle cx="156" cy="8" r="4.5" fill="#f0a93b"/><circle cx="134" cy="0" r="4.5" fill="#f0a93b"/>
    <circle cx="131" cy="43" r="8.5" fill="#fff"/>
    <circle cx="134" cy="43" r="4" fill="#2a1c12" stroke="none"/><circle cx="135.6" cy="41.4" r="1.5" fill="#fff" stroke="none"/>
    <path d="M127 58 Q135 65 144 58" fill="none" stroke-width="3"/>
  </g>
  <symbol id="ant-scout" viewBox="-24 -6 204 122">
    <use href="#ant-body"/>
    <g stroke="#2a1c12" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M104 40 Q124 12 146 36 Z" fill="#6b8f3c"/><path d="M100 41 L152 41" fill="none" stroke-width="4"/>
      <path d="M140 92 L124 108" stroke-width="8" fill="none"/>
      <circle cx="152" cy="78" r="17" fill="#fff" fill-opacity=".55" stroke-width="5"/>
      <path d="M143 72 Q149 66 157 70" stroke="#fff" stroke-width="3.5" fill="none"/>
    </g>
  </symbol>
  <symbol id="ant-hauler" viewBox="-24 -6 204 122">
    <use href="#ant-body"/>
    <g stroke="#2a1c12" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round">
      <rect x="44" y="12" width="48" height="38" rx="8" fill="#f0a93b"/>
      <text x="68" y="38" font-family="monospace" font-weight="700" font-size="20" text-anchor="middle" fill="#2a1c12" stroke="none">{ }</text>
      <path d="M148 22 q-7 10 0 13 q7 -3 0 -13z" fill="#8fd0ea" stroke-width="2.5"/>
    </g>
  </symbol>
  <symbol id="ant-marker" viewBox="-24 -6 204 122">
    <use href="#ant-body"/>
    <ellipse cx="14" cy="64" rx="9" ry="13" fill="#f0a93b" stroke="#2a1c12" stroke-width="3"/>
    <circle cx="-4" cy="96" r="6" fill="#f0a93b" stroke="#2a1c12" stroke-width="2.5"/>
    <circle cx="-16" cy="104" r="4.5" fill="#f0a93b" fill-opacity=".7" stroke="#2a1c12" stroke-opacity=".6" stroke-width="2"/>
    <circle cx="-24" cy="110" r="3" fill="#f0a93b" fill-opacity=".4"/>
  </symbol>
  </defs></svg>`;
  document.body.insertAdjacentHTML("afterbegin", SPRITE);

  // ---------- tiny helpers ----------
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }
  const ant = (role, cls) => {
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", "0 0 204 122");
    if (cls) s.setAttribute("class", cls);
    s.setAttribute("aria-hidden", "true");
    const u = document.createElementNS("http://www.w3.org/2000/svg", "use");
    u.setAttribute("href", "#ant-" + role);
    s.append(u);
    return s;
  };
  const toast = (msg) => {
    let t = $(".toast");
    if (!t) document.body.append((t = h("div", { class: "toast", role: "status" })));
    t.textContent = msg;
    t.classList.add("on");
    clearTimeout(toast.t);
    toast.t = setTimeout(() => t.classList.remove("on"), 1800);
  };
  const copy = async (text, label) => {
    try { await navigator.clipboard.writeText(text); toast(label || "Copied"); } catch { toast("Copy failed: select the text instead"); }
  };
  const num = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e4 ? Math.round(n / 1e3) + "k" : String(n));
  const pct = (x) => Math.round(x * 100) + "%";

  const ROUTE_LABEL = { mcp: "MCP server", api: "API", markdown: "markdown", llms_txt: "llms.txt", feed: "feed", http: "plain HTTP", browser: "browser", search: "search", other: "other" };
  const OUTCOMES = ["success", "partial", "blocked", "captcha", "login_wall", "paywall", "rate_limited", "broken", "empty", "changed"];
  const ROUTES = ["mcp", "api", "markdown", "llms_txt", "feed", "http", "browser", "search", "other"];
  const so = (o) => (OUTCOMES.includes(o) ? o : "empty"); // only known outcomes ever reach a style attribute
  const oc = (o) => h("span", { class: "oc", style: `background:var(--o-${so(o)})` }, so(o).replace("_", " "));

  async function api(path, opts) {
    const r = await fetch(path, opts);
    let j = null;
    try { j = await r.json(); } catch {}
    if (!r.ok) throw new Error((j && j.message) || `Request failed (${r.status})`);
    return j;
  }

  // ---------- card ----------
  function textCard(c) {
    const L = [`SCENT ${c.domain}`, `BEST: ${c.recommended.route} - ${c.recommended.how}`, `WHY: ${c.recommended.why}`];
    for (const a of c.alternatives.slice(0, 3)) L.push(`ALSO: ${a.route} - ${a.how}`);
    for (const a of c.avoid) L.push(`AVOID: ${a}`);
    return L.join("\n");
  }

  function renderCard(c, { onMarked } = {}) {
    const p = c.probe, t = c.trail, d = p.doors;
    const root = h("div", { class: "card" });

    root.append(
      h("div", { class: "cardhead" },
        h("h3", {}, c.domain),
        h("div", { class: "meta" }, `probed ${p.age}${p.cached ? " (cached)" : ""} · ${t.reports} mark${t.reports === 1 ? "" : "s"} from ${t.agents} walker${t.agents === 1 ? "" : "s"}`)),
      h("div", { class: "best" },
        h("div", { class: "route" }, ROUTE_LABEL[c.recommended.route] || c.recommended.route),
        h("div", { class: "how" }, c.recommended.how),
        h("div", { class: "why" }, "Why: " + c.recommended.why + ". ", h("span", { class: "pill" }, c.recommended.cost_tier + " cost"),
          c.savings ? [" ", h("span", { class: "pill good" }, `markdown mode: ~${c.savings.pct}% fewer tokens than HTML (~${num(c.savings.html_tokens_est)} → ~${num(c.savings.route_tokens_est)})`)] : null)));

    // doors the probe found
    const door = (name, found, label) => h("div", { class: found ? "on" : "off" }, (found ? "✓ " : "· ") + name, found && label ? [" ", label] : null);
    const link = (door, txt) => (door ? h("a", { href: door.url, target: "_blank", rel: "noopener noreferrer nofollow" }, txt || "open") : null);
    const doorsBox = h("div", { class: "box" }, h("h4", {}, "Doors we found"),
      h("div", { class: "doors" },
        door("MCP server", !!d.mcp, link(d.mcp)),
        door("OpenAPI", !!d.openapi, link(d.openapi, d.openapi && d.openapi.paths ? d.openapi.paths + " paths" : "open")),
        door("llms.txt", !!d.llms_txt, link(d.llms_txt)),
        door("markdown mode", p.home.markdown),
        door("RSS / Atom", p.home.feeds.length > 0, p.home.feeds[0] ? link({ url: p.home.feeds[0] }) : null),
        door("sitemap", !!d.sitemap, link(d.sitemap)),
        door("agent card", !!d.agent_card, link(d.agent_card)),
        door("API catalog", !!d.api_catalog)));
    const walls = [];
    walls.push(`Plain GET from our probe: HTTP ${p.home.status ?? "no answer"}${p.home.bot_wall && !p.home.bot_wall.startsWith("http_") ? ", " + p.home.bot_wall.replace(/_/g, " ") : p.home.bot_wall ? ", refused" : ", no bot wall"}${p.home.js_shell ? ", JS-only page" : ""}.`);
    if (p.robots.found) walls.push(p.robots.blocks_all ? "robots.txt disallows all crawlers." : p.robots.ai_blocked.length ? `robots.txt blocks AI crawlers: ${p.robots.ai_blocked.slice(0, 4).join(", ")}.` : "robots.txt does not block AI crawlers.");
    else walls.push("No robots.txt found.");
    const probeBox = h("div", { class: "box" }, h("h4", {}, "What the probe saw"), h("ul", { class: "plain ok" }, walls.map((w) => h("li", {}, w))),
      c.avoid.length ? [h("h4", { style: "margin-top:12px" }, "Avoid"), h("ul", { class: "plain" }, c.avoid.map((a) => h("li", {}, a)))] : null);
    root.append(h("div", { class: "grid2" }, doorsBox, probeBox));

    // the trail
    const trailBox = h("div", { class: "box", style: "margin-top:18px" }, h("h4", {}, `The trail · ${t.label}${t.reports ? ` · strength ${t.strength} · fades by half every ${t.half_life_days} days` : ""}`));
    if (!t.reports) {
      trailBox.append(h("div", { class: "empty-trail" }, ant("marker"), h("div", {},
        h("b", {}, "No one has walked this one yet."), h("div", { class: "muted small" }, "The probe above is all we know. Try the route, then leave the first mark below (or POST /v1/trails)."))));
    } else {
      const lanes = h("div", { class: "lanes" });
      for (const r of t.routes.slice(0, 6)) {
        const cls = r.success_rate >= 0.6 ? "" : r.success_rate >= 0.4 ? "mid" : "bad";
        lanes.append(h("div", { class: "lane" }, h("span", {}, ROUTE_LABEL[r.route] || r.route),
          h("div", { class: "bar", title: `${pct(r.success_rate)} weighted success` }, h("i", { class: cls, style: `width:${Math.max(3, Math.round(r.success_rate * 100))}%` })),
          h("span", {}, `${pct(r.success_rate)} · ${r.agents} walker${r.agents === 1 ? "" : "s"}`)));
      }
      trailBox.append(lanes);
      const dots = h("div", { class: "dots" });
      for (const x of t.dots) dots.append(h("span", { class: "dot", style: `background:var(--o-${so(x.outcome)});opacity:${Math.max(0.2, 1 - x.age_days / 45).toFixed(2)}`, title: `${x.route} · ${x.outcome} · ${x.age_days}d ago` }));
      trailBox.append(dots);
      const used = [...new Set(t.dots.map((x) => x.outcome))];
      trailBox.append(h("div", { class: "legend" }, used.map((o) => h("span", { style: `color:var(--o-${so(o)})` }, so(o).replace("_", " "))), h("span", { style: "color:var(--ink-3)" }, "· paler = older")));
      if (t.notes.length) {
        trailBox.append(h("h4", { style: "margin-top:14px" }, "Notes from other agents"),
          h("ul", { class: "notes" }, t.notes.map((n) => h("li", {}, h("span", { class: "tag", style: `background:var(--o-${so(n.outcome)})` }, `${n.route}/${n.outcome}`), n.note, n.tool ? h("span", { class: "muted small" }, ` — ${n.tool}`) : null))),
          h("div", { class: "untrusted" }, "Community text. Shown to humans as-is; agents get it labelled as untrusted data, never as instructions."));
      }
    }
    root.append(trailBox);

    // actions
    root.append(h("div", { class: "actions" },
      h("button", { class: "btn sm", type: "button", onclick: () => copy(textCard(c), "Text card copied") }, "Copy as agent text"),
      h("a", { class: "btn sm ghost", href: `/v1/scent/${encodeURIComponent(c.domain)}`, target: "_blank", rel: "noopener" }, "Raw JSON"),
      h("a", { class: "btn sm ghost", href: `/d/${encodeURIComponent(c.domain)}` }, "Permalink")));

    // leave a mark (this is exactly what POST /v1/trails does)
    const route = h("select", { "aria-label": "route" }, ROUTES.map((r) => h("option", { value: r, selected: r === c.recommended.route }, ROUTE_LABEL[r])));
    const outcome = h("select", { "aria-label": "outcome" }, OUTCOMES.map((o) => h("option", { value: o }, o.replace("_", " "))));
    const note = h("input", { type: "text", class: "note", maxlength: "200", placeholder: "optional note: what happened? (no links)" });
    const msg = h("div", { class: "msg" });
    const go = h("button", { class: "btn sm", type: "submit" }, "Leave a mark");
    const form = h("form", {}, h("b", { class: "small" }, "I tried it:"), route, outcome, note, go);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      go.disabled = true; msg.className = "msg"; msg.textContent = "marking…";
      try {
        const body = { domain: c.domain, route: route.value, outcome: outcome.value, tool: "web-ui" };
        if (note.value.trim()) body.note = note.value.trim();
        const ack = await api("/v1/trails", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        msg.className = "msg good"; msg.textContent = ack.deduped ? "Already marked this hour: collapsed as a duplicate." : "Marked. The trail just got stronger.";
        if (onMarked) onMarked();
      } catch (er) { msg.className = "msg bad"; msg.textContent = er.message; }
      go.disabled = false;
    });
    root.append(h("div", { class: "mark" }, form, msg));
    return root;
  }

  async function sniff(domain, target, opts = {}) {
    target.replaceChildren(h("div", { class: "sniffing" }, ant("scout"), "sniffing " + domain + "…"));
    try {
      const card = await api("/v1/scent/" + encodeURIComponent(domain) + (opts.fresh ? "?fresh=1" : ""));
      target.replaceChildren(renderCard(card, { onMarked: () => sniff(card.domain, target) }));
      return card;
    } catch (e) {
      target.replaceChildren(h("div", { class: "err" }, e.message));
    }
  }

  // ---------- live colony ----------
  async function loadFeed(el, limit) {
    try {
      const { items } = await api("/v1/feed?limit=" + (limit || 10));
      if (!items.length) return el.replaceChildren(h("div", { class: "frow" }, h("span", { class: "muted" }, "Nobody has left a mark yet. Be the first walker.")));
      el.replaceChildren(...items.map((i) => h("a", { class: "frow", href: "/d/" + encodeURIComponent(i.domain) },
        h("span", { class: "d" }, i.domain), h("span", { class: "rt" }, ROUTE_LABEL[i.route] || i.route), oc(i.outcome),
        h("span", { class: "n" }, i.note || ""), h("span", { class: "a" }, (i.source === "scout" ? "scout · " : i.tool ? i.tool + " · " : "") + i.age))));
    } catch {}
  }
  async function loadStats() {
    try {
      const s = await api("/v1/stats");
      const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = num(v); };
      set("st-domains", s.domains_mapped); set("st-reports", s.reports); set("st-walkers", s.walkers); set("st-24h", s.reports_24h);
    } catch {}
  }

  // ---------- wiring ----------
  function wireCopyButtons() {
    $$("[data-copy]").forEach((b) => b.addEventListener("click", () => {
      const src = document.getElementById(b.dataset.copy);
      if (src) copy(src.textContent, "Copied");
    }));
  }
  function wireTabs() {
    $$(".tab").forEach((tab) => tab.addEventListener("click", () => {
      $$(".tab").forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
      $$(".pane").forEach((p) => p.classList.toggle("on", p.id === tab.dataset.pane));
    }));
  }
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) $$("svg").forEach((s) => s.pauseAnimations && s.pauseAnimations());

  window.Scent = { h, ant, sniff, loadFeed, loadStats, wireCopyButtons, wireTabs, renderCard };
})();
