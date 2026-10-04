(() => {
  const { sniff } = window.Scent;
  const domain = decodeURIComponent(location.pathname.split("/")[2] || "");
  document.title = `Scent: ${domain}`;
  document.getElementById("api-line").textContent = `GET /v1/scent/${domain}`;
  sniff(domain, document.getElementById("result"));
})();
