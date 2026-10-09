/**
 * The memory graph: recall by meaning, no near-copies, learned is not known
 * until confirmed, and housekeeping.
 *
 *   npx tsx tests/memory.test.ts
 */
import assert from "node:assert/strict";
import { MemoryGraph, doubtNote, freshness, siteOf, similarity, tokens, type MemoryRecord } from "../server/memory";

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    throw err;
  }
}

function graph() {
  let saves = 0;
  const g = new MemoryGraph([], [], () => { saves += 1; });
  return { g, saves: () => saves };
}

console.log("memory");

test("words are compared without stop words or endings", () => {
  assert.deepEqual(tokens("Restarting the containers"), ["restart", "container"]);
  assert.ok(similarity("restart the docker containers", "restarting docker container") > 0.9);
});

test("recall ranks by the request, not by age or use", () => {
  const { g } = graph();
  const old = g.write({ title: "Backups go to the NAS", body: "The nightly backup writes to /mnt/nas/backups via rsync." }).record;
  old.uses = 50;
  g.write({ title: "Restart the media server", body: "docker restart jellyfin fixes a stuck library scan." });
  const hits = g.recall("jellyfin library scan is stuck again");
  assert.equal(hits[0].record.title, "Restart the media server");
  assert.ok(!hits.some((h) => h.record === old), "an unrelated memory is not recalled for its use count");
  assert.match(hits[0].reason, /matched/);
});

test("pinned memories are always recalled, and say why", () => {
  const { g } = graph();
  const pin = g.write({ title: "Answer in British English", body: "Colour, not color.", kind: "preference" }).record;
  g.update(pin.id, { pinned: true });
  const hits = g.recall("what is the weather");
  assert.equal(hits.length, 1);
  assert.match(hits[0].reason, /pinned/);
  assert.equal(g.recall("what is the weather", 6, false).length, 0);
});

test("writing a near-copy updates the original", () => {
  const { g } = graph();
  const first = g.write({ title: "Media server restart", body: "docker restart jellyfin", kind: "procedure" });
  const again = g.write({ title: "Media server restart", body: "docker restart jellyfin && docker logs jellyfin", kind: "procedure" });
  assert.equal(first.action, "added");
  assert.equal(again.action, "merged");
  assert.equal(g.records.length, 1);
  assert.match(g.records[0].body, /docker logs/);
});

test("a learned rewrite of a confirmed memory waits to be kept", () => {
  const { g } = graph();
  const known = g.write({ title: "Backup location", body: "Backups are written to /mnt/nas/backups every night at 3.", kind: "fact" }).record;
  const learned = g.write({
    title: "Backup location", body: "Backups moved to /mnt/usb/backups; the NAS share is gone.", kind: "fact", status: "provisional",
  });
  assert.equal(learned.action, "proposed");
  assert.equal(learned.record.replaces, known.id);
  assert.equal(known.superseded_by, null, "the confirmed one stands until the rewrite is kept");
  g.confirm(learned.record.id);
  assert.equal(known.superseded_by, learned.record.id);
  assert.deepEqual(g.active().map((r) => r.id), [learned.record.id]);
});

test("learning the same thing again counts as it having worked", () => {
  const { g } = graph();
  const known = g.write({ title: "Restart jellyfin", body: "docker restart jellyfin fixes a stuck scan", kind: "procedure" }).record;
  const again = g.write({ title: "Restart jellyfin", body: "docker restart jellyfin fixes a stuck scan", kind: "procedure", status: "provisional" });
  assert.equal(again.action, "reinforced");
  assert.equal(known.worked, 1);
  assert.equal(g.records.length, 1);
});

test("an unconfirmed memory that keeps working is confirmed, and a procedure promoted", () => {
  const { g } = graph();
  const r = g.write({ title: "Clear the cache", body: "rm -rf ~/.cache/app then restart it", kind: "procedure", status: "provisional" }).record;
  assert.equal(g.reinforce(r.id), null);
  assert.equal(g.reinforce(r.id), "confirmed");
  assert.equal(r.status, "confirmed");
  assert.ok(!r.tags.includes("learned"));
  assert.equal(g.reinforce(r.id), "promoted");
  assert.ok(r.tags.includes("proven"));
  assert.equal(r.pinned, false, "proven is not pinned: it is recalled only when it is relevant");
  assert.equal(g.recall("what is the weather in paris").length, 0);
  assert.equal(g.recall("the app cache is broken, clear it")[0]?.record.id, r.id);
});

test("an unrelated skill is not recalled for sharing one word", () => {
  const { g } = graph();
  g.write({
    title: "Deploy the blog", kind: "procedure", tags: ["skill"],
    body: "Build the site, copy the files to the server over rsync, then purge the CDN cache.",
  });
  const rename = g.write({ title: "Rename photos by date", kind: "procedure", tags: ["skill", "photos"],
    body: "exiftool '-FileName<DateTimeOriginal' renames every photo in the folder." }).record;
  assert.equal(g.recall("move these files into a folder on the desktop please").some((h) => h.record.title === "Deploy the blog"), false);
  assert.equal(g.recall("which skill do i have").length, 0, "the bookkeeping tag matches nothing");
  assert.equal(g.recall("rename my photos")[0]?.record.id, rename.id);
});

test("procedures pinned by the old promotion are unpinned on load", () => {
  const base = { scope: "workspace", status: "confirmed" as const, source_session: null, source_seq: null, uses: 3, last_used: null, superseded_by: null, created: 1, updated: 1 };
  const records: MemoryRecord[] = [
    { ...base, id: "p", kind: "procedure", title: "Clear the cache", body: "rm -rf ~/.cache/app", tags: ["proven"], pinned: true },
    { ...base, id: "q", kind: "preference", title: "British English", body: "Colour", tags: [], pinned: true },
  ];
  const g = new MemoryGraph(records, []);
  assert.equal(g.get("p")?.pinned, false);
  assert.equal(g.get("q")?.pinned, true, "what the person pinned stays pinned");
});

test("new memories are linked to related ones", () => {
  const { g } = graph();
  const a = g.write({ title: "Jellyfin runs in docker", body: "The jellyfin container serves the media library.", tags: ["jellyfin"] }).record;
  const b = g.write({ title: "Jellyfin library path", body: "The media library for jellyfin is /mnt/media.", tags: ["jellyfin"] }).record;
  assert.ok(g.links.some((l) => l.src === b.id && l.dst === a.id));
});

test("a link joins memories about the same thing, not ones that share a tag or a common word", () => {
  const { g } = graph();
  const notes = [
    ["Kia EV5 Canada: only the Win trim qualifies", "The Kia EV5 in Canada gets the federal EV incentive only on the Win trim.", ["autora", "canada"]],
    ["Canada ev incentives: federal rebate", "The Canada federal EV rebate caps the price of an eligible electric vehicle.", ["autora", "canada"]],
    ["Autora vendor balance endpoint", "Autora reads each vendor's balance from the vendor's balance endpoint.", ["autora"]],
    ["Autora spend bar shows one vendor", "The Autora spend bar shows the vendor balance, one bar per vendor.", ["autora"]],
    ["Job search: reliable LinkedIn", "Autora can read LinkedIn job search results reliably in Canada.", ["autora", "canada"]],
  ] as const;
  // Enough other memories that "autora" is a word in most of them and says nothing.
  for (let i = 0; i < 14; i += 1) g.write({ title: `Autora note ${i}`, body: `Autora detail number ${i} about topic${i} and thing${i}.`, tags: ["autora"] });
  const made = notes.map(([title, body, tags]) => g.write({ title, body, tags: [...tags] }).record);
  const linked = (a: string, b: string) => g.links.some((l) => (l.src === a && l.dst === b) || (l.src === b && l.dst === a));
  assert.ok(linked(made[0].id, made[1].id), "two Canadian EV notes are tied");
  assert.ok(linked(made[2].id, made[3].id), "the two vendor balance notes are tied");
  assert.ok(!linked(made[0].id, made[2].id), "a Kia note is not tied to a vendor balance note");
  assert.ok(!linked(made[0].id, made[4].id) || !linked(made[2].id, made[4].id), "one shared word or tag does not tie everything");
  for (const r of g.active()) assert.ok(g.links.filter((l) => l.src === r.id || l.dst === r.id).length <= 8, "no memory is tied to everything");
});

test("links drawn by the old rule are dropped and drawn again by what the memories say", () => {
  const base = { scope: "global", status: "confirmed" as const, pinned: false, source_session: null, source_seq: null, created: 1, updated: 1, uses: 0, last_used: null, superseded_by: null, tags: [] as string[] };
  const records: MemoryRecord[] = [
    { ...base, id: "a", kind: "fact", title: "Jellyfin runs in docker", body: "The jellyfin container serves the media library." },
    { ...base, id: "b", kind: "fact", title: "Jellyfin library path", body: "The media library for jellyfin is /mnt/media." },
    { ...base, id: "c", kind: "fact", title: "Birthday of the dog", body: "The dog was born in spring." },
  ];
  const links = [{ src: "a", dst: "c", rel: "related" }, { src: "b", dst: "c", rel: "related" }, { src: "a", dst: "b", rel: "revises" }];
  const g = new MemoryGraph(records, links);
  assert.ok(!g.links.some((l) => l.rel === "related"), "the old rule's links are gone");
  assert.ok(!g.links.some((l) => l.dst === "c" || l.src === "c"), "the dog is tied to neither");
  assert.ok(g.links.some((l) => l.rel === "revises"), "a real revision stays, and is not drawn a second time as a similarity");
  assert.equal(g.links.length, 1);
});

test("forgetting removes a memory and its links; replacing keeps history", () => {
  const { g } = graph();
  const a = g.write({ title: "Old router address", body: "The router is at 192.168.1.1 on the admin page", tags: ["router"] }).record;
  const b = g.write({ title: "New router address", body: "The router is at 10.0.0.1 on the admin page", tags: ["router"] }).record;
  g.forget(a.id, b.id);
  assert.equal(a.superseded_by, b.id);
  g.forget(b.id);
  assert.equal(g.get(b.id), undefined);
  assert.ok(!g.links.some((l) => l.src === b.id || l.dst === b.id));
});

test("housekeeping merges copies and drops stale unconfirmed guesses", () => {
  const records: MemoryRecord[] = [];
  const g = new MemoryGraph(records, []);
  const base = { scope: "workspace", tags: [], status: "confirmed" as const, pinned: false, source_session: null, source_seq: null, uses: 1, last_used: null, superseded_by: null };
  records.push(
    { ...base, id: "a", kind: "fact", title: "Printer IP", body: "The office printer is at 10.0.0.9", created: 1, updated: 1 },
    { ...base, id: "b", kind: "fact", title: "Printer IP", body: "The office printer is at 10.0.0.9", created: 2, updated: 2 },
    { ...base, id: "c", kind: "fact", title: "A guess", body: "Something learned once and never used", status: "provisional", uses: 0, created: 0, updated: 0 },
  );
  const out = g.consolidate(60 * 24 * 3600);
  assert.equal(out.merged, 1);
  assert.equal(out.dropped, 1);
  assert.equal(g.get("a")?.superseded_by, "b");
  assert.equal(g.get("c"), undefined);
});

test("the forms of a word are one word", () => {
  // The old endings cut "prices" to "pric" and left "price" alone.
  for (const forms of [
    ["price", "prices", "priced", "pricing"], ["file", "files"], ["trade", "trading", "trades"],
    ["update", "updated", "updates"], ["cookie", "cookies"], ["entry", "entries"], ["run", "running", "runs"],
    ["stop", "stopped", "stopping"], ["address", "addresses"], ["setting", "settings"],
  ]) {
    assert.equal(new Set(forms.map((f) => tokens(f).join(" "))).size, 1, forms.join("/"));
  }
  assert.deepEqual(tokens("status analysis"), ["status", "analysis"], "-us and -is are not plurals");
});

test("words in any script are words, and dotted names are found by their parts", () => {
  assert.deepEqual(tokens("Min portfölj"), ["min", "portfölj"]);
  assert.ok(tokens("Мой сервер").length === 2, "Cyrillic is not dropped");
  const t = tokens("see docker-jellyfin and https://github.com/x");
  assert.ok(t.includes("docker-jellyfin") && t.includes("jellyfin") && t.includes("github.com") && t.includes("github"));
  assert.ok(!t.includes("com") && !t.includes("https"), "the scheme and the TLD say nothing");
});

test("a memory about share prices is found by a question about the price", () => {
  const { g } = graph();
  const m = g.write({ title: "Share prices", body: "Quotes come from the stooq CSV endpoint, no key needed.", tags: ["stocks"] }).record;
  assert.equal(g.recall("what is the price of ASML")[0]?.record.id, m.id);
});

test("a short follow-up is recalled with the conversation before it", () => {
  const { g } = graph();
  const m = g.write({ title: "Restart jellyfin", body: "docker restart jellyfin fixes a stuck library scan.", kind: "procedure" }).record;
  const before = "the jellyfin library scan is stuck\nI can restart the jellyfin container, shall I?";
  assert.equal(g.recall("yes do it").length, 0, "the request alone says nothing");
  const hits = g.recallForTurn("yes do it", before);
  assert.equal(hits[0]?.record.id, m.id);
  assert.match(hits[0].reason, /conversation/);
  assert.equal(g.recallForTurn("and the other server?", before)[0]?.record.id, m.id);
  // A request with words of its own is recalled on those, not on the last subject.
  assert.equal(g.recallForTurn("what's the weather in paris", before).length, 0);
  assert.equal(g.recallForTurn("how many people live in france", before).length, 0);
});

test("a memory found wrong ranks lower and says so until it holds again", () => {
  const { g } = graph();
  const a = g.write({ title: "Backup path", body: "Backups go to /mnt/nas/backups nightly.", tags: ["backup"] }).record;
  const b = g.write({ title: "Backup schedule", body: "Backups run nightly at 3 to /mnt/nas.", tags: ["backup"] }).record;
  const first = g.recall("nightly backup")[0].record.id;
  g.doubt(first);
  assert.notEqual(g.recall("nightly backup")[0].record.id, first, "the doubted one drops below the other");
  assert.match(doubtNote(g.get(first)!) ?? "", /found wrong/);
  g.recheck(first);
  assert.equal(g.get(first)?.doubted, 0);
  assert.equal(doubtNote(g.get(first)!), null);
  g.doubt(a.id);
  g.reinforce(a.id);
  assert.equal(a.doubted, 0, "working again clears it");
  g.doubt(b.id);
  g.update(b.id, { body: "Backups run nightly at 4 to /mnt/usb." });
  assert.equal(b.doubted, 0, "a rewrite is a new claim");
});

test("what is written down about a site is found by the site", () => {
  const { g } = graph();
  const login = g.write({ title: "Avanza login", body: "Sign in at www.avanza.se with BankID; the password form is a trap.", kind: "procedure" }).record;
  const gh = g.write({ title: "GitHub tokens", body: "Use the fine-grained token in the vault.", tags: ["github"] }).record;
  g.write({ title: "Router", body: "The router is at 192.168.1.1" });
  assert.equal(siteOf("shop.example.co.uk:8080"), "example.co.uk");
  assert.equal(siteOf("192.168.1.1"), "");
  assert.equal(siteOf("localhost"), "");
  assert.deepEqual(g.aboutSite("www.avanza.se").map((m) => m.id), [login.id]);
  assert.deepEqual(g.aboutSite("api.github.com").map((m) => m.id), [gh.id], "by the site's name in the tags");
  assert.deepEqual(g.aboutSite("api.github.com", new Set([gh.id])), [], "already given this turn");
  assert.deepEqual(g.aboutSite("notgithub.com"), []);
});

test("new tags are lowercased and keep the bookkeeping", () => {
  const { g } = graph();
  const r = g.write({ title: "A guess", body: "Something learned from a turn", status: "provisional" }).record;
  g.update(r.id, { tags: ["Jellyfin", "jellyfin"] });
  assert.deepEqual(r.tags, ["jellyfin", "learned"]);
});

test("a reference keeps where and when it was read, and is found by its site and its subject", () => {
  const { g } = graph();
  const { record } = g.write({
    title: "GitHub: where repository settings are", body: "Settings tab on the repository page.", kind: "reference",
    subject: "github", facet: "interface", source: "https://docs.github.com/en/repositories",
  });
  assert.equal(record.subject, "github");
  assert.ok(record.fetched && record.fetched > 0);
  g.write({ title: "Cooking: pasta", body: "Boil it." });
  assert.deepEqual(g.referencesFor("github.com").map((r) => r.id), [record.id]);
  assert.deepEqual(g.referencesFor("gist.github.com").map((r) => r.id), [record.id], "a subdomain is the same site");
  assert.deepEqual(g.referencesFor("example.com"), []);
  assert.equal(g.aboutSite("github.com")[0].id, record.id, "what was read from the site's docs comes first");
});

test("what is held about a site is none, old or fresh, at the pace of its facet", () => {
  const { g } = graph();
  assert.equal(g.groundingOf("acme.com"), "none");
  const { record } = g.write({ title: "Acme: menu", body: "Top left.", kind: "reference", subject: "acme", facet: "interface", source: "https://acme.com/help" });
  assert.equal(g.groundingOf("acme.com"), "fresh");
  const day = 86400, t = Math.floor(Date.now() / 1000);
  record.fetched = t - 30 * day;
  assert.equal(g.groundingOf("acme.com"), "stale", "an interface read 30 days ago is past 21");
  record.facet = "docs";
  assert.equal(g.groundingOf("acme.com"), "fresh", "docs are trusted for 90 days");
  record.fetched = t - 100 * day;
  assert.match(freshness(record, t) ?? "", /read from its source 100 days ago/);
  g.update(record.id, { body: "Top right, since the redesign." });
  assert.equal(g.groundingOf("acme.com"), "fresh", "rewriting it from the source reads as read today");
  assert.equal(freshness(g.get(record.id)!, t), null);
});

test("a reference is a kind the mind can hold and edit", () => {
  const { g } = graph();
  const { record } = g.write({ title: "Acme: api", body: "POST /v1.", kind: "reference", subject: "acme", source: "https://acme.com/api" });
  const r = g.update(record.id, { subject: "Acme Cloud", facet: "api", version: "2" })!;
  assert.equal(r.subject, "acme cloud");
  assert.equal(r.facet, "api");
  assert.equal(r.version, "2");
});

console.log(`${passed} passed`);
