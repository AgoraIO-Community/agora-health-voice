import { readFile } from "node:fs/promises";
import type {
  Activity, CalendarDate, HealthDataProvider, HeartRate, Measurement, Movement, ReadResult, Sleep,
} from "./types.js";

type FixtureValue = number | null | "unsupported";
type Daily<T> = Record<string, Omit<T, "date">>;
type Measurements<T> = { [K in keyof T]: FixtureValue };
type Fixture = {
  demoDate: CalendarDate;
  sleep: Daily<Measurements<Sleep>>;
  heartRate: Daily<Measurements<HeartRate>>;
  movement: Daily<Measurements<Movement>>;
  activities: Array<Pick<Activity, "date" | "type"> & Measurements<Pick<Activity, "durationSeconds" | "distanceMetres">>>;
};

function measurement(value: FixtureValue): Measurement {
  if (value === null) return { status: "missing" };
  if (value === "unsupported") return { status: "unsupported" };
  return { status: "available", value };
}

function daily<T, U>(rows: Record<string, T>, date: CalendarDate, normalize: (row: T) => U): ReadResult<U & { date: CalendarDate }> {
  const row = rows[date];
  return row ? { status: "available", record: { date, ...normalize(row) } } : { status: "missing" };
}

export async function loadSyntheticProvider(
  file = new URL("../../fixtures/synthetic-health.json", import.meta.url),
): Promise<{ provider: HealthDataProvider; demoDate: CalendarDate }> {
  const data = JSON.parse(await readFile(file, "utf8")) as Fixture;
  const activities = data.activities.map((row): Activity => ({
    date: row.date,
    type: row.type,
    durationSeconds: measurement(row.durationSeconds),
    distanceMetres: measurement(row.distanceMetres),
  })).sort((a, b) => b.date.localeCompare(a.date));

  return {
    demoDate: data.demoDate,
    provider: {
      async sleep(date) {
        return daily(data.sleep, date, row => ({ sleepSeconds: measurement(row.sleepSeconds) }));
      },
      async heartRate(date) {
        return daily(data.heartRate, date, row => ({
          restingBpm: measurement(row.restingBpm),
          minBpm: measurement(row.minBpm),
          maxBpm: measurement(row.maxBpm),
        }));
      },
      async movement(date) {
        return daily(data.movement, date, row => ({
          steps: measurement(row.steps),
          distanceMetres: measurement(row.distanceMetres),
        }));
      },
      async recentActivities(limit) {
        return { status: "available", record: activities.slice(0, limit) };
      },
    },
  };
}
