/**
 * What to suggest: the things this install could do for the person, worked
 * out from what is actually here rather than from a list of examples.
 *
 * The hardest thing about an agent is knowing what to ask it. A new chat used
 * to open on four fixed examples -- a Hacker News summary, a made-up site to
 * watch -- which say what an agent is in general and nothing about what this
 * one can do for this person. Everything here is read from the install
 * instead: the disk it is on, the apps running beside it, the sites its browser
 * is signed in to, what it remembers about the person, what is scheduled and
 * how that went. No model is asked, so a suggestion costs nothing to make, and
 * a suggestion with nothing behind it is not made: an empty list is an honest
 * answer, and the chat then falls back to the examples.
 *
 * Three kinds, all pure so they can be tested without a machine:
 *
 *  - starters: one-tap tasks for an empty chat;
 *  - offers: a schedule worth setting up, asked once and never again;
 *  - next steps: what to do after a turn -- watching a page it read, plus
 *    the follow-ups the look back thought of.
 *
 * Every task here reports and changes nothing, and nothing outward-facing is
 * ever suggested: a message, a post or a purchase is the person's to start.
 */

export interface Container {
  name: string;
  /** Docker's own word: running, restarting, exited, paused... */
  state: string;
  /** "Up 3 hours (unhealthy)", "Restarting (1) 5 seconds ago". */
  status: string;
}

/** A memory, as much of one as suggesting needs. */
export interface KnownThing {
  id: string;
  kind: string;
  title: string;
  body: string;
  tags: string[];
  status: string;
  worked: number;
  uses: number;
  last_used: number | null;
}

export interface JobBrief {
  id: string;
  name: string;
  prompt: string;
  cron: string;
  enabled: boolean;
  last_error: string | null;
  /** Whether its latest run went wrong. */
  failed: boolean;
}

/** Everything a suggestion may be made from. */
export interface Signals {
  disk: { used: number; total: number } | null;
  /** Null when Docker cannot be reached: not the same as no containers. */
  containers: Container[] | null;
  /** Sites the browser is signed in to, "github.com" style. */
  signIns: string[];
  memories: KnownThing[];
  jobs: JobBrief[];
  tools: { terminal: boolean; browser: boolean; customTools: boolean };
}

export interface Suggestion {
  key: string;
  /** What the card says: short, and in the person's voice. */
  title: string;
  /** Why this one, in a few words, for the line under it. */
  why: string;
  /** What is sent when it is tapped. */
  prompt: string;
}

/** Report, never act: said at the end of every prompt that looks at something. */
const HANDS_OFF = "Report only; change nothing, and send nothing.";

// --------------------------------------------------------------- subjects --

/** Words that say a memory is about investing. */
const MONEY = /\b(stocks?|shares?|portfolio|watchlist|tickers?|etfs?|dividends?|invest\w*|brokers?|holdings?|crypto|bitcoin|nasdaq|s&p)\b/i;

/** Whether what is remembered says the person follows investments. */
export function followsMarkets(memories: KnownThing[]): boolean {
  return memories.some((m) => m.tags.some((t) => MONEY.test(t)) || MONEY.test(m.title) || MONEY.test(m.body));
}

/** Whether a job already covers a subject, by the words in its name and task. */
function covered(jobs: JobBrief[], words: RegExp): boolean {
  return jobs.some((j) => j.enabled && (words.test(j.name) || words.test(j.prompt)));
}

/** A site, as the thing people call it, when it is one worth a task. */
const SITE_TASKS: { sites: RegExp; key: string; title: string; why: string; prompt: string }[] = [
  {
    sites: /^(google\.com|gmail\.com)$/,
    key: "site:gmail",
    title: "Summarize my unread email",
    why: "The browser is signed in to Google.",
    prompt:
      "Open Gmail in the browser and summarize my unread email from the last day: who it is from, " +
      "what it is about, and which ones need a reply. Draft nothing and send nothing.",
  },
  {
    sites: /^github\.com$/,
    key: "site:github",
    title: "What needs me on GitHub?",
    why: "The browser is signed in to GitHub.",
    prompt:
      "Open my GitHub notifications in the browser and tell me what needs my attention: review " +
      `requests, mentions, and failing checks on my pull requests. ${HANDS_OFF}`,
  },
  {
    sites: /^linkedin\.com$/,
    key: "site:linkedin",
    title: "Anything new on LinkedIn?",
    why: "The browser is signed in to LinkedIn.",
    prompt:
      "Check my LinkedIn messages and notifications in the browser and tell me which are worth a " +
      "reply. Send nothing and accept nothing.",
  },
  {
    sites: /^amazon\.[a-z.]+$/,
    key: "site:amazon",
    title: "Where are my orders?",
    why: "The browser is signed in to Amazon.",
    prompt: `Check my recent Amazon orders in the browser and tell me what is arriving when. ${HANDS_OFF}`,
  },
  {
    sites: /^youtube\.com$/,
    key: "site:youtube",
    title: "What's new from my subscriptions?",
    why: "The browser is signed in to YouTube.",
    prompt: "Open my YouTube subscriptions in the browser and list what is new since yesterday, one line each.",
  },
];

/** How full a disk is, as a whole percentage. */
const percent = (d: { used: number; total: number }) => Math.round((d.used / Math.max(1, d.total)) * 100);

/** A container in trouble: restarting, or up but failing its health check. */
export function troubled(c: Container): "restarting" | "unhealthy" | null {
  if (c.state === "restarting" || /^restarting/i.test(c.status)) return "restarting";
  if (/\(unhealthy\)/i.test(c.status)) return "unhealthy";
  return null;
}

// --------------------------------------------------------------- starters --

/** The card that asks the agent itself: always offered, last. */
export const DISCOVER: Suggestion = {
  key: "discover",
  title: "What could you do for me?",
  why: "It looks around and suggests.",
  prompt:
    "Look at what you can do on this machine, what the browser is signed in to, what is scheduled " +
    "and what you remember about me, and suggest five specific things you could do for me -- ones " +
    "you could start right now, each with a one-line reason. Do not start any of them yet.",
};

/**
 * One-tap tasks for an empty chat, most pressing first.
 *
 * Something going wrong comes before something that could be nice: a disk
 * nearly full, an app that keeps restarting, a schedule that failed. Then what
 * the person follows and what the agent has done for them before, then the
 * sites it can reach. At most `limit`, and DISCOVER is not counted -- it is
 * added by the caller, after these, whether or not there are any.
 */
export function starters(s: Signals, limit = 4): Suggestion[] {
  const out: Suggestion[] = [];
  const add = (x: Suggestion) => {
    if (out.length < limit && !out.some((o) => o.key === x.key)) out.push(x);
  };

  if (s.tools.terminal && s.disk && s.disk.used / s.disk.total >= 0.85) {
    add({
      key: "disk",
      title: `Find what's filling the disk (${percent(s.disk)}% full)`,
      why: "The disk is nearly full.",
      prompt:
        `The disk is ${percent(s.disk)}% full. Find the biggest folders and files on it, and tell me ` +
        "what is safe to clear and how much it would free. Delete nothing yet.",
    });
  }

  if (s.tools.terminal) {
    for (const c of s.containers ?? []) {
      const trouble = troubled(c);
      if (!trouble) continue;
      add({
        key: `container:${c.name}`,
        title: trouble === "restarting" ? `Why does ${c.name} keep restarting?` : `Why is ${c.name} unhealthy?`,
        why: `Docker says: ${c.status}.`,
        prompt:
          `The container ${c.name} is ${trouble === "restarting" ? "restarting over and over" : "failing its health check"} ` +
          `(${c.status}). Read its logs, find out why, and tell me what would fix it. Change nothing yet.`,
      });
    }
  }

  for (const job of s.jobs) {
    if (!job.enabled || !job.failed) continue;
    add({
      key: `job:${job.id}`,
      title: `Fix “${job.name}”`,
      why: "It failed on its last run.",
      prompt:
        `My scheduled task “${job.name}” failed on its last run` +
        `${job.last_error ? ` with: ${job.last_error.slice(0, 300)}` : ""}. Find out why, and fix the task ` +
        "if the fix is in the task itself; otherwise tell me what is wrong.",
    });
  }

  if (followsMarkets(s.memories)) {
    add({
      key: "markets",
      title: "How are my stocks doing today?",
      why: "You've told me what you follow.",
      prompt:
        "Look up what you know about my holdings and watchlist (memory_search), check today's price " +
        "move and any news for each, and give me a short brief with the biggest movers first. Buy " +
        "nothing and sell nothing.",
    });
  }

  /* Something it has done for them before, that worked: the most useful
     "again" there is, and a reminder that it remembers how. */
  const again = s.memories
    .filter((m) => m.kind === "procedure" && m.status === "confirmed" && (m.worked > 0 || m.uses >= 2))
    .sort((a, b) => (b.last_used ?? 0) - (a.last_used ?? 0))[0];
  if (again) {
    add({
      key: `again:${again.id}`,
      title: `Do “${again.title}” again`,
      why: "It worked before, and I remember how.",
      prompt: `Do “${again.title}” again, the way that worked last time (it is in your memory as ${again.id}), and tell me how it went.`,
    });
  }

  if (s.tools.browser) {
    for (const site of s.signIns) {
      const task = SITE_TASKS.find((t) => t.sites.test(site));
      if (task) add({ key: task.key, title: task.title, why: task.why, prompt: task.prompt });
    }
  }

  if (s.tools.terminal && s.containers && s.containers.length > 0) {
    add({
      key: "containers",
      title: "How are my apps doing?",
      why: `${s.containers.length} app container${s.containers.length === 1 ? "" : "s"} on this machine.`,
      prompt:
        "List the Docker containers on this machine and tell me which are unhealthy, restarting or " +
        `stopped, and which have been running the longest without an update. ${HANDS_OFF}`,
    });
  }

  return out;
}

// ----------------------------------------------------------------- offers --

export interface Offer {
  key: string;
  /** The question, as asked. */
  text: string;
  why: string;
  job: { name: string; cron: string; prompt: string };
}

/** Quiet hours, as far as an offer's time is concerned. */
export interface QuietWindow {
  quiet: boolean;
  from: number;
  to: number;
}

function inWindow(minute: number, q: QuietWindow): boolean {
  if (!q.quiet || q.from === q.to) return false;
  return q.from < q.to ? minute >= q.from && minute < q.to : minute >= q.from || minute < q.to;
}

/** A time of day that is not inside the quiet hours: the time asked for, or a
    quarter of an hour after the window ends. */
export function outsideQuiet(minute: number, q: QuietWindow): number {
  return inWindow(minute, q) ? (q.to + 15) % 1440 : minute;
}

/** "07:45" from minutes. */
const clock = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

/**
 * Schedules worth offering, from what the install already shows, each asked
 * once: `answered` holds every key the person has said yes or no to, and
 * none of those comes back. One subject already covered by a job of theirs
 * is not offered either -- they have it.
 *
 * The first is the one to ask; the rest wait their turn.
 */
export function offers(s: Signals, answered: Record<string, string>, quiet: QuietWindow): Offer[] {
  const out: Offer[] = [];
  const at = (minute: number, days: string) => {
    const m = outsideQuiet(minute, quiet);
    return { cron: `${m % 60} ${Math.floor(m / 60)} * * ${days}`, time: clock(m) };
  };

  if (followsMarkets(s.memories) && !covered(s.jobs, /stock|market|portfolio|watchlist|shares/i)) {
    const t = at(7 * 60 + 45, "1-5");
    out.push({
      key: "offer:markets",
      text: `Want a short brief on your stocks every weekday at ${t.time}?`,
      why: "You've told me what you follow.",
      job: {
        name: "Morning market brief",
        cron: t.cron,
        prompt:
          "Morning brief on my investments: memory_search for my holdings and watchlist, check today's " +
          "price move and any news for each, and give me a short summary with the biggest movers " +
          "first. Buy nothing, sell nothing, send nothing.",
      },
    });
  }

  if (s.tools.browser && s.signIns.some((x) => /^(google\.com|gmail\.com)$/.test(x)) &&
      !covered(s.jobs, /e-?mail|inbox|gmail/i)) {
    const t = at(8 * 60, "1-5");
    out.push({
      key: "offer:email",
      text: `Want a summary of new email every weekday at ${t.time}?`,
      why: "The browser is signed in to Google.",
      job: {
        name: "Morning email summary",
        cron: t.cron,
        prompt:
          "Open Gmail in the browser and summarize the email that arrived since yesterday morning: who, " +
          "what, and which ones need a reply. Draft nothing and send nothing.",
      },
    });
  }

  if (s.tools.browser && s.signIns.includes("github.com") && !covered(s.jobs, /github|pull request/i)) {
    const t = at(9 * 60, "1-5");
    out.push({
      key: "offer:github",
      text: `Want a look at what needs you on GitHub every weekday at ${t.time}?`,
      why: "The browser is signed in to GitHub.",
      job: {
        name: "GitHub check-in",
        cron: t.cron,
        prompt:
          "Open my GitHub notifications in the browser and tell me what needs my attention: review " +
          `requests, mentions, failing checks on my pull requests. ${HANDS_OFF}`,
      },
    });
  }

  if (s.tools.terminal && (s.containers?.length ?? 0) >= 3 && !covered(s.jobs, /docker|container|apps?\b/i)) {
    const t = at(10 * 60, "0");
    out.push({
      key: "offer:apps",
      text: `Want me to check your apps every Sunday at ${t.time} for anything unhealthy?`,
      why: `${s.containers!.length} app containers on this machine.`,
      job: {
        name: "Weekly app check",
        cron: t.cron,
        prompt:
          "Check the Docker containers on this machine: which are unhealthy, restarting or stopped, and " +
          `why, from their logs. ${HANDS_OFF}`,
      },
    });
  }

  if (s.tools.terminal && s.disk && s.disk.used / s.disk.total >= 0.75 && !covered(s.jobs, /disk|storage|space/i)) {
    const t = at(9 * 60, "1");
    out.push({
      key: "offer:disk",
      text: `The disk is ${percent(s.disk)}% full. Want a check on it every Monday at ${t.time}?`,
      why: "So it never fills up by surprise.",
      job: {
        name: "Weekly disk check",
        cron: t.cron,
        prompt:
          "Check how full the disks are, what grew most this week, and what could be cleared and how " +
          "much that would free. Delete nothing.",
      },
    });
  }

  return out.filter((o) => !answered[o.key]);
}

// ------------------------------------------------------------- next steps --

export interface NextStep {
  label: string;
  prompt: string;
}

export interface TurnSummary {
  request: string;
  /** The tool calls of the turn, in order. */
  calls: { name: string; args: Record<string, any>; ok: boolean }[];
  /** Whether the agent can save a tool of its own (tool_create). */
  customTools: boolean;
}

/** Pages it makes no sense to watch: this machine, and no page at all. */
const LOCAL = /^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/i;

/**
 * Follow-ups for the end of a turn, from what it did.
 *
 * A page it read can be watched, unless the turn already set a schedule.
 * `fromModel` are the follow-ups the look back after the turn thought of,
 * specific to what was said; they come after. Three at most. ("Do this every
 * morning" and "Save this as a tool" used to be offered too; they were
 * generic, took room under every reply, and were dropped.)
 */
export function nextSteps(turn: TurnSummary, fromModel: NextStep[] = []): NextStep[] {
  const ok = turn.calls.filter((c) => c.ok);
  const scheduled = turn.calls.some((c) => c.name === "schedule");
  const out: NextStep[] = [];
  const add = (x: NextStep) => {
    const label = x.label.trim();
    const prompt = x.prompt.trim();
    if (!label || !prompt || out.length >= 3) return;
    if (out.some((o) => o.label.toLowerCase() === label.toLowerCase())) return;
    out.push({ label, prompt });
  };

  if (!scheduled) {
    const page = [...ok].reverse()
      .find((c) => (c.name === "browser_open" || c.name === "http_request") && /^https?:\/\//i.test(String(c.args?.url ?? "")));
    const url = page ? String(page.args.url) : "";
    if (url && !LOCAL.test(url)) {
      add({ label: "Tell me when this page changes", prompt: `Watch ${url} and tell me when it changes. Check it every hour.` });
    }
  }

  for (const step of fromModel.slice(0, 2)) add(step);

  return out;
}
