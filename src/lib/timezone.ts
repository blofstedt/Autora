/**
 * The clock the console reads schedules and quiet hours on.
 *
 * The server runs in a container, where "local time" is UTC unless someone set
 * it -- so "8am every day" and "quiet from 23:00" were on a clock the person is
 * not on. The page knows theirs, so the first time it opens against a server
 * that has none chosen, it says so, once. After that the setting is theirs:
 * this never overrides a choice, and picking "the machine's" clock is a choice.
 */

/** This device's zone, as an IANA name, or empty. */
export function deviceTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}

/** Every zone this browser knows, for a picker. */
export function timezoneNames(): string[] {
  try {
    const list = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone");
    if (list?.length) return list;
  } catch {
    // Older browsers: the picker becomes a text box.
  }
  return [];
}

/**
 * Tell the server this device's zone if none has been chosen. Returns the zone
 * that was set, or null when nothing was done -- already chosen, nothing to
 * say, or the server said no.
 */
export async function adoptDeviceTimezone(): Promise<string | null> {
  const mine = deviceTimezone();
  if (!mine) return null;
  try {
    const res = await fetch("/api/settings", { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const body = await res.json();
    if (typeof body?.timezone !== "string" || body.timezone) return null;
    // The machine is already on this clock: nothing to correct.
    if (body.machine_timezone === mine) return null;
    const set = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timezone: mine }),
    });
    return set.ok ? mine : null;
  } catch {
    return null;
  }
}
