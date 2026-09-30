import { useEffect, useState } from "react";
import { deviceTimezone, timezoneNames } from "../lib/timezone";

/**
 * Which clock "8am" and "quiet from 23:00" are on.
 *
 * Adopted from this device the first time the app is opened (see
 * lib/timezone.ts); this is where it is read, and changed. Empty means the
 * machine's own clock, which in the container is UTC.
 */
type Zone = { timezone: string; machine_timezone: string };

async function load(): Promise<Zone | null> {
  try {
    const res = await fetch("/api/settings", { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const body = await res.json();
    return { timezone: String(body.timezone ?? ""), machine_timezone: String(body.machine_timezone ?? "") };
  } catch {
    return null;
  }
}

/** What time it is there now, as that zone writes it. */
function nowIn(zone: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: zone || undefined, weekday: "short", hour: "2-digit", minute: "2-digit" }).format(new Date());
  } catch {
    return "";
  }
}

export function TimeZoneCard() {
  const [zone, setZone] = useState<Zone | null>(null);
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const names = timezoneNames();
  const mine = deviceTimezone();

  useEffect(() => {
    let alive = true;
    void load().then((found) => {
      if (!alive || !found) return;
      setZone(found);
      setDraft(found.timezone);
    });
    return () => { alive = false; };
  }, []);

  const save = async (timezone: string) => {
    setNote(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return setNote(body?.detail ?? "That could not be saved.");
      setZone({ timezone: String(body.timezone ?? ""), machine_timezone: String(body.machine_timezone ?? "") });
      setDraft(String(body.timezone ?? ""));
    } catch {
      setNote("That could not be saved.");
    }
  };

  if (!zone) return null;
  const effective = zone.timezone || zone.machine_timezone;

  return (
    <section className="set-card">
      <h3>Time zone</h3>
      <p className="jf-hint">
        The clock your schedules, watchers and quiet hours run on. It is {nowIn(effective)} there now
        ({effective}{zone.timezone ? "" : ", the machine's own"}).
      </p>
      <label className="jf-row">
        <span>Zone</span>
        <span className="notify-inline">
          <input
            list="tz-names"
            value={draft}
            placeholder={zone.machine_timezone || "Europe/Stockholm"}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => draft.trim() !== zone.timezone && void save(draft.trim())}
            aria-label="Time zone"
            autoCapitalize="off"
            spellCheck={false}
          />
          {mine && mine !== zone.timezone && (
            <button type="button" className="btn tiny" onClick={() => void save(mine)}>
              Use this device's ({mine})
            </button>
          )}
        </span>
      </label>
      {names.length > 0 && <datalist id="tz-names">{names.map((n) => <option key={n} value={n} />)}</datalist>}
      {note && <p className="set-warn" role="status">{note}</p>}
    </section>
  );
}
