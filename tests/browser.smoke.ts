/** Optional desktop Chromium smoke test: synthetic microphone + normalized mock provider.
 * Install with npx playwright install chromium. Never establishes real AI accuracy. */
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createApp } from "../apps/server/src/app.js";
import type {
  SpeechProvider,
  ProviderCallbacks,
} from "../apps/server/src/providers/speech-provider.js";
import type { Start } from "../packages/shared/protocol.js";
class BrowserMock implements SpeechProvider {
  readonly id = "browser-test-mock";
  connections = 0;
  frames = 0;
  capabilities() {
    return { translation: true, diarization: true, languages: ["bg", "en"] };
  }
  async initialize() {}
  async create(_key: string, options: Start, cb: ProviderCallbacks) {
    this.connections++;
    cb.state("connected");
    return {
      audio: () => {
        this.frames++;
        if (this.frames <= 2) {
          cb.segment({
            id: "source",
            revision: this.frames,
            final: this.frames === 2,
            original: "Здравейте всички.",
            translated: "",
            sourceLanguage: "bg",
            targetLanguage: options.target,
            speakerId: "1",
            startMs: 0,
            endMs: 1000,
            channel: "original",
          });
          cb.segment({
            id: "translation",
            revision: this.frames,
            final: this.frames === 2,
            original: "",
            translated: "Hello everyone. Welcome to our meeting.",
            sourceLanguage: "bg",
            targetLanguage: options.target,
            speakerId: "1",
            channel: "translation",
          });
        }
        return true;
      },
      end: async () => {
        cb.state("ended");
      },
    };
  }
}
const provider = new BrowserMock();
const { app } = await createApp(provider, {
  HOST_PASSWORD: "browser-test-host",
  LOG_LEVEL: "silent",
});
await app.listen({ host: "127.0.0.1", port: 0 });
const address = app.server.address();
assert.ok(address && typeof address !== "string");
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({
  headless: true,
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
  ],
});
try {
  const context = await browser.newContext({
    permissions: ["microphone"],
    viewport: { width: 1440, height: 1100 },
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin);
  await page.locator("#password").fill("browser-test-host");
  await page.locator("#sign-in").click();
  await page.locator("#controls").waitFor({ state: "visible" });
  await page.locator("#key").fill("synthetic-test-key");
  await page.locator("#start").click();
  await page
    .getByText("Hello everyone. Welcome to our meeting.", { exact: true })
    .waitFor();
  assert.ok(provider.frames >= 1);
  assert.equal(await page.locator("#key").inputValue(), "");
  assert.equal(provider.connections, 1);
  await page.locator("#pause").click();
  assert.equal(await page.locator("#pause").textContent(), "Resume");
  await page.locator("#pause").click();
  const viewerUrl = await page.locator("#share").inputValue();
  const viewer = await context.newPage();
  await viewer.goto(viewerUrl);
  await viewer
    .getByText("Hello everyone. Welcome to our meeting.", { exact: true })
    .waitFor();
  assert.equal(await viewer.locator("#controls").isVisible(), false);
  assert.equal(
    await viewer.locator(".caption-meta button").first().isDisabled(),
    true,
  );
  assert.equal(provider.connections, 1);
  await page.screenshot({
    path: "/tmp/linguaroom-desktop.png",
    fullPage: true,
  });
  await viewer.setViewportSize({ width: 390, height: 844 });
  await viewer.screenshot({
    path: "/tmp/linguaroom-mobile.png",
    fullPage: true,
  });
  assert.equal(
    await viewer.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.locator("#stop").click();
  await page
    .getByText("Meeting ended. API key reference discarded.", { exact: true })
    .waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "Browser smoke passed: fake microphone AudioWorklet, PCM relay, captions, pause/resume, read-only viewer, mobile layout, stop; no Soniox call.",
  );
  await context.close();
} finally {
  await browser.close();
  await app.close();
}
