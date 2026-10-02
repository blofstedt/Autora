/** Which website a host belongs to. Kept apart so memory.ts and mindrules.ts can both use it. */

/**
 * The site a host belongs to: "shop.example.com" is "example.com", and
 * "news.bbc.co.uk" is "bbc.co.uk". Empty for anything that is not a named
 * site -- an address, localhost -- since a note that mentions 192.168.1.1 is
 * not about every device on the network.
 */
export function siteOf(host: string): string {
  const h = String(host ?? "").toLowerCase().trim().replace(/:\d+$/, "").replace(/^www\./, "");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(h)) return "";
  const parts = h.split(".");
  const n = parts.length >= 3 && parts[parts.length - 1].length === 2 && parts[parts.length - 2].length <= 3 ? 3 : 2;
  return parts.slice(-n).join(".");
}
