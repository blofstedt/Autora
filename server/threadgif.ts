/**
 * GIFs in Threads: an agent asks for one by a few words ("facepalm", "party") and
 * the server finds it, so the agent never writes an address and cannot make one up.
 *
 * Needs a GIPHY_API_KEY or TENOR_API_KEY (Settings -> secrets); without either
 * agents are not told they can. A GIF is kept as an address plus a caption, and
 * only ever from the two services' own image hosts (compared as parsed hostnames,
 * never as a substring), so a post can not point the page at anywhere else.
 */

export interface Gif { url: string; alt: string }

const HOSTS = [/^media\d*\.giphy\.com$/, /^i\.giphy\.com$/, /^media\.tenor\.com$/, /^c\.tenor\.com$/];

/** A GIF address from a GIF host over https, or null. */
export function cleanGifUrl(raw: unknown): string | null {
  try {
    const u = new URL(String(raw ?? ""));
    if (u.protocol !== "https:" || u.username || u.password) return null;
    return HOSTS.some((h) => h.test(u.hostname.toLowerCase())) ? u.toString() : null;
  } catch { return null; }
}

/** A stored or sent gif, checked: the address must be one of the hosts, the caption plain and short. */
export function cleanGif(raw: unknown): Gif | null {
  if (!raw || typeof raw !== "object") return null;
  const url = cleanGifUrl((raw as { url?: unknown }).url);
  if (!url) return null;
  return { url, alt: String((raw as { alt?: unknown }).alt ?? "").replace(/\s+/g, " ").trim().slice(0, 120) || "GIF" };
}

type Fetcher = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/**
 * One GIF for a few words: from GIPHY if it has a key, else Tenor, picked at
 * random among the first results so the same words are not the same picture every
 * time. Family-friendly results only. Null when there is no key, nothing found or
 * the service is down: the post simply goes without.
 */
export async function findGif(
  query: string,
  keys: { giphy?: string; tenor?: string },
  fetcher: Fetcher = (u, i) => fetch(u, i),
  random: () => number = Math.random,
): Promise<Gif | null> {
  const q = query.replace(/\s+/g, " ").trim().slice(0, 60);
  if (!q) return null;
  const pick = <T>(list: T[]): T | undefined => list[Math.floor(random() * list.length)];
  const signal = () => AbortSignal.timeout(8000);
  if (keys.giphy) {
    try {
      const res = await fetcher(`https://api.giphy.com/v1/gifs/search?api_key=${encodeURIComponent(keys.giphy)}&q=${encodeURIComponent(q)}&limit=8&rating=pg&lang=en`, { signal: signal() });
      if (res.ok) {
        const data = (await res.json()) as { data?: { title?: string; images?: { downsized_medium?: { url?: string }; fixed_height?: { url?: string } } }[] };
        const found = (data.data ?? [])
          .map((g) => ({ url: cleanGifUrl(g.images?.downsized_medium?.url ?? g.images?.fixed_height?.url), alt: g.title ?? q }))
          .filter((g): g is Gif => !!g.url);
        const one = pick(found);
        if (one) return cleanGif(one);
      }
    } catch { /* fall through to the other service, or to nothing */ }
  }
  if (keys.tenor) {
    try {
      const res = await fetcher(`https://tenor.googleapis.com/v2/search?key=${encodeURIComponent(keys.tenor)}&q=${encodeURIComponent(q)}&limit=8&contentfilter=medium&media_filter=gif,tinygif`, { signal: signal() });
      if (res.ok) {
        const data = (await res.json()) as { results?: { content_description?: string; media_formats?: { gif?: { url?: string }; tinygif?: { url?: string } } }[] };
        const found = (data.results ?? [])
          .map((g) => ({ url: cleanGifUrl(g.media_formats?.tinygif?.url ?? g.media_formats?.gif?.url), alt: g.content_description ?? q }))
          .filter((g): g is Gif => !!g.url);
        const one = pick(found);
        if (one) return cleanGif(one);
      }
    } catch { /* nothing */ }
  }
  return null;
}
