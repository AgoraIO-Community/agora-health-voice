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
}

let run: Run | undefined;
let retryStop: Run | undefined;
let configured = false;
AgoraRTC.setLogLevel(4);

function render(state: string, message: string) {
  panel.dataset.state = state;
  status.textContent = message;
  startButton.disabled = !configured || !!run || !!retryStop;
  stopButton.disabled = state === "stopping" || (!retryStop && (!run || run.cancelled));
  if (state !== "live" && state !== "starting") playbackButton.hidden = true;
}

async function post<T>(path: string, id: string): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
    keepalive: path === "/api/stop",
    signal: AbortSignal.timeout(25_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "The local server could not complete the request.");
  return result as T;
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

async function end(current: Run, message = "Session ended. Start whenever you’re ready.", state = "idle") {
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
    render("error", error instanceof Error ? error.message : "Could not confirm the session ended. Try Stop again.");
  }
}

async function start() {
  if (run || retryStop || !configured) return;
  const current: Run = { id: crypto.randomUUID(), cancelled: false, requested: false, ready: false };
  run = current;
  render("starting", "Waiting for microphone permission…");
  try {
    const mic = await AgoraRTC.createMicrophoneAudioTrack({ AEC: true, ANS: true });
    if (current.cancelled) { mic.close(); return; }
    current.mic = mic;
    render("starting", "Connecting to Agora…");
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

    await client.join(rtc.appId, rtc.channel, rtc.token, rtc.uid);
    if (current.cancelled) return;
    await client.publish(mic);
    if (current.cancelled) return;
    current.ready = true;
    render("live", "Microphone on. Ask a question.");
  } catch (error) {
    if (!current.cancelled) {
      const message = !current.requested
        ? "Microphone access failed. Check browser permissions and try again."
        : error instanceof Error && !current.client
          ? error.message
          : "Could not connect audio. Check your connection and try again.";
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
    } catch {
      render("error", "Could not confirm the Agora stop. Try again or wait for expiry.");
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
  source.textContent = info.synthetic ? `Synthetic data · Demo date ${info.demoDate}` : "Custom data source";
  if (info.voiceMode === "basic") {
    source.textContent = "Basic Voice · Conversation test";
    document.querySelector<HTMLElement>(".intro")!.textContent = "Start a short conversation with the voice assistant.";
    document.querySelector<HTMLElement>(".examples")!.hidden = true;
  }
  configured = info.voiceConfigured;
  render("idle", configured ? "Ready to start a voice session." : "Voice setup needed. Add credentials and a callback URL in .env.");
} catch {
  source.textContent = "Data source unavailable";
  render("error", "Could not read local setup. Restart the server and reload.");
}
