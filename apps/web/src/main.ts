import "./styles.css";
import { StandaloneSession } from "./standalone";
import { exportTranscript } from "../../server/src/export";
import {
  languages,
  startSchema,
  type Snapshot,
  type RoomEvent,
} from "../../../packages/shared/protocol";
import { Microphone } from "./audio/microphone";
const viewer = location.pathname === "/viewer";
const standalone =
  !viewer && new URLSearchParams(location.search).get("mode") !== "server";
const viewerToken = location.hash.slice(1);
if (viewer) history.replaceState(null, "", location.pathname);
let room: Snapshot | null = null;
let socket: WebSocket | undefined;
let intentional = false;
let paused = false;
let capturing = false;
let changingCapture = false;
let authenticated = false;
const mic = new Microphone();
const local = new StandaloneSession(
  (snapshot) => {
    room = snapshot;
    render();
  },
  notice,
  () => {
    capturing = false;
    changingCapture = true;
    void mic.stop().finally(() => {
      changingCapture = false;
      render();
    });
  },
);
const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `<header><a class="brand" href="/">◈ <span>LinguaRoom<small>A LITTLE CLOSER, IN EVERY LANGUAGE</small></span></a><div class="header-actions"><span class="pill">LIVE TRANSLATION</span><button id="theme" aria-label="Toggle theme">◐</button></div></header><main><section class="intro"><span class="eyebrow">ONE ROOM. MANY LANGUAGES.</span><h1>${viewer ? "A shared understanding." : "Every voice, understood."}</h1><p>Live translation for conversations that bring people together.</p></section><div id="notice" role="status" aria-live="polite"></div><section id="login" class="panel" ${viewer ? "hidden" : ""}><h2>Host access</h2><p>Enter the login code shown in the server console, or your configured host password.</p><label>Host login code<input id="password" type="password" autocomplete="current-password"></label><button id="sign-in" class="primary">Unlock host controls</button></section><div class="layout"><dialog id="controls" class="panel" aria-label="Meeting settings" hidden><div class="section-title"><h2>Meeting setup</h2><span class="dot"></span></div><label>Session name<input id="name" value="My meeting" maxlength="100"></label><label>Translate into<select id="target"></select></label><label>Microphone<select id="device"><option value="">Default microphone</option></select></label><button id="devices">Refresh microphones</button><label>Input level<meter id="meter" min="0" max="1" value="0"></meter></label><div class="button-row"><button id="start" class="primary">Start meeting</button><button id="pause" disabled>Pause</button><button id="stop" disabled>Stop</button></div><details open><summary>Provider & privacy</summary><label>Soniox API key<input id="key" type="password" autocomplete="off" placeholder="Kept in memory for this session"></label><div class="button-row"><button id="clear-key">Clear key</button><button id="test">Test connection</button></div><label class="check"><input id="diarization" type="checkbox" checked>Identify speakers</label><label class="check"><input id="endpoint" type="checkbox" checked>Detect pauses</label><label class="check"><input id="save" type="checkbox">Save transcript on this server</label><p class="fine">Audio is sent to Soniox. No microphone audio is saved. Speaker separation is best effort; take turns speaking.</p></details><details><summary>Sharing & diagnostics</summary><p id="https-state"></p><label>Read-only viewer link<input id="share" readonly></label><div class="button-row"><button id="copy">Copy link</button><button id="rotate">Revoke links</button></div><pre id="diagnostics"></pre><button id="saved">Saved sessions</button><div id="saved-list"></div></details><button id="logout">Lock host controls</button></dialog><section class="panel captions-panel"><div class="section-title"><div><span class="eyebrow">LIVE CAPTIONS</span><h2 id="meeting-title">Ready when you are</h2></div><span id="state" class="pill">Idle</span></div><div class="caption-tools"><label class="check"><input id="original" type="checkbox" checked>Original speech</label><label class="check"><input id="labels" type="checkbox" checked>Speakers</label><button id="present">⛶ Present</button><label>Text size<input id="size" type="range" min="18" max="64" value="26"></label></div><div id="captions" aria-live="polite"><div class="empty"><span>◎</span><h3>The conversation starts here.</h3><p>${viewer ? "Waiting for the host to begin." : "Choose a language, connect your microphone, and start a meeting."}</p><div class="language-tags">Български · Deutsch · Español · 日本語 · English</div></div></div><footer id="exports" hidden><span>Transcript</span><a href="/api/export/json">JSON</a><a href="/api/export/txt">TXT</a><a href="/api/export/srt">SRT (original)</a><button id="clear">Clear</button></footer></section></div><p class="fine page-note">Private by default · One microphone · One shared translation stream</p></main>`;
const setupToggle = document.createElement("button");
setupToggle.id = "setup-toggle";
setupToggle.textContent = "Settings";
setupToggle.setAttribute("aria-controls", "controls");
setupToggle.setAttribute("aria-haspopup", "dialog");
setupToggle.hidden = viewer;
setupToggle.onclick = () => {
  document.querySelector<HTMLDialogElement>("#controls")!.showModal();
};
const settings = document.querySelector<HTMLDialogElement>("#controls")!;
const closeSettings = document.createElement("button");
closeSettings.className = "close-settings";
closeSettings.textContent = "Done";
closeSettings.onclick = () => settings.close();
settings.prepend(closeSettings);
settings.addEventListener("click", (event) => {
  if (event.target === settings) {
    const bounds = settings.getBoundingClientRect();
    if (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    )
      settings.close();
  }
});
const transport = document.createElement("div");
transport.className = "transport";
transport.append(document.querySelector("#start")!.parentElement!);
const liveHint = document.createElement("span");
liveHint.className = "transport-hint";
liveHint.textContent = "Your voice. A world of understanding.";
transport.prepend(liveHint);
transport.hidden = viewer;
document.querySelector(".captions-panel")!.append(transport);
document.querySelector(".header-actions")!.prepend(setupToggle);
function el<T extends HTMLElement = HTMLElement>(id: string) {
  return document.getElementById(id) as T;
}
function value(id: string) {
  return el<HTMLInputElement>(id).value;
}
function checked(id: string) {
  return el<HTMLInputElement>(id).checked;
}
function notice(message: string) {
  el("notice").textContent = message;
}
async function api(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
) {
  if (standalone) {
    if (path === "session") return local.start(startSchema.parse(body));
    if (path === "stop") {
      await local.stop();
      return {};
    }
    if (path === "clear") {
      if (room) room.segments = [];
      render();
      return {};
    }
    if (path === "speaker") {
      const data = body as { id: string; name: string; segmentId: string };
      if (room) {
        room.speakers[data.id] = data.name;
        const s = room.segments.find((s) => s.id === data.segmentId);
        if (s) s.speakerId = data.id;
      }
      render();
      return {};
    }
    if (path === "status") return { room: local.room, metrics: {} };
    throw new Error("This action requires Shared server mode.");
  }
  const response = await fetch(`/api/${path}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Request failed");
  return data;
}
function action(id: string, fn: () => Promise<unknown> | void) {
  el(id).onclick = () => {
    const report = (error: unknown) =>
      notice(error instanceof Error ? error.message : "Action failed");
    try {
      // Keep audio activation inside the browser's original click handler.
      void Promise.resolve(fn()).catch(report);
    } catch (error) {
      report(error);
    }
  };
}
const names = new Intl.DisplayNames(["en"], { type: "language" });
for (const lang of languages) {
  const option = document.createElement("option");
  option.value = lang;
  option.textContent = `${names.of(lang)} (${lang})`;
  el("target").append(option);
}
el<HTMLSelectElement>("target").value = "en";
function options() {
  return {
    key: value("key") || undefined,
    target: value("target"),
    name: value("name"),
    diarization: checked("diarization"),
    endpoint: checked("endpoint"),
    save: standalone ? false : checked("save"),
  };
}
function render() {
  const waitingForAudio =
    standalone && room?.state === "connected" && !room.metrics.audioConfirmed;
  el("state").textContent = waitingForAudio
    ? "Waiting for audio"
    : (room?.state ?? "Idle");
  el("meeting-title").textContent = room?.name ?? "Ready when you are";
  if (!viewer) {
    const active = room?.state === "connected" || room?.state === "connecting";
    el<HTMLButtonElement>("start").disabled = capturing || changingCapture;
    el("start").textContent = capturing
      ? waitingForAudio
        ? "● Listening"
        : "● Live"
      : active
        ? "Reconnect microphone"
        : "Start meeting";
    el<HTMLButtonElement>("stop").disabled =
      changingCapture || (!active && room?.state !== "disconnected");
    el<HTMLButtonElement>("pause").disabled = !capturing;
  }
  if (!room) return;
  const container = el("captions");
  if (room.segments.length) container.querySelector(".empty")?.remove();
  const visible = room.segments.slice(-300);
  const keep = new Set(visible.map((s) => s.id));
  container.querySelectorAll<HTMLElement>("[data-segment]").forEach((row) => {
    if (!keep.has(row.dataset.segment!)) row.remove();
  });
  for (const s of visible) {
    let row = Array.from(container.children).find(
      (n) => (n as HTMLElement).dataset.segment === s.id,
    ) as HTMLElement | undefined;
    if (!row) {
      row = document.createElement("article");
      row.dataset.segment = s.id;
      container.append(row);
    }
    row.className = `caption ${s.final ? "final" : "partial"} ${s.channel}`;
    row.hidden = s.channel === "original" && !checked("original");
    row.hidden = row.hidden || (!s.original && !s.translated);
    const signature = JSON.stringify([
      s,
      checked("original"),
      checked("labels"),
      room.speakers,
    ]);
    if (row.dataset.signature === signature) continue;
    row.dataset.signature = signature;
    row.replaceChildren();
    const meta = document.createElement("div");
    meta.className = "caption-meta";
    if (checked("labels")) {
      const label = document.createElement("button");
      label.textContent =
        room.speakers[s.speakerId ?? ""] ?? `Speaker ${s.speakerId ?? "?"}`;
      label.disabled = viewer;
      label.title = "Rename speaker or correct speaker ID";
      label.onclick = () => {
        const id = prompt(
          "Speaker ID (change to correct this caption)",
          s.speakerId ?? "1",
        );
        if (!id) return;
        const name = prompt(
          "Speaker name",
          room?.speakers[id] ?? `Speaker ${id}`,
        );
        if (name)
          void api("speaker", { id, name, segmentId: s.id }).catch((e) =>
            notice(e.message),
          );
      };
      meta.append(label);
    }
    const language = document.createElement("span");
    language.textContent = `${s.channel === "translation" ? "Translation" : s.sourceLanguage ? names.of(s.sourceLanguage) : "Language pending"} · ${s.final ? "Final" : "Live"}${s.startMs !== undefined ? ` · ${(s.startMs / 1000).toFixed(1)}s` : ""}`;
    meta.append(language);
    const text = document.createElement("p");
    text.textContent = s.translated || s.original;
    row.append(meta, text);
  }
  container.scrollTop = container.scrollHeight;
  el("diagnostics").textContent = JSON.stringify(
    standalone
      ? { capture: mic.diagnostics(), provider: room.metrics }
      : room.metrics,
    null,
    2,
  );
}
function connect() {
  if (standalone) return;
  if (
    socket?.readyState === WebSocket.OPEN ||
    socket?.readyState === WebSocket.CONNECTING
  )
    return;
  intentional = false;
  socket = new WebSocket(
    `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${viewer ? `/ws/viewer?token=${encodeURIComponent(viewerToken)}` : "/ws/host"}`,
  );
  socket.onmessage = (e) => {
    const data = JSON.parse(e.data);
    if (data.type === "snapshot") {
      room = data.room;
      render();
      return;
    }
    const event = data as RoomEvent;
    if (room && event.sessionId !== room.id) return;
    if (event.segment && room) {
      const s = event.segment;
      const i = room.segments.findIndex((old) => old.id === s.id);
      const old = room.segments[i];
      if (!old || (s.revision > old.revision && (!old.final || s.final))) {
        if (i < 0) room.segments.push(s);
        else room.segments[i] = s;
      }
    }
    if (event.type === "connection.changed" && room)
      room.state = event.message ?? "unknown";
    if (event.type === "processing.error")
      notice(event.message ?? "Processing error");
    if (event.type === "session.ended" && room) {
      room.state = "ended";
      capturing = false;
      void mic.stop();
    }
    render();
  };
  socket.onclose = (e) => {
    socket = undefined;
    if (!intentional) {
      notice("Live connection lost. Audio may be lost. Reconnecting…");
      if (e.code !== 1008) setTimeout(connect, 2000);
      else
        notice(
          "Access expired or revoked. Open a new viewer link or log in again.",
        );
    }
  };
  socket.onerror = () =>
    notice(
      "WebSocket connection failed. Check server, origin and TLS configuration.",
    );
}
async function devices() {
  if (!navigator.mediaDevices)
    throw new Error("Microphone devices require trusted HTTPS or localhost");
  const list = await navigator.mediaDevices.enumerateDevices();
  const select = el<HTMLSelectElement>("device");
  select.replaceChildren(new Option("Default microphone", ""));
  for (const d of list.filter((d) => d.kind === "audioinput"))
    select.add(
      new Option(d.label || `Microphone ${select.length}`, d.deviceId),
    );
}
async function status() {
  if (standalone) {
    room = local.room;
    render();
    return;
  }
  const data = await api("status");
  room = data.room;
  if (room)
    Object.assign(room.metrics, data.metrics, {
      microphoneFrameMs: 100,
      browserQueueBytes: socket?.bufferedAmount ?? 0,
      webSocketState: socket?.readyState ?? 3,
    });
  el("share").setAttribute(
    "value",
    data.viewerUrl ? new URL(data.viewerUrl, location.origin).href : "",
  );
  el("https-state").textContent = window.isSecureContext
    ? "Browser secure context available."
    : "Insecure browser context: use localhost or trusted HTTPS.";
  if (data.environmentKey)
    el<HTMLInputElement>("key").placeholder =
      "Server environment key configured";
  render();
}
async function unlock() {
  await api("status");
  authenticated = true;
  el("login").hidden = true;
  el("controls").hidden = false;
  el("exports").hidden = false;
  connect();
  await status();
  await devices().catch(() => {});
}
action("sign-in", async () => {
  await api("login", { password: value("password") });
  el<HTMLInputElement>("password").value = "";
  await unlock();
  notice("Host authenticated.");
});
action("start", async () => {
  if (!authenticated || changingCapture || capturing) return;
  if (standalone && !value("key")) {
    settings.showModal();
    notice("Add your Soniox API key in Settings to begin.");
    el<HTMLInputElement>("key").focus();
    return;
  }
  changingCapture = true;
  render();
  notice("Connecting microphone…");
  try {
    await mic.start(
      value("device"),
      (pcm, level) => {
        el<HTMLMeterElement>("meter").value = Math.min(1, level * 5);
        if (!capturing || paused) return;
        if (standalone) {
          local.audio(pcm);
          return;
        }
        if (
          socket?.readyState === WebSocket.OPEN &&
          socket.bufferedAmount < 32000
        )
          socket.send(pcm);
        else notice("Audio transport unavailable or behind; audio dropped.");
      },
      notice,
      notice,
    );
    notice("Connecting to Soniox…");
    const data =
      room?.state === "connected"
        ? await api("status")
        : await api("session", options());
    room = data.room;
    capturing = true;
    settings.close();
    if (!standalone) el<HTMLInputElement>("key").value = "";
    if (!standalone)
      el<HTMLInputElement>("share").value = new URL(
        data.viewerUrl,
        location.origin,
      ).href;
    paused = false;
    el("pause").textContent = "Pause";
    el<HTMLButtonElement>("start").disabled = true;
    el<HTMLButtonElement>("pause").disabled = false;
    el<HTMLButtonElement>("stop").disabled = false;
    connect();
    render();
    notice(
      standalone && !room?.metrics.audioConfirmed
        ? "Microphone connected. Waiting for Soniox to process audio…"
        : "Meeting live. Audio is being processed by Soniox.",
    );
  } catch (error) {
    capturing = false;
    await mic.stop();
    if (standalone) await local.stop();
    render();
    throw error;
  } finally {
    changingCapture = false;
    render();
  }
});
action("pause", async () => {
  paused = !paused;
  if (paused) await mic.pause();
  else await mic.resume();
  if (standalone) local.setPaused(paused);
  el("pause").textContent = paused ? "Resume" : "Pause";
  notice(
    paused
      ? "Capture paused. Provider connection remains open."
      : "Capture resumed.",
  );
});
action("stop", async () => {
  if (changingCapture) return;
  changingCapture = true;
  render();
  try {
    await mic.stop();
    capturing = false;
    await api("stop", {});
    el<HTMLButtonElement>("start").disabled = false;
    el<HTMLButtonElement>("pause").disabled = true;
    el<HTMLButtonElement>("stop").disabled = true;
    await status();
    notice(
      standalone
        ? "Meeting ended. Export your transcript before closing."
        : "Meeting ended. API key reference discarded.",
    );
  } finally {
    changingCapture = false;
    render();
  }
});
action("clear-key", () => {
  el<HTMLInputElement>("key").value = "";
  if (standalone) {
    localStorage.removeItem("linguaroom.soniox-key");
    el<HTMLInputElement>("remember-key").checked = false;
  }
  notice(
    "Key input cleared. An active provider connection retains its authentication until stopped.",
  );
});
action("test", async () => {
  if (standalone) {
    notice("Start a meeting to verify your key with Soniox.");
    return;
  }
  const data = await api("key/test", options());
  notice(data.message);
});
action("devices", devices);
action("copy", async () => {
  await navigator.clipboard.writeText(value("share"));
  notice("Viewer link copied.");
});
action("rotate", async () => {
  const data = await api("viewer/rotate", {});
  el<HTMLInputElement>("share").value = new URL(
    data.viewerUrl,
    location.origin,
  ).href;
  notice("Previous viewer links revoked.");
});
action("clear", async () => {
  await api("clear", {});
  await status();
});
action("logout", async () => {
  await mic.stop();
  await api("logout", {});
  intentional = true;
  socket?.close();
  location.reload();
});
action("saved", async () => {
  const data = await api("saved");
  const list = el("saved-list");
  list.replaceChildren();
  for (const file of data.sessions as string[]) {
    const id = file.slice(0, -5);
    const row = document.createElement("div");
    const link = document.createElement("a");
    link.href = `/api/saved/${id}`;
    link.textContent = id;
    const button = document.createElement("button");
    button.textContent = "Delete";
    button.onclick = () => {
      if (confirm("Delete saved transcript?"))
        void api(`saved/${id}`, undefined, "DELETE")
          .then(() => row.remove())
          .catch((e) => notice(e.message));
    };
    row.append(link, button);
    list.append(row);
  }
});
action("theme", () => {
  document.documentElement.classList.toggle("light");
});
action("present", async () => {
  document.body.classList.toggle("presentation");
  if (document.body.classList.contains("presentation"))
    await document.documentElement.requestFullscreen?.().catch(() => {});
  else if (document.fullscreenElement) await document.exitFullscreen();
});
el<HTMLInputElement>("size").oninput = () =>
  document.documentElement.style.setProperty(
    "--caption-size",
    `${value("size")}px`,
  );
el("original").onchange = render;
el("labels").onchange = render;
window.addEventListener("pagehide", () => {
  intentional = true;
  void mic.stop();
  socket?.close();
  local.socket?.close();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden && !viewer)
    notice(
      "Browser backgrounded: Android may interrupt capture. Keep the browser foreground and screen on.",
    );
});
if (viewer) {
  document.body.classList.add("viewer");
  el("controls").hidden = true;
  el("login").hidden = true;
  el<HTMLInputElement>("original").checked = false;
  if (!viewerToken)
    notice(
      "Missing viewer token. Open the complete link supplied by your host.",
    );
  else connect();
} else if (standalone) {
  authenticated = true;
  el("login").hidden = true;
  el("controls").hidden = false;
  el("exports").hidden = false;
  el("logout").hidden = true;
  el("save").closest("label")!.remove();
  const audioDiagnostics = document.createElement("details");
  audioDiagnostics.innerHTML = "<summary>Audio diagnostics</summary>";
  audioDiagnostics.append(el("diagnostics"));
  settings.append(audioDiagnostics);
  el("share").closest("details")!.remove();
  el("test").hidden = true;
  el<HTMLInputElement>("key").placeholder = "Your personal Soniox API key";
  const remember = document.createElement("label");
  remember.className = "check";
  remember.innerHTML =
    '<input id="remember-key" type="checkbox">Remember API key on this device';
  el("key").closest("label")!.after(remember);
  const privacy = document.createElement("p");
  privacy.className = "fine";
  privacy.textContent =
    "Your key goes directly to Soniox. Remembering it stores it in this browser; use only on a trusted device. Transcripts stay in memory until exported.";
  remember.after(privacy);
  try {
    const saved = localStorage.getItem("linguaroom.soniox-key");
    if (saved) {
      el<HTMLInputElement>("key").value = saved;
      el<HTMLInputElement>("remember-key").checked = true;
    }
  } catch {
    notice("Browser storage unavailable. Your key will stay in memory only.");
  }
  const storeKey = () => {
    try {
      if (checked("remember-key"))
        localStorage.setItem("linguaroom.soniox-key", value("key"));
      else localStorage.removeItem("linguaroom.soniox-key");
    } catch {
      notice("Could not save the key in this browser.");
    }
  };
  el("remember-key").onchange = storeKey;
  el("key").oninput = storeKey;
  const shared = document.createElement("details");
  shared.innerHTML =
    '<summary>Shared server (optional)</summary><p>Use your own LinguaRoom server for host controls and viewer links. Termux on Android and Linux are supported.</p><label>Server URL<input id="server-url" type="url" placeholder="https://your-server.example"></label><button id="open-server">Open shared server</button>';
  el("controls").append(shared);
  action("open-server", () => {
    const url = new URL(value("server-url"));
    if (
      url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      )
    )
      throw new Error("Use an HTTPS server URL (or localhost).");
    if (url.username || url.password)
      throw new Error("Enter a server URL without credentials.");
    url.searchParams.set("mode", "server");
    location.assign(url.href);
  });
  document.querySelector<HTMLAnchorElement>(".brand")!.href =
    import.meta.env.BASE_URL;
  document.querySelector(".page-note")!.textContent =
    "Standalone · Audio sent directly to Soniox · No application server required";
  document.querySelectorAll<HTMLAnchorElement>("#exports a").forEach((link) => {
    link.onclick = (event) => {
      event.preventDefault();
      if (!room) {
        notice("Start a meeting first.");
        return;
      }
      try {
        const format = link.getAttribute("href")!.split("/").at(-1)!;
        const url = URL.createObjectURL(
          new Blob([exportTranscript(room, format)], {
            type:
              format === "json"
                ? "application/json"
                : "text/plain;charset=utf-8",
          }),
        );
        const download = document.createElement("a");
        download.href = url;
        download.download = `linguaroom.${format}`;
        download.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (error) {
        notice(error instanceof Error ? error.message : "Export failed");
      }
    };
  });
  void devices().catch(() => {});
} else void unlock().catch(() => {});

if (!viewer && !standalone)
  setInterval(() => {
    if (authenticated) void status().catch(() => {});
  }, 5000);
