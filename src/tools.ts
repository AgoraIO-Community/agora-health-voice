import type { CalendarDate, HealthDataProvider, Measurement, ReadResult } from "./providers/types.js";

const dateSchema = {
  type: "string",
  description: "Use today, yesterday, or an exact YYYY-MM-DD calendar date.",
} as const;

const sleepDateSchema = {
  ...dateSchema,
  description: "Use lastNight for last night's sleep. Also accepts today, yesterday, or YYYY-MM-DD.",
};

const maxActivities = 5;
const definitions = {
  sleep: { name: "getSleep", description: "Read the recorded overnight sleep duration.", key: "date", schema: sleepDateSchema },
  "heart-rate": { name: "getDailyHeartRate", description: "Read recorded daily resting, minimum and maximum heart rate.", key: "date", schema: dateSchema },
  movement: { name: "getDailyMovement", description: "Read recorded daily steps and movement distance.", key: "date", schema: dateSchema },
  activities: {
    name: "getRecentActivities", description: "Read a short, newest-first list of recent activities.",
    key: "limit", schema: { type: "integer", minimum: 1, maximum: maxActivities },
  },
} as const;

export type ToolName = keyof typeof definitions;

export function isToolName(value: string): value is ToolName {
  return Object.hasOwn(definitions, value);
}

export function toolDefinitions(base: string, bearer: string) {
  return Object.entries(definitions).map(([route, tool]) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: {
      type: "object",
      properties: { [tool.key]: tool.schema },
      required: [tool.key],
      additionalProperties: false,
    },
    execution: { mode: "sync" },
    server: {
      method: "POST",
      url: `${base}/tools/${route}`,
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: { [tool.key]: `{{args.${tool.key}}}` },
      timeout_ms: 5000,
    },
  }));
}

export class InvalidToolInput extends Error {}

export function isCalendarDate(value: unknown): value is CalendarDate {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value;
}

export function localDate(timeZone: string, now = new Date()): CalendarDate {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const part = (name: string) => parts.find(item => item.type === name)?.value;
  return `${part("year")}-${part("month")}-${part("day")}` as CalendarDate;
}

function resolveDate(input: unknown, today: CalendarDate, tool: ToolName): CalendarDate {
  if (isCalendarDate(input)) return input;
  if (input === "today" || (input === "lastNight" && tool === "sleep")) return today;
  if (input === "yesterday") {
    const date = new Date(`${today}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - 1);
    return date.toISOString().slice(0, 10) as CalendarDate;
  }
  throw new InvalidToolInput("Choose today, yesterday, an exact date, or lastNight for sleep.");
}

function metric(measurement: Measurement, unit: string) {
  return measurement.status === "available"
    ? { status: "available", value: measurement.value, unit }
    : { status: measurement.status, unit };
}

function dated<T extends { date: CalendarDate }, U>(
  result: ReadResult<T>, date: CalendarDate, project: (record: T) => U,
) {
  if (result.status !== "available") return { status: result.status, date };
  if (result.record.date !== date) return { status: "missing", date };
  return { status: "available", date, measurements: project(result.record) };
}

export async function runTool(
  provider: HealthDataProvider, name: ToolName, body: Record<string, unknown>, today: CalendarDate,
) {
  const key = definitions[name].key;
  if (Object.keys(body).length !== 1 || !Object.hasOwn(body, key)) throw new InvalidToolInput("Invalid tool arguments.");
  if (name === "activities") {
    const limit = body.limit;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > maxActivities) {
      throw new InvalidToolInput(`Choose an activity limit from 1 to ${maxActivities}.`);
    }
    const result = await provider.recentActivities(limit);
    if (result.status !== "available") return { status: result.status };
    const activities = result.record.slice(0, limit).map(row => ({
      date: row.date,
      type: row.type,
      duration: metric(row.durationSeconds, "seconds"),
      distance: metric(row.distanceMetres, "metres"),
    }));
    return { status: activities.length ? "available" : "missing", activities };
  }

  const date = resolveDate(body.date, today, name);
  switch (name) {
    case "sleep":
      return dated(await provider.sleep(date), date, row => ({
        sleepDuration: metric(row.sleepSeconds, "seconds"),
      }));
    case "heart-rate":
      return dated(await provider.heartRate(date), date, row => ({
        restingHeartRate: metric(row.restingBpm, "bpm"),
        minimumHeartRate: metric(row.minBpm, "bpm"),
        maximumHeartRate: metric(row.maxBpm, "bpm"),
      }));
    case "movement":
      return dated(await provider.movement(date), date, row => ({
        steps: metric(row.steps, "steps"),
        recordedMovementDistance: metric(row.distanceMetres, "metres"),
      }));
  }
}


// Session-start acceptance probe using the same authenticated headers as health tools.
export function singleToolDefinition(base: string, bearer: string) {
  return {
    type: "function",
    name: "getFictionalSteps",
    description: "Return the fixed fictional step count for a test.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    execution: { mode: "sync" },
    server: {
      method: "POST",
      url: `${base}/tools/fictional-steps`,
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      timeout_ms: 5000,
    },
  };
}
