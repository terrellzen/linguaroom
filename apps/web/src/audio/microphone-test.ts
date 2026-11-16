// A local-only probe: acquire the input before creating any Web Audio engine.
export function microphoneTest(
  container: HTMLElement,
  busy: () => boolean,
  onBusy: (active: boolean) => void,
  deviceId: () => string,
) {
  container.innerHTML = `<summary>Microphone test</summary><p>No API key needed. Audio stays on this device and is discarded. First open the microphone, then test audio processing.</p><label>Capture settings<select data-mode><option value="default">Browser defaults</option><option value="meeting">Meeting settings (mono, echo cancellation, noise suppression)</option></select></label><div class="button-row"><button data-open>1. Open microphone</button><button data-process disabled>2. Test audio processing</button><button data-stop disabled>Stop test</button><button data-copy>Copy test results</button></div><label>Test input level<meter data-level min="0" max="1" value="0"></meter></label><p data-status role="status">Ready to test.</p><pre data-results></pre>`;
  const find = <T extends HTMLElement>(selector: string) =>
    container.querySelector<T>(selector)!;
  const open = find<HTMLButtonElement>("[data-open]");
  const process = find<HTMLButtonElement>("[data-process]");
  const stopButton = find<HTMLButtonElement>("[data-stop]");
  const mode = find<HTMLSelectElement>("[data-mode]");
  const meter = find<HTMLMeterElement>("[data-level]");
  let generation = 0;
  let active = false;
  let stream: MediaStream | undefined;
  let context: AudioContext | undefined;
  let recorder: MediaRecorder | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let activationDeadline: ReturnType<typeof setTimeout> | undefined;
  let results: Record<string, unknown> = {};
  const display = () => {
    if (stream) {
      const track = stream.getAudioTracks()[0];
      results.trackState = track?.readyState;
      results.trackMuted = track?.muted;
      results.trackSettings = track?.getSettings();
    }
    if (context) {
      results.contextState = context.state;
      results.audioTimeSeconds = context.currentTime;
    }
    // Device identifiers aren't needed to diagnose permission or activation.
    const settings = results.trackSettings as MediaTrackSettings | undefined;
    if (settings) {
      delete settings.deviceId;
      delete settings.groupId;
    }
    find("[data-results]").textContent = JSON.stringify(results, null, 2);
  };
  const status = (text: string) => {
    find("[data-status]").textContent = text;
    results.stage = text;
    display();
  };
  const permission = async (field: string, run: number) => {
    try {
      const state = await navigator.permissions.query({
        name: "microphone" as PermissionName,
      });
      if (generation === run) results[field] = state.state;
    } catch {
      if (generation === run) results[field] = "unavailable in this browser";
    }
    if (generation === run) display();
  };
  const stop = () => {
    generation++;
    clearInterval(interval);
    clearTimeout(deadline);
    clearTimeout(activationDeadline);
    display();
    if (recorder && recorder.state !== "inactive") recorder.stop();
    recorder = undefined;
    stream?.getTracks().forEach((track) => track.stop());
    stream = undefined;
    if (context) {
      context.onstatechange = null;
      void context.close().catch(() => {});
      context = undefined;
    }
    meter.value = 0;
    open.disabled = false;
    mode.disabled = false;
    process.disabled = true;
    stopButton.disabled = true;
    if (active) onBusy(false);
    active = false;
    results.stopped = true;
    display();
  };
  stopButton.onclick = () => {
    status("Test stopped. Results are kept below.");
    stop();
  };
  open.onclick = () => {
    if (busy() || active) {
      status("Stop the meeting before testing the microphone.");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) {
      status("Microphone testing requires trusted HTTPS or localhost.");
      return;
    }
    active = true;
    onBusy(true);
    const run = ++generation;
    results = {
      build: __APP_BUILD__,
      browser: navigator.userAgent,
      permissionTapActive: navigator.userActivation?.isActive,
      captureSettings: mode.value,
      permissionBefore: "checking",
      nativeChunks: 0,
      nativeBytes: 0,
      peakLevel: 0,
    };
    open.disabled = true;
    mode.disabled = true;
    stopButton.disabled = false;
    status("Opening microphone without an audio engine…");
    void permission("permissionBefore", run);
    deadline = setTimeout(() => {
      status("Microphone request timed out.");
      stop();
    }, 30000);
    const selected = deviceId();
    // Invoke capture directly from the tap, without awaiting Permissions.query.
    void navigator.mediaDevices
      .getUserMedia({
        audio:
          mode.value === "meeting"
            ? {
                deviceId: selected ? { exact: selected } : undefined,
                channelCount: 1,
                echoCancellation: true,
                noiseSuppression: true,
              }
            : selected
              ? { deviceId: { exact: selected } }
              : true,
      })
      .then((input) => {
        if (generation !== run) {
          input.getTracks().forEach((track) => track.stop());
          return;
        }
        clearTimeout(deadline);
        stream = input;
        process.disabled = false;
        void permission("permissionAfter", run);
        status("Microphone opened. Speak, then tap 2. Test audio processing.");
        try {
          recorder = new MediaRecorder(input);
          results.recorderType = recorder.mimeType;
          recorder.ondataavailable = (event) => {
            if (generation !== run || !event.data.size) return;
            results.nativeChunks = Number(results.nativeChunks) + 1;
            results.nativeBytes = Number(results.nativeBytes) + event.data.size;
            display();
          };
          recorder.start(250);
        } catch (error) {
          results.recorderError = String(error);
        }
        interval = setInterval(display, 250);
        deadline = setTimeout(() => {
          status("Test finished after 30 seconds. Results are kept below.");
          stop();
        }, 30000);
      })
      .catch((error: unknown) => {
        if (generation !== run) return;
        results.error = String(error);
        status("Microphone could not open. See results below.");
        stop();
      });
  };
  const startProcessing = (retry = false) => {
    if (!stream || !active) return;
    process.disabled = true;
    const run = generation;
    try {
      // This new gesture happens with an already-granted, live input.
      context = new AudioContext();
      const engine = context;
      results.contextStateBeforeResume = context.state;
      results.processingTapActive = navigator.userActivation?.isActive;
      const resuming = context.resume();
      const analyser = context.createAnalyser();
      const source = context.createMediaStreamSource(stream);
      const silent = context.createGain();
      silent.gain.value = 0;
      source.connect(analyser).connect(silent).connect(context.destination);
      const samples = new Float32Array(analyser.fftSize);
      clearInterval(interval);
      interval = setInterval(() => {
        analyser.getFloatTimeDomainData(samples);
        const rms = Math.sqrt(
          samples.reduce((sum, value) => sum + value * value, 0) /
            samples.length,
        );
        meter.value = Math.min(1, rms * 5);
        results.peakLevel = Math.max(Number(results.peakLevel), rms);
        if (
          rms > 0 &&
          results.stage !== "Microphone test detected audio samples."
        )
          status("Microphone test detected audio samples.");
        display();
      }, 100);
      context.onstatechange = display;
      status("Starting audio processing from your tap…");
      activationDeadline = setTimeout(() => {
        if (generation !== run || context !== engine) return;
        if (retry) {
          status(
            "Audio engine is still suspended after replacement. Copy the test results.",
          );
          return;
        }
        results.firstEngine = {
          state: engine.state,
          audioTimeSeconds: engine.currentTime,
        };
        results.activationResets = 1;
        status("Replacing stalled audio engine…");
        clearInterval(interval);
        engine.onstatechange = null;
        context = undefined;
        // Bound cleanup even if Firefox never settles its native close promise.
        let timeout: ReturnType<typeof setTimeout>;
        void Promise.race([
          engine.close().catch(() => {}),
          new Promise<void>((resolve) => {
            timeout = setTimeout(resolve, 2000);
          }),
        ]).then(() => {
          clearTimeout(timeout);
          if (generation === run) startProcessing(true);
        });
      }, 3000);
      void resuming.then(
        () => {
          if (generation === run && context === engine) {
            clearTimeout(activationDeadline);
            status("Audio engine running. Speak to check for audio samples.");
          }
        },
        (error: unknown) => {
          if (generation === run && context === engine) {
            clearTimeout(activationDeadline);
            results.error = String(error);
            status("Audio processing failed. See results below.");
          }
        },
      );
    } catch (error) {
      results.error = String(error);
      status("Audio processing failed. See results below.");
    }
  };
  process.onclick = () => startProcessing();
  find<HTMLButtonElement>("[data-copy]").onclick = () => {
    void navigator.clipboard.writeText(JSON.stringify(results, null, 2)).then(
      () => {
        find("[data-status]").textContent = "Test results copied.";
      },
      () => {
        find("[data-status]").textContent =
          "Select and copy the results below.";
      },
    );
  };
  return { stop, diagnostics: () => ({ ...results }) };
}
