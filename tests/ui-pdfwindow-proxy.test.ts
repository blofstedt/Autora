/**
 * The PDF window behind a login proxy, as on Umbrel: every request needs the
 * proxy's cookie, or it is sent to the login page. The editor's frame has no
 * origin of its own, so the requests it makes itself carry no cookies; it
 * used to fetch its script and styles that way, and stayed white. It must
 * need nothing but its own page, and pdf.js's data must come through the app.
 *
 * Needs the editor built (npm run build); skips without a browser.
 *
 *   npx tsx tests/ui-pdfwindow-proxy.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import { chromium, type Frame } from "playwright-core";
import { PDFDocument, PDFHexString, PDFName, PDFNumber, PDFOperator, PDFOperatorNames, PDFString, StandardFonts } from "@cantoo/pdf-lib";
import { sleep, startApp } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

/** Whether the page has been drawn: dark pixels on the editor's canvas. */
async function drawn(frame: Frame): Promise<boolean> {
  return frame.evaluate(() => [...document.querySelectorAll("canvas")].some((c) => {
    if (c.width < 100) return false;
    const data = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let ink = 0;
    for (let i = 0; i < data.length; i += 4 * 13) if (data[i] < 100) ink++;
    return ink > 20;
  }));
}

async function main() {
  const exe = process.env.AUTORA_BROWSER_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  if (!fs.existsSync(exe)) { console.log("  skip  no browser here"); return; }
  if (!fs.existsSync("dist/pdf-editor/index.html")) { console.log("  skip  the editor is not built (npm run build)"); return; }
  const app = await startApp();
  const target = new URL(app.base);

  // The login proxy: no cookie, no app.
  const refused: string[] = [];
  const passedOn: string[] = [];
  const gate = http.createServer((req, res) => {
    if (!/(^|;\s*)proxy_token=1/.test(req.headers.cookie ?? "")) {
      refused.push(req.url ?? "");
      res.writeHead(302, { Location: "/login" });
      return res.end();
    }
    passedOn.push(req.url ?? "");
    const up = http.request({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    req.pipe(up);
  });
  gate.on("upgrade", (req, sock, head) => {
    const up = net.connect(Number(target.port), target.hostname, () => {
      up.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`);
      up.write(head);
      up.pipe(sock);
      sock.pipe(up);
    });
    up.on("error", () => sock.destroy());
    sock.on("error", () => up.destroy());
  });
  await new Promise<void>((r) => gate.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(gate.address() as net.AddressInfo).port}`;

  const browser = await chromium.launch({ executablePath: exe });
  try {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const p = doc.addPage([612, 792]);
    p.drawText("Lease agreement", { x: 50, y: 700, size: 40, font });
    // A line in a font that uses one of the predefined CMaps: pdf.js always
    // asks for that data (pdfjs/cmaps/), it has no other copy of it.
    const cjk = doc.context.register(doc.context.obj({
      Type: "Font", Subtype: "Type0", BaseFont: "KozMinPr6N-Regular", Encoding: "UniJIS-UCS2-H",
      DescendantFonts: [doc.context.obj({
        Type: "Font", Subtype: "CIDFontType0", BaseFont: "KozMinPr6N-Regular",
        CIDSystemInfo: { Registry: PDFString.of("Adobe"), Ordering: PDFString.of("Japan1"), Supplement: 6 },
        FontDescriptor: doc.context.obj({ Type: "FontDescriptor", FontName: "KozMinPr6N-Regular", Flags: 4, FontBBox: [0, -150, 1000, 880], ItalicAngle: 0, Ascent: 880, Descent: -120, CapHeight: 700, StemV: 80 }),
      })],
    }));
    p.node.setFontDictionary(PDFName.of("FJ"), cjk);
    p.pushOperators(PDFOperator.of(PDFOperatorNames.BeginText), PDFOperator.of(PDFOperatorNames.SetFontAndSize, [PDFName.of("FJ"), PDFNumber.of(40)]),
      PDFOperator.of(PDFOperatorNames.MoveText, [PDFNumber.of(50), PDFNumber.of(600)]),
      PDFOperator.of(PDFOperatorNames.ShowText, [PDFHexString.of("65E5672C")]), PDFOperator.of(PDFOperatorNames.EndText));
    const up = await fetch(`${app.base}/api/artifacts`, {
      method: "POST", headers: { "Content-Type": "application/octet-stream", "X-File-Name": "lease.pdf" }, body: new Uint8Array(await doc.save()),
    });
    const file = (await up.json()).artifact.id;
    const s = await app.newSession("Lease");
    let n = 0;
    app.decide = () => n++ === 0 ? { tools: [{ name: "pdf_look", args: { file } }] } : { text: "Here it is." };
    await app.turn(s, "show me the lease");

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addCookies([{ name: "proxy_token", value: "1", url: base, sameSite: "Lax" }]);
    const page = await context.newPage();
    await page.goto(`${base}/?session=${s}`);

    await test("the editor opens and draws the page, with nothing of its own turned away", async () => {
      await page.waitForSelector(".app-pane .pdf-window", { timeout: 15_000 });
      let editor: Frame | undefined;
      for (let i = 0; i < 100 && !editor; i++) {
        editor = page.frames().find((f) => f.url().includes("/pdf-editor/"));
        if (!editor) await sleep(100);
      }
      assert.ok(editor, "the editor's frame is there");
      for (let i = 0; i < 100 && !(await drawn(editor)); i++) await sleep(200);
      assert.deepEqual(refused, [], "every request reached the app");
      assert.ok(await drawn(editor), "the page is drawn");
      for (let i = 0; i < 50 && !passedOn.some((u) => u.startsWith("/pdf-editor/pdfjs/")); i++) await sleep(200);
      assert.deepEqual(refused, [], "nothing pdf.js asked for was turned away");
      assert.ok(passedOn.some((u) => u.startsWith("/pdf-editor/pdfjs/")), "pdf.js's data came through the app's page");
    });
  } finally {
    await browser.close();
    gate.close();
    await app.stop();
  }
  console.log(`\n${passed} passed`);
  process.exit(0);
}
main().catch((err) => { console.error(err); process.exit(1); });
