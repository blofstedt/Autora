/**
 * A picture a tool handed back: how it reaches the model on each vendor, and
 * how all but the newest one is dropped from the history.
 *
 *   npx tsx tests/pictures.test.ts
 */
import assert from "node:assert/strict";
import { ContextEngine } from "../server/context";
import { anthropicMessages, geminiContents, openAiMessages, type ChatCall } from "../server/llm";

console.log("pictures");

const PNG = "aGVsbG8=";
const shot = { mime: "image/png", data: PNG };

const history: ChatCall["messages"] = [
  { role: "user", text: "what does the page look like?" },
  {
    role: "assistant",
    text: "",
    calls: [{ id: "call_1", name: "browser_screenshot", args: {} }],
  },
  {
    role: "tool",
    replies: [
      { id: "call_1", name: "browser_screenshot", ok: true, result: "A picture of the page.", images: [shot] },
    ],
  },
];

const call = { provider: "deepseek", model: "m", key: "k", baseUrl: "https://example.invalid", system: "", messages: history } as ChatCall;

const openai = openAiMessages(call);
const results = openai.find((m) => m.role === "tool");
assert.ok(results, "the tool result is still there");
assert.equal(results.content, "A picture of the page.");
const withImage = openai.find((m) => m.role === "user" && Array.isArray(m.content));
assert.ok(withImage, "the picture should follow the tool result as a user message");
const url = withImage.content.find((c: any) => c.type === "image_url")?.image_url?.url;
assert.equal(url, `data:image/png;base64,${PNG}`);
assert.ok(
  openai.indexOf(withImage) === openai.indexOf(results) + 1,
  "the picture comes straight after the result it belongs to",
);
console.log("  ok  OpenAI's history gets the picture as the next user message");

const anthropic = anthropicMessages(call);
const turn = anthropic.find((m) => m.content.some?.((c: any) => c.type === "tool_result"));
assert.equal(turn.content[0].type, "tool_result", "the result stays first");
const image = turn.content.find((c: any) => c.type === "image");
assert.ok(image, "the picture rides in the same message as the results");
assert.equal(image.source.data, PNG);
assert.equal(image.source.media_type, "image/png");
console.log("  ok  Anthropic's gets it in the same user turn as the tool results");

const gemini = geminiContents(call);
const geminiTool = gemini.find((c) => c.parts.some((p: any) => p.functionResponse));
assert.ok(geminiTool.parts.some((p: any) => p.inlineData?.data === PNG), "gemini gets inlineData");
assert.equal(geminiTool.parts[0].functionResponse.name, "browser_screenshot", "after the response");
console.log("  ok  Gemini's gets it as inlineData beside the function response");

/* Only the newest picture is kept: a screenshot is worth one look, and every
   earlier one would otherwise be re-sent, in full, on every later call. */
const engine = new ContextEngine();
const first = {
  role: "tool" as const,
  replies: [{ id: "a", name: "browser_screenshot", ok: true, result: "one", images: [shot] }],
};
const second = {
  role: "tool" as const,
  replies: [{ id: "b", name: "browser_screenshot", ok: true, result: "two", images: [shot] }],
};
engine.load([{ message: first, seq: 1 }, { message: second, seq: 2 }]);
engine.supersedePictures();
assert.equal(first.replies[0].images, undefined, "the older picture is dropped");
assert.ok(second.replies[0].images, "the newest stays");
assert.equal(second.replies[0].result, "two", "and its result is untouched");
console.log("  ok  all but the newest picture are dropped from the history");

console.log("pictures: all passed");
