import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Activity, CalendarDate, HealthDataProvider, Measurement, ReadResult } from "./types.js";

const HOST = "https://personal.connectapi.garmin.com";
const TOKEN_PATH = "/personalapitoken-service/personal-api/personal-api-key/token";
const AUTH_TIMEOUT_MS = 10_000;
const DATA_TIMEOUT_MS = 4_000;
const BUDGET_MS = AUTH_TIMEOUT_MS + DATA_TIMEOUT_MS;
const REFRESH_MS = 60_000;
const PAGE_SIZE = 2;
const invalid = () => new Error("Garmin returned an invalid response.");
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Dependencies are injectable so validation never needs credentials or live requests. */
interface Options {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  keyFile?: string;
}

function credential(env: NodeJS.ProcessEnv, file: string): string {
  let value = env.GARMIN_PERSONAL_API_KEY;
  if (value === undefined) {
    let fd: number | undefined;
    try {
      // Refuse symlinks and group/world access; inspect the opened file, not its path.
      fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = fstatSync(fd);
      if (!info.isFile() || info.size > 16_384 || (info.mode & 0o077) !== 0 ||
          (process.getuid && info.uid !== process.getuid())) throw new Error();
      value = readFileSync(fd, "utf8");
    } catch {
      throw new Error("Garmin key file must be a readable, owner-only regular file.");
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  const key = value.trim();
  if (!key || key.length > 16_384 || !/^[\x21-\x7e]+$/.test(key)) {
    throw new Error("Garmin API key configuration is invalid.");
  }
  return key;
}

function calendarDate(v: unknown): v is CalendarDate {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isFinite(+d) && d.toISOString().slice(0, 10) === v;
}

function measurement(value: unknown, integer = false, positive = false, max = Number.MAX_SAFE_INTEGER): Measurement {
  if (value === null || value === undefined) return { status: "missing" };
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max ||
      (integer && !Number.isSafeInteger(value)) || (positive && value === 0)) throw invalid();
  return { status: "available", value };
}

function daily<T extends { date: CalendarDate }>(row: T): ReadResult<T> {
  return Object.values(row).some(v => object(v) && v.status === "available")
    ? { status: "available", record: row } : { status: "missing" };
}

function checkDate(row: Record<string, unknown>, date: CalendarDate, required = false) {
  if ((required || row.calendarDate !== undefined) && row.calendarDate !== date) throw invalid();
}

function activity(raw: unknown): { id: string; local: string; row: Activity } {
  if (!object(raw)) throw invalid();
  const id = raw.activityId;
  if (!((typeof id === "number" && Number.isSafeInteger(id) && id > 0) ||
      (typeof id === "string" && /^[1-9][0-9]{0,29}$/.test(id)))) throw invalid();
  // Garmin's local timestamp defines its calendar date; never reinterpret it as UTC.
  const local = raw.startTimeLocal;
  if (typeof local !== "string" || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(local) ||
      !calendarDate(local.slice(0, 10)) || !Number.isFinite(Date.parse(local.replace(" ", "T") + "Z")) ||
      Number(local.slice(11, 13)) > 23 || Number(local.slice(14, 16)) > 59 || Number(local.slice(17, 19)) > 59) throw invalid();
  if (!object(raw.activityType) || typeof raw.activityType.typeKey !== "string" ||
      !/^[a-z][a-z0-9_]{0,99}$/.test(raw.activityType.typeKey)) throw invalid();
  const key = raw.activityType.typeKey;
  const labels: Record<string, string> = { running: "Run", walking: "Walk", cycling: "Cycling", strength_training: "Strength training" };
  const type = labels[key] ?? key.replaceAll("_", " ").replace(/^./, c => c.toUpperCase());
  const timestamp = new Date(local.replace(" ", "T") + "Z").toISOString();
  return { id: String(id), local: timestamp, row: {
    date: local.slice(0, 10) as CalendarDate, type,
    durationSeconds: measurement(raw.duration), distanceMetres: measurement(raw.distance),
  } };
}

export function createCustomProvider(options: Options = {}): HealthDataProvider {
  const env = options.env ?? process.env;
  const key = credential(env, options.keyFile ?? join(homedir(), ".config/garmin/connect-personal-api-key"));
  const request = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  let cached: { value: string; expires: number } | undefined;
  let pending: Promise<{ value: string; expires: number }> | undefined;
  class Unauthorized extends Error {}

  async function http(path: string, authorization: string, signal: AbortSignal, token = false): Promise<unknown> {
    // Preserve the four-second data-request cap even when authentication takes longer.
    if (!token) signal = AbortSignal.any([signal, AbortSignal.timeout(DATA_TIMEOUT_MS)]);
    try {
      signal.throwIfAborted();
      const response = await request(HOST + path, {
        method: token ? "POST" : "GET", headers: { Authorization: authorization, Accept: token ? "*/*" : "application/json" },
        redirect: "error", signal,
      });
      if (!response.ok || response.status === 204) {
        await response.body?.cancel();
        if (!token && [204, 404].includes(response.status)) return null;
        if (response.status === 401) throw new Unauthorized();
        throw new Error("Garmin request failed.");
      }
      const reader = response.body?.getReader();
      if (!reader) throw invalid();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          signal.throwIfAborted();
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > (token ? 16_384 : 524_288)) throw invalid();
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      signal.throwIfAborted();
      const text = Buffer.concat(chunks).toString("utf8");
      if (token) return text.trim();
      try { return JSON.parse(text) as unknown; } catch { throw invalid(); }
    } catch (error) {
      if (error instanceof Unauthorized) throw error;
      // Never allow upstream error bodies, credentials, or measurements to escape.
      throw new Error("Garmin data is unavailable.");
    }
  }

  async function bearer() {
    if (cached && cached.expires > now() + REFRESH_MS) return cached;
    if (!pending) {
      pending = (async () => {
        // Token issuance has its own bounded lifetime, shared by concurrent operations.
        const value = await http(TOKEN_PATH, `ApiKey ${key}`, AbortSignal.timeout(AUTH_TIMEOUT_MS), true);
        if (typeof value !== "string" || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) throw invalid();
        let exp: unknown;
        try { exp = JSON.parse(Buffer.from(value.split(".")[1]!, "base64url").toString("utf8")).exp; } catch { throw invalid(); }
        // JWT metadata is used only for cache lifetime, never as proof of identity.
        if (typeof exp !== "number" || !Number.isSafeInteger(exp) || exp * 1000 <= now() + REFRESH_MS) throw invalid();
        cached = { value, expires: Math.min(exp * 1000, now() + 24 * 60 * 60 * 1000) };
        return cached;
      })().finally(() => { pending = undefined; });
    }
    return pending;
  }

  async function get(path: string, signal: AbortSignal) {
    let token = await bearer();
    try { return await http(path, `Bearer ${token.value}`, signal); }
    catch (error) {
      if (!(error instanceof Unauthorized)) throw error;
      if (cached === token) cached = undefined;
      signal.throwIfAborted();
      token = await bearer();
      try { return await http(path, `Bearer ${token.value}`, signal); }
      catch (retryError) {
        if (retryError instanceof Unauthorized && cached === token) cached = undefined;
        throw new Error("Garmin data is unavailable.");
      }
    }
  }

  // The deadline covers token waiting, all pages, and response bodies as well as headers.
  async function operation<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("Garmin data is unavailable.")); }, BUDGET_MS);
    });
    try { return await Promise.race([work(controller.signal), timeout]); }
    catch { throw new Error("Garmin data is unavailable."); }
    finally { clearTimeout(timer!); }
  }

  async function day<T>(date: CalendarDate, path: string, map: (raw: Record<string, unknown>) => ReadResult<T>): Promise<ReadResult<T>> {
    if (!calendarDate(date)) throw new Error("Invalid Garmin calendar date.");
    return operation(async signal => {
      const raw = await get(path, signal);
      if (raw === null) return { status: "missing" } as const;
      if (!object(raw)) throw invalid();
      if (Object.keys(raw).length === 0) return { status: "missing" } as const;
      return map(raw);
    });
  }

  return {
    movement(date) {
      return day(date, `/usersummary-service/v2/dailysummaries?startDate=${date}&endDate=${date}`, raw => {
        if (!Array.isArray(raw.data) || raw.data.length > 1) throw invalid();
        if (!raw.data.length) return { status: "missing" };
        const row = raw.data[0];
        if (!object(row)) throw invalid();
        checkDate(row, date, true);
        if (row.includesWellnessData !== undefined && row.includesWellnessData !== null && typeof row.includesWellnessData !== "boolean") throw invalid();
        if (row.includesWellnessData === false) return { status: "missing" };
        if (row.movement == null) return { status: "missing" };
        if (!object(row.movement)) throw invalid();
        if (row.movement.steps == null) return { status: "missing" };
        if (!object(row.movement.steps)) throw invalid();
        return daily({ date, steps: measurement(row.movement.steps.value, true), distanceMetres: measurement(row.movement.steps.distanceInMeters) });
      });
    },
    sleep(date) {
      return day(date, `/sleep-service/sleep/dailySleep?date=${date}`, raw => {
        checkDate(raw, date);
        if (!["sleepTimeSeconds", "calendarDate", "sleepScores", "deepSleepSeconds", "remSleepSeconds", "awakeSleepSeconds"].some(field => field in raw)) throw invalid();
        return daily({ date, sleepSeconds: measurement(raw.sleepTimeSeconds, false, false, 86_400) });
      });
    },
    heartRate(date) {
      return day(date, `/wellness-service/wellness/dailyHeartRate?date=${date}`, raw => {
        checkDate(raw, date, true);
        const restingBpm = measurement(raw.restingHeartRate, true, true);
        const minBpm = measurement(raw.minHeartRate, true, true);
        const maxBpm = measurement(raw.maxHeartRate, true, true);
        if (minBpm.status === "available" && maxBpm.status === "available" && minBpm.value > maxBpm.value) throw invalid();
        return daily({ date, restingBpm, minBpm, maxBpm });
      });
    },
    recentActivities(limit) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 5) throw new Error("Invalid Garmin activity limit.");
      return operation(async signal => {
        const rows: ReturnType<typeof activity>[] = [];
        const seen = new Set<string>();
        let previousOldest: string | undefined;
        // At most three two-record pages for the existing maximum of five activities.
        for (let start = 0; rows.length < limit; start += PAGE_SIZE) {
          const raw = await get(`/activitylist-service/activities/search/activities?start=${start}&limit=${PAGE_SIZE}`, signal);
          if (raw === null) break;
          if (!Array.isArray(raw) || raw.length > PAGE_SIZE) throw invalid();
          const page = raw.map(activity).sort((a, b) => b.local.localeCompare(a.local));
          if (previousOldest && page.some(item => item.local > previousOldest!)) throw invalid();
          for (const item of page) {
            if (seen.has(item.id)) throw invalid();
            seen.add(item.id);
            rows.push(item);
          }
          previousOldest = page.at(-1)?.local;
          if (raw.length < PAGE_SIZE) break;
        }
        return { status: "available", record: rows.slice(0, limit).map(item => item.row) };
      });
    },
  };
}
