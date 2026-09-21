# Connecting Gemini

Autora talks to Google's Gemini API from the server, never from the browser.
The key lives in the server's environment and is not sent to the page, is not
written into the repository, and is not exposed by any endpoint -- `/api/settings`
reports only whether a key is set, never its value.

## 1. Get a key

1. Open <https://aistudio.google.com/apikey>.
2. **Get API key** -> **Create API key**, and pick a Google Cloud project (a new
   one is fine).
3. Copy it. This is the only time it is shown in full.

The free tier covers `gemini-flash-latest`, which is what Autora calls by
default.

## 2. Give it to the server

Locally, put it in a `.env` file beside `package.json` (already gitignored):

```
GEMINI_API_KEY=your-key-here
```

Or pass it on the command line for one run:

```bash
GEMINI_API_KEY=your-key-here npm run dev
```

With Docker:

```bash
docker run -e GEMINI_API_KEY=your-key-here -p 3000:3000 autora
```

The key is read once at startup, so **restart the server after setting it**.

## 3. Check it worked

Open Settings (the gear, top right). Under *Model keys*, Google Gemini should
read **Connected (server environment)**, and *Active* should name the model the
next turn will call.

Then send any message. A real reply streams in a few words at a time; a
fallback reply arrives all at once and begins "No model is connected yet".

## Choosing a model

`gemini-flash-latest` is a rolling alias that follows Google's current free
Flash, so the app does not break the day a dated model retires. To pin one
instead, either set `GEMINI_MODEL` in the environment or type a model name into
Settings -> Model, which takes effect on the next turn without a restart.

To list what your key can reach:

```bash
curl -s https://generativelanguage.googleapis.com/v1beta/models \
  -H "X-goog-api-key: $GEMINI_API_KEY" | grep '"name"'
```

## Speed and thinking

Flash is a thinking model, and thinking costs both tokens and seconds before
the first word appears -- on a short console reply it can be more than thirty
times the tokens of the answer itself. Autora therefore asks for no thinking by
default. Set `GEMINI_THINKING_BUDGET` to a token count for harder work, or to
`-1` to let the model decide.

## When something goes wrong

Errors are shown in the thread rather than swallowed, because a canned reply in
place of a real one is indistinguishable from the model working. The common
ones:

| What you see | What it means |
| --- | --- |
| *high demand ... try again later* | Google is busy. Autora already retries three times with backoff; if you still see it, the spike outlasted them. |
| *prepayment credits are depleted* | The key's quota or credit is used up. Top up or switch projects at <https://ai.studio/projects>. |
| *API key not valid* | The key is wrong, or belongs to a project without the Generative Language API enabled. |
| *No model is connected yet* | No `GEMINI_API_KEY` reached the server, or it was set after the server started. |

## What the model is told

Each turn sends, in this order:

- the standing system prompt from Settings, plus whichever memory records this
  turn recalled, as a system instruction;
- the last 24 turns of this session, rebuilt from the event log so what the
  model sees matches what the thread shows;
- the new message.

Replies stream back as `turn.agent.text` deltas, which is what makes the thread
fill as the model writes and the mark in the margin animate while it does.
