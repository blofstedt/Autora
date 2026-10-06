/**
 * What a page looks like in words: its captchas, its numbered elements, and
 * where you are scrolled to.
 *
 * These were the tail of server/browser.ts, which also holds the whole of the
 * LiveBrowser class. They are pure -- a page reading in, lines of text out --
 * and are used as much outside that class as inside it, which is why they are
 * the part worth having on their own.
 */

import { labelOf, type PageRead, type Ref, type ScrollState } from "./browser";


export function describeCaptchas(captchas: PageRead["captchas"]): string {
  if (!captchas.length) return "";
  return captchas
    .map((c) =>
      c.solved
        ? `CAPTCHA: ${labelOf(c.kind)} is passed.`
        : c.challenge
          ? `CAPTCHA: ${labelOf(c.kind)} is showing a picture challenge. It is not in the numbered list; call browser_captcha to answer it, and hand it to the person with browser_handoff only if that gives up.`
          : `CAPTCHA: ${labelOf(c.kind)} checkbox is on the page and not ticked. It is not in the numbered list; call browser_captcha to tick it.`,
    )
    .join("\n");
}

export function refLine(r: Ref): string {
  const bits = [`[${r.ref}]`, r.role];
  if (r.name) bits.push(JSON.stringify(r.name));
  if (r.purpose) bits.push(`(${r.purpose})`);
  if (r.type) bits.push(`type=${r.type}`);
  if (r.value) bits.push(`value=${JSON.stringify(r.value)}`);
  else if (r.placeholder) bits.push(`placeholder=${JSON.stringify(r.placeholder)}`);
  if (r.options?.length) {
    const more = (r.optionCount ?? r.options.length) - r.options.length;
    bits.push(`options: ${r.options.map((o) => JSON.stringify(o)).join(", ")}${more > 0 ? ` (+${more} more)` : ""}`);
  }
  if (r.maxLength) bits.push(`max ${r.maxLength} chars`);
  if (r.range) bits.push(`range ${r.range}`);
  if (r.checked === true) bits.push("checked");
  else if (r.checked === false) bits.push("not checked");
  if (r.expanded === true) bits.push("expanded");
  else if (r.expanded === false) bits.push("collapsed");
  if (r.selected) bits.push("selected");
  if (r.current) bits.push("current");
  if (r.required) bits.push("required");
  if (r.disabled) bits.push("disabled");
  if (r.invalid) bits.push(`INVALID: ${JSON.stringify(r.invalid)}`);
  else if (r.hint) bits.push(`hint: ${JSON.stringify(r.hint)}`);
  if (r.covered) bits.push(`COVERED by ${JSON.stringify(r.covered)}`);
  if (r.href) bits.push(`-> ${r.href}`);
  return bits.join(" ");
}

export function scrollLine(s: ScrollState): string {
  const where = s.pane ? "The scrolling pane" : "The page";
  if (s.max <= 0) return `${where} fits on one screen; there is nothing to scroll.`;
  const screensBelow = (s.max - s.y) / Math.max(1, s.view);
  const pct = Math.round((s.y / s.max) * 100);
  const pos = s.y <= 2 ? "at the top" : s.y >= s.max - 2 ? "at the bottom" : `${pct}% of the way down`;
  const left = s.y >= s.max - 2
    ? "nothing more below"
    : `about ${screensBelow < 1 ? "less than one screen" : `${Math.round(screensBelow * 10) / 10} screens`} more below`;
  return `${where} is ${pos}, ${left}.`;
}
