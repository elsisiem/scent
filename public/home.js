(() => {
  const { h, sniff, loadFeed, loadStats, wireCopyButtons, wireTabs } = window.Scent;
  const form = document.getElementById("f");
  const input = document.getElementById("dom");
  const result = document.getElementById("result");
  const go = document.getElementById("go");
  const PRESETS = ["github.com", "news.ycombinator.com", "stripe.com", "developers.cloudflare.com", "linkedin.com", "nytimes.com"];

  async function run(d) {
    input.value = d;
    go.disabled = true;
    await sniff(d, result);
    go.disabled = false;
  }
  form.addEventListener("submit", (e) => { e.preventDefault(); if (input.value.trim()) run(input.value.trim()); });
  const chips = document.getElementById("chips");
  for (const p of PRESETS) chips.append(h("button", { class: "chip", type: "button", onclick: () => run(p) }, p));

  wireCopyButtons();
  wireTabs();
  loadStats();
  loadFeed(document.getElementById("feed"), 10);
  setInterval(() => { loadFeed(document.getElementById("feed"), 10); loadStats(); }, 15000);
})();
