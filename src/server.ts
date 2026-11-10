import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type RequestListener, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  AgoraRequestError, createAgoraGateway, readAgoraConfig, sessionDurationMs,
  type AgoraGateway, type BrowserConnection, type VoiceSessionRequest,
} from "./agora.js";
import { createCustomProvider } from "./providers/custom.js";
import { loadSyntheticProvider } from "./providers/synthetic.js";
import type { CalendarDate, HealthDataProvider } from "./providers/types.js";
import { InvalidToolInput, isToolName, localDate, runTool } from "./tools.js";

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly agora?: {
    requestId?: string; timestamp: string; status?: number; validationDetails: unknown[];
  }) { super(message); }
}

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers["content-type"]?.split(";")[0] !== "application/json") {
    throw new HttpError(415, "Send a JSON object.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  // Keep the connection open long enough to return 413 for an oversized body.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 4096) throw new HttpError(413, "Request body is too large.");
    chunks.push(chunk);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // Return the same response for malformed JSON and non-object JSON.
  }
  throw new HttpError(400, "Send a valid JSON object.");
}

function route(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>): RequestListener {
  return (req, res) => {
    void handler(req, res).catch((error: unknown) => {
      if (res.destroyed || res.writableEnded) return;
      if (error instanceof HttpError) {
        if (error.status === 413) res.setHeader("Connection", "close");
        json(res, error.status, { error: error.message, ...(error.agora ? { agora: error.agora } : {}) });
      } else if (error instanceof InvalidToolInput) {
        json(res, 400, { error: error.message });
      } else {
        json(res, 500, { error: "The local server could not complete the request." });
      }
    });
  };
}

interface Session extends VoiceSessionRequest {
  expiresAt: number;
  revoked: boolean;
  started?: Promise<{ agentId: string; rtc: BrowserConnection }>;
  cleanup?: Promise<void>;
  timer: NodeJS.Timeout;
}

interface Options {
  provider: HealthDataProvider;
  demoDate?: CalendarDate;
  timeZone: string;
  gateway?: AgoraGateway;
  localPort: number;
  html: Buffer;
  script: Buffer;
  durationMs?: number;
  healthDebug?: boolean;
  voiceMode?: "health" | "basic" | "single-tool";
}

export function createHandlers(options: Options) {
  let active: Session | undefined;
  let shuttingDown = false;
  const { gateway } = options;
  const duration = options.durationMs ?? sessionDurationMs;
  const hosts = new Set([`localhost:${options.localPort}`, `127.0.0.1:${options.localPort}`]);

  function stop(session: Session): Promise<void> {
    session.revoked = true;
    if (session.cleanup) return session.cleanup;
    session.cleanup = (async () => {
      if (!gateway) return;
      let id: string | undefined;
      try {
        id = (await session.started)?.agentId;
      } catch (error) {
        // A lost response can conceal an agent that Agora successfully started.
        if (error instanceof AgoraRequestError && error.status &&
          error.status < 500 && ![408, 409, 429].includes(error.status)) return;
        id = await gateway.find(session.channel);
        if (!id) {
          await delay(750);
          id = await gateway.find(session.channel);
        }
      }
      if (id) {
        try {
          await gateway.stop(id);
        } catch {
          await delay(400);
          await gateway.stop(id);
        }
      }
    })().then(() => {
      clearTimeout(session.timer);
      if (active === session) active = undefined;
    }, () => {
      session.cleanup = undefined;
      throw new HttpError(502, "The microphone can close now. Agora stop could not be confirmed. Try Stop again or wait for expiry.");
    });
    return session.cleanup;
  }

  function expire(session: Session) {
    void stop(session).catch(() => {
      console.error("Could not confirm the Agora stop. Agora's session duration limit still applies.");
      // Allow any in-flight remote start its full server-enforced lifetime.
      session.timer = setTimeout(() => {
        if (active === session) active = undefined;
      }, 15_000);
      session.timer.unref();
    });
  }

  const local = route(async (req, res) => {
    const host = req.headers.host;
    if (!host || !hosts.has(host) || req.headers.forwarded || req.headers["x-forwarded-host"]) {
      throw new HttpError(403, "Open the app on localhost.");
    }
    const path = new URL(req.url ?? "/", `http://${host}`).pathname;
    if (req.method === "GET" && (path === "/" || path === "/browser.js")) {
      res.writeHead(200, {
        "Content-Type": path === "/" ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer",
        "Permissions-Policy": "microphone=(self), camera=()",
      });
      res.end(path === "/" ? options.html : options.script);
      return;
    }
    if (req.method === "GET" && path === "/api/info") {
      return json(res, 200, { synthetic: !!options.demoDate, demoDate: options.demoDate, voiceConfigured: !!gateway, voiceMode: options.voiceMode ?? "health" });
    }
    if (req.method !== "POST" || (path !== "/api/start" && path !== "/api/stop")) {
      throw new HttpError(404, "Route not found.");
    }
    if (req.headers.origin !== `http://${host}` || req.headers["sec-fetch-site"] === "cross-site") {
      throw new HttpError(403, "Session controls require the local browser origin.");
    }
    const { id } = await body(req);
    if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)) throw new HttpError(400, "Invalid session ID.");
    if (path === "/api/stop") {
      if (active?.id === id) await stop(active);
      return json(res, 200, { stopped: true });
    }
    if (shuttingDown || res.destroyed) throw new HttpError(503, "The local server is closing.");
    if (!gateway) throw new HttpError(503, "Add the voice settings from .env.example and restart.");
    if (active) throw new HttpError(409, "Another session is starting or active. Stop it or wait for it to expire.");

    const session: Session = {
      id,
      channel: `health-${randomBytes(12).toString("hex")}`,
      callbackBearer: randomBytes(32).toString("base64url"),
      expiresAt: Date.now() + duration,
      revoked: false,
      timer: setTimeout(() => expire(session), duration),
    };
    session.timer.unref();
    active = session;
    session.started = gateway.start(session);
    res.once("close", () => {
      if (!res.writableFinished) expire(session);
    });
    try {
      const { rtc } = await session.started;
      if (session.revoked) throw new HttpError(409, "The session was stopped during startup.");
      json(res, 200, { ...rtc, expiresAt: session.expiresAt });
    } catch (error) {
      expire(session);
      if (error instanceof HttpError) throw error;
      const detail = error instanceof AgoraRequestError && error.status ? ` (HTTP ${error.status})` : "";
      const diagnostic = error instanceof AgoraRequestError && error.diagnostic ? ` ${error.diagnostic}` : "";
      throw new HttpError(502, `Agora could not start the voice session${detail}.${diagnostic} Check the project, credentials, and callback URL.`,
        error instanceof AgoraRequestError ? {
          requestId: error.requestId, timestamp: error.timestamp,
          status: error.status, validationDetails: error.validationDetails,
        } : undefined);
    }
  });

  let callbackNumber = 0;
  const callbacks = route(async (req, res) => {
    const callback = ++callbackNumber;
    const functions: Record<string, string> = {
      sleep: "getSleep", "heart-rate": "getDailyHeartRate", movement: "getDailyMovement",
      activities: "getRecentActivities", "fictional-steps": "getFictionalSteps",
    };
    // Emit only local sequence numbers and fixed labels. Never include request values.
    const log = (event: string, fields: Record<string, string | number> = {}) => {
      if (options.healthDebug) {
        console.info(JSON.stringify({ event: `health_tool_${event}`, callback, ...fields }));
      }
    };
    log("arrived");
    res.once("finish", () => log("response", { status: res.statusCode }));
    res.once("close", () => {
      if (!res.writableFinished) log("connection_closed");
    });
    const path = req.url ?? "";
    const name = path.startsWith("/tools/") ? path.slice(7) : "";
    if (req.method !== "POST" || (!isToolName(name) && !(options.voiceMode === "single-tool" && name === "fictional-steps"))) throw new HttpError(404, "Route not found.");
    log("function", { function: functions[name]! });
    const session = active;
    const supplied = req.headers.authorization ?? "";
    const expected = `Bearer ${session?.callbackBearer ?? ""}`;
    if (!session || session.revoked || Date.now() >= session.expiresAt ||
      Buffer.byteLength(supplied) !== expected.length ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
      log("authentication", { outcome: "failed" });
      throw new HttpError(401, "Tool authorization failed.");
    }
    log("authentication", { outcome: "succeeded" });
    const args = await body(req);
    if (session.revoked || Date.now() >= session.expiresAt) throw new HttpError(401, "The session expired.");
    let result: unknown;
    try {
      if (name === "fictional-steps") {
        if (Object.keys(args).length) throw new InvalidToolInput("This test takes no arguments.");
        result = { status: "available", fictional: true, steps: 1234 };
      } else if (isToolName(name)) {
        result = await runTool(options.provider, name, args, options.demoDate ?? localDate(options.timeZone));
      }
      const status = (result as { status?: unknown })?.status;
      log("provider", {
        outcome: "succeeded",
        status: typeof status === "string" && ["available", "missing", "unsupported", "unavailable"].includes(status)
          ? status : "unknown",
      });
    } catch (error) {
      log("provider", { outcome: error instanceof InvalidToolInput ? "invalid_arguments" : "failed" });
      if (error instanceof InvalidToolInput) throw error;
      result = { status: "unavailable" };
    }
    if (session.revoked || Date.now() >= session.expiresAt) throw new HttpError(401, "The session expired.");
    json(res, 200, result);
  });

  return {
    local,
    callbacks,
    async shutdown() {
      shuttingDown = true;
      if (active) await stop(active);
    },
  };
}

function port(value: string | undefined, fallback: number) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < 1024 || number > 65535) {
    throw new Error("Choose a port from 1024 to 65535.");
  }
  return number;
}

async function main() {
  const env = process.env;
  const selected = env.HEALTH_DATA_PROVIDER ?? "synthetic";
  if (selected !== "synthetic" && selected !== "custom") {
    throw new Error("HEALTH_DATA_PROVIDER must be synthetic or custom.");
  }
  const source = selected === "custom"
    ? { provider: createCustomProvider(), demoDate: undefined }
    : await loadSyntheticProvider();
  const voiceMode = env.VOICE_MODE ?? "health";
  if (voiceMode !== "health" && voiceMode !== "basic" && voiceMode !== "single-tool") throw new Error("VOICE_MODE must be health, basic or single-tool.");
  const config = readAgoraConfig(env);
  const timeZone = env.HEALTH_TIME_ZONE ?? "UTC";
  localDate(timeZone); // Validate the time zone before opening ports.
  const localPort = port(env.LOCAL_PORT, 3000);
  const callbackPort = port(env.CALLBACK_PORT, 3001);
  if (localPort === callbackPort) throw new Error("LOCAL_PORT and CALLBACK_PORT must differ.");

  const handlers = createHandlers({
    ...source,
    timeZone,
    gateway: config && createAgoraGateway(config, fetch, voiceMode),
    voiceMode,
    healthDebug: env.HEALTH_DEBUG === "true",
    localPort,
    html: await readFile(new URL("../src/browser/index.html", import.meta.url)),
    script: await readFile(new URL("./browser.js", import.meta.url)),
  });

  const servers = [createServer(handlers.local), createServer(handlers.callbacks)];
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    for (const server of servers) {
      server.close();
      server.closeAllConnections();
    }
    try {
      await handlers.shutdown();
    } catch {
      console.error("Could not confirm the Agora stop. Agora's session duration limit still applies.");
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
  const ports = [localPort, callbackPort];
  servers.forEach((server, index) => {
    server.requestTimeout = 10_000;
    server.headersTimeout = 5000;
    server.on("error", error => {
      console.error(`Could not open the local listener on port ${ports[index]}: ${(error as NodeJS.ErrnoException).code ?? "error"}`);
      process.exitCode = 1;
      void close();
    });
    server.listen(ports[index], "127.0.0.1", () => {
      if (index === 0) console.log(`Health Voice is available at http://localhost:${localPort}`);
      else console.log(`Tool callbacks are on http://127.0.0.1:${callbackPort}. Tunnel only this port.`);
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Unable to start Health Voice.");
    process.exitCode = 1;
  });
}
