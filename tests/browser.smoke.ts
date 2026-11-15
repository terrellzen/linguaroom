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
  // The working Termux sequence must also hold in the direct Pages path.
  await standaloneContext.addInitScript(() => {
    const stats = window as typeof window & { audioContextCount: number };
    stats.audioContextCount = 0;
    // Simulate activation requiring a fresh trusted tap after permission.
    // This checks the recovery flow, not the actual Android audio backend.
    let captureGranted = false;
    let needsReset = true;
    document.addEventListener(
      "click",
      (event) => {
        if (
          event.isTrusted &&
          ["Activate audio", "2. Test audio processing"].includes(
            (event.target as HTMLElement)?.textContent ?? "",
          )
        )
          needsReset = false;
      },
      true,
    );
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await getUserMedia(constraints);
      captureGranted = true;
      for (const track of stream.getTracks()) {
        const stop = track.stop.bind(track);
        track.stop = () => {
          captureGranted = false;
          needsReset = true;
          stop();
        };
      }
      return stream;
    };
    const NativeContext = window.AudioContext;
    window.AudioContext = class extends NativeContext {
      resume() {
        if (!captureGranted || needsReset) return new Promise<void>(() => {});
        return super.resume();
      }
      constructor(...options: ConstructorParameters<typeof AudioContext>) {
        super(...options);
        stats.audioContextCount++;
      }
    };
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
          assert.equal(config.audio_format, "pcm_s16le");
          assert.equal(config.sample_rate, 16000);
          assert.equal(config.num_channels, 1);
          configured = true;
        } else if (!replied) {
          assert.ok(
            configured,
            "Provider must receive configuration before PCM audio",
          );
          assert.equal(
            Buffer.from(message).byteLength,
            3200,
            "Each frame must be 100 ms of 16 kHz mono PCM",
          );
          replied = true;
          setTimeout(
            () =>
              ws.send(
                JSON.stringify({
                  total_audio_proc_ms: 1000,
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
              ),
            1500,
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
  const initialDiagnostics = JSON.parse(
    (await device.locator("#diagnostics").textContent()) ?? "{}",
  );
  assert.ok(initialDiagnostics.build);
  assert.equal(initialDiagnostics.capture.contextState, "closed");
  assert.equal(initialDiagnostics.capture.startCount, 0);
  await device.locator("#setup-toggle").click();
  await device.locator("#microphone-test summary").click();
  for (const captureMode of ["default", "meeting"]) {
    await device.locator("[data-mode]").selectOption(captureMode);
    await device
      .getByRole("button", { name: "1. Open microphone", exact: true })
      .click();
    await device
      .getByText(
        "Microphone opened. Speak, then tap 2. Test audio processing.",
        { exact: true },
      )
      .waitFor();
    assert.equal(
      standaloneConnections,
      0,
      "Local mic test must not contact Soniox",
    );
    assert.equal(await device.locator("#start").isDisabled(), true);
    const before = JSON.parse(
      (await device.locator("[data-results]").textContent())!,
    );
    assert.equal(
      before.contextState,
      undefined,
      "Capture test must not create an audio engine",
    );
    assert.equal(before.trackState, "live");
    await device
      .getByRole("button", { name: "2. Test audio processing", exact: true })
      .click();
    await device
      .getByText("Audio engine running. Speak and check the input level.", {
        exact: true,
      })
      .waitFor();
    await device.waitForFunction(() => {
      const probe = JSON.parse(
        document.querySelector("[data-results]")!.textContent!,
      );
      return (
        probe.nativeBytes > 0 &&
        probe.peakLevel > 0 &&
        probe.audioTimeSeconds > 0
      );
    });
    await device
      .getByRole("button", { name: "Stop test", exact: true })
      .click();
    assert.equal(await device.locator("#start").isEnabled(), true);
    assert.ok(
      (await device.locator("[data-results]").textContent())!.includes(
        '"stopped": true',
      ),
    );
  }
  assert.equal(standaloneConnections, 0);
  await device.locator("#microphone-test summary").click();
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
  await device
    .getByRole("button", { name: "Activate audio", exact: true })
    .click();
  await device
    .getByText("Microphone connected. Waiting for Soniox to process audio…", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    await device.locator("#state").textContent(),
    "Waiting for audio",
  );
  await device.getByText("Hola localmente.", { exact: true }).waitFor();
  await device
    .getByText("Meeting live. Audio is being processed by Soniox.", {
      exact: true,
    })
    .waitFor();
  await device.locator("#setup-toggle").click();
  const diagnostics = JSON.parse(
    (await device.locator("#diagnostics").textContent()) ?? "{}",
  );
  assert.ok(diagnostics.capture.receivedChunks > 0);
  assert.equal(diagnostics.capture.activationResets, 0);
  assert.equal(diagnostics.capture.startCount, 1);
  assert.ok(diagnostics.provider.audioBytesSent > 0);
  assert.equal(diagnostics.provider.processedAudioMs, 1000);
  await device.locator(".close-settings").click();
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
  for (const reload of [...Array<boolean>(10).fill(false), true]) {
    if (reload) await device.reload();
    await device.locator("#start").click();
    await device
      .getByRole("button", { name: "Activate audio", exact: true })
      .click();
    await device
      .getByText("Meeting live. Audio is being processed by Soniox.", {
        exact: true,
      })
      .waitFor();
    await device.getByText("Hola localmente.", { exact: true }).waitFor();
    const recovered = JSON.parse(
      (await device.locator("#diagnostics").textContent()) ?? "{}",
    );
    assert.equal(
      recovered.capture.activationResets,
      0,
      "The activation tap must preserve the granted input without a reset",
    );
    assert.equal(
      await device.evaluate(
        () =>
          (window as typeof window & { audioContextCount: number })
            .audioContextCount,
      ),
      1,
      "All meetings in a page must share one audio engine",
    );
    await device.locator("#stop").click();
    await device
      .getByText("Meeting ended. Export your transcript before closing.", {
        exact: true,
      })
      .waitFor();
  }
  assert.equal(standaloneConnections, 12);
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
    "Standalone smoke passed: activation deliberately stalled until a trusted activation tap, recovery without reacquiring input, PCM startup order, processing confirmation, pause/resume, ten same-page restarts on one context and reload, direct mocked Soniox, remembered key/removal, local export, no backend calls, mobile/landscape/desktop viewport fit.",
  );
} finally {
  await browser.close();
  await app.close();
}
