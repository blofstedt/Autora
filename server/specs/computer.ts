/**
 * The the desktop tools.
 *
 * These were entries in one 81-entry array in server/tools.ts. Nothing about
 * them changed in the move -- each is the same spec, in the same order, and the
 * registry below lists them in the order they were listed before.
 */

import type { ToolSpec } from "../tools";

export const computerSPECS: ToolSpec[] = [
  {
    name: "computer_screenshot",
    group: "computer",
    description:
      "Take a picture of the relayed desktop. You get it back in the result, so " +
      "this is how to see the screen; the person sees it too. Coordinates for " +
      "the click and move tools are in that screen's own pixels, whose full " +
      "size is given in the result.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "computer_click",
    group: "computer",
    description:
      "Click on the relayed desktop at a screen coordinate. Take a screenshot " +
      "first: there is no element numbering here, only pixels.",
    parameters: {
      type: "object",
      properties: {
        x: { type: "integer", description: "Horizontal position, in screen pixels." },
        y: { type: "integer", description: "Vertical position, in screen pixels." },
        button: {
          type: "string",
          enum: ["left", "right", "middle"],
          description: "Which button. Default left.",
        },
        double: { type: "boolean", description: "Double-click instead. Default false." },
      },
      required: ["x", "y"],
    },
    risky: true,
  },
  {
    name: "computer_move",
    group: "computer",
    description: "Move the desktop's pointer without clicking.",
    parameters: {
      type: "object",
      properties: {
        x: { type: "integer", description: "Horizontal position, in screen pixels." },
        y: { type: "integer", description: "Vertical position, in screen pixels." },
      },
      required: ["x", "y"],
    },
    risky: true,
  },
  {
    name: "computer_type",
    group: "computer",
    description:
      "Type text into whatever has focus on the relayed desktop. Click the " +
      "field first; this does not choose a target.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "The literal text to type." },
      },
      required: ["text"],
    },
    risky: true,
  },
  {
    name: "computer_key",
    group: "computer",
    description:
      "Press keys or key combinations on the relayed desktop, in order. Write a " +
      "combination with plus signs, e.g. \"cmd+s\", \"ctrl+shift+t\", \"enter\", " +
      "\"escape\".",
    parameters: {
      type: "object",
      properties: {
        keys: {
          type: "array",
          items: { type: "string" },
          description: "The keys or combinations to press, in order.",
        },
      },
      required: ["keys"],
    },
    risky: true,
  },
  {
    name: "computer_scroll",
    group: "computer",
    description: "Scroll the relayed desktop's active window.",
    parameters: {
      type: "object",
      properties: {
        dy: {
          type: "integer",
          description: "Positive scrolls up, negative scrolls down.",
        },
      },
      required: ["dy"],
    },
    risky: true,
  },

  // --------------------------------------------------------------- person --
];
