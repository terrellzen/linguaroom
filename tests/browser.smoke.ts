/** Desktop Chromium/Firefox smoke test: synthetic microphone + normalized mock provider.
 * Install with npx playwright install chromium. Never establishes real AI accuracy. */
import assert from "node:assert/strict";
import { chromium, firefox } from "playwright";
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
const firefoxTest = process.argv.includes("--firefox");
const browser = firefoxTest
  ? await firefox.launch({
      headless: true,
      firefoxUserPrefs: {
        "media.navigator.streams.fake": true,
        "media.navigator.permission.disabled": true,
        "media.autoplay.default": 0,
      },
    })
  : await chromium.launch({
      headless: true,
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
      ],
    });
try {
  const context = await browser.newContext({
    permissions: firefoxTest ? [] : ["microphone"],
    viewport: { width: 1440, height: 1100 },
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${origin}/?mode=server`);
  await page.locator("#password").fill("browser-test-host");
  await page.locator("#sign-in").click();
  await page.locator("#setup-toggle").click();
  await page.locator("#controls").waitFor({ state: "visible" });
  await page.locator("#key").fill("synthetic-test-key");
  await page.locator(".close-settings").click();
  await page.locator("#start").click();
  await page
    .getByText("Hello everyone. Welcome to our meeting.", { exact: true })
    .waitFor();
  assert.ok(provider.frames >= 1);
  assert.equal(await page.locator("#key").inputValue(), "");
  assert.equal(provider.connections, 1);
  await page.locator("#pause").click();
  await page.waitForFunction(
    () => document.querySelector("#pause")?.textContent === "Resume",
  );
  await page.locator("#pause").click();
  await page.waitForFunction(
    () => document.querySelector("#pause")?.textContent === "Pause",
  );
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
  const standaloneContext = await browser.newContext({
    permissions: firefoxTest ? [] : ["microphone"],
    viewport: { width: 390, height: 844 },
  });
  // Direct capture must work with Web Audio completely unavailable.
  await standaloneContext.addInitScript(() => {
    window.AudioContext = class {
      constructor() {
        throw new Error("Standalone capture must not open playback audio");
      }
    } as unknown as typeof AudioContext;
  });
  let standaloneConnections = 0;
  await standaloneContext.routeWebSocket(
    "wss://stt-rt.soniox.com/transcribe-websocket",
    (ws) => {
      standaloneConnections++;
      let replied = false;
      let configured = false;
      ws.onMessage((message) => {
        if (message === "") {
          ws.send(JSON.stringify({ finished: true }));
          ws.close();
        } else if (typeof message === "string") {
          const config = JSON.parse(message);
          if (config.type === "keepalive") return;
          assert.equal(config.audio_format, "auto");
          assert.equal(config.sample_rate, undefined);
          assert.equal(config.num_channels, undefined);
          configured = true;
        } else if (!replied) {
          assert.ok(
            configured,
            "Provider must receive configuration before encoded audio",
          );
          const header = Buffer.from(message).subarray(0, 4).toString("hex");
          assert.ok(
            ["1a45dfa3", "4f676753"].includes(header),
            "First chunk must contain a WebM or Ogg header",
          );
          replied = true;
          ws.send(
            JSON.stringify({
              tokens: [
                {
                  text: "Hello locally.",
                  is_final: true,
                  speaker: "1",
                  language: "en",
                  start_ms: 0,
                  end_ms: 1000,
                },
                { text: "<end>", is_final: true },
                {
                  text: "Hola localmente.",
                  is_final: true,
                  speaker: "1",
                  language: "es",
                  translation_status: "translation",
                },
                { text: "<end>", is_final: true },
              ],
            }),
          );
        }
      });
    },
  );
  const device = await standaloneContext.newPage();
  const standaloneErrors: string[] = [];
  const apiRequests: string[] = [];
  device.on("pageerror", (error) => standaloneErrors.push(error.message));
  device.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/"))
      apiRequests.push(request.url());
  });
  await device.goto(origin);
  for (const viewport of [
    { width: 568, height: 280 },
    { width: 844, height: 390 },
  ]) {
    await device.setViewportSize(viewport);
    assert.ok(
      await device
        .locator("#captions")
        .evaluate((el) => el.scrollHeight <= el.clientHeight + 1),
      "Idle landscape captions should not scroll",
    );
    await device.locator("#setup-toggle").click();
    const settings = await device.locator("#controls").boundingBox();
    assert.ok(
      settings &&
        settings.y >= 0 &&
        settings.y + settings.height <= viewport.height,
      "Settings dialog stays within landscape viewport",
    );
    await device.locator(".close-settings").click();
  }
  await device.setViewportSize({ width: 390, height: 844 });

  assert.equal(await device.locator("#login").isVisible(), false);
  await device.locator("#setup-toggle").click();
  await device.locator("#key").fill("synthetic-personal-key");
  await device.locator("#remember-key").check();
  await device.reload();
  await device.locator("#setup-toggle").click();
  assert.equal(
    await device.locator("#key").inputValue(),
    "synthetic-personal-key",
  );
  await device.locator(".close-settings").click();
  await device.locator("#start").click();
  await device.getByText("Hola localmente.", { exact: true }).waitFor();
  assert.equal(await device.locator("#controls").isVisible(), false);
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 844, height: 390 },
    { width: 1440, height: 900 },
  ]) {
    await device.setViewportSize(viewport);
    assert.equal(
      await device.evaluate(
        () =>
          document.documentElement.scrollHeight <= innerHeight &&
          document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    const captions = await device.locator("#captions").boundingBox();
    await device.screenshot({ path: `/tmp/linguaroom-${viewport.width}.png` });
    assert.ok(
      captions &&
        captions.height > 40 &&
        captions.y + captions.height <= viewport.height,
    );
  }
  // The document can fit while nested captions still overflow unnecessarily.
  // Check the short conversation itself, plus visible transport/export controls.
  for (const viewport of [
    { width: 844, height: 390 },
    { width: 740, height: 360 },
    { width: 667, height: 320 },
    { width: 568, height: 280 },
    { width: 932, height: 430 },
  ]) {
    await device.setViewportSize(viewport);
    const fit = await device.evaluate(() => {
      const captions = document.querySelector<HTMLElement>("#captions")!;
      const visible = [
        "header",
        ".caption-tools",
        "#exports",
        ".transport",
        "#captions",
      ].every((selector) => {
        const rect = document.querySelector(selector)!.getBoundingClientRect();
        return (
          rect.x >= 0 &&
          rect.y >= 0 &&
          rect.right <= innerWidth + 1 &&
          rect.bottom <= innerHeight + 1
        );
      });
      const transport = document
        .querySelector(".transport")!
        .getBoundingClientRect();
      const exportsFit = Array.from(
        document.querySelector("#exports")!.children,
      ).every((child) => child.getBoundingClientRect().right < transport.left);
      return {
        visible,
        exportsFit,
        overflow: captions.scrollHeight - captions.clientHeight,
        documentOverflow: document.documentElement.scrollHeight - innerHeight,
      };
    });
    await device.screenshot({
      path: `/tmp/linguaroom-landscape-${viewport.width}.png`,
    });
    assert.ok(
      fit.visible,
      `Controls outside landscape viewport ${JSON.stringify(viewport)}`,
    );
    assert.ok(
      fit.overflow <= (firefoxTest ? 2 : 1),
      `Short captions scroll unnecessarily at ${JSON.stringify(viewport)}: ${JSON.stringify(fit)}`,
    );
    assert.ok(fit.documentOverflow <= 1);
    assert.ok(
      fit.exportsFit,
      `Exports overlap meeting buttons at ${JSON.stringify(viewport)}`,
    );
  }
  // Growing transcripts scroll inside their area; the bottom controls stay fixed.
  await device.evaluate(() => {
    const captions = document.querySelector("#captions")!;
    const caption = captions.querySelector("article")!;
    for (let i = 0; i < 30; i++) captions.append(caption.cloneNode(true));
  });
  assert.ok(
    await device
      .locator("#captions")
      .evaluate((el) => el.scrollHeight > el.clientHeight),
  );
  const stopBounds = await device.locator("#stop").boundingBox();
  assert.ok(stopBounds && stopBounds.y + stopBounds.height <= 430);
  await device.evaluate(() => {
    const captions = document.querySelector("#captions")!;
    Array.from(captions.children)
      .slice(2)
      .forEach((child) => child.remove());
  });
  const download = device.waitForEvent("download");
  await device.getByRole("link", { name: "TXT", exact: true }).click();
  assert.equal((await download).suggestedFilename(), "linguaroom.txt");
  await device.screenshot({ path: "/tmp/linguaroom-standalone-desktop.png" });
  await device.setViewportSize({ width: 390, height: 844 });
  await device.screenshot({ path: "/tmp/linguaroom-standalone-mobile.png" });
  await device.locator("#pause").click();
  await device.waitForFunction(
    () => document.querySelector("#pause")?.textContent === "Resume",
  );
  await device.locator("#pause").click();
  await device.waitForFunction(
    () => document.querySelector("#pause")?.textContent === "Pause",
  );
  await device.locator("#stop").click();
  await device
    .getByText("Meeting ended. Export your transcript before closing.", {
      exact: true,
    })
    .waitFor();
  for (const reload of [false, true]) {
    if (reload) await device.reload();
    await device.locator("#start").click();
    await device
      .getByText("Meeting live. Audio is being processed by Soniox.", {
        exact: true,
      })
      .waitFor();
    await device.getByText("Hola localmente.", { exact: true }).waitFor();
    await device.locator("#stop").click();
    await device
      .getByText("Meeting ended. Export your transcript before closing.", {
        exact: true,
      })
      .waitFor();
  }
  assert.equal(standaloneConnections, 3);
  await device.locator("#setup-toggle").click();
  await device.locator("#clear-key").click();
  assert.equal(
    await device.evaluate(() => localStorage.getItem("linguaroom.soniox-key")),
    null,
  );
  assert.deepEqual(apiRequests, []);
  assert.deepEqual(standaloneErrors, []);
  await standaloneContext.close();
  console.log(
    "Standalone smoke passed: native encoded audio with Web Audio disabled, container headers, pause/resume, repeated start/stop and reload, direct mocked Soniox, remembered key/removal, local export, no backend calls, mobile/landscape/desktop viewport fit.",
  );
} finally {
  await browser.close();
  await app.close();
}
