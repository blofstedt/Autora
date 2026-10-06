/**
 * The speaking out loud tools.
 *
 * These were entries in one 81-entry array in server/tools.ts. Nothing about
 * them changed in the move -- each is the same spec, in the same order, and the
 * registry below lists them in the order they were listed before.
 */

import type { ToolSpec } from "../tools";

export const voiceSPECS: ToolSpec[] = [
  {
    name: "speak",
    group: "voice",
    description:
      "Say something out loud to the person, right now, in the console's own " +
      "voice (a Deepgram API key when there is one, otherwise the browser's " +
      "voice). It plays immediately on the page they have open -- nothing is " +
      "saved and there is no file to hand over. Use it whenever you are asked " +
      "to say, read out, pronounce or speak something, or to try the voice. " +
      "Never make an audio file for this, never call Deepgram yourself " +
      "from the terminal or http_request, and never save or attach a recording: " +
      "this tool is how you speak. Keep each call to what you mean to be heard " +
      "(up to about 2,000 characters), plain words with no markdown.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Exactly what to say aloud." },
      },
      required: ["text"],
    },
  },

  {
    name: "voice_mute",
    group: "voice",
    description:
      "Stop or start the console saying things out loud on this page, at once. " +
      "Call it with muted true the moment the person asks you to stop talking, " +
      "be quiet, or says the voice is annoying: it silences whatever is being " +
      "said mid-sentence and silences the speak tool, and the switch in " +
      "Settings -> Model & tools -> Voice shows it. It does not change whether " +
      "replies are read out in talk mode -- that is the person's own listening " +
      "switch.",
    parameters: {
      type: "object",
      properties: {
        muted: {
          type: "boolean",
          description: "True to go quiet, false to be heard again.",
        },
      },
      required: ["muted"],
    },
  },

  // ------------------------------------------------------------ widgets --
];
