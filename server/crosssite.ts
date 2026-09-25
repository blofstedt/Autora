/**
 * Requests from other websites, refused.
 *
 * Autora has no login of its own -- on Umbrel the app proxy's login is in
 * front of it, and elsewhere it is whoever can reach the port -- and what it
 * can do is run commands on this machine. That makes the browser of the
 * person using it the thing to protect: while they have Autora open in one
 * tab, a page in another tab can still aim requests at Autora's address.
 * Most of those are already stopped by the browser (a JSON body needs a CORS
 * preflight this server never grants), but not all of them: a form post with
 * no body can still stop a turn, run a job or clear the spend ledger, and a
 * WebSocket is not covered by CORS at all -- a page anywhere could open
 * `/ws/<session>`, read the whole thread and approve a held command.
 *
 * Browsers say where a request came from in `Sec-Fetch-Site`, a header a page
 * cannot set or forge. Everything the app itself sends is `same-origin`; a
 * request typed into the address bar is `none`. Anything else changing state,
 * and any WebSocket from another site, is refused here.
 *
 * Deliberately fail-open when the header is missing: the desktop relay and
 * curl send none, and neither does an old browser. A proxy in front (Umbrel's,
 * `tailscale serve`, nginx) passes the header through untouched, so nothing
 * here depends on how the Host header was rewritten on the way in.
 */

import type { IncomingHttpHeaders } from "node:http";

/** Methods that only read. */
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/** True when the browser says the request was started by a page on another
    site -- including another app on the same host, which is "same-site". */
export function fromAnotherSite(headers: IncomingHttpHeaders): boolean {
  const site = String(headers["sec-fetch-site"] ?? "").trim().toLowerCase();
  return site === "cross-site" || site === "same-site";
}

/** Why an HTTP request is refused, or null to let it through. */
export function refuseRequest(method: string, headers: IncomingHttpHeaders): string | null {
  if (SAFE.has(method.toUpperCase())) return null;
  return fromAnotherSite(headers)
    ? "Refused: this request came from another website, not from Autora's own page."
    : null;
}

/** Whether a WebSocket upgrade may go ahead. */
export function allowSocket(headers: IncomingHttpHeaders): boolean {
  return !fromAnotherSite(headers);
}
