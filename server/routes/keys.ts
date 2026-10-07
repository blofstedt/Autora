/**
 * Secrets, saved sign-ins, provider model lists and key checks, and the usage ledger.
 *
 * Moved out of server.ts (docs/REVIEW.md C1); nothing changed in the move.
 * What the routes need from the rest of the server arrives in `deps`.
 */

import type { Express, Request, Response } from "express";
import { billingSummary } from "../billing";
import { deleteLogin, describeCredentials, saveLogin, setIdentity } from "../credentials";
import { listModels } from "../llm";
import { PROVIDERS, modelsFor, rememberModels } from "../providers";
import {
  SECRET_PRESETS, baseUrlFor, clearUsage, deleteSecret, getSecret, keyFor, listSecrets, save, setSecret,
} from "../state";
import { refreshAllVendorMoney, vendorMoneyStale } from "../vendor-money";

export function keyRoutes(app: Express) {
  // 10a. Secrets Store Management
  app.get("/api/secrets", (req: Request, res: Response) => {
    res.json(listSecrets());
  });

  app.get("/api/secrets/presets", (req: Request, res: Response) => {
    res.json(SECRET_PRESETS);
  });

  app.post("/api/secrets/reveal", (req: Request, res: Response) => {
    const name = String(req.body?.name ?? "").trim();
    if (!name) return res.status(400).json({ error: "Secret name is required" });
    const value = getSecret(name);
    if (value === null) return res.status(404).json({ error: "Secret not found" });
    res.json({ ok: true, name, value });
  });

  app.post("/api/secrets", (req: Request, res: Response) => {
    const name = String(req.body?.name ?? "").trim().toUpperCase();
    const value = String(req.body?.value ?? "");
    if (!name) return res.status(400).json({ error: "Secret variable name is required" });
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(name)) {
      return res.status(400).json({ error: "Name must be a valid environment variable identifier (letters, digits, and underscores, starting with a letter or underscore)" });
    }
    if (!value && value !== "") {
      return res.status(400).json({ error: "Secret value is required" });
    }
    setSecret(name, value);
    save();
    res.json({ ok: true, secrets: listSecrets() });
  });

  app.delete("/api/secrets/:name", (req: Request, res: Response) => {
    const name = req.params.name;
    deleteSecret(name);
    save();
    res.json({ ok: true, secrets: listSecrets() });
  });

  /* 10a'. Credentials: the person's details and sign-ins, typed in by the
     agent through placeholders. Values go in; only masked forms come out.
     See server/credentials.ts. */
  app.get("/api/credentials", (_req: Request, res: Response) => {
    res.json(describeCredentials());
  });

  app.put("/api/credentials/identity", (req: Request, res: Response) => {
    setIdentity(req.body && typeof req.body === "object" ? req.body : {});
    res.json(describeCredentials());
  });

  app.post("/api/credentials/logins", (req: Request, res: Response) => {
    const body = req.body ?? {};
    const text = (v: unknown) => (typeof v === "string" ? v : undefined);
    try {
      saveLogin({
        site: String(body.site ?? ""),
        previous: text(body.previous),
        username: text(body.username),
        password: text(body.password),
        authenticator: text(body.authenticator),
      });
    } catch (err: any) {
      return res.status(400).json({ error: err?.message ?? String(err) });
    }
    res.json(describeCredentials());
  });

  app.delete("/api/credentials/logins/:site", (req: Request, res: Response) => {
    deleteLogin(req.params.site);
    res.json(describeCredentials());
  });

  // 10b. Provider models and key checks

  /**
   * The models a vendor says it has.
   *
   * Refreshing asks the vendor directly, which is the only way to keep up with
   * a catalogue that changes weekly -- and for OpenRouter, the only practical
   * way to offer it at all. Whatever comes back is remembered for pricing, so
   * a model discovered here is billed from the vendor's own numbers rather
   * than from nothing.
   */
  app.get("/api/providers/:id/models", async (req: Request, res: Response) => {
    const id = req.params.id;
    const spec = PROVIDERS.find((p) => p.id === id);
    if (!spec) return res.status(404).json({ detail: `Unknown provider "${id}".` });

    if (req.query.refresh !== "1") {
      return res.json({ provider: id, models: modelsFor(id), refreshed: false });
    }
    if (!spec.listable) {
      return res.status(400).json({ detail: `${spec.label} does not publish a model list.` });
    }

    // No key requirement here: OpenRouter publishes its catalogue (and its
    // prices) to anyone, which is exactly when browsing the list is most
    // useful -- before signing up. Vendors that do want a key say so
    // themselves, and their refusal is more accurate than our guess at it.
    const key = keyFor(id);

    try {
      const models = await listModels(id, key, baseUrlFor(id));
      rememberModels(id, models);
      res.json({ provider: id, models: modelsFor(id), refreshed: true, found: models.length });
    } catch (err: any) {
      res.status(502).json({ detail: `Could not reach ${spec.label}: ${err?.message ?? err}` });
    }
  });

  /** Does this key work? Checked before it is trusted with a conversation, so
      a typo is found here rather than as a failed turn ten minutes later. */
  app.post("/api/providers/:id/test", async (req: Request, res: Response) => {
    const id = req.params.id;
    const spec = PROVIDERS.find((p) => p.id === id);
    if (!spec) return res.status(404).json({ detail: `Unknown provider "${id}".` });

    // A key typed but not yet saved can be tested as it stands, so nobody has
    // to save a guess to find out whether it was right.
    const candidate =
      typeof req.body?.key === "string" && req.body.key.trim()
        ? req.body.key.trim()
        : keyFor(id);
    if (!candidate && id !== "local") {
      return res.status(400).json({ detail: `No ${spec.label} key to check.` });
    }

    try {
      // The catalogue is public information whichever key asked for it, so a
      // successful check doubles as a model refresh -- which is what someone
      // pasting a key is about to want anyway.
      const models = await listModels(id, candidate, baseUrlFor(id));
      rememberModels(id, models);
      res.json({ ok: true, models: models.length });
    } catch (err: any) {
      res.status(400).json({ ok: false, detail: err?.message ?? String(err) });
    }
  });

  // 10c. Billing

  /** What has been spent, and on what. Read-only: the ledger is written by
      the turns themselves, one row each, as they finish. */
  app.get("/api/usage", (req: Request, res: Response) => {
    /* Every vendor's balance is what the real totals are read from, and those
       are fetched behind the answer rather than in front of it: this route is
       asked at the end of every turn and on every window focus, and it must
       never wait on somebody else's server to answer. A stale reading starts
       a refresh of all of them; this reply carries what is already known. */
    if (vendorMoneyStale()) void refreshAllVendorMoney();
    res.json(billingSummary());
  });

  /** Start the count again -- after settling a bill, or after a spell of
      testing that should not colour the month. Deliberately a separate call
      rather than a settings field, because it throws away history. */
  app.post("/api/usage/reset", (req: Request, res: Response) => {
    clearUsage();
    res.json(billingSummary());
  });
}
