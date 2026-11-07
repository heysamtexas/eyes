// End-to-end smoke test: serves the app, loads a photo in headless Chrome, drives the gaze
// through window.eyesTest and checks the eyes actually move. Screenshots land in test-output/.
//
//   npm run smoke                                  # Mona Lisa sample
//   npm run smoke -- path/to/photo.jpg             # your own photo
//   npm run smoke -- photo.jpg --video face.y4m    # also feed a fake webcam clip
//
// Uses Playwright's Chromium; set CHROME_PATH to use another Chrome binary.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { createServer } from "vite";

const args = process.argv.slice(2);
const videoAt = args.indexOf("--video");
const video = videoAt >= 0 ? resolve(args.splice(videoAt, 2)[1]) : undefined;
const photo = resolve(args[0] ?? "public/sample.jpg");
const outDir = resolve("test-output");
mkdirSync(outDir, { recursive: true });

const server = await createServer({ server: { port: 0 }, logLevel: "error" });
await server.listen();
const url = server.resolvedUrls.local[0];

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    ...(video ? [`--use-file-for-fake-video-capture=${video}`] : []),
  ],
});

let failed = false;
const check = (ok, msg) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) failed = true;
};

try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(url);
  // Deterministic run: no spontaneous blinks or reactions.
  await page.evaluate(() => {
    for (const id of ["autoBlink", "reactions", "mirrorBlink"]) document.getElementById(id).checked = false;
  });
  await page.setInputFiles("#file", photo);
  await page.waitForSelector("#portrait:not([hidden])", { timeout: 60_000 });

  const faces = (await page.evaluate(() => window.eyesTest.layers().length - 1)) / 2;
  check(faces >= 1, `found ${faces} face(s); status: "${await page.textContent("#status")}"`);

  await page.waitForFunction(() => document.getElementById("camera").textContent === "Stop camera", null, { timeout: 30_000 })
    .then(() => check(true, "camera started automatically"))
    .catch(() => check(false, "camera did not start"));

  const shoot = async (name, viewer) => {
    await page.evaluate((v) => window.eyesTest.setViewer(v), viewer);
    await page.waitForTimeout(800);
    const data = await page.evaluate(() => document.getElementById("portrait").toDataURL("image/png"));
    writeFileSync(`${outDir}/${name}.png`, Buffer.from(data.split(",")[1], "base64"));
    return data;
  };
  const at = (x, y) => ({ x, y, size: 0.08, blink: [0, 0] });
  const left = await shoot("left", at(0.95, 0.5));
  const right = await shoot("right", at(0.05, 0.5));
  await shoot("center", at(0.5, 0.5));
  await shoot("blink", { ...at(0.5, 0.5), blink: [1, 1] });
  check(left !== right, "portrait changes when the viewer moves");

  if (video) {
    await page.evaluate(() => window.eyesTest.setViewer(undefined));
    await page.waitForTimeout(1500);
    await shoot("webcam", undefined);
  }

  const fps = await page.evaluate(
    () => new Promise((done) => {
      let n = 0;
      const t0 = performance.now();
      const tick = () => (++n, performance.now() - t0 < 2000 ? requestAnimationFrame(tick) : done(n / 2));
      requestAnimationFrame(tick);
    }),
  );
  console.log(`     ${fps} fps headless`);
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
  console.log(`     screenshots in ${outDir}`);
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
