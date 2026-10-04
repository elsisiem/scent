/**
 * Domain handling. The canonical key for a site is its lowercase hostname without a leading "www.".
 * Anything that is not a public DNS name (IP literals, localhost, intranet suffixes, ports) is refused,
 * so Scent can never be pointed at internal services.
 */

const LABEL = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$/;
const BAD_SUFFIX = /\.(local|localhost|internal|lan|home|corp|intranet|test|invalid|example|onion|arpa)$/;

/** Returns the canonical domain, or null if the input is not a usable public hostname. */
export function normalizeDomain(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let s = input.trim().toLowerCase();
  if (!s || s.length > 253) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = "https://" + s.replace(/^\/\//, "");
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.username || u.password || u.port) return null;
  return publicHost(u.hostname.replace(/^www\./, ""));
}

/** Hostname check on its own (used for every redirect hop while probing). */
export function publicHost(h: string): string | null {
  h = h.toLowerCase().replace(/\.$/, "");
  if (h.length < 4 || h.length > 253 || !h.includes(".")) return null;
  if (h.startsWith("[") || /^[\d.]+$/.test(h)) return null; // IP literals
  if (BAD_SUFFIX.test(h) || h === "localhost") return null;
  const labels = h.split(".");
  if (!labels.every((l) => LABEL.test(l))) return null;
  const tld = labels[labels.length - 1];
  if (!/^(?:[a-z]{2,24}|xn--[a-z0-9-]{2,50})$/.test(tld)) return null;
  return h;
}
