/**
 * Which saved files each app can load (the Load button in its bar; server/loadfile.ts does the loading).
 *
 * Plain functions with no imports, because the page's picker and the server's route must agree on this: what the picker
 * offers is what the route accepts.
 */

export type LoadApp = "pdf" | "pages" | "sheets" | "slides" | "photo" | "video" | "studio" | "cad" | "game";
export const LOAD_APPS: LoadApp[] = ["pdf", "pages", "sheets", "slides", "photo", "video", "studio", "cad", "game"];

const OFFICE_EXT: Record<"pages" | "sheets" | "slides", string> = { pages: "docx", sheets: "xlsx", slides: "pptx" };

/** What each app takes, in words for the picker's heading. */
export const LOAD_WHAT: Record<LoadApp, string> = {
  pdf: "a PDF",
  pages: "a document",
  sheets: "a spreadsheet",
  slides: "a presentation",
  photo: "a picture",
  video: "a video, a sound or a picture",
  studio: "a song you saved",
  cad: "a model you saved",
  game: "a game you saved, or a picture, sound or font for it",
};

/** Whether this app can use this file, by what it is. */
export function loadable(app: LoadApp, file: { name: string; mime: string }): boolean {
  const name = file.name.toLowerCase();
  const mime = file.mime.toLowerCase();
  switch (app) {
    case "pdf": return mime === "application/pdf" || name.endsWith(".pdf");
    case "pages": case "sheets": case "slides": return name.endsWith(`.${OFFICE_EXT[app]}`);
    case "photo": return /^image\/(png|jpeg|webp|gif|bmp|tiff)$/.test(mime) || /\.(png|jpe?g|webp|gif|bmp|tiff?|psd)$/.test(name);
    case "video": return /^(video|audio|image)\//.test(mime) || /\.(mp4|mov|webm|mkv|mp3|wav|m4a|ogg|aac|png|jpe?g|gif|webp)$/.test(name);
    case "studio": return name.endsWith(".song.json");
    case "cad": return name.endsWith(".json");
    case "game": return name.endsWith(".json") || /^(image|audio|font)\//.test(mime) || /\.(png|jpe?g|gif|webp|svg|mp3|wav|ogg|ttf|otf|woff2?|glb|gltf)$/.test(name);
  }
}
