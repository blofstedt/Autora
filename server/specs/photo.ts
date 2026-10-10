/**
 * Autora Photo: the photo editing window. The picture lives on the server (server/photodesk.ts) as PhotoCraft's own
 * layered file, and in the editor beside the chat; these tools are the agent's hands on the same picture, so the person
 * watches it change and can change anything by hand. The agent runs PhotoCraft's own command registry: anything a
 * person can click in a menu, it can do.
 */

import type { ToolSpec } from "../tools";

export const photoSPECS: ToolSpec[] = [
  {
    name: "photo_open",
    group: "files",
    description:
      "Open Autora Photo (PhotoCraft's editor) beside the chat. With `file` (an image, a PSD, or a PhotoCraft file: an artifact " +
      "id, a path or an artifact's name) it puts that picture in the window, replacing what was there. With `new` it starts a " +
      "blank canvas. With neither it just opens the window on the chat's picture. A chat has one picture; its layers are kept, " +
      "so a PSD stays layered. The other photo tools open the window themselves.",
    parameters: {
      type: "object",
      properties: {
        file: { type: "string", description: "The picture to open: an artifact id (file_...), a path on this host, or an artifact's name." },
        new: {
          type: "object",
          description: "A blank canvas: { width, height } in pixels (default 1920x1080), and `background` (white, black, transparent, or a colour like #336699).",
          properties: {
            width: { type: "number" },
            height: { type: "number" },
            background: { type: "string" },
          },
        },
      },
    },
  },
  {
    name: "photo_look",
    group: "files",
    description:
      "See the picture as it is now, flattened, as an image you are shown. Do this after you change something and before you say " +
      "it is done. `max_side` is the longest side in pixels (default 1024, at most 2048).",
    parameters: {
      type: "object",
      properties: {
        max_side: { type: "number", description: "The longest side of the image you are shown, in pixels." },
      },
    },
  },
  {
    name: "photo_info",
    group: "files",
    description:
      "The picture as data: its size, colour mode and depth, and its layer tree (names, kinds, visibility, opacity, blend modes, " +
      "masks, adjustments). Call it again before relying on what you saw: the person edits the same picture by hand.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "photo_commands",
    group: "files",
    description:
      "Find PhotoCraft commands by name: every menu item, tool and dialog is a command with an id such as filter.sharpen.smartSharpen " +
      "or layer.newAdjustmentLayer.curves, listed with its parameters and whether it can run now. There are hundreds, so pass a `filter` " +
      "(a word of the id or label: blur, curves, crop, layer.new). Use the ids with photo_edit.",
    parameters: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Only commands whose id or label contains this text." },
      },
    },
  },
  {
    name: "photo_edit",
    group: "files",
    description:
      "Change the picture by running PhotoCraft commands in order: `commands` is a list of { id, params }. They run on the chat's picture " +
      "and are kept, and the window shows the result and the person can undo it (each command is a history step). It stops at the first " +
      "that fails, and the ones before it stay applied. Find ids with photo_commands; the params are the ones it lists. Example: " +
      "[{ id: \"filter.blur.gaussianBlur\", params: { radius: 3 } }, { id: \"layer.new.layer\", params: { name: \"Ink\" } }].",
    parameters: {
      type: "object",
      properties: {
        commands: {
          type: "array",
          description: "The commands to run, in order.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "The command's id." },
              params: { type: "object", description: "Its parameters, as photo_commands lists them." },
            },
            required: ["id"],
          },
        },
      },
      required: ["commands"],
    },
  },
  {
    name: "photo_export",
    group: "files",
    description:
      "Save the picture as a file in the thread for the person to download: png, jpg, webp, tif, psd (layered) or pcraft (PhotoCraft's own, " +
      "layered). `quality` is 1-100 for jpg and webp. Do it when they ask for a file, not after every edit.",
    parameters: {
      type: "object",
      properties: {
        format: { type: "string", description: "png (default), jpg, webp, tif, psd or pcraft." },
        name: { type: "string", description: "A name for the file, without the extension." },
        quality: { type: "number", description: "1-100, for jpg and webp." },
      },
    },
  },
];
