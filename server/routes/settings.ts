/**
 * The settings API: what the page reads and writes in Settings (model, tools, appearance, speech, retention, loop, MCP, time zone...).
 *
 * Moved out of server.ts (docs/REVIEW.md C1); nothing changed in the move.
 * What the routes need from the rest of the server arrives in `deps`.
 */

import type { Express, Request, Response } from "express";
import { mergeAutomation } from "../automation";
import { mergeCaptcha } from "../captcha";
import { dictationStatus } from "../dictation";
import { AUTO_ORDER, PRICES_CHECKED, PROVIDERS, modelsFor } from "../providers";
import { mergePush, readyChannels } from "../push";
import { mergeProactivity } from "../quiet";
import { forgetSpeech, speakStream, speechStatus, speak as synthesise } from "../speech";
import { FONTS, THEMES, applyTimezone, baseUrlFor, fastModelFor, keyFor, keySource, machineTimezone, maskKey, mergeAppearance, mergeLoop, mergeRetention, mergeSpeech, modelFor, resolveProvider, save, setKey, state, stateFilePath, validTimezone } from "../state";
import { groupStates, toolSettings, updateToolSettings } from "../tools";
import { forgetVendorMoney, setTopUp } from "../vendor-money";
import { mergeVerify } from "../verify";
import type { WebPush } from "../webpush";

export function settingsRoutes(app: Express, deps: {
  /** Which model reads CAPTCHA pictures, in words, or null. */
  captchaVisionLabel: () => string | null;
  webPush: WebPush;
  /** Notifications held for quiet hours go out (the clock may have moved). */
  flushHeldPushes: () => void;
  /** Every scheduled job is planned again, and kept. */
  replanJobs: () => void;
  /** The app window is closed in every chat that has one open. */
  stopPreviews: () => Promise<void>;
}) {
  const { captchaVisionLabel, webPush, flushHeldPushes, replanJobs, stopPreviews } = deps;
  // 10. Settings API

  /** One payload for both reads and writes -- two hand-kept copies drifted,
      and the PATCH one had already lost the Anthropic row. */
  const settingsPayload = () => {
    const active = resolveProvider();
    const activeSpec = PROVIDERS.find((p) => p.id === active.provider);

    /** What the running model charges, per million tokens. */
    const activePrice = () => {
      const models = modelsFor(active.provider);
      const spec = models.find((m) => m.id === active.model);
      if (!spec || spec.priced === false) {
        return `No published price for ${active.model} — its turns are counted but not billed.`;
      }
      return `$${spec.input} in / $${spec.output} out per 1M tokens`;
    };

    /* Every vendor Autora can talk to, with its key state and its models, so
       the panel can be built from one fetch. The key itself never leaves the
       server: what travels is whether one is set, where it came from, and
       four characters of it -- enough to recognise the key you meant to use,
       useless to anyone who intercepts it. */
    const catalog = PROVIDERS.map((spec) => {
      const source = keySource(spec.id);
      return {
        id: spec.id,
        label: spec.label,
        note: spec.note,
        kind: spec.kind,
        key_hint: spec.keyHint,
        keys_url: spec.keysUrl,
        base_url: baseUrlFor(spec.id),
        default_base_url: spec.baseUrl,
        default_model: spec.defaultModel,
        listable: spec.listable,
        open_ended: Boolean(spec.openEnded),
        needs_key: spec.id !== "local",
        /* Whether this vendor publishes a balance at all. The panel uses it to
           offer the "paid in" box only where the figure can be turned into a
           spend, rather than collecting a number it can never use. */
        balance_endpoints: Boolean(spec.balance),
        key: {
          set: Boolean(keyFor(spec.id)),
          source,
          masked: maskKey(keyFor(spec.id)),
          env_names: spec.envKeys,
        },
        model: modelFor(spec.id),
        fast_model: fastModelFor(spec.id),
        models: modelsFor(spec.id),
      };
    });

    return {
      provider: state.provider,
      // The legacy single-model field still answers "what will run", which is
      // what older clients did with it.
      model: active.model,
      base_url: active.provider ? baseUrlFor(active.provider) : "",
      providers: ["auto", ...PROVIDERS.map((p) => p.id)],
      auto_order: AUTO_ORDER,
      system_prompt: state.systemPrompt,
      system_prompt_limit: 8000,
      timezone: state.timezone,
      machine_timezone: machineTimezone(),
      catalog,
      prices_checked: PRICES_CHECKED,
      budget_usd: state.budgetUsd,
      /* Whose top-up this is, so the panel edits that vendor's account rather
         than whichever one happens to be selected when the page is opened. */
      top_up_usd: active.provider ? (state.topUps[active.provider] ?? null) : null,
      top_up_provider: active.provider || null,
      loop: { ...state.loop },
      verify: { ...state.verify },
      retention: { ...state.retention },
      automation: { ...state.automation },
      state_file: stateFilePath(),
      credentials: PROVIDERS.filter((spec) => spec.id !== "local").map((spec) => {
        const source = keySource(spec.id);
        return {
          name: spec.id,
          label: spec.label,
          note: spec.note,
          role: "model" as const,
          set: source !== null,
          hint:
            source === "app"
              ? `Saved in app (${maskKey(keyFor(spec.id))})`
              : source === "env"
                ? "From the server environment"
                : spec.keyHint,
        };
      }),
      active: {
        // What the next turn will actually call, rather than a name written
        // down once and left behind by every model change since.
        model: active.model || null,
        endpoint: active.provider ? baseUrlFor(active.provider) : null,
        provider: activeSpec?.label ?? null,
        // Not the name again -- that is already on the line above. What is
        // worth saying here is what this choice costs, which is the fact the
        // billing card is about to be counting with.
        hint: active.problem ?? activePrice(),
        // Whether a turn sent now would reach a model. The chat shows its
        // setup card until this is true.
        connected: Boolean(active.provider) && !active.problem,
      },
    };
  };

  /* The tool section is assembled separately because availability is asked of
     the world -- is Chromium installed, is a relay dialled in -- which is
     async, and the rest of the payload is not. */
  const settingsWithTools = async () => ({
    ...settingsPayload(),
    appearance: { ...state.appearance, themes: THEMES, fonts: FONTS },
    /* Whether there is a voice at all, so the panel can say where it comes
       from and offer the voices it has. A voice chosen in the panel wins over
       the environment, the way every other setting here does. */
    speech: await speechStatus(false, state.speech.voice || undefined),
    /* What would answer a picture challenge, so the panel can say so before
       anyone meets one: the backends, the model that reads pictures, and
       whether the person's own solver is configured at all. Never the key. */
    captcha: {
      ...state.captcha,
      backends: [...state.captcha.backends],
      remoteKeySet: Boolean(state.captcha.remoteKey),
      remoteKey: undefined,
      vision: captchaVisionLabel(),
    },
    /* Two times of day on their clock, so the panel can show when the agent
       keeps its own initiative to itself. */
    proactivity: { ...state.proactivity },
    /* Where news reaches the phone. The two tokens as whether they are set
       and where from, never the tokens themselves. */
    push: {
      on: { ...state.push.on },
      ready: readyChannels(webPush),
      /* The installed app's own notifications: the key a browser subscribes
         with, and which devices have. Endpoints are never sent back. */
      web: { publicKey: webPush.publicKey(), devices: webPush.list() },
    },
    tools: {
      config: toolSettings(),
      groups: await groupStates(),
    },
  });

  app.get("/api/settings", async (req: Request, res: Response) => {
    res.json(await settingsWithTools());
  });

  app.patch("/api/settings", async (req: Request, res: Response) => {
    const body = req.body ?? {};
    const known = new Set(["auto", ...PROVIDERS.map((p) => p.id)]);

    if (body.provider !== undefined) {
      if (!known.has(body.provider)) {
        return res.status(400).json({ detail: `Unknown provider "${body.provider}".` });
      }
      state.provider = body.provider;
    }

    // Per-provider choices. The flat `model` / `base_url` fields still work and
    // apply to whichever provider is selected, so an older client that knows
    // nothing about the catalogue can still change the model it is using.
    const target = state.provider === "auto" ? resolveProvider().provider : state.provider;

    if (body.models && typeof body.models === "object") {
      for (const [id, model] of Object.entries(body.models)) {
        if (!known.has(id) || typeof model !== "string") continue;
        state.models[id] = model.trim();
      }
    } else if (typeof body.model === "string" && target) {
      state.models[target] = body.model.trim();
    }

    /* Talk mode's own model. An empty string is a real choice here -- it says
       answer spoken turns with the main model -- so it is stored, not ignored. */
    if (body.fast_models && typeof body.fast_models === "object") {
      for (const [id, model] of Object.entries(body.fast_models)) {
        if (!known.has(id) || typeof model !== "string") continue;
        state.fastModels[id] = model.trim();
      }
    }

    if (body.base_urls && typeof body.base_urls === "object") {
      for (const [id, url] of Object.entries(body.base_urls)) {
        if (!known.has(id) || typeof url !== "string") continue;
        state.baseUrls[id] = url.trim();
      }
    } else if (typeof body.base_url === "string" && target) {
      state.baseUrls[target] = body.base_url.trim();
    }

    if (typeof body.system_prompt === "string") {
      state.systemPrompt = body.system_prompt.slice(0, 8000);
    }

    /* The clock schedules and quiet hours are read on. A name the runtime does
       not know is refused rather than taken as UTC, and empty goes back to the
       machine's. Every job is planned again: its next run is a moment in the
       new zone, not the old one. */
    if (typeof body.timezone === "string") {
      const tz = body.timezone.trim();
      if (tz && !validTimezone(tz)) {
        return res.status(400).json({ detail: `"${tz}" is not a time zone (try Europe/Stockholm).` });
      }
      if (tz !== state.timezone) {
        state.timezone = tz;
        applyTimezone(tz);
        replanJobs();
        flushHeldPushes();
      }
    }

    // A key arrives only when someone typed one: an untouched field sends
    // nothing, and an empty string means "remove it", not "save a blank".
    if (body.credentials && typeof body.credentials === "object") {
      for (const [name, value] of Object.entries(body.credentials)) {
        if (typeof value !== "string") continue;
        setKey(name, value);
        // A key taken out takes that vendor's last balance reading with it, so
        // no bar can go on showing money for an account that is no longer set
        // up here. A name that is not a keyed vendor falls through.
        if (!value.trim()) forgetVendorMoney(name);
      }
    }

    if (body.budget_usd !== undefined) {
      const raw = body.budget_usd;
      const amount = raw === null || raw === "" ? null : Number(raw);
      if (amount !== null && (!Number.isFinite(amount) || amount < 0)) {
        return res.status(400).json({ detail: "The monthly budget must be a positive amount." });
      }
      state.budgetUsd = amount;
    }

    /* What has been paid in at the vendor. This is half of the real total --
        spend is this less the balance left -- and it is typed in rather than
        worked out because everything before the first balance the console ever
        read is history it never saw. Later payments need no hand: a balance
        that jumps up is one, and is folded in as it is observed. */
    if (body.top_up_usd !== undefined) {
      const raw = body.top_up_usd;
      const amount = raw === null || raw === "" ? null : Number(raw);
      if (amount !== null && (!Number.isFinite(amount) || amount < 0)) {
        return res.status(400).json({ detail: "The amount topped up must be a positive amount." });
      }
      /* Per vendor, and the panel says which one: the money belongs to the
         account it was paid into, and writing it against another provider's
         balance is how the wrong total gets shown. */
      const target = body.top_up_provider ?? resolveProvider().provider;
      if (target) setTopUp(target, amount);
    }

    /* Which tools the agent has, and how tightly each is gated. Turning a
       group off here removes its tools from the model's schema on the very
       next turn and changes what the agent is told it can do -- both come from
       the one registry, so the panel cannot promise something the schema does
       not deliver. */
    if (body.tools && typeof body.tools === "object") {
      updateToolSettings(body.tools);
      if (!toolSettings().app.enabled) {
        await stopPreviews();
      }
    }
    if (body.appearance && typeof body.appearance === "object") mergeAppearance(state.appearance, body.appearance);
    /* How a picture challenge is answered. The key for a self-hosted solver
       comes from the panel like any other and is never sent back. */
    if (body.captcha && typeof body.captcha === "object") mergeCaptcha(state.captcha, body.captcha);
    if (body.proactivity && typeof body.proactivity === "object") {
      mergeProactivity(state.proactivity, body.proactivity);
      // Quiet hours switched off or moved: whatever they held can go now.
      flushHeldPushes();
    }
    /* Phone notifications: which kinds of news are sent. Where they go is the
       devices that asked, kept by server/webpush.ts. */
    if (body.push && typeof body.push === "object") {
      mergePush(state.push, body.push);
    }
    /* Which voice speaks. It is checked while Deepgram is reachable at all: a
       typo saved here would otherwise only show up at the next sentence, in the
       middle of a conversation, where it reads as the app being broken rather
       than as a setting being wrong. With Deepgram unreachable the choice is
       kept unverified instead, since only a network that came back can settle
       it. */
    if (body.speech && typeof body.speech === "object") {
      const wanted = typeof body.speech.voice === "string" ? body.speech.voice.trim() : "";
      if (wanted && wanted !== state.speech.voice) {
        const listing = await speechStatus(true, wanted);
        if (listing.available && listing.voices.length > 0 && !listing.voices.some((v) => v.id === wanted)) {
          return res.status(400).json({ detail: "Deepgram has no voice called " + wanted + "." });
        }
      }
      mergeSpeech(state.speech, body.speech);
      forgetSpeech();
    }
    /* When a turn is called a loop, and how much is kept. Both used to be
       constants in the source: a turn could be stopped by a rule nobody could
       see, and nothing ever deleted anything. */
    if (body.loop && typeof body.loop === "object") mergeLoop(state.loop, body.loop);
    if (body.verify && typeof body.verify === "object") mergeVerify(state.verify, body.verify);
    if (body.retention && typeof body.retention === "object") mergeRetention(state.retention, body.retention);
    /* What automated runs may cost. Enforced in the scheduler and again in
       the agent loop -- see server/automation.ts. */
    if (body.automation && typeof body.automation === "object") mergeAutomation(state.automation, body.automation);

    save();
    res.json(await settingsWithTools());
  });


  /* The console's own voice. A GET says whether there is a voice service and
     which voices it offers; a POST turns one fragment of speech into an audio
     file the page can play.

     The page asks this server rather than Deepgram directly because it has no
     key and should not be given one: a key in the page is a key in every
     browser that opens the app. Going through here also means the audio arrives
     from the origin the page already trusts. */
  app.get("/api/speech", async (_req: Request, res: Response) => {
    /* The saved voice is put to the service as a preference, and what comes
       back is the voice that will actually be heard: a voice Deepgram has
       never heard of -- one saved while a local voice server was speaking,
       say -- is not passed through, and the panel should show the voice it
       would really use rather than a name that would be refused at the next
       sentence. */
    const status = await speechStatus(false, state.speech.voice || undefined);
    res.json({
      available: status.available,
      provider: status.provider,
      voice: status.voice,
      voices: status.voices,
      reason: status.reason,
      url: status.url,
      liveThinking: state.speech.liveThinking,
      liveView: state.speech.liveView,
      /* Whether the microphone can be opened once for the whole of talk mode
         instead of the browser's recogniser, which re-arms -- and beeps -- on
         every phrase. The page asks this and chooses; nothing here is required
         for an install with no key. */
      dictation: dictationStatus(),
    });
  });

  app.post("/api/speech", async (req: Request, res: Response) => {
    const text = String(req.body?.text ?? "");
    if (!text.trim()) return res.status(400).json({ error: "Nothing to say." });
    try {
      const utterance = await synthesise(text, {
        voice: typeof req.body?.voice === "string" ? req.body.voice : state.speech.voice,
        speed: req.body?.speed,
      });
      // Never cached: the same sentence in another voice, or after a voice
      // change, must not come back as the old recording.
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", utterance.contentType);
      res.setHeader("X-Autora-Voice", utterance.voice);
      res.send(Buffer.from(utterance.audio));
    } catch (err: any) {
      /* 503, not 500: "there is no voice service right now" is a state the
         page already knows how to live with -- it says the sentence with the
         browser's own voice instead. */
      res.status(503).json({ error: String(err?.message ?? err) });
    }
  });

  /* The same fragment, but as a stream: raw PCM as it is rendered, so a whole
     reply can be one rendering and still start in half a second. This is what
     the page uses for the replies it narrates -- a request per sentence is a
     request per draw of the voice, and the voice changed with every one. */
  app.post("/api/speech/stream", async (req: Request, res: Response) => {
    const text = String(req.body?.text ?? "");
    if (!text.trim()) return res.status(400).json({ error: "Nothing to say." });
    let utterance;
    try {
      /* Nothing has been written when this throws, so a refusal still arrives
         as a status the page can read and fall back on. */
      utterance = await speakStream(text, {
        voice: typeof req.body?.voice === "string" ? req.body.voice : state.speech.voice,
        speed: req.body?.speed,
      });
    } catch (err: any) {
      return res.status(503).json({ error: String(err?.message ?? err) });
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", utterance.contentType);
    res.setHeader("X-Autora-Voice", utterance.voice);
    const reader = utterance.stream.getReader();
    /* A barge-in, a closed tab or a page that navigated away: stop paying for
       the rest of a rendering nobody will hear. */
    const abandon = () => { void reader.cancel().catch(() => undefined); };
    res.on("close", abandon);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(Buffer.from(value))) {
          await new Promise<void>((resolve) => res.once("drain", resolve));
        }
        if (res.writableEnded || res.destroyed) break;
      }
      res.end();
    } catch (err: any) {
      res.destroy();
    } finally {
      res.off("close", abandon);
    }
  });
}
