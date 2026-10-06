/**
 * The things that happen later: schedules and watchers tools.
 *
 * These were entries in one 81-entry array in server/tools.ts. Nothing about
 * them changed in the move -- each is the same spec, in the same order, and the
 * registry below lists them in the order they were listed before.
 */

import type { ToolSpec } from "../tools";

export const scheduleSPECS: ToolSpec[] = [
  {
    name: "schedule",
    group: "schedule",
    description:
      "Set something going that comes back to you later: a task and a cron " +
      "time for it. Use it for anything that should happen at a time (\"every " +
      "weekday at 8am, check the release status and report\") or be watched for " +
      "a change (give `watch` a page, a file or a command, and the task runs " +
      "only when what it watches differs from the last look). The task runs as " +
      "a turn of its own, in a new session, with this workspace's memory and " +
      "tools, and the person sees what it says. Name it after the outcome, and " +
      "write the prompt as an instruction to yourself: say what to do and what " +
      "to tell the person. Prefer a watcher over a schedule that looks again " +
      "and again: a watcher speaks only when something actually changed. " +
      "Nothing runs while the machine or the console is off -- a time missed is " +
      "missed, not made up afterwards. To change one you already set, give its " +
      "id; to see them, use schedules.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "What it is for, in a few words, e.g. \"Release check\".",
        },
        cron: {
          type: "string",
          description:
            "Five-field cron, in the server's local time: \"0 8 * * 1-5\" is " +
            "08:00 on weekdays, \"*/15 * * * *\" is every fifteen minutes. " +
            "@hourly, @daily, @weekly and @monthly also work. For a watcher " +
            "this is how often to look.",
        },
        prompt: {
          type: "string",
          description:
            "What to do when it runs, written as an instruction to yourself, " +
            "ending with what to say to the person.",
        },
        id: {
          type: "string",
          description: "An existing job's id, to change that one instead of making a new one.",
        },
        enabled: { type: "boolean", description: "Whether it should run. Default true." },
        watch: {
          type: "object",
          description:
            "Only for a watcher: what to look at, and the task runs only when " +
            "it differs from the last look. Leave it out for a plain schedule.",
          properties: {
            kind: {
              type: "string",
              description: "page (an http(s) address), file (a path on this machine) or command (a shell command's output).",
            },
            target: { type: "string", description: "The address, the path, or the command." },
          },
          required: ["kind", "target"],
        },
      },
      required: ["name", "cron", "prompt"],
    },
    risky: true,
  },
  {
    name: "schedules",
    group: "schedule",
    description:
      "The scheduled tasks and watchers this workspace has: each one's id, " +
      "when it next runs, when it last ran, and anything that went wrong. " +
      "Read it before creating one that may already exist, and to find the id " +
      "to change or remove.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "unschedule",
    group: "schedule",
    description:
      "Remove a scheduled task or watcher, by id. With keep: true it is paused " +
      "instead -- kept, but never fired -- which is the better choice when it " +
      "may be wanted again.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The job's id, as schedules lists it." },
        keep: { type: "boolean", description: "Pause it rather than removing it. Default false." },
      },
      required: ["id"],
    },
    risky: true,
  },

  {
    name: "pre_authorise",
    group: "schedule",
    description:
      "Agree a class of work in advance, so the guard stops asking about it: " +
      "give the tool and a few words that a call of that kind contains. Use it " +
      "when the same harmless hold keeps coming back -- restarting the same " +
      "container, re-running the same deploy -- and say why in the note, " +
      "because the person reads this list. It is not a way round a hold you " +
      "have not explained, and it cannot cover anything irrecoverable: " +
      "formatting a disk, wiping a volume, force-pushing over main and deleting " +
      "the whole tree are asked about every time, however many agreements " +
      "there are.",
    parameters: {
      type: "object",
      properties: {
        tool: {
          type: "string",
          description: "terminal, run_background or http_request -- the tools the guard asks about.",
        },
        match: {
          type: "string",
          description:
            "The words a call must contain, e.g. \"docker compose restart kokoro\" " +
            "or \"POST https://api.example.com/deploy\". At least 8 characters, " +
            "and specific enough that it cannot match something else.",
        },
        note: { type: "string", description: "Why it is agreed, in a few words the person will read." },
      },
      required: ["tool", "match"],
    },
    risky: true,
  },
  {
    name: "pre_authorisations",
    group: "schedule",
    description:
      "The standing agreements there are: what is pre-authorised, who added " +
      "each one, and how often it has been used. With revoke, an id, take one " +
      "back.",
    parameters: {
      type: "object",
      properties: {
        revoke: { type: "string", description: "The id of an agreement to take back, e.g. allow-m7x2k-abc." },
      },
    },
    risky: true,
  },

  {
    name: "inventory",
    group: "schedule",
    description:
      "Look at the machine again -- which commands are installed, which are " +
      "not, the shell, the working directory and what is in it, the disk -- " +
      "and answer with it. The first turn of a session is given this by " +
      "itself, so call it only when something may have changed: after " +
      "installing a tool, after a restart, or when a fact about this machine " +
      "turns out not to hold.",
    parameters: { type: "object", properties: {} },
  },

  // ---------------------------------------------------------------- todo --
  {
    name: "todo",
    group: "schedule",
    description:
      "The to-do list the person watches, in the conversation. Write the plan " +
      "on it before you start anything that takes more than one step, then " +
      "rewrite it as you go: an item is in-progress while you work on it and " +
      "completed the moment it is finished. Every call is the WHOLE list as " +
      "it now stands, in order. Keep one item in-progress at a time. The list " +
      "appears by itself on the first call. Use it for programming (many " +
      "items), and for small errands too -- an email is read it, pull the " +
      "attachment, draft the reply, show it, send it. Call it with no " +
      "arguments to read the list back.",
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description:
            "The whole list, in order. Each item is a short title, or " +
            "{title, status}. Status is not-started (the default), " +
            "in-progress or completed.",
          items: {
            anyOf: [
              { type: "string" },
              {
                type: "object",
                properties: {
                  title: { type: "string", description: "One short line: what this step does." },
                  status: { type: "string", description: "not-started, in-progress or completed." },
                },
                required: ["title"],
              },
            ],
          },
        },
      },
    },
  },

  {
    name: "tools_enable",
    group: "schedule",
    description:
      "Bring in a set of tools that is not in your list yet. The console note says which sets exist and what each " +
      "is for. Call this when the job needs one, then use its tools on your next step; they stay for the rest of " +
      "the chat. You do not need it for tools you can already see.",
    parameters: {
      type: "object",
      properties: {
        family: { type: "string", description: "The set to load, by name (pdf, widgets, mcp, schedule, notebooks)." },
      },
      required: ["family"],
    },
  },

  // -------------------------------------------------------------- ledger --
  {
    name: "ledger",
    group: "schedule",
    description:
      "Your working notes for the job in hand, kept for you across interruptions, stops and restarts " +
      "(a new turn starts without what you worked out in the last one; these are not lost). Record what " +
      "you settle and what you find out as you go, so it is never worked out twice: decided is a choice " +
      "and why; learned is a fact that cost a call to find (where something is, how a file is laid out, " +
      "what a service returned); next is the whole list of what you will do next, in order; goal is the " +
      "job in a line. forget drops any line holding one of the given words; reset starts again. Short " +
      "lines. Autora already records which files and pages you touched. Call with no arguments to read " +
      "the notes back.",
    parameters: {
      type: "object",
      properties: {
        goal: { type: "string", description: "The job, in one line." },
        decided: { type: "array", items: { type: "string" }, description: "Choices made, with the reason." },
        learned: { type: "array", items: { type: "string" }, description: "Facts found out that cost a call." },
        next: { type: "array", items: { type: "string" }, description: "What you will do next, in order. Replaces the list." },
        forget: { type: "array", items: { type: "string" }, description: "Drop lines that hold any of these words." },
        reset: { type: "boolean", description: "Start the notes again." },
      },
    },
  },

  // ------------------------------------------------------- requirements --
  {
    name: "requirements",
    group: "schedule",
    description:
      "What the person asked for, kept in their own words so none of it is lost or paraphrased away. " +
      "When a message asks for more than one thing -- features, fixes, changes -- add each ask as its " +
      "own item, worded as they worded it. When they add to it, change their mind or take something " +
      "away mid-conversation (even while you work), record it here: add a new ask, edit one whose " +
      "wording changed, drop one they no longer want (with the reason). Mark an item done only when it " +
      "is, with how you checked it. Before you finish, every item should be done or dropped. This is " +
      "separate from the to-do list, which is your own plan. Call with no arguments to read the list back.",
    parameters: {
      type: "object",
      properties: {
        add: { type: "array", items: { type: "string" }, description: "New asks, one per item, in the person's words." },
        edit: {
          type: "array",
          description: "Asks whose wording changed: [{id, text}].",
          items: { type: "object", properties: { id: { type: "string" }, text: { type: "string" } }, required: ["id", "text"] },
        },
        done: {
          type: "array",
          description: "Asks that are finished: [{id, how}] where how says how you checked.",
          items: { type: "object", properties: { id: { type: "string" }, how: { type: "string" } }, required: ["id"] },
        },
        drop: {
          type: "array",
          description: "Asks no longer wanted or impossible: [{id, why}].",
          items: { type: "object", properties: { id: { type: "string" }, why: { type: "string" } }, required: ["id"] },
        },
        reopen: { type: "array", items: { type: "string" }, description: "Ids to open again." },
      },
    },
  },

  // ---------------------------------------------------------- app_preview --
  {
    name: "app_preview",
    group: "schedule",
    description:
      "The app window: show the website or app you are building beside the conversation, live, so the " +
      "person watches it take shape and can select parts of it and say what to change. start runs a " +
      "dev server (command, and cwd if it is not the working folder; port if it does not say) or serves " +
      "a folder of files (dir) or opens something already running (url, localhost only). Start it as " +
      "soon as there is something to see, then keep building: hot reload updates it. reload refreshes; " +
      "look returns a picture of the page and its console errors -- use it to check your own work; " +
      "stop closes it. To test what you built, use it as a person would, in the same window the person is " +
      "watching, with a visible cursor: click and hover take a target (the words on a button or link, a " +
      "field's label or placeholder, or a CSS selector); type puts text into a target (or into the field " +
      "already focused) and submit presses Enter after; press sends a key (Enter, Tab, Escape, ArrowDown); " +
      "scroll moves the page by dy pixels (negative is up). Each returns a picture of the page afterwards, " +
      "so you see what happened. The person's comments come back as one message beginning [Autora: the person " +
      "reviewed the app preview; make those changes in the source.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", description: "start, reload, look, stop, click, hover, type, press or scroll." },
        target: { type: "string", description: "click, hover, type: what to act on -- words on it, a label, a placeholder, or a CSS selector." },
        text: { type: "string", description: "type: the text to type." },
        key: { type: "string", description: "press: a key, e.g. Enter, Tab, Escape, ArrowDown, Control+A." },
        dy: { type: "number", description: "scroll: pixels down (negative for up). Default 500." },
        submit: { type: "boolean", description: "type: press Enter afterwards." },
        command: { type: "string", description: "start: the dev server command, e.g. npm run dev." },
        cwd: { type: "string", description: "start: where to run it." },
        dir: { type: "string", description: "start: a folder of static files to serve." },
        url: { type: "string", description: "start: an address on this machine that is already running." },
        port: { type: "number", description: "start: the port the command serves on, if it does not print one." },
      },
      required: ["action"],
    },
  },

  // ------------------------------------------------------------ set_mode --
  {
    name: "set_mode",
    group: "schedule",
    description:
      "Agent mode only: switch between planning and building. Planning is " +
      "read-only -- you look, search and write the to-do list, and anything " +
      "that changes something is refused. Building does the work. Every " +
      "turn starts in planning. Switch to build once the plan is on the " +
      "to-do list (or straight away for a very simple task), and back to plan " +
      "if the work turns out to need a new plan. The person sees each switch " +
      "in the chat with your reason, so give one, in a few words.",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "build or plan." },
        reason: { type: "string", description: "Why, in a few words: shown to the person." },
      },
      required: ["to"],
    },
  },

  // ------------------------------------------------------------ browser --
  {
    name: "research",
    group: "schedule",
    description:
      "Hand a self-contained question to a separate research worker and get a short report back. The worker has a " +
      "clean context and read-only tools (code search, read-only commands, files, PDFs, web search where available), " +
      "does the looking, and returns findings with where it saw each -- none of its searching or reading enters this " +
      "conversation. Use it when answering needs a lot of looking and you only need the conclusion: \"where is X " +
      "handled and what does it do?\", \"which of these files uses Y?\", \"what does this library say about Z?\". " +
      "Do not use it for something one search answers, or for anything that has to change a file: it cannot. Write the " +
      "question so it stands alone -- the worker has not seen this conversation -- and say what you need back.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "What to find out, complete in itself, and what form the answer should take." },
        questions: {
          type: "array",
          items: { type: "string" },
          description: "Two or three independent questions, each complete in itself. They are looked into at the same time by separate workers and come back together, so use this instead of calling research several times.",
        },
      },
    },
  },

  // ---------------------------------------------------------------- PDFs --
];
