/**
 * The workspace memory graph tools.
 *
 * These were entries in one 81-entry array in server/tools.ts. Nothing about
 * them changed in the move -- each is the same spec, in the same order, and the
 * registry below lists them in the order they were listed before.
 */

import type { ToolSpec } from "../tools";

export const memorySPECS: ToolSpec[] = [
  {
    name: "memory_write",
    group: "memory",
    description:
      "Write something down in the workspace memory graph, where it will be " +
      "recalled in later sessions. For durable facts, preferences, procedures and " +
      "references worth keeping -- not for a running commentary on this " +
      "conversation, which is already recorded. One topic per memory, a title that " +
      "names its subject, short. Secrets are refused.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "A short label, a few words.",
        },
        body: {
          type: "string",
          description: "The fact itself, written so it still makes sense months from now.",
        },
        kind: {
          type: "string",
          enum: ["fact", "preference", "procedure", "skill", "reference"],
          description:
            "What sort of thing this is. Default fact. A procedure is how to do " +
            "something here that worked -- the steps, commands and gotchas. A reference is what a product's " +
            "OFFICIAL documentation or help says about how it works (where things are in an interface, what an " +
            "API call is named): it needs subject and source.",
        },
        subject: {
          type: "string",
          description: "What it is about: the product, site, app or project, in a word or two (\"github\", \"google sheets\"). The title is filed under it.",
        },
        facet: {
          type: "string",
          enum: ["interface", "api", "docs", "workflow", "quirk"],
          description: "For knowledge about a product: interface (where things are, what they are called -- goes stale fastest), api, docs, workflow, quirk.",
        },
        source: {
          type: "string",
          description: "A reference's source: the address of the official page you read it from.",
        },
        version: { type: "string", description: "The version it describes, if the page says." },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "A few words it should be found by.",
        },
      },
      required: ["title", "body"],
    },
    risky: true,
  },
  {
    name: "memory_update",
    group: "memory",
    description:
      "Correct or extend a memory that is out of date or incomplete, by its id " +
      "(recalled memories and memory_search show ids). Prefer this to writing " +
      "a second memory about the same thing.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The memory's id, e.g. mem-abc123." },
        title: { type: "string", description: "A new title, if it should change." },
        body: { type: "string", description: "The whole new body, replacing the old one." },
        kind: { type: "string", enum: ["fact", "preference", "procedure", "skill", "reference"] },
        subject: { type: "string", description: "What it is about, if that should change." },
        facet: { type: "string", enum: ["interface", "api", "docs", "workflow", "quirk"] },
        source: { type: "string", description: "For a reference: the page it was read from again. Stamps today as when it was read." },
        version: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["id"],
    },
    risky: true,
  },
  {
    name: "memory_forget",
    group: "memory",
    description:
      "Retire a memory that is wrong or no longer true. Name the memory that " +
      "replaces it, if there is one, so the history is kept.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The memory to retire." },
        replaced_by: { type: "string", description: "The id of the memory that supersedes it, if any." },
      },
      required: ["id"],
    },
    risky: true,
  },
  {
    name: "memory_confirm",
    group: "memory",
    description:
      "Say that a memory still holds, after you have used it and seen it was " +
      "right: the path is still there, the command still works, the release " +
      "still goes that way. It stamps today's date on the record, so the next " +
      "session can tell knowledge that was just checked from knowledge written " +
      "months ago and never looked at again -- and a memory older than a month " +
      "says so when it is recalled. Pass a note when what you found differs in " +
      "detail; it is added to the memory.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The memory's id, e.g. mem-abc123." },
        note: {
          type: "string",
          description: "What you actually found, if it is worth writing down, e.g. \"still at /data/work/a2, now on 0.9.68\".",
        },
      },
      required: ["id"],
    },
    risky: true,
  },
  {
    name: "memory_search",
    group: "memory",
    description:
      "Search the workspace memory graph for what has been written down " +
      "before. Some of it is already in your instructions for this turn; this " +
      "is how you find the rest.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Words to look for in titles, bodies and tags.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "vault_read",
    group: "memory",
    description:
      "Read back a tool output that was too long to keep in context. When a " +
      "result says it was stored as a vault artifact (an id like art_1a2b3c4d), " +
      "only its start and end were shown; this returns any other part of it, " +
      "or every line that contains some text. Vault artifacts last as long as " +
      "this session's server process does.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The artifact id, e.g. art_1a2b3c4d." },
        offset: {
          type: "number",
          description: "Character to start from. Defaults to 0.",
        },
        length: {
          type: "number",
          description: "How many characters to return. Defaults to as many as fit.",
        },
        search: {
          type: "string",
          description:
            "Instead of a range, return every line containing this text " +
            "(case-insensitive), with line numbers.",
        },
      },
      required: ["id"],
    },
  },
];
