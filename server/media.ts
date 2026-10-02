/**
 * The media tool: audio, video and images as things the agent can work with.
 *
 * Until now a recording was a file it could not open and a scan was a picture
 * it could only squint at. ffmpeg does the media work (inspect, take frames,
 * pull the audio out, trim, convert, resize); transcription goes to the speech
 * service the person already has a key for (Deepgram, else OpenAI's Whisper),
 * with the audio first shrunk to speech quality so a long recording fits; OCR
 * runs tesseract when it is installed and, when it is not, hands the pictures
 * to the model to read -- so a scan is never a dead end.
 *
 * Everything runs the program directly, with arguments, never through a shell.
 * What comes out is an artifact (shown in the thread) or text.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { artifactPath, cleanName, formatSize, getArtifact, listArtifacts, mimeFor, saveArtifact, MAX_ARTIFACT_BYTES } from "./artifacts";

import { MEDIA_READ } from "./readonly";
export { MEDIA_READ };

/** Whether this call only looks: it makes nothing but pictures or text for the agent. */
export function mediaReadOnly(args: Record<string, any>): boolean {
  return MEDIA_READ.has(String(args.action ?? "").trim().toLowerCase());
}

export interface MediaFile { id: string; name: string; mime: string; size: number }
export interface MediaImage { name: string; data: Buffer; mime: string }

export interface MediaResult {
  ok: boolean;
  summary: string;
  preview?: string;
  files: MediaFile[];
  /** Pictures for the model to look at (frames, or pages to read when there is no OCR). */
  images: MediaImage[];
}

export interface MediaCall {
  cwd: string;
  session: string;
  args: Record<string, any>;
  onCancel?: (stop: () => void) => void;
  cancelled?: () => boolean;
  /** For transcription: the keys the person has set. */
  keys: { deepgram: string; openai: string };
  /** Render PDF pages to pictures (for OCR of a scanned PDF). */
  pdfPages?: (data: Buffer, pages: number[], scale: number) => Promise<{ page: number; png: Buffer }[]>;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
}

const done = (r: Partial<MediaResult> & { ok: boolean; summary: string }): MediaResult => ({ files: [], images: [], ...r });
const bad = (summary: string) => done({ ok: false, summary });

// ----------------------------------------------------------- programs --

const found = new Map<string, string | null>();
export function which(name: string): string | null {
  if (found.has(name)) return found.get(name) ?? null;
  let hit: string | null = null;
  for (const d of (process.env.PATH ?? "").split(path.delimiter)) {
    try {
      fs.accessSync(path.join(d, name), fs.constants.X_OK);
      hit = path.join(d, name);
      break;
    } catch {
      // next
    }
  }
  found.set(name, hit);
  return hit;
}

function exec(file: string, args: string[], opts: { timeout?: number; onCancel?: (stop: () => void) => void } = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => { if (out.length < 8_000_000) out += String(d); });
    child.stderr.on("data", (d) => { err = (err + String(d)).slice(-6000); });
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } err += "\n(timed out)"; }, opts.timeout ?? 10 * 60_000);
    opts.onCancel?.(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } });
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: 127, out, err: String(e.message) }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, out, err }); });
  });
}

const missing = (name: string, why: string) =>
  bad(`${name} is not installed on this host, and ${why} needs it. (The Docker image includes it; on another install, add it with the system's package manager.)`);

// -------------------------------------------------------------- input --

interface Input { file: string; name: string; fromArtifact: boolean }

function resolveInput(call: MediaCall): Input | string {
  const ref = String(call.args.file ?? "").trim();
  if (!ref) return "Say which file: an artifact id (file_...), a path, or an artifact's name.";
  if (/^file_[0-9a-f]{16}$/.test(ref)) {
    const art = getArtifact(ref);
    if (art) return { file: artifactPath(art.id), name: art.name, fromArtifact: true };
  }
  const full = path.resolve(call.cwd, ref);
  try {
    if (fs.statSync(full).isFile()) return { file: full, name: path.basename(full), fromArtifact: false };
  } catch {
    // not a path
  }
  const named = listArtifacts().find((a) => a.name.toLowerCase() === path.basename(ref).toLowerCase());
  if (named) return { file: artifactPath(named.id), name: named.name, fromArtifact: true };
  return `There is no file "${ref}": give an artifact id (artifact_list shows them) or a path on this host.`;
}

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "autora-media-"));
}

function rm(dir: string) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function keep(call: MediaCall, name: string, data: Buffer, note: string): MediaFile {
  const art = saveArtifact({ origin: "agent", name: cleanName(name), data, mime: mimeFor(name), session: call.session, note });
  return { id: art.id, name: art.name, mime: art.mime, size: art.size };
}

const secs = (v: unknown): number | null => {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? v : null;
  const text = String(v).trim();
  const parts = text.split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  return parts.reduce((total, n) => total * 60 + n, 0);
};

const clock = (s: number) => {
  const t = Math.round(s);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  return `${h ? `${h}:${String(m).padStart(2, "0")}` : m}:${String(sec).padStart(2, "0")}`;
};

// --------------------------------------------------------------- info --

interface Probe {
  format?: { duration?: string; size?: string; format_long_name?: string; bit_rate?: string };
  streams?: Record<string, any>[];
}

async function probe(file: string): Promise<Probe | null> {
  const p = which("ffprobe");
  if (!p) return null;
  const r = await exec(p, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], { timeout: 60_000 });
  if (r.code !== 0) return null;
  try { return JSON.parse(r.out); } catch { return null; }
}

function describeProbe(name: string, pr: Probe): string {
  const lines = [name];
  const f = pr.format ?? {};
  const dur = Number(f.duration);
  lines.push(`${f.format_long_name ?? "unknown format"}${Number.isFinite(dur) && dur > 0 ? `, ${clock(dur)} long` : ""}${f.size ? `, ${formatSize(Number(f.size))}` : ""}${f.bit_rate ? `, ${Math.round(Number(f.bit_rate) / 1000)} kb/s` : ""}`);
  for (const s of pr.streams ?? []) {
    if (s.codec_type === "video") {
      const fps = typeof s.avg_frame_rate === "string" && s.avg_frame_rate.includes("/") ? (() => { const [a, b] = s.avg_frame_rate.split("/").map(Number); return b ? Math.round((a / b) * 100) / 100 : 0; })() : 0;
      lines.push(`video: ${s.codec_name}, ${s.width}x${s.height}${fps ? `, ${fps} fps` : ""}`);
    } else if (s.codec_type === "audio") {
      lines.push(`audio: ${s.codec_name}, ${s.channels ?? "?"} ch, ${s.sample_rate ?? "?"} Hz${s.tags?.language ? `, ${s.tags.language}` : ""}`);
    } else if (s.codec_type === "subtitle") {
      lines.push(`subtitles: ${s.codec_name}${s.tags?.language ? `, ${s.tags.language}` : ""}`);
    }
  }
  return lines.join("\n");
}

async function info(call: MediaCall, input: Input): Promise<MediaResult> {
  if (!which("ffprobe")) return missing("ffprobe (part of ffmpeg)", "inspecting media");
  const pr = await probe(input.file);
  if (!pr) return bad(`${input.name} is not media ffmpeg can read.`);
  return done({ ok: true, summary: describeProbe(input.name, pr), preview: input.name });
}

// ------------------------------------------------------------- frames --

async function frames(call: MediaCall, input: Input): Promise<MediaResult> {
  const ff = which("ffmpeg");
  if (!ff) return missing("ffmpeg", "taking frames");
  const pr = await probe(input.file);
  if (!pr) return bad(`${input.name} is not media ffmpeg can read.`);
  const dur = Number(pr.format?.duration) || 0;
  const isVideo = dur > 0.5;
  if (!(pr.streams ?? []).some((s) => s.codec_type === "video")) return bad(`${input.name} has no picture to take frames from.`);
  let times: number[] = [];
  const at = Array.isArray(call.args.at) ? call.args.at : call.args.at !== undefined ? [call.args.at] : [];
  if (at.length) times = at.map(secs).filter((t): t is number => t !== null);
  else if (!isVideo || dur === 0) times = [0];
  else {
    const n = Math.min(12, Math.max(1, Math.round(Number(call.args.count) || 6)));
    times = Array.from({ length: n }, (_, i) => (dur * (i + 0.5)) / n);
  }
  times = times.slice(0, 12);
  if (!times.length) return bad("at needs times in seconds or as m:ss.");
  const width = Math.min(1600, Math.max(160, Math.round(Number(call.args.width) || 960)));
  const dir = tmp();
  try {
    const images: MediaImage[] = [];
    for (const t of times) {
      if (call.cancelled?.()) break;
      const out = path.join(dir, `f-${images.length}.jpg`);
      const r = await exec(ff, ["-v", "error", "-ss", String(t), "-i", input.file, "-frames:v", "1", "-vf", `scale='min(${width},iw)':-2`, "-q:v", "3", "-y", out], { timeout: 60_000, onCancel: call.onCancel });
      if (r.code === 0 && fs.existsSync(out)) images.push({ name: `${path.parse(input.name).name}-${clock(t).replace(":", "m")}s.jpg`, data: fs.readFileSync(out), mime: "image/jpeg" });
    }
    if (!images.length) return bad(`No frame could be taken from ${input.name}.`);
    return done({
      ok: true,
      summary: `${images.length} frame${images.length === 1 ? "" : "s"} from ${input.name}, at ${times.slice(0, images.length).map(clock).join(", ")}: shown in this result.`,
      preview: `${images.length} frames`,
      images,
    });
  } finally {
    rm(dir);
  }
}

// -------------------------------------------------------------- audio --

async function toSpeech(call: MediaCall, input: Input, dir: string, start: number | null, end: number | null): Promise<string | MediaResult> {
  const ff = which("ffmpeg");
  if (!ff) return missing("ffmpeg", "preparing audio");
  const out = path.join(dir, "speech.mp3");
  const args = ["-v", "error", ...(start !== null ? ["-ss", String(start)] : []), ...(end !== null ? ["-to", String(end)] : []), "-i", input.file, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", "-y", out];
  const r = await exec(ff, args, { onCancel: call.onCancel });
  if (r.code !== 0 || !fs.existsSync(out)) return bad(`${input.name} has no audio ffmpeg could read${r.err ? `: ${r.err.trim().split("\n").slice(-1)[0]}` : "."}`);
  return out;
}

async function extractAudio(call: MediaCall, input: Input): Promise<MediaResult> {
  const ff = which("ffmpeg");
  if (!ff) return missing("ffmpeg", "extracting audio");
  const format = ["mp3", "wav", "m4a", "ogg", "flac"].includes(String(call.args.format ?? "mp3")) ? String(call.args.format ?? "mp3") : "mp3";
  const dir = tmp();
  try {
    const out = path.join(dir, `audio.${format}`);
    const r = await exec(ff, ["-v", "error", "-i", input.file, "-vn", ...(format === "mp3" ? ["-b:a", "128k"] : []), "-y", out], { onCancel: call.onCancel });
    if (r.code !== 0 || !fs.existsSync(out)) return bad(`No audio could be taken from ${input.name}${r.err ? `: ${r.err.trim().split("\n").slice(-1)[0]}` : "."}`);
    const data = fs.readFileSync(out);
    if (data.byteLength > MAX_ARTIFACT_BYTES) return bad(`The audio is ${formatSize(data.byteLength)}, over the ${formatSize(MAX_ARTIFACT_BYTES)} a file may be here.`);
    const file = keep(call, String(call.args.output ?? "").trim() || `${path.parse(input.name).name}.${format}`, data, `Audio from ${input.name}`);
    return done({ ok: true, summary: `Saved the audio as ${file.name} (${formatSize(file.size)}), artifact ${file.id}.`, preview: file.name, files: [file] });
  } finally {
    rm(dir);
  }
}

// --------------------------------------------------------- transcribe --

interface Segment { start: number; end: number; text: string }

async function viaDeepgram(call: MediaCall, key: string, audio: Buffer, language: string | null): Promise<Segment[] | string> {
  const f = call.fetchImpl ?? fetch;
  const q = new URLSearchParams({ model: "nova-2", smart_format: "true", utterances: "true", punctuate: "true" });
  if (language) q.set("language", language); else q.set("detect_language", "true");
  const res = await f(`https://api.deepgram.com/v1/listen?${q}`, { method: "POST", headers: { Authorization: `Token ${key}`, "Content-Type": "audio/mpeg" }, body: new Uint8Array(audio) });
  if (!res.ok) return `Deepgram answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`;
  const data: any = await res.json();
  const utterances = data?.results?.utterances;
  if (Array.isArray(utterances) && utterances.length) return utterances.map((u: any) => ({ start: Number(u.start) || 0, end: Number(u.end) || 0, text: String(u.transcript ?? "").trim() })).filter((s: Segment) => s.text);
  const text = data?.results?.channels?.[0]?.alternatives?.[0]?.transcript;
  return text ? [{ start: 0, end: 0, text: String(text) }] : "Deepgram heard no speech.";
}

async function viaWhisper(call: MediaCall, key: string, audio: Buffer, language: string | null): Promise<Segment[] | string> {
  const f = call.fetchImpl ?? fetch;
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type: "audio/mpeg" }), "speech.mp3");
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");
  if (language) form.append("language", language.slice(0, 2));
  const res = await f("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form });
  if (!res.ok) return `OpenAI answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`;
  const data: any = await res.json();
  if (Array.isArray(data.segments) && data.segments.length) return data.segments.map((s: any) => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, text: String(s.text ?? "").trim() })).filter((s: Segment) => s.text);
  return data.text ? [{ start: 0, end: 0, text: String(data.text) }] : "No speech was heard.";
}

async function transcribe(call: MediaCall, input: Input): Promise<MediaResult> {
  const { deepgram, openai } = call.keys;
  if (!deepgram && !openai) {
    return bad("There is no speech service to transcribe with. Paste a Deepgram API key (or an OpenAI one) in Settings, or set DEEPGRAM_API_KEY, and try again.");
  }
  const dir = tmp();
  try {
    const start = secs(call.args.start), end = secs(call.args.end);
    const prepared = await toSpeech(call, input, dir, start, end);
    if (typeof prepared !== "string") return prepared;
    const audio = fs.readFileSync(prepared);
    const language = typeof call.args.language === "string" && call.args.language.trim() ? call.args.language.trim() : null;
    if (!deepgram && audio.byteLength > 24 * 1024 * 1024) {
      return bad(`The speech is ${formatSize(audio.byteLength)} once shrunk, over the 25 MB OpenAI takes. Give a start and end to do it in parts, or set a Deepgram key, which has no such limit.`);
    }
    if (call.cancelled?.()) return bad("Stopped.");
    const got = deepgram ? await viaDeepgram(call, deepgram, audio, language) : await viaWhisper(call, openai, audio, language);
    if (typeof got === "string") return bad(got);
    const offset = start ?? 0;
    const lines = got.map((s) => (s.end > 0 || s.start > 0 ? `[${clock(s.start + offset)}] ${s.text}` : s.text));
    const text = lines.join("\n");
    const file = keep(call, `${path.parse(input.name).name}-transcript.txt`, Buffer.from(text, "utf8"), `Transcript of ${input.name}`);
    const room = 14_000;
    const shown = text.length > room ? `${text.slice(0, room)}\n... (${text.length - room} more characters; the whole transcript is the saved file)` : text;
    return done({ ok: true, summary: `Transcript of ${input.name} (${got.length} segments), saved as ${file.name}, artifact ${file.id}:\n\n${shown}`, preview: `${got.length} segments`, files: [file] });
  } finally {
    rm(dir);
  }
}

// ---------------------------------------------------------------- ocr --

async function ocr(call: MediaCall, input: Input): Promise<MediaResult> {
  const tess = which("tesseract");
  const lang = typeof call.args.language === "string" && /^[a-z]{3}(\+[a-z]{3})*$/.test(call.args.language) ? call.args.language : "eng";
  const dir = tmp();
  try {
    const isPdf = fs.readFileSync(input.file).subarray(0, 1024).includes("%PDF-");
    const pictures: { label: string; file: string; data: Buffer }[] = [];
    if (isPdf) {
      if (!call.pdfPages) return bad("Reading a scanned PDF needs the PDF renderer, which is not available here.");
      const pages = String(call.args.pages ?? "1").split(",").flatMap((part) => {
        const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part);
        if (!m) return [];
        const a = Number(m[1]), b = m[2] ? Number(m[2]) : a;
        return Array.from({ length: Math.min(10, Math.max(0, b - a + 1)) }, (_, i) => a + i);
      }).slice(0, 10);
      if (!pages.length) return bad("pages is like 1, 1-3 or 2,4 (at most 10 at a time).");
      const rendered = await call.pdfPages(fs.readFileSync(input.file), pages, tess ? 3 : 2);
      for (const r of rendered) {
        const file = path.join(dir, `p${r.page}.png`);
        fs.writeFileSync(file, r.png);
        pictures.push({ label: `page ${r.page}`, file, data: r.png });
      }
    } else {
      pictures.push({ label: input.name, file: input.file, data: fs.readFileSync(input.file) });
    }
    if (!pictures.length) return bad("Nothing could be read from that file.");
    if (!tess) {
      const images = pictures.slice(0, 4).map((p) => ({ name: p.label, data: p.data, mime: p.label.endsWith(".png") || p.file.endsWith(".png") ? "image/png" : mimeFor(p.file) }));
      return done({
        ok: true,
        summary: `Tesseract (OCR) is not installed here, so there is no machine transcription. The ${images.length === 1 ? "picture is" : "pictures are"} in this result: read the text from ${images.length === 1 ? "it" : "them"} yourself, and say that it was read by eye, not by OCR.`,
        preview: "no OCR: pictures returned",
        images,
      });
    }
    const out: string[] = [];
    for (const p of pictures) {
      if (call.cancelled?.()) break;
      const r = await exec(tess, [p.file, "stdout", "-l", lang, "--psm", String(call.args.layout === "single" ? 6 : 3)], { timeout: 120_000, onCancel: call.onCancel });
      if (r.code !== 0) return bad(`Tesseract failed on ${p.label}: ${r.err.trim().split("\n").slice(-1)[0] || "unknown error"}`);
      out.push(pictures.length > 1 ? `--- ${p.label} ---\n${r.out.trim()}` : r.out.trim());
    }
    const text = out.join("\n\n");
    if (!text.trim()) return done({ ok: true, summary: "No text was found. If the picture is a photo of something with writing at an angle, try a straighter or larger shot.", preview: "no text" });
    const room = 14_000;
    return done({ ok: true, summary: text.length > room ? `${text.slice(0, room)}\n... (${text.length - room} more characters)` : text, preview: `${text.length} characters` });
  } finally {
    rm(dir);
  }
}

// ----------------------------------------------------- trim / convert --

const OUT_FORMATS = new Set(["mp4", "webm", "mov", "mkv", "mp3", "wav", "m4a", "ogg", "flac", "gif", "png", "jpg", "webp"]);

async function transform(call: MediaCall, input: Input, mode: "trim" | "convert"): Promise<MediaResult> {
  const ff = which("ffmpeg");
  if (!ff) return missing("ffmpeg", mode === "trim" ? "trimming" : "converting");
  const a = call.args;
  const srcExt = path.extname(input.name).slice(1).toLowerCase();
  const format = String(a.format ?? (mode === "trim" ? srcExt : "")).toLowerCase().replace(/^\./, "");
  if (!OUT_FORMATS.has(format)) return bad(`format is one of: ${[...OUT_FORMATS].join(", ")}.`);
  const args = ["-v", "error"];
  const start = secs(a.start), end = secs(a.end);
  if (mode === "trim") {
    if (start === null && end === null) return bad("trim needs a start, an end, or both (seconds or m:ss).");
    if (start !== null && end !== null && end <= start) return bad("end must be after start.");
    if (start !== null) args.push("-ss", String(start));
    if (end !== null) args.push("-to", String(end));
  }
  args.push("-i", input.file);
  const filters: string[] = [];
  const width = Number(a.width), height = Number(a.height);
  if (Number.isFinite(width) && width > 0 || Number.isFinite(height) && height > 0) {
    filters.push(`scale=${width > 0 ? Math.min(7680, Math.round(width)) : -2}:${height > 0 ? Math.min(4320, Math.round(height)) : -2}`);
  }
  const c = a.crop;
  if (c && typeof c === "object" && [c.x, c.y, c.width, c.height].every((n: unknown) => Number.isFinite(Number(n)))) {
    filters.unshift(`crop=${Math.round(c.width)}:${Math.round(c.height)}:${Math.round(c.x)}:${Math.round(c.y)}`);
  }
  const rot = Number(a.rotate);
  if (rot === 90) filters.push("transpose=1"); else if (rot === 270 || rot === -90) filters.push("transpose=2"); else if (rot === 180) filters.push("hflip,vflip");
  const fps = Number(a.fps);
  if (Number.isFinite(fps) && fps > 0 && ["mp4", "webm", "gif", "mov", "mkv"].includes(format)) filters.push(`fps=${Math.min(60, fps)}`);
  const audioOnly = ["mp3", "wav", "m4a", "ogg", "flac"].includes(format);
  const image = ["png", "jpg", "webp"].includes(format);
  if (filters.length && !audioOnly) args.push("-vf", filters.join(","));
  if (audioOnly) args.push("-vn");
  if (image) args.push("-frames:v", "1");
  args.push("-y");
  const dir = tmp();
  try {
    const out = path.join(dir, `out.${format}`);
    const r = await exec(ff, [...args, out], { onCancel: call.onCancel });
    if (r.code !== 0 || !fs.existsSync(out)) return bad(`ffmpeg could not do that${r.err ? `: ${r.err.trim().split("\n").slice(-1)[0]}` : "."}`);
    const data = fs.readFileSync(out);
    if (data.byteLength > MAX_ARTIFACT_BYTES) return bad(`The result is ${formatSize(data.byteLength)}, over the ${formatSize(MAX_ARTIFACT_BYTES)} a file may be here. Trim it shorter or scale it down.`);
    const name = String(a.output ?? "").trim() || `${path.parse(input.name).name}-${mode === "trim" ? "trimmed" : "converted"}.${format}`;
    const file = keep(call, /\.\w+$/.test(name) ? name : `${name}.${format}`, data, `${mode === "trim" ? "Trimmed" : "Converted"} from ${input.name}`);
    return done({ ok: true, summary: `Saved ${file.name} (${formatSize(file.size)}), artifact ${file.id}.`, preview: file.name, files: [file] });
  } finally {
    rm(dir);
  }
}

// ----------------------------------------------------------- the tool --

export async function runMedia(call: MediaCall): Promise<MediaResult> {
  const action = String(call.args.action ?? "").trim().toLowerCase();
  if (!["info", "frames", "audio", "transcribe", "ocr", "trim", "convert"].includes(action)) {
    return bad("action is info, frames, audio, transcribe, ocr, trim or convert.");
  }
  const input = resolveInput(call);
  if (typeof input === "string") return bad(input);
  try {
    switch (action) {
      case "info": return await info(call, input);
      case "frames": return await frames(call, input);
      case "audio": return await extractAudio(call, input);
      case "transcribe": return await transcribe(call, input);
      case "ocr": return await ocr(call, input);
      case "trim": return await transform(call, input, "trim");
      default: return await transform(call, input, "convert");
    }
  } catch (err: any) {
    return bad(String(err?.message ?? err).split("\n")[0]);
  }
}

// Kept for callers that only need to know what is installed.
export function mediaTools(): { ffmpeg: boolean; tesseract: boolean } {
  return { ffmpeg: Boolean(which("ffmpeg")), tesseract: Boolean(which("tesseract")) };
}

