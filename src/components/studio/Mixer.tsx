import { instrumentOf, type Project } from "../../lib/studio/model";
import type { Editor } from "./useSong";

/** One strip a track: how loud, where in the room, how much reverb. The master is last, with the meter. */
export function Mixer({ project, edit, sendPrompt }: { project: Project; edit: Editor; sendPrompt: (text: string) => void }) {
  const soloed = project.tracks.some((t) => t.solo);
  return (
    <div className="st-mixer">
      {project.tracks.length === 0 && <p className="st-hint st-pad">Add a track and its channel appears here.</p>}
      {project.tracks.map((t) => {
        const quiet = t.mute || (soloed && !t.solo);
        return (
          <div key={t.id} className={`st-strip${quiet ? " is-quiet" : ""}`} style={{ ["--tc" as string]: t.color }}>
            <b className="st-strip-name" title={t.name}>{t.name}</b>
            <span className="st-inst">{instrumentOf(t.instrument).name}</span>
            <label className="st-knob">Pan
              <input type="range" min={-100} max={100} value={Math.round(t.pan * 100)} aria-label={`${t.name} pan`}
                onChange={(e) => edit((p) => { const x = p.tracks.find((y) => y.id === t.id); if (x) x.pan = Number(e.target.value) / 100; }, `pan-${t.id}`)}
                onDoubleClick={() => edit((p) => { const x = p.tracks.find((y) => y.id === t.id); if (x) x.pan = 0; })} />
              <em>{t.pan === 0 ? "C" : t.pan < 0 ? `L${Math.round(-t.pan * 100)}` : `R${Math.round(t.pan * 100)}`}</em>
            </label>
            <label className="st-knob">Reverb
              <input type="range" min={0} max={100} value={Math.round(t.reverb * 100)} aria-label={`${t.name} reverb`}
                onChange={(e) => edit((p) => { const x = p.tracks.find((y) => y.id === t.id); if (x) x.reverb = Number(e.target.value) / 100; }, `rev-${t.id}`)} />
              <em>{Math.round(t.reverb * 100)}</em>
            </label>
            <div className="st-fader-wrap">
              <input className="st-fader" type="range" min={0} max={120} value={Math.round(t.volume * 100)} aria-label={`${t.name} volume`}
                onChange={(e) => edit((p) => { const x = p.tracks.find((y) => y.id === t.id); if (x) x.volume = Number(e.target.value) / 100; }, `vol-${t.id}`)}
                onDoubleClick={() => edit((p) => { const x = p.tracks.find((y) => y.id === t.id); if (x) x.volume = 0.75; })} />
            </div>
            <em className="st-db">{Math.round(t.volume * 100)}</em>
            <div className="st-strip-btns">
              <button className={`st-ms${t.mute ? " is-on is-mute" : ""}`} aria-pressed={t.mute} title="Mute" onClick={() => edit((p) => { const x = p.tracks.find((y) => y.id === t.id); if (x) x.mute = !x.mute; })}>M</button>
              <button className={`st-ms${t.solo ? " is-on is-solo" : ""}`} aria-pressed={t.solo} title="Solo" onClick={() => edit((p) => { const x = p.tracks.find((y) => y.id === t.id); if (x) x.solo = !x.solo; })}>S</button>
            </div>
          </div>
        );
      })}
      <div className="st-strip st-master">
        <b className="st-strip-name">Master</b>
        <span className="st-inst">All tracks</span>
        <div className="st-meter" aria-hidden="true"><i /></div>
        <div className="st-fader-wrap">
          <input className="st-fader" type="range" min={0} max={120} value={Math.round(project.master * 100)} aria-label="Master volume"
            onChange={(e) => edit((p) => { p.master = Number(e.target.value) / 100; }, "master")}
            onDoubleClick={() => edit((p) => { p.master = 0.9; })} />
        </div>
        <em className="st-db">{Math.round(project.master * 100)}</em>
        {project.tracks.length > 1 && (
          <button className="st-tool st-balance" onClick={() => sendPrompt("Balance the mix: look at the song, then set the volumes, panning and reverb so everything can be heard. Tell me what you changed and why.")} title="Ask Autora to balance the levels">
            Balance with Autora
          </button>
        )}
      </div>
    </div>
  );
}
