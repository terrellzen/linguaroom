import "./styles.css";
import {
  languages,
  type Snapshot,
  type RoomEvent,
} from "../../../packages/shared/protocol";
import { Microphone } from "./audio/microphone";
const viewer = location.pathname === "/viewer";
const viewerToken = location.hash.slice(1);
if (viewer) history.replaceState(null, "", location.pathname);
let room: Snapshot | null = null;
let socket: WebSocket | undefined;
let intentional = false;
let paused = false;
let capturing = false;
let authenticated = false;
const mic = new Microphone();
const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `<header><a class="brand" href="/">◈ <span>LinguaRoom<small>UNDERSTAND TOGETHER</small></span></a><div class="header-actions"><span class="pill">V3 · Soniox</span><button id="theme" aria-label="Toggle theme">◐</button></div></header><main><section class="intro"><span class="eyebrow">ONE ROOM. MANY LANGUAGES.</span><h1>${viewer ? "A shared understanding." : "Every voice, understood."}</h1><p>Live translation for conversations that bring people together.</p></section><div id="notice" role="status" aria-live="polite"></div><section id="login" class="panel" ${viewer ? "hidden" : ""}><h2>Host access</h2><p>Enter the login code shown in the server console, or your configured host password.</p><label>Host login code<input id="password" type="password" autocomplete="current-password"></label><button id="sign-in" class="primary">Unlock host controls</button></section><div class="layout"><aside id="controls" class="panel" hidden><div class="section-title"><h2>Meeting setup</h2><span class="dot"></span></div><label>Session name<input id="name" value="My meeting" maxlength="100"></label><label>Translate into<select id="target"></select></label><label>Microphone<select id="device"><option value="">Default microphone</option></select></label><button id="devices">Refresh microphones</button><label>Input level<meter id="meter" min="0" max="1" value="0"></meter></label><div class="button-row"><button id="start" class="primary">Start meeting</button><button id="pause" disabled>Pause</button><button id="stop" disabled>Stop</button></div><details open><summary>Provider & privacy</summary><label>Soniox API key<input id="key" type="password" autocomplete="off" placeholder="Kept in memory for this session"></label><div class="button-row"><button id="clear-key">Clear key</button><button id="test">Test connection</button></div><label class="check"><input id="diarization" type="checkbox" checked>Identify speakers</label><label class="check"><input id="endpoint" type="checkbox" checked>Detect pauses</label><label class="check"><input id="save" type="checkbox">Save transcript on this server</label><p class="fine">Audio is sent to Soniox. No microphone audio is saved. Speaker separation is best effort; take turns speaking.</p></details><details><summary>Sharing & diagnostics</summary><p id="https-state"></p><label>Read-only viewer link<input id="share" readonly></label><div class="button-row"><button id="copy">Copy link</button><button id="rotate">Revoke links</button></div><pre id="diagnostics"></pre><button id="saved">Saved sessions</button><div id="saved-list"></div></details><button id="logout">Lock host controls</button></aside><section class="panel captions-panel"><div class="section-title"><div><span class="eyebrow">LIVE CAPTIONS</span><h2 id="meeting-title">Ready when you are</h2></div><span id="state" class="pill">Idle</span></div><div class="caption-tools"><label class="check"><input id="original" type="checkbox" checked>Original speech</label><label class="check"><input id="labels" type="checkbox" checked>Speakers</label><button id="present">⛶ Present</button><label>Text size<input id="size" type="range" min="18" max="64" value="26"></label></div><div id="captions" aria-live="polite"><div class="empty"><span>◎</span><h3>The conversation starts here.</h3><p>${viewer ? "Waiting for the host to begin." : "Choose a language, connect your microphone, and start a meeting."}</p><div class="language-tags">Български · Deutsch · Español · 日本語 · English</div></div></div><footer id="exports" hidden><span>Transcript</span><a href="/api/export/json">JSON</a><a href="/api/export/txt">TXT</a><a href="/api/export/srt">SRT (original)</a><button id="clear">Clear</button></footer></section></div><p class="fine page-note">Private by default · One microphone · One shared translation stream</p></main>`;
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
    Promise.resolve()
      .then(fn)
      .catch((e) => notice(e instanceof Error ? e.message : "Action failed"));
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
    save: checked("save"),
  };
}
function render() {
  el("state").textContent = room?.state ?? "Idle";
  el("meeting-title").textContent = room?.name ?? "Ready when you are";
  if (!viewer) {
    const active = room?.state === "connected" || room?.state === "connecting";
    el<HTMLButtonElement>("start").disabled = capturing;
    el("start").textContent = capturing
      ? "Microphone live"
      : active
        ? "Reconnect microphone"
        : "Start meeting";
    el<HTMLButtonElement>("stop").disabled =
      !active && room?.state !== "disconnected";
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
  el("diagnostics").textContent = JSON.stringify(room.metrics, null, 2);
}
function connect() {
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
  if (!authenticated) return;
  notice("Connecting microphone…");
  await mic.start(
    value("device"),
    (pcm, level) => {
      el<HTMLMeterElement>("meter").value = Math.min(1, level * 5);
      if (paused || !capturing) return;
      if (
        socket?.readyState === WebSocket.OPEN &&
        socket.bufferedAmount < 32000
      )
        socket.send(pcm);
      else notice("Audio transport unavailable or behind; audio dropped.");
    },
    notice,
  );
  try {
    const data =
      room?.state === "connected"
        ? await api("status")
        : await api("session", options());
    room = data.room;
    capturing = true;
    el<HTMLInputElement>("key").value = "";
    el<HTMLInputElement>("share").value = new URL(
      data.viewerUrl,
      location.origin,
    ).href;
    paused = false;
    el<HTMLButtonElement>("start").disabled = true;
    el<HTMLButtonElement>("pause").disabled = false;
    el<HTMLButtonElement>("stop").disabled = false;
    connect();
    render();
    notice("Meeting live. Audio is being processed by Soniox.");
  } catch (error) {
    capturing = false;
    await mic.stop();
    throw error;
  }
});
action("pause", async () => {
  paused = !paused;
  if (paused) await mic.pause();
  else await mic.resume();
  el("pause").textContent = paused ? "Resume" : "Pause";
  notice(
    paused
      ? "Capture paused. Provider connection remains open."
      : "Capture resumed.",
  );
});
action("stop", async () => {
  capturing = false;
  await mic.stop();
  await api("stop", {});
  el<HTMLButtonElement>("start").disabled = false;
  el<HTMLButtonElement>("pause").disabled = true;
  el<HTMLButtonElement>("stop").disabled = true;
  await status();
  notice("Meeting ended. API key reference discarded.");
});
action("clear-key", () => {
  el<HTMLInputElement>("key").value = "";
  notice(
    "Key input cleared. An active provider connection retains its authentication until stopped.",
  );
});
action("test", async () => {
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
} else void unlock().catch(() => {});

if (!viewer)
  setInterval(() => {
    if (authenticated) void status().catch(() => {});
  }, 5000);
