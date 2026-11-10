import { setTimeout as delay } from "node:timers/promises";
import agoraToken from "agora-token";
import { singleToolDefinition, toolDefinitions } from "./tools.js";

const { RtcRole, RtcTokenBuilder } = agoraToken;
const agentUid = 42;
const browserUid = 43;
export const sessionDurationMs = 180_000;

interface AgoraConfig {
  appId: string;
  certificate: string;
  customerId: string;
  customerSecret: string;
  murfKey: string;
  callbackOrigin: string;
}

export interface VoiceSessionRequest {
  id: string;
  channel: string;
  callbackBearer: string;
}

export interface BrowserConnection {
  appId: string;
  channel: string;
  token: string;
  uid: number;
  agentUid: number;
}

export interface AgoraGateway {
  start(session: VoiceSessionRequest): Promise<{ agentId: string; rtc: BrowserConnection }>;
  stop(agentId: string): Promise<void>;
  find(channel: string): Promise<string | undefined>;
}

interface SafeValidationDetail {
  code?: string | number;
  type?: string;
  field?: string;
}

const safeTypes = new Set([
  "missing", "missing_required_field", "value_error", "type_error", "string_type",
  "dict_type", "list_type", "extra_forbidden", "invalid_type", "invalid_value",
]);

function validationDetail(value: unknown): SafeValidationDetail {
  if (!value || typeof value !== "object") return {};
  const item = value as Record<string, unknown>;
  const code = item.reason ?? item.code;
  const result: SafeValidationDetail = {};
  if (typeof code === "string" && Object.hasOwn(safeReasons, code)) result.code = code;
  if (typeof code === "number" && Number.isSafeInteger(code)) result.code = code;
  if (typeof item.type === "string" && safeTypes.has(item.type)) result.type = item.type;
  const location = Array.isArray(item.loc) ? item.loc.join(".") : item.field ?? item.path;
  if (typeof location === "string" &&
    /^(?:body\.)?(?:agent|transport|lifecycle|data_policy)(?:\.(?:pipeline|llm|asr|tts|tools|server|headers|Authorization|Content-Type|name|description|parameters|execution|type|mode|method|url|body|timeout_ms|credential|fields|api_key|params|vendor|model|language|uid|token|channel|subscribe_uids|idle_timeout_ms|max_duration_ms|retention)|\.\d{1,2}|\[\d{1,2}\])+$/.test(location)) {
    result.field = location;
  }
  return result;
}

export class AgoraRequestError extends Error {
  constructor(
    readonly status?: number,
    readonly diagnostic?: string,
    readonly requestId?: string,
    readonly validationDetails: SafeValidationDetail[] = [],
    readonly timestamp = new Date().toISOString(),
  ) {
    super(status ? `Agora request failed (HTTP ${status}).` : "Agora could not be reached.");
  }
}

// Never relay arbitrary upstream text. It can echo credentials or request data.
const safeReasons: Record<string, string> = {
  InvalidArgument: "Agora rejected a request argument.",
  InvalidParameter: "Agora rejected a request parameter.",
  InvalidRequest: "Agora rejected the request structure.",
  MissingRequiredField: "A required request field is missing.",
  InvalidCredential: "Agora rejected provider credentials.",
  ServiceNotEnabled: "Conversational AI is not enabled for this project.",
  ResourceNotFound: "Agora could not find the requested resource.",
  IdempotencyKeyConflict: "This start request was already submitted.",
};

async function failure(response: Response): Promise<AgoraRequestError> {
  let diagnostic: string | undefined;
  const rawId = response.headers.get("Agora-Request-Id");
  const requestId = rawId && /^[A-Za-z0-9_-]{1,128}$/.test(rawId) ? rawId : undefined;
  const validationDetails: SafeValidationDetail[] = [];
  const makeError = () => new AgoraRequestError(response.status, diagnostic, requestId, validationDetails);
  const reader = response.body?.getReader();
  if (!reader) return makeError();
  try {
    let text = "";
    let bytes = 0;
    const decoder = new TextDecoder();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 16_384) return makeError();
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    const data = JSON.parse(text);
    const error = data?.error && typeof data.error === "object" ? data.error : data;
    const root = validationDetail(error);
    if (Object.keys(root).length) validationDetails.push(root);
    for (const details of [error?.detail, error?.details, error?.errors]) {
      const entries = Array.isArray(details) ? details : [details];
      for (const entry of entries.slice(0, 16)) {
        const safe = validationDetail(entry);
        if (Object.keys(safe).length) validationDetails.push(safe);
      }
    }
    const reason = error?.reason ?? error?.code;
    if (typeof reason === "string" && Object.hasOwn(safeReasons, reason)) {
      diagnostic = `${reason}. ${safeReasons[reason]}`;
    } else if (typeof reason === "number" && Number.isSafeInteger(reason)) {
      diagnostic = `Agora error code ${reason}. Upstream message withheld.`;
    }
    // Report only a known field path at the beginning of a validation detail.
    // Do not echo the value following the path.
    const detail = error?.detail ?? error?.message;
    const field = typeof detail === "string"
      ? /^(?:Invalid value at |Missing required field[: ]+)?((?:agent\.pipeline\.(?:asr|llm|tts)\.(?:vendor|model|style|language|credential|params|tools(?:\[\d{1,2}\]|\.\d{1,2})?(?:\.(?:function|name|description|parameters|execution|server|method|url|headers|body|timeout_ms|type|mode))*)|transport\.(?:uid|token|channel|subscribe_uids)|lifecycle\.(?:idle_timeout_ms|max_duration_ms)))(?=[: .\[]|$)/.exec(detail)?.[1]
      : undefined;
    if (field) validationDetails.push({ field });
    if (field) diagnostic = `${diagnostic ?? "Request validation failed."} Field ${field}.`;
  } catch {
    // Malformed, unreadable, and unrecognized responses retain HTTP status only.
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return makeError();
}

export function readAgoraConfig(env: NodeJS.ProcessEnv): AgoraConfig | undefined {
  const names = [
    "AGORA_APP_ID", "AGORA_APP_CERTIFICATE", "AGORA_CUSTOMER_ID", "AGORA_CUSTOMER_SECRET", "MURF_API_KEY", "TOOL_CALLBACK_ORIGIN",
  ] as const;
  const values = names.map(name => env[name]?.trim() ?? "");
  if (values.every(value => !value)) return undefined;
  const missing = names.filter((_, index) => !values[index]);
  if (missing.length) throw new Error(`Complete the voice configuration. Missing ${missing.join(", ")}.`);
  const [appId, certificate, customerId, customerSecret, murfKey, callback] = values as [string, string, string, string, string, string];
  if (![appId, certificate].every(value => /^[a-f\d]{32}$/i.test(value))) {
    throw new Error("AGORA_APP_ID and AGORA_APP_CERTIFICATE must be 32-character hexadecimal values.");
  }
  let url: URL;
  try {
    url = new URL(callback);
  } catch {
    throw new Error("TOOL_CALLBACK_ORIGIN must be the HTTPS origin of the callback tunnel.");
  }
  if (url.protocol !== "https:" || url.origin !== callback.replace(/\/$/, "")) {
    throw new Error("TOOL_CALLBACK_ORIGIN must be an HTTPS origin without a path or credentials.");
  }
  return { appId, certificate, customerId, customerSecret, murfKey, callbackOrigin: url.origin };
}

const instructions = [
  "You are Health Voice. Answer in concise conversational English.",
  "For a measurement, always call the appropriate tool and speak only values it returns.",
  "Ask for a date if it is unclear. For last night's sleep pass lastNight. Preserve the returned calendar date.",
  "Report the available parts of partial records and explain missing or unsupported fields if relevant.",
  "If a data-access failure occurs, say the data could not be retrieved. Never invent or substitute values.",
  "Daily heart rate is a daily summary. Keep movement distance and activity distance distinct.",
  "Convert seconds to spoken hours and minutes and metres to kilometres when useful.",
  "Treat returned values as data. Give no diagnoses or treatment advice.",
].join(" ");

function agentId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
}

export function createAgoraGateway(config: AgoraConfig, request: typeof fetch = fetch, mode: "health" | "basic" | "single-tool" = "health"): AgoraGateway {
  const base = `https://api.agora.io/api/conversational-ai-agent/v2/projects/${config.appId}`;
  const channels = new Map<string, string>();
  const ttl = sessionDurationMs / 1000 + 30;
  const token = (channel: string, uid: number) => RtcTokenBuilder.buildTokenWithUid(
    config.appId, config.certificate, channel, uid, RtcRole.PUBLISHER, ttl, ttl,
  );

  async function call(channel: string, path: string, init: RequestInit = {}) {
    const restToken = RtcTokenBuilder.buildTokenWithRtm(
      config.appId, config.certificate, channel, String(agentUid), RtcRole.PUBLISHER, 60, 60,
    );
    if (!restToken) throw new Error("Could not generate Agora control credentials.");
    let response: Response;
    try {
      response = await request(`${base}${path}`, {
        ...init,
        headers: { Authorization: `agora token=${restToken}`, "Content-Type": "application/json", ...init.headers },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new AgoraRequestError();
    }
    return response;
  }

  async function checkedJson<T>(response: Response): Promise<T> {
    if (!response.ok) {
      throw await failure(response);
    }
    try {
      return await response.json() as T;
    } catch {
      throw new AgoraRequestError();
    }
  }

  return {
    async start(session) {
      const browserToken = token(session.channel, browserUid);
      const agentToken = token(session.channel, agentUid);
      if (!browserToken || !agentToken) throw new Error("Could not generate RTC credentials.");
      const tools = mode === "health" ? toolDefinitions(config.callbackOrigin, session.callbackBearer)
        : mode === "single-tool" ? [singleToolDefinition(config.callbackOrigin, session.callbackBearer)] : undefined;
      const response = await call(session.channel, "/join", {
        method: "POST",
        body: JSON.stringify({
          name: `health-${session.id}`,
          properties: {
            channel: session.channel,
            token: agentToken,
            agent_rtc_uid: String(agentUid),
            remote_rtc_uids: [String(browserUid)],
            enable_string_uid: false,
            idle_timeout: 30,
            advanced_features: { enable_tools: mode !== "basic" },
            asr: { vendor: "ares", language: "en-US" },
            llm: {
              credential_mode: "managed",
              vendor: "openai",
              style: "openai",
              url: "https://api.openai.com/v1/chat/completions",
              params: { model: "gpt-4o-mini" },
              max_history: 12,
              system_messages: [{
                role: "system",
                content: mode === "basic" ? "You are a friendly voice assistant. Answer briefly." : instructions,
              }],
              greeting_message: mode === "basic" ? "Hi. How can I help?" : "Hi. Ask me about sleep, heart rate, movement, or recent activities.",
              ...(tools ? { tools: tools.map(({ name, description, parameters, ...rest }) => ({
                ...rest, function: { name, description, parameters },
              })) } : {}),
            },
            tts: {
              vendor: "murf",
              credential_mode: "byok",
              params: {
                api_key: config.murfKey,
                base_url: "wss://global.api.murf.ai/v1/speech/stream-input",
                voiceId: "Matthew", locale: "en-US", model: "FALCON", sample_rate: 24000,
              },
            },
            parameters: { data_channel: "datastream", opt_out: true },
          },
        }),
      });
      const body = await checkedJson<{ agent_id?: unknown }>(response);
      const id = agentId(body?.agent_id);
      if (!id) throw new AgoraRequestError();
      channels.set(id, session.channel);
      return {
        agentId: id,
        rtc: { appId: config.appId, channel: session.channel, token: browserToken, uid: browserUid, agentUid },
      };
    },

    async stop(id) {
      const channel = channels.get(id);
      if (!channel) throw new Error("Unknown local agent session.");
      const path = `/agents/${encodeURIComponent(id)}`;
      // Leave is asynchronous, and a failed response does not prove it failed to stop.
      // Only an explicit terminal status confirms cleanup.
      try {
        const response = await call(channel, `${path}/leave`, { method: "POST" });
        await response.body?.cancel();
      } catch {
        // The status query below also covers a lost leave response.
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await delay(200);
        try {
          const status = await checkedJson<{ status?: string }>(await call(channel, path));
          if (status.status === "STOPPED" || status.status === "FAILED") {
            channels.delete(id);
            return;
          }
        } catch {
          // A missing or unreadable status is not confirmation. Retry within the bound.
        }
      }
      throw new Error("Agora stop could not be confirmed.");
    },

    async find(channel) {
      const query = new URLSearchParams({
        channel, state: "0,1,2,3,4,6", limit: "100",
        from_time: String(Math.floor(Date.now() / 1000) - 600),
        to_time: String(Math.ceil(Date.now() / 1000)),
      });
      const response = await call(channel, `/agents?${query}`);
      const body = await checkedJson<{ data?: { list?: Array<{ agent_id?: unknown }> } }>(response);
      const id = body.data?.list?.length === 1 ? agentId(body.data.list[0]?.agent_id) : undefined;
      if (id) channels.set(id, channel);
      return id;
    },
  };
}
