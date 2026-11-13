import AgoraRTC, {
  type IAgoraRTCClient, type IAgoraRTCRemoteUser, type IMicrophoneAudioTrack, type IRemoteAudioTrack,
} from "agora-rtc-sdk-ng";
import type { BrowserConnection } from "../agora.js";

const startButton = document.querySelector<HTMLButtonElement>("#start")!;
const stopButton = document.querySelector<HTMLButtonElement>("#stop")!;
const playbackButton = document.querySelector<HTMLButtonElement>("#playback")!;
const source = document.querySelector<HTMLElement>("#source")!;
const status = document.querySelector<HTMLElement>("#status")!;
const panel = document.querySelector<HTMLElement>("#session")!;
const stateLabel = document.querySelector<HTMLElement>("#state-label")!;

type SessionState = "idle" | "starting" | "live" | "stopping" | "error";
const stateLabels: Record<SessionState, string> = {
  idle: "Ready", starting: "Connecting", live: "Active", stopping: "Stopping", error: "Error",
};

interface Run {
  id: string;
  cancelled: boolean;
  requested: boolean;
  ready: boolean;
  mic?: IMicrophoneAudioTrack;
  client?: IAgoraRTCClient;
  audio?: IRemoteAudioTrack;
  timer?: number;
  stopRequest?: Promise<void>;
  startupFailure?: string;
}

let run: Run | undefined;
let retryStop: Run | undefined;
let configured = false;
AgoraRTC.setLogLevel(4);

function render(state: SessionState, message: string) {
  panel.dataset.state = state;
  stateLabel.textContent = stateLabels[state];
  status.textContent = message;
  startButton.disabled = !configured || !!run || !!retryStop;
  stopButton.disabled = state === "stopping" || (!retryStop && (!run || run.cancelled));
  if (state !== "live" && state !== "starting") playbackButton.hidden = true;
}

// Only fixed backend messages are eligible for display. Never relay arbitrary
// response text: a proxy or SDK error can contain credentials or request data.
const safeBackendErrors = new Set([
  "Open the app on localhost.",
  "Session controls require the approved browser origin.",
  "Session controls require the local browser origin.",
  "Mobile authentication required.",
  "Send a JSON object.", "Send a valid JSON object.", "Request body is too large.",
  "Route not found.", "Invalid session ID.", "The local server is closing.",
  "Add the voice settings from .env.example and restart.",
  "Another session is starting or active. Stop it or wait for it to expire.",
  "The session was stopped during startup.",
  "The local server could not complete the request.",
  "The microphone can close now. Agora stop could not be confirmed. Try Stop again or wait for expiry.",
]);
class PostError extends Error {}

function safeBackendError(result: Record<string, unknown>): string {
  const message = result.error;
  if (typeof message !== "string") return "";
  if (safeBackendErrors.has(message)) return ` ${message}`;
  // The server sanitizes Agora details; retain the actionable summary without
  // forwarding dynamic text or structured upstream objects into the UI.
  if (message.startsWith("Agora could not start the voice session")) {
    return " Agora could not start the voice session. Check the server configuration and callback URL.";
  }
  return "";
}

async function post<T>(path: "/api/start" | "/api/stop", id: string): Promise<T> {
  let response: Response;
  const unavailable = `${path}; HTTP unavailable; content type unavailable; redirected unavailable`;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
      keepalive: path === "/api/stop",
      signal: AbortSignal.timeout(25_000),
    });
  } catch {
    throw new PostError(`Network/request failure (${unavailable}). Check the connection and retry.`);
  }
  const mime = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  const isJson = mime === "application/json" || mime === "application/problem+json";
  const contentType = ["application/json", "application/problem+json", "text/html", "text/plain", "application/octet-stream"].includes(mime ?? "")
    ? mime : mime ? "other" : "missing";
  const details = `${path}; HTTP ${response.status}; content type ${contentType}; redirected ${response.redirected ? "yes" : "no"}`;
  let text: string;
  try { text = await response.text(); } catch {
    throw new PostError(`Network/response read failure (${details}).`);
  }
  let result: unknown;
  let issue = "";
  if (!text.trim()) issue = "Empty JSON response";
  else if (!isJson) issue = "Expected a JSON response";
  else {
    try { result = JSON.parse(text); } catch { issue = "Invalid JSON response"; }
    if (!issue && (!result || typeof result !== "object" || Array.isArray(result))) issue = "Invalid JSON response object";
  }
  if (!response.ok) {
    const backend = issue ? "" : safeBackendError(result as Record<string, unknown>);
    throw new PostError(`HTTP error (${details}).${backend}${issue ? ` ${issue}.` : ""}`);
  }
  if (issue) throw new PostError(`${issue} (${details}).`);
  return result as T;
}

function startupMessage(stage: string, error: unknown): string {
  if (error instanceof PostError) return `${stage} failed: ${error.message}`;
  const names = new Set(["NotAllowedError", "NotFoundError", "NotReadableError", "NotSupportedError", "SyntaxError", "TypeError", "AbortError", "TimeoutError"]);
  const name = error && typeof error === "object" && "name" in error && typeof error.name === "string" && names.has(error.name)
    ? ` (${error.name})` : "";
  const hint = stage === "Microphone access" ? "Check browser permissions and try again." : "Check browser audio support and your connection, then try again.";
  return `${stage} failed${name}. ${hint}`;
}

function releaseAudio(current: Run) {
  window.clearTimeout(current.timer);
  current.mic?.close();
  current.mic = undefined;
  current.audio?.stop();
  current.audio = undefined;
}

function stopAgent(current: Run): Promise<void> {
  if (!current.requested) return Promise.resolve();
  current.stopRequest ??= post("/api/stop", current.id).then(() => undefined).catch(error => {
    current.stopRequest = undefined;
    throw error;
  });
  return current.stopRequest;
}

async function end(current: Run, message = "Session ended. Start whenever you’re ready.", state: SessionState = "idle") {
  if (current.cancelled) return;
  current.cancelled = true;
  releaseAudio(current);
  render("stopping", "Stopping voice…");
  try {
    // Ask the server immediately. A join still in progress leaves when it settles.
    const remote = stopAgent(current);
    const local = current.ready ? current.client?.leave() : undefined;
    await Promise.all([remote, local?.catch(() => undefined)]);
    if (run === current) run = undefined;
    render(state, message);
  } catch (error) {
    if (run === current) run = undefined;
    retryStop = current;
    const cleanup = error instanceof PostError ? error.message : "Could not confirm the session ended.";
    render("error", `${current.startupFailure ? `${current.startupFailure} ` : ""}Cleanup failed: ${cleanup} Try Stop again.`);
  }
}

async function start() {
  if (run || retryStop || !configured) return;
  const current: Run = { id: crypto.randomUUID(), cancelled: false, requested: false, ready: false };
  run = current;
  render("starting", "Waiting for microphone permission…");
  let stage = "Microphone access";
  try {
    const mic = await AgoraRTC.createMicrophoneAudioTrack({ AEC: true, ANS: true });
    if (current.cancelled) { mic.close(); return; }
    current.mic = mic;
    render("starting", "Connecting to Agora…");
    stage = "Session start (/api/start)";
    current.requested = true;
    const rtc = await post<BrowserConnection & { expiresAt: number }>("/api/start", current.id);
    if (current.cancelled) {
      // Stop may have arrived at the server before Start.
      current.stopRequest = undefined;
      await stopAgent(current);
      return;
    }
    current.timer = window.setTimeout(() => {
      void end(current, "The three-minute session ended. Start again to continue.");
    }, Math.max(0, rtc.expiresAt - Date.now()));
    stage = "RTC client creation";
    const client = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });
    current.client = client;

    const subscribe = async (user: IAgoraRTCRemoteUser) => {
      if (current.cancelled || user.uid !== rtc.agentUid) return;
      try {
        await client.subscribe(user, "audio");
        if (current.cancelled) return;
        current.audio = user.audioTrack;
        current.audio?.play();
      } catch {
        void end(current, "Agent audio could not be played. Start again to retry.", "error");
      }
    };
    client.on("user-published", (user, media) => { if (media === "audio") void subscribe(user); });
    client.on("user-left", user => {
      if (user.uid === rtc.agentUid) void end(current, "The voice agent disconnected.");
    });
    client.on("token-privilege-did-expire", () => void end(current, "The voice session expired."));
    client.on("connection-state-change", state => {
      if (state === "DISCONNECTED" && current.ready) {
        void end(current, "The audio connection was lost. Start again to reconnect.", "error");
      }
    });

    stage = "RTC join";
    await client.join(rtc.appId, rtc.channel, rtc.token, rtc.uid);
    if (current.cancelled) return;
    stage = "Microphone publication";
    await client.publish(mic);
    if (current.cancelled) return;
    current.ready = true;
    render("live", "Microphone on. Ask a question.");
  } catch (error) {
    if (!current.cancelled) {
      const message = startupMessage(stage, error);
      current.startupFailure = message;
      await end(current, message, "error");
    }
  } finally {
    if (current.cancelled && !current.ready) await current.client?.leave().catch(() => undefined);
  }
}

startButton.addEventListener("click", () => void start());
stopButton.addEventListener("click", async () => {
  if (retryStop) {
    const pending = retryStop;
    render("stopping", "Retrying session cleanup…");
    try {
      await stopAgent(pending);
      retryStop = undefined;
      render("idle", "Session ended. Start whenever you’re ready.");
    } catch (error) {
      const cleanup = error instanceof PostError ? error.message : "Could not confirm the Agora stop.";
      render("error", `${pending.startupFailure ? `${pending.startupFailure} ` : ""}Cleanup retry failed: ${cleanup} Try again or wait for expiry.`);
    }
  } else if (run) {
    void end(run);
  }
});
AgoraRTC.on("autoplay-failed", () => {
  if (run?.audio && !run.cancelled) playbackButton.hidden = false;
});
playbackButton.addEventListener("click", () => {
  playbackButton.hidden = true;
  run?.audio?.play();
});
window.addEventListener("pagehide", () => {
  const current = run ?? retryStop;
  if (!current) return;
  current.cancelled = true;
  releaseAudio(current);
  if (current.requested) {
    navigator.sendBeacon("/api/stop", new Blob([JSON.stringify({ id: current.id })], { type: "application/json" }));
  }
  void current.client?.leave().catch(() => undefined);
});
window.addEventListener("pageshow", event => { if (event.persisted) location.reload(); });

try {
  const response = await fetch("/api/info");
  if (!response.ok) throw new Error();
  const info = await response.json() as { synthetic: boolean; demoDate?: string; voiceConfigured: boolean; voiceMode: "health" | "basic" };
  source.dataset.provider = info.synthetic ? "synthetic" : "garmin";
  source.textContent = info.synthetic
    ? "Synthetic Data — demonstration mode"
    : "Garmin — live reference integration";
  if (info.voiceMode === "basic") {
    document.querySelector<HTMLElement>(".intro")!.textContent = "Basic voice mode · Start a short conversation with the voice assistant.";
    document.querySelector<HTMLElement>(".examples")!.hidden = true;
  }
  configured = info.voiceConfigured;
  render("idle", configured ? "Ready to start a voice session." : "Voice setup needed. Complete the server configuration to enable conversations.");
} catch {
  source.textContent = "Data source unavailable";
  render("error", "Could not read local setup. Restart the server and reload.");
}
