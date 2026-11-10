export type CalendarDate = `${number}-${number}-${number}`;

export type Measurement =
  | { status: "available"; value: number }
  | { status: "missing" | "unsupported" };

export type ReadResult<T> =
  | { status: "available"; record: T }
  | { status: "missing" | "unsupported" };

export interface Sleep {
  date: CalendarDate;
  sleepSeconds: Measurement;
}

export interface HeartRate {
  date: CalendarDate;
  restingBpm: Measurement;
  minBpm: Measurement;
  maxBpm: Measurement;
}

export interface Movement {
  date: CalendarDate;
  steps: Measurement;
  distanceMetres: Measurement;
}

export interface Activity {
  date: CalendarDate;
  type: string;
  durationSeconds: Measurement;
  distanceMetres: Measurement;
}

export interface HealthDataProvider {
  sleep(date: CalendarDate): Promise<ReadResult<Sleep>>;
  heartRate(date: CalendarDate): Promise<ReadResult<HeartRate>>;
  movement(date: CalendarDate): Promise<ReadResult<Movement>>;
  recentActivities(limit: number): Promise<ReadResult<readonly Activity[]>>;
}
