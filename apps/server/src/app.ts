import Fastify from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import staticFiles from "@fastify/static";
import { WebSocketServer, WebSocket } from "ws";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile, readdir, readFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import {
  startSchema,
  type Snapshot,
  type RoomEvent,
  type EventType,
} from "../../../packages/shared/protocol.js";
import type {
  SpeechProvider,
  SpeechStream,
} from "./providers/speech-provider.js";
import { SonioxProvider } from "./providers/soniox/provider.js";
import { config } from "./config.js";
import { exportTranscript } from "./export.js";
export async function createApp(
  provider: SpeechProvider = new SonioxProvider(),
  env: NodeJS.ProcessEnv = process.env,
) {
  const cfg = config(env);
  const app = Fastify({
    ...(cfg.https ? { https: cfg.https } : {}),
    trustProxy:
      cfg.TRUST_PROXY === "true"
        ? [
            "127.0.0.1",
            "::1",
            ...(cfg.PROXY_ADDRESS ? [cfg.PROXY_ADDRESS] : []),
          ]
        : false,
    bodyLimit: 8192,
    logger: {
      level: cfg.LOG_LEVEL,
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "key",
        "apiKey",
        "SONIOX_API_KEY",
      ],
      serializers: {
        req: (r) => ({
          method: r.method,
          url: r.url.split("?")[0],
          remoteAddress: r.ip,
        }),
      },
    },
  });
  await app.register(cookie);
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  await provider.initialize();
  const token = () => randomBytes(32).toString("base64url");
  const hostPassword = env.HOST_PASSWORD || token();
  if (!env.HOST_PASSWORD)
    app.log.info(
      { setupCode: hostPassword },
      "Local host login code (expires on restart); do not share with viewers",
    );
  const hosts = new Map<string, number>();
  let room: Snapshot | undefined;
  let stream: SpeechStream | undefined;
  let busy = false;
  let viewerToken = "";
  let viewerExpiry = 0;
  let audioSocket: WebSocket | undefined;
  let save = false;
  const speakerCorrections = new Map<string, string>();
  const providerRevisions = new Map<string, number>();
  let disconnectedTimer: NodeJS.Timeout | undefined;
  const sockets = new Set<WebSocket>();
  const viewers = new Set<WebSocket>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32768 });
  const secure = (r: { protocol: string; hostname: string; ip: string }) =>
    r.protocol === "https" ||
    (["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(r.ip) &&
      ["localhost", "127.0.0.1", "[::1]"].includes(r.hostname));
  const originAllowed = (
    origin: string | undefined,
    host: string | undefined,
    protocol: string,
  ) =>
    Boolean(
      origin && origin === (cfg.PUBLIC_ORIGIN ?? `${protocol}://${host}`),
    );
  const hostAuth = (cookies: Record<string, string | undefined>) =>
    Boolean(cookies.lr_host && (hosts.get(cookies.lr_host) ?? 0) > Date.now());
  app.addHook("onRequest", async (req, reply) => {
    reply
      .header(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      )
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header("Cache-Control", "no-store");
    const route=req.routeOptions.url;
    const path=req.url.split('?')[0];
    let decoded:string;try{decoded=decodeURIComponent(path);}catch{return reply.code(400).send({error:'Invalid URL'});}
    if((decoded.startsWith('/api/')&&decoded!==path)||path.split('/').some(part=>part==='.'||part==='..'))return reply.code(400).send({error:'Noncanonical URL'});
    if (route?.startsWith("/api/") && route !== "/api/health") {
      if (!secure(req))
        return reply.code(403).send({
          error: "Host administration requires HTTPS or trusted localhost.",
        });
      if (
        req.method !== "GET" &&
        !originAllowed(req.headers.origin, req.headers.host, req.protocol)
      )
        return reply.code(403).send({ error: "Origin rejected" });
      if (route !== "/api/login" && !hostAuth(req.cookies))
        return reply.code(401).send({ error: "Host login required" });
    }
  });
  app.setErrorHandler((error, _req, reply) => {
    reply.code(error instanceof z.ZodError ? 400 : 500).send({
      error:
        error instanceof z.ZodError
          ? "Invalid request"
          : error instanceof Error
            ? error.message
            : "Request failed",
    });
  });
  const emit = (
    type: EventType,
    message?: string,
    segment?: RoomEvent["segment"],
  ) => {
    if (!room) return;
    const event: RoomEvent = {
      schemaVersion: 1,
      sessionId: room.id,
      eventId: randomUUID(),
      providerId: provider.id,
      type,
      timestamp: new Date().toISOString(),
      message,
      segment,
    };
    const data = JSON.stringify(event);
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) {
        if (socket.bufferedAmount > 1024 * 1024)
          socket.close(1013, "Viewer too slow");
        else socket.send(data);
      }
    }
  };
  const snapshot = () => ({
    type: "snapshot",
    schemaVersion: 1,
    room: room ?? null,
  });
  const persist = async () => {
    if (room && save) {
      await mkdir(cfg.DATA_DIR, { recursive: true, mode: 0o700 });
      await writeFile(
        resolve(cfg.DATA_DIR, `${room.id}.json`),
        JSON.stringify(room),
        { mode: 0o600 },
      );
    }
  };
  const stop = async () => {
    clearTimeout(disconnectedTimer);
    if (busy) throw new Error("Session transition in progress");
    busy = true;
    try {
      const ending = stream;
      stream = undefined;
      await ending?.end();
      if (room) {
        room.state = "ended";
        emit("session.ended");
        await persist();
      }
      audioSocket?.close();
      audioSocket = undefined;
    } finally {
      busy = false;
    }
  };
  app.get("/api/health", async () => ({ status: "ok", version: "3.0.0" }));
  app.post(
    "/api/login",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { password } = z
        .object({ password: z.string().max(512) })
        .strict()
        .parse(req.body);
      const a = Buffer.from(password),
        b = Buffer.from(hostPassword);
      if (a.length !== b.length || !timingSafeEqual(a, b))
        return reply.code(401).send({ error: "Invalid host login code" });
      for (const [id, expiry] of hosts)
        if (expiry < Date.now()) hosts.delete(id);
      const credential = token();
      hosts.set(credential, Date.now() + 12 * 3600000);
      reply.setCookie("lr_host", credential, {
        httpOnly: true,
        secure: req.protocol === "https",
        sameSite: "strict",
        path: "/",
        maxAge: 12 * 3600,
      });
      return { authenticated: true };
    },
  );
  app.post("/api/logout", async (req, reply) => {
    hosts.delete(req.cookies.lr_host!);
    reply.clearCookie("lr_host", { path: "/" });
    return { ok: true };
  });
  app.get("/api/status", async () => ({
    room: room ?? null,
    environmentKey: Boolean(env.SONIOX_API_KEY),
    capabilities: provider.capabilities(),
    secure: !!cfg.https || cfg.TRUST_PROXY === "true",
    metrics: {
      memoryBytes: process.memoryUsage().rss,
      uptimeSeconds: process.uptime(),
      viewers: sockets.size,
    },
    viewerUrl: room ? `/viewer#${viewerToken}` : null,
  }));
  app.post("/api/key/test", async (req) => {
    if (stream || busy)
      throw new Error("Stop the active session before testing a key");
    const options = startSchema.parse(req.body);
    let key = options.key || env.SONIOX_API_KEY;
    if (!key) throw new Error("Soniox key required");
    busy = true;
    try {
      delete options.key;
      let failed = "";
      const test = await provider.create(
        key,
        { ...options, endpoint: true },
        {
          segment() {},
          state() {},
          error(m) {
            failed = m;
          },
          usage() {},
        },
      );
      key = "";
      await test.end();
      if (failed) throw new Error(failed);
      return { ok: true, message: "Provider connection accepted" };
    } finally {
      busy = false;
    }
  });
  app.post("/api/session", async (req) => {
    if (stream || busy)
      throw new Error("A meeting is already active or connecting");
    const options = startSchema.parse(req.body);
    let key = options.key || env.SONIOX_API_KEY;
    if (!key) throw new Error("Soniox key required");
    busy = true;
    delete options.key;
    try {
      for (const viewer of viewers)
        viewer.close(1008, "Meeting changed; request a new viewer link");
      viewerToken = token();
      viewerExpiry = Date.now() + 12 * 3600000;
      save = options.save;
      speakerCorrections.clear();
      providerRevisions.clear();
      room = {
        id: randomUUID(),
        name: options.name,
        target: options.target,
        state: "connecting",
        segments: [],
        speakers: {},
        startedAt: new Date().toISOString(),
        metrics: { audioBytes: 0, droppedBytes: 0, updates: 0 },
      };
      stream = await provider.create(key, options, {
        segment(s) {
          if (!room) return;
          const index = room.segments.findIndex((old) => old.id === s.id);
          const old = room.segments[index];
          if (
            s.revision <= (providerRevisions.get(s.id) ?? 0) ||
            (old?.final && !s.final)
          )
            return;
          providerRevisions.set(s.id, s.revision);
          if (old) s.revision = Math.max(s.revision, old.revision + 1);
          const corrected = speakerCorrections.get(s.id);
          if (corrected) s.speakerId = corrected;
          if (index < 0) room.segments.push(s);
          else room.segments[index] = s;
          room.metrics.updates++;
          if (room.segments.length > 10000) {
            const removed = room.segments.shift();
            if (removed) {
              speakerCorrections.delete(removed.id);
              providerRevisions.delete(removed.id);
            }
            emit(
              "processing.error",
              "Caption memory limit reached; oldest caption removed. Export regularly.",
            );
          }
          emit(
            s.channel === "translation"
              ? "translation.updated"
              : s.final
                ? "transcript.finalized"
                : "transcript.updated",
            undefined,
            s,
          );
        },
        state(state) {
          if (room) room.state = state;
          emit("connection.changed", state);
        },
        error(message) {
          if (room)
            room.metrics.providerErrors =
              (room.metrics.providerErrors ?? 0) + 1;
          emit("processing.error", message);
        },
        usage(metrics) {
          if (room) Object.assign(room.metrics, metrics);
        },
      });
      key = "";
      emit("session.started");
      return { room, viewerUrl: `/viewer#${viewerToken}` };
    } catch (error) {
      if (room) room.state = "failed";
      throw error;
    } finally {
      key = "";
      delete options.key;
      busy = false;
    }
  });
  app.post("/api/stop", async () => {
    await stop();
    return { ok: true };
  });
  app.post("/api/clear", async () => {
    if (stream || busy) throw new Error("Stop before clearing");
    if (room) {
      room.segments = [];
      room.speakers = {};
      for (const s of sockets) s.send(JSON.stringify(snapshot()));
    }
    return { ok: true };
  });
  app.post("/api/speaker", async (req) => {
    const { id, name, segmentId } = z
      .object({
        id: z.string().max(100),
        name: z.string().max(100),
        segmentId: z.string().optional(),
      })
      .strict()
      .parse(req.body);
    if (!room) throw new Error("No meeting");
    room.speakers[id] = name;
    if (segmentId) {
      const s = room.segments.find((s) => s.id === segmentId);
      if (s) {
        speakerCorrections.set(s.id, id);
        s.speakerId = id;
        s.revision++;
        emit("speaker.updated", undefined, s);
      }
    }
    emit("speaker.updated");
    for (const socket of sockets) socket.send(JSON.stringify(snapshot()));
    await persist();
    return { ok: true };
  });
  app.post("/api/viewer/rotate", async () => {
    viewerToken = token();
    viewerExpiry = Date.now() + 12 * 3600000;
    for (const s of viewers) s.close(1008, "Viewer access revoked");
    return { viewerUrl: `/viewer#${viewerToken}` };
  });
  app.get("/api/export/:format", async (req, reply) => {
    if (!room) throw new Error("No meeting");
    const { format } = z
      .object({ format: z.enum(["json", "txt", "srt"]) })
      .parse(req.params);
    reply
      .header(
        "Content-Disposition",
        `attachment; filename="linguaroom.${format}"`,
      )
      .type(format === "json" ? "application/json" : "text/plain");
    return exportTranscript(room, format);
  });
  app.get("/api/saved", async () => {
    try {
      return {
        sessions: (await readdir(cfg.DATA_DIR)).filter((f) =>
          /^[a-f0-9-]{36}\.json$/.test(f),
        ),
      };
    } catch {
      return { sessions: [] };
    }
  });
  app.get("/api/saved/:id", async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return reply
      .type("application/json")
      .send(await readFile(resolve(cfg.DATA_DIR, `${id}.json`), "utf8"));
  });
  app.delete("/api/saved/:id", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await unlink(resolve(cfg.DATA_DIR, `${id}.json`));
    return { ok: true };
  });
  app.server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://local");
    const proxyTrusted = [
      "127.0.0.1",
      "::1",
      "::ffff:127.0.0.1",
      cfg.PROXY_ADDRESS,
    ].includes(req.socket.remoteAddress);
    const protocol = cfg.https
      ? "https"
      : cfg.TRUST_PROXY === "true" &&
          proxyTrusted &&
          req.headers["x-forwarded-proto"] === "https"
        ? "https"
        : "http";
    if (
      !originAllowed(req.headers.origin, req.headers.host, protocol) ||
      sockets.size >= 32
    ) {
      socket.destroy();
      return;
    }
    const cookies = app.parseCookie(req.headers.cookie ?? "");
    const host = hostAuth(cookies);
    const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
      req.socket.remoteAddress ?? "",
    );
    const hostSecure =
      protocol === "https" ||
      (local &&
        ["localhost", "127.0.0.1", "[::1]"].includes(
          (req.headers.host ?? "").replace(/:\d+$/, ""),
        ));
    const viewer =
      url.pathname === "/ws/viewer" &&
      url.searchParams.get("token") === viewerToken &&
      viewerToken !== "" &&
      Date.now() < viewerExpiry;
    if (!(viewer || (host && hostSecure && url.pathname === "/ws/host"))) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      let audioWindow = Date.now();
      let audioWindowBytes = 0;
      let alive = true;
      ws.on("pong", () => {
        alive = true;
      });
      Object.assign(ws, {
        isAlive: () => alive,
        markPing: () => {
          alive = false;
        },
      });
      sockets.add(ws);
      if (viewer) viewers.add(ws);
      ws.send(JSON.stringify(snapshot()));
      const expiry = setTimeout(
        () => ws.close(1008, "Access expired"),
        Math.max(
          1,
          (viewer ? viewerExpiry : hosts.get(cookies.lr_host!)!) - Date.now(),
        ),
      );
      ws.on("message", (raw, binary) => {
        if (!viewer && !hostAuth(cookies)) {
          ws.close(1008, "Host authorization expired");
          return;
        }
        if (viewer) {
          ws.close(1008, "Read-only");
          return;
        }
        if (
          !binary ||
          !stream ||
          !room ||
          Buffer.from(raw as Buffer).length % 2 !== 0
        ) {
          ws.close(1008, "Audio unavailable or invalid");
          return;
        }
        if (audioSocket && audioSocket !== ws) {
          ws.close(1008, "Only one microphone connection allowed");
          return;
        }
        audioSocket = ws;
        clearTimeout(disconnectedTimer);
        const data = Buffer.from(raw as Buffer);
        if (Date.now() - audioWindow > 1000) {
          audioWindow = Date.now();
          audioWindowBytes = 0;
        }
        audioWindowBytes += data.length;
        if (audioWindowBytes > 64000) {
          ws.close(1008, "Audio rate exceeded");
          return;
        }
        if (!stream.audio(data)) room.metrics.droppedBytes += data.length;
        else room.metrics.audioBytes += data.length;
      });
      ws.on("close", () => {
        clearTimeout(expiry);
        sockets.delete(ws);
        viewers.delete(ws);
        if (audioSocket === ws) {
          audioSocket = undefined;
          emit(
            "processing.error",
            "Microphone disconnected; audio may be lost. Session stops in 30 seconds unless reconnected.",
          );
          disconnectedTimer = setTimeout(
            () => void stop().catch(() => {}),
            30000,
          );
        }
      });
      ws.on("error", () => {});
    });
  });
  const heartbeat = setInterval(() => {
    for (const s of sockets) {
      const tracked = s as WebSocket & {
        isAlive: () => boolean;
        markPing: () => void;
      };
      if (!tracked.isAlive()) {
        s.terminate();
        continue;
      }
      if (s.readyState === WebSocket.OPEN) {
        tracked.markPing();
        s.ping();
      }
    }
  }, 20000);
  await app.register(staticFiles, { root: resolve("dist/web"), prefix: "/" });
  app.setNotFoundHandler((req, reply) =>
    req.url.startsWith("/api/")
      ? reply.code(404).send({ error: "Not found" })
      : reply.sendFile("index.html"),
  );
  app.addHook("onClose", async () => {
    clearInterval(heartbeat);
    clearTimeout(disconnectedTimer);
    for (const s of sockets) s.close(1001, "Server shutdown");
    await stream?.end();
    await persist();
    wss.close();
  });
  return { app, cfg };
}
