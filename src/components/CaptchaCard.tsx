import { useEffect, useState } from "react";

/**
 * Picture challenges: whether they are answered here, and by what.
 *
 * A checkbox CAPTCHA that does not trust the browser puts up a picture -- a
 * grid to pick from, a piece to drag -- and that used to be where the agent
 * stopped and asked the person. It does not have to be, so this is the card
 * that decides how it is answered. Three backends, all free, all optional:
 *
 *   Pictures     arithmetic on the two images, done on this machine. Exact on
 *                sliders, nothing to install, nothing sent anywhere.
 *   The model    the picture goes to the provider already connected, which is
 *                the only thing that can answer "select all the buses".
 *   Your solver  a solver you run yourself, speaking the createTask /
 *                getTaskResult shape. Off until a URL is given.
 *
 * The order is the order they are tried. A backend that cannot answer says why
 * and the next one is asked, so a machine with no key still solves sliders and
 * a machine that solves nothing else still ticks boxes.
 */
type Backend = "local" | "vision" | "remote";

type CaptchaSettings = {
  enabled: boolean;
  backends: Backend[];
  attempts: number;
  remoteUrl: string;
  remoteKey?: string;
  remoteKeySet?: boolean;
  /** The model that would read a challenge picture, or null. */
  vision?: string | null;
};

const LABELS: { id: Backend; name: string; what: string }[] = [
  { id: "local", name: "Pictures", what: "arithmetic on the two images, on this machine" },
  { id: "vision", name: "The model", what: "the connected model reads the picture" },
  { id: "remote", name: "Your own solver", what: "a solver you run yourself, reached by URL" },
];

const ROW: React.CSSProperties = {
  display: "flex",
  gap: 9,
  alignItems: "flex-start",
  margin: "7px 0",
  fontSize: "calc(12.5px * var(--ts, 1))",
  lineHeight: 1.5,
};

const EMOJI_FREE_HINT: React.CSSProperties = { display: "block", color: "var(--text-3)", fontSize: "calc(11.5px * var(--ts, 1))" };

async function load(): Promise<CaptchaSettings | null> {
  try {
    const res = await fetch("/api/settings", { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    return (await res.json())?.captcha ?? null;
  } catch {
    return null;
  }
}

async function save(patch: Partial<CaptchaSettings>): Promise<CaptchaSettings | null> {
  try {
    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ captcha: patch }),
    });
    if (!res.ok) return null;
    return (await res.json())?.captcha ?? null;
  } catch {
    return null;
  }
}

export function CaptchaCard() {
  const [state, setState] = useState<CaptchaSettings | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [key, setKey] = useState("");

  useEffect(() => {
    let alive = true;
    void load().then((found) => {
      if (!alive) return;
      setState(found);
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  const change = (patch: Partial<CaptchaSettings>) => {
    setNote(null);
    void save(patch).then((next) => {
      if (next) setState(next);
      else setNote("That could not be saved.");
    });
  };

  const toggleBackend = (id: Backend) => {
    if (!state) return;
    const on = state.backends.includes(id);
    const next = on ? state.backends.filter((b) => b !== id) : [...state.backends, id];
    if (!next.length) {
      setNote("At least one backend has to stay on.");
      return;
    }
    change({ backends: next });
  };

  if (!loaded) {
    return (
      <section className="set-card">
        <h3>CAPTCHA</h3>
        <p className="jf-hint">Reading the settings…</p>
      </section>
    );
  }

  const on = (id: Backend) => Boolean(state?.backends.includes(id));

  return (
    <section className="set-card">
      <h3>CAPTCHA</h3>
      <p className="jf-hint">
        What happens when a CAPTCHA checkbox escalates to a picture. The backends are tried in the
        order they are switched on; one that cannot answer says why, and the next is asked. Nothing
        here costs anything beyond the model call the turn is already making.
      </p>

      <label style={ROW}>
        <input
          type="checkbox"
          checked={state?.enabled !== false}
          onChange={(e) => change({ enabled: e.target.checked })}
        />
        <span>
          Answer picture challenges automatically
          <span style={EMOJI_FREE_HINT}>Off hands every one of them to you instead.</span>
        </span>
      </label>

      {LABELS.map((backend) => (
        <label style={ROW} key={backend.id}>
          <input type="checkbox" checked={on(backend.id)} onChange={() => toggleBackend(backend.id)} />
          <span>
            {backend.name}
            <span style={EMOJI_FREE_HINT}>
              {backend.what}
              {backend.id === "vision" &&
                ` — ${state?.vision ? state.vision : "no image-reading model is connected"}`}
            </span>
          </span>
        </label>
      ))}

      <label className="jf-row" style={{ marginTop: 10 }}>
        <span>Tries</span>
        <select
          value={state?.attempts ?? 3}
          onChange={(e) => change({ attempts: Number(e.target.value) })}
          style={{ padding: "9px 11px", borderRadius: "var(--r-sm)", background: "var(--s2)", border: "1px solid var(--border)", color: "var(--text)", fontFamily: "inherit", fontSize: "calc(13px * var(--ts, 1))" }}
        >
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <p className="jf-hint">How many times to answer one challenge before handing it to you.</p>

      {on("remote") && (
        <>
          <label className="jf-row" style={{ marginTop: 10 }}>
            <span>Your solver's URL</span>
            <input
              type="text"
              value={state?.remoteUrl ?? ""}
              placeholder="http://127.0.0.1:8000"
              spellCheck={false}
              onChange={(e) => setState(state ? { ...state, remoteUrl: e.target.value } : state)}
              onBlur={(e) => change({ remoteUrl: e.target.value })}
            />
          </label>
          <label className="jf-row" style={{ marginTop: 10 }}>
            <span>Solver key</span>
            <input
              type="password"
              autoComplete="off"
              value={key}
              placeholder={state?.remoteKeySet ? "••••••••" : "only if your solver asks for one"}
              onChange={(e) => setKey(e.target.value)}
              onBlur={() => {
                if (key.trim()) {
                  change({ remoteKey: key });
                  setKey("");
                }
              }}
            />
          </label>
        </>
      )}

      {note && <p className="jf-hint">{note}</p>}
    </section>
  );
}
