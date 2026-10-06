/**
 * The the terminal and the long-running work behind it tools.
 *
 * These were entries in one 81-entry array in server/tools.ts. Nothing about
 * them changed in the move -- each is the same spec, in the same order, and the
 * registry below lists them in the order they were listed before.
 */

import type { ToolSpec } from "../tools";

export const terminalSPECS: ToolSpec[] = [
  {
    name: "terminal",
    group: "terminal",
    description:
      "Run a shell command on the machine Autora is running on and return its " +
      "output and exit code. Runs through `bash -lc`, so pipes, redirection, " +
      "`&&` and environment variables all work. This is a real shell on a real " +
      "host: it is not a sandbox and it is not a simulation. Output is streamed " +
      "into the conversation as it arrives, so the person watching sees the " +
      "command and its output as it runs. Not a terminal emulator -- there is no " +
      "TTY, so interactive programs (vim, `top`, a password prompt, anything " +
      "paging) will hang rather than work. Use non-interactive flags, and prefer " +
      "`sudo -n` so a password prompt fails fast instead of waiting. " +
      "Autora itself is a node process on this machine (in its Umbrel " +
      "container, the main one): killing or restarting it ends this " +
      "conversation and can leave the app offline, and in the container " +
      "files changed under /app are replaced at the next update. To change " +
      "Autora, change its source repository instead.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The command line to run, exactly as you would type it.",
        },
        cwd: {
          type: "string",
          description:
            "Optional directory to run in. Defaults to the configured working " +
            "directory.",
        },
      },
      required: ["command"],
    },
    risky: true,
  },

  {
    name: "run_background",
    group: "terminal",
    description:
      "Start a shell command that keeps running after this turn is over: a " +
      "build, a long test run, a download, a restore, anything that would hit " +
      "the terminal's time limit. Same shell, same secrets and same working " +
      "directory as terminal, but nothing waits for it. You get a job id and " +
      "the file its output is going to; the job carries on when the turn ends, " +
      "and the next turn is told by itself what has become of it. Read it " +
      "later with background_output -- never start it and then sleep or poll " +
      "in this turn. For something that must happen at a time, or be looked at " +
      "again later, use schedule instead: a job there is a prompt and a time, " +
      "and it comes back to you on its own.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The command line to run in the background, exactly as you would type it.",
        },
        cwd: {
          type: "string",
          description: "Optional directory to run in. Defaults to the configured working directory.",
        },
        note: {
          type: "string",
          description:
            "One line on why it was started, in your own words, e.g. " +
            "\"rebuilding the app bundle\". The next turn reads this.",
        },
      },
      required: ["command"],
    },
    risky: true,
  },
  {
    name: "background_jobs",
    group: "terminal",
    description:
      "List the background commands you started: what each one was, whether " +
      "it is still running or has finished, its exit code and how long it " +
      "ran. Cheap, and the right first call when something you set going " +
      "earlier is needed now.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "background_output",
    group: "terminal",
    description:
      "What a background command has printed, and how it ended. Give the " +
      "job id run_background returned. For a job still running this is what " +
      "it has printed so far, not the finished output.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The job id, e.g. job-m7x2k1p4a." },
        lines: {
          type: "number",
          description: "How many lines from the end to return. Default 40, at most 500.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "background_stop",
    group: "terminal",
    description:
      "Stop a background command you started, and anything it started. Use it " +
      "for one that is going wrong, or is no longer wanted.",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "The job id, e.g. job-m7x2k1p4a." } },
      required: ["id"],
    },
    risky: true,
  },

  {
    name: "tool_create",
    group: "terminal",
    description:
      "Save a shell script as a tool of your own, for work you expect to do " +
      "again: once saved it is offered as my_<name> in every later session. " +
      "The script runs like a terminal command (bash -lc, same directory and " +
      "secrets); each parameter arrives as the environment variable " +
      "ARG_<NAME> (uppercase), and all of them as JSON in TOOL_ARGS. Saving " +
      "under an existing name replaces that tool. Only save what has already " +
      "worked in the terminal.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Lowercase, underscores, e.g. check_backup." },
        description: { type: "string", description: "What it does and when to use it, for your future self." },
        parameters: {
          // The handler takes either: a list of {name, ...} or a JSON Schema
          // object, which is what models reach for first.
          type: ["array", "object"],
          description: "The arguments it takes: a list of {name, description, required}, or a JSON Schema object.",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              description: { type: "string" },
              required: { type: "boolean" },
            },
            required: ["name"],
          },
        },
        script: { type: "string", description: "The shell script." },
      },
      required: ["name", "description", "script"],
    },
    risky: true,
  },
  {
    name: "tool_delete",
    group: "terminal",
    description: "Delete a tool you wrote with tool_create, by its my_<name>.",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "e.g. my_check_backup" } },
      required: ["name"],
    },
    risky: true,
  },
  {
    name: "edit_file",
    group: "terminal",
    description:
      "Change a file in the working folder, or make a new one, without losing anything the person saved to it " +
      "meanwhile. Prefer this to sed or a shell redirect for any file the person might also have open: it " +
      "compares the file with what you last read, keeps their changes next to yours when you touched different " +
      "lines, and writes nothing -- telling you exactly what they did -- when you both changed the same lines. " +
      "edits is a list of {old, new}: old is the exact text to replace (it must be in the file once, or set all), " +
      "new is what it becomes. content makes a whole new file, or with overwrite replaces one. Paths are from the " +
      "terminal's directory. Read the lines you are changing first; keep old short but exact.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "The file, from the terminal's directory." },
        edits: {
          type: "array",
          description: "What to replace, in order.",
          items: {
            type: "object",
            properties: {
              old: { type: "string", description: "The exact text to replace." },
              new: { type: "string", description: "What it becomes." },
              all: { type: "boolean", description: "Replace every place it occurs." },
            },
            required: ["old", "new"],
          },
        },
        content: { type: "string", description: "A whole file: to make a new one." },
        overwrite: { type: "boolean", description: "With content: replace a file that already exists." },
      },
      required: ["path"],
    },
    risky: true,
  },

  {
    name: "code_search",
    group: "terminal",
    description:
      "Find where something is in a folder of code, without reading files one at a time. Plain code does the " +
      "searching, not a model, so it is fast and nothing in it is a guess. Three ways: ranked (the default) finds " +
      "the places most about some words -- \"fetch user\" finds fetchUserById and fetch_user_by_id -- and returns each " +
      "with its best lines; exact finds every line holding some text; regex finds every line matching a pattern. " +
      "Results are path:line, so read just that place afterwards (sed -n 'START,ENDp' file) instead of the whole " +
      "file. It skips node_modules, build output, hidden folders, environment files and binaries. Start here when " +
      "you do not know where something lives; use the terminal's grep only for something this cannot say.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to rank by, or the exact text, or a regular expression." },
        mode: { type: "string", enum: ["ranked", "exact", "regex"], description: "Default ranked." },
        path: { type: "string", description: "A folder to look in, from the terminal's directory. Default: the terminal's directory." },
        glob: { type: "string", description: "Only files matching this: \"*.ts\", \"src/**/*.tsx\"." },
        case_sensitive: { type: "boolean", description: "For exact and regex. Default any case." },
        max: { type: "number", description: "How many places to return (ranked) -- default 8, at most 30." },
      },
      required: ["query"],
    },
  },

  {
    name: "read_file",
    group: "terminal",
    description:
      "Read a text file, or part of one, with line numbers -- without the terminal. By default the first 200 " +
      "lines; start and end read a range. outline lists the file's functions, classes and headings with their " +
      "line numbers, so a large file costs a few lines to understand; symbol returns the whole body of one " +
      "function, class or heading by name. Prefer outline then symbol to cat-ing a big file. Paths are from the " +
      "terminal's directory. Reads only: use edit_file to change a file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "The file, from the terminal's directory." },
        start: { type: "number", description: "First line, from 1." },
        end: { type: "number", description: "Last line, inclusive. At most 600 lines at a time." },
        outline: { type: "boolean", description: "List declarations and headings with line numbers." },
        symbol: { type: "string", description: "Return the body of the declaration with this name." },
      },
      required: ["path"],
    },
  },

];
