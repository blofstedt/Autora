/**
 * Replay a chat's recorded events against the loop watch and error budget.
 *
 *   npx tsx scripts/replay.ts events.json [warnAt=3 stopAt=8 stallAfter=8 ...]
 *
 * `events.json` is the session's events array (what GET /api/sessions/:id
 * returns under `events`, or the array itself). Extra arguments override the
 * loop-watch knobs, so two settings can be compared on the same chat.
 */
import fs from "node:fs";
import { replay, replayText } from "../server/replay";
import { looksOnly } from "../server/modes";

const [file, ...rest] = process.argv.slice(2);
if (!file) {
  console.error("usage: tsx scripts/replay.ts events.json [warnAt=3 stopAt=8 staleAfter=10 checkEvery=20 stallAfter=8]");
  process.exit(2);
}
const raw = JSON.parse(fs.readFileSync(file, "utf8"));
const events = Array.isArray(raw) ? raw : raw.events;
if (!Array.isArray(events)) {
  console.error("no events array found in the file");
  process.exit(2);
}
const config: Record<string, number> = {};
for (const arg of rest) {
  const [k, v] = arg.split("=");
  if (k && Number.isFinite(Number(v))) config[k] = Number(v);
}
console.log(replayText(replay(events, config, {}, looksOnly)));
