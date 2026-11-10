import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createCustomProvider } from "../dist/providers/custom.js";
import { localDate, runTool, toolDefinitions } from "../dist/tools.js";

// All credentials, tokens, dates, and measurements below are generated or fictional.
// Each provider receives an explicit mock fetch and never reads the real key file.
const date = "2025-02-14";
const origin = "https://personal.connectapi.garmin.com";
const tokenPath = "/personalapitoken-service/personal-api/personal-api-key/token";
const mockKey = ["fixture", "credential"].join("-");
const epoch = Date.parse("2025-02-14T00:00:00Z");
const missing = { status: "missing" };
const available = value => ({ status: "available", value });
function jwt(exp) {
  return [Buffer.from("{}").toString("base64url"), Buffer.from(JSON.stringify({ exp })).toString("base64url"), "fixture"].join(".");
}
function fixture(data, { token, now = () => epoch, tokenFetch } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    const u = new URL(url);
    assert.ok(u.origin === origin && init.redirect === "error" && !!init.signal);
    calls.push({ path: u.pathname, query: u.searchParams, method: init.method });
    if (u.pathname === tokenPath) {
      assert.ok(init.method === "POST" && init.headers.Authorization === `ApiKey ${mockKey}`);
      if (tokenFetch) return tokenFetch(init);
      return new Response(token ?? jwt(Math.floor(now() / 1000) + 3600));
    }
    assert.ok(init.method === "GET" && init.headers.Authorization.startsWith("Bearer "));
    return typeof data === "function" ? data(u, init) : Response.json(data);
  };
  return { provider: createCustomProvider({ env: { GARMIN_PERSONAL_API_KEY: mockKey }, fetch, now }), calls };
}
const tokenCalls = calls => calls.filter(call => call.path === tokenPath).length;
const failure = promise => assert.rejects(promise, error => error.message === "Garmin data is unavailable.");
const rawActivity = (id, day = date, fields = {}) => ({
  activityId: id, startTimeLocal: `${day}T08:00:00.000`, activityType: { typeKey: "running" },
  duration: 1200, distance: 2400, ...fields,
});

test("Garmin uses the protected local key file, accepts an explicit environment override, and never authenticates at startup", async () => {
  const folder = await mkdtemp(join(tmpdir(), "health-voice-key-test-"));
  const path = join(folder, "key");
  let calls = 0;
  const fetch = async (_url, init) => {
    calls++;
    if (init.method === "POST") {
      assert.ok(init.headers.Authorization === `ApiKey ${mockKey}`);
      return new Response(jwt(epoch / 1000 + 3600));
    }
    return Response.json({ sleepTimeSeconds: 1200 });
  };
  try {
    await writeFile(path, `${mockKey}\n`, { mode: 0o600 });
    const provider = createCustomProvider({ env: {}, keyFile: path, fetch, now: () => epoch });
    assert.ok(calls === 0);
    await provider.sleep(date);
    assert.ok(calls === 2);
    await chmod(path, 0o644);
    assert.throws(() => createCustomProvider({ env: {}, keyFile: path, fetch }), /owner-only regular file/);
    await chmod(path, 0o600);
    const link = join(folder, "link");
    await symlink(path, link);
    assert.throws(() => createCustomProvider({ env: {}, keyFile: link, fetch }), /owner-only regular file/);
    assert.throws(() => createCustomProvider({ env: {}, keyFile: folder, fetch }), /owner-only regular file/);
    assert.throws(() => createCustomProvider({ env: {}, keyFile: join(folder, "absent"), fetch }), /owner-only regular file/);
    assert.throws(() => createCustomProvider({ env: { GARMIN_PERSONAL_API_KEY: "" }, keyFile: path, fetch }), /configuration is invalid/);
    assert.throws(() => createCustomProvider({ env: { GARMIN_PERSONAL_API_KEY: "a\nb" }, keyFile: path, fetch }), /configuration is invalid/);
    createCustomProvider({ env: { GARMIN_PERSONAL_API_KEY: mockKey }, keyFile: "absent", fetch });
    assert.ok(calls === 2);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("all four Garmin operations normalize only contract fields and share one token", async () => {
  const { provider, calls } = fixture(u => {
    if (u.pathname.includes("dailysummaries")) return Response.json({ data: [{ calendarDate: date, movement: { steps: { value: 42, distanceInMeters: 30 } } }] });
    if (u.pathname.includes("dailySleep")) return Response.json({ calendarDate: date, sleepTimeSeconds: 1200, deepSleepSeconds: 300 });
    if (u.pathname.includes("dailyHeartRate")) return Response.json({ calendarDate: date, restingHeartRate: 60, minHeartRate: 50, maxHeartRate: 90 });
    return Response.json([rawActivity(1, date, { activityName: "private fixture title", route: "private fixture route" })]);
  });
  const [movement, sleep, heart, activities] = await Promise.all([
    provider.movement(date), provider.sleep(date), provider.heartRate(date), provider.recentActivities(1),
  ]);
  assert.deepEqual(movement, { status: "available", record: { date, steps: available(42), distanceMetres: available(30) } });
  assert.deepEqual(sleep, { status: "available", record: { date, sleepSeconds: available(1200) } });
  assert.deepEqual(heart, { status: "available", record: { date, restingBpm: available(60), minBpm: available(50), maxBpm: available(90) } });
  assert.deepEqual(activities.record[0], { date, type: "Run", durationSeconds: available(1200), distanceMetres: available(2400) });
  assert.ok(tokenCalls(calls) === 1);
});

test("cached bearer renews before expiry, after expiry, and no later than 24 hours", async () => {
  let clock = epoch;
  const { provider, calls } = fixture({ sleepTimeSeconds: 1200 }, { now: () => clock });
  await provider.sleep(date);
  clock += 3539_000;
  await provider.sleep(date);
  assert.ok(tokenCalls(calls) === 1);
  clock += 1000;
  await provider.sleep(date);
  assert.ok(tokenCalls(calls) === 2);
  clock += 3601_000;
  await provider.sleep(date);
  assert.ok(tokenCalls(calls) === 3);
  const long = fixture({ sleepTimeSeconds: 1200 }, { now: () => clock, token: jwt(epoch / 1000 + 7 * 86400) });
  await long.provider.sleep(date);
  clock += 86400_000;
  await long.provider.sleep(date);
  assert.ok(tokenCalls(long.calls) === 2);
});

test("bad, expired, near-expiry, missing-expiry and failed token exchanges never fetch data", async () => {
  for (const token of ["invalid", jwt(epoch / 1000 - 1), jwt(epoch / 1000 + 30), jwt(undefined), jwt("later")]) {
    const { provider, calls } = fixture({}, { token });
    await failure(provider.sleep(date));
    assert.ok(calls.length === 1);
  }
  for (const status of [401, 403, 429, 500]) {
    const { provider, calls } = fixture({}, { tokenFetch: () => new Response("withheld", { status }) });
    await failure(provider.sleep(date));
    assert.ok(calls.length === 1);
  }
});

test("one unauthorized data response renews once; repeated rejection stops and other errors are not retried", async () => {
  let reads = 0;
  const { provider, calls } = fixture(() => ++reads === 1 ? new Response(null, { status: 401 }) : Response.json({ sleepTimeSeconds: 1200 }));
  assert.ok((await provider.sleep(date)).status === "available");
  assert.ok(reads === 2 && tokenCalls(calls) === 2);
  const rejected = fixture(() => new Response(null, { status: 401 }));
  await failure(rejected.provider.sleep(date));
  assert.ok(rejected.calls.length === 4);
  for (const status of [403, 429, 500, 302]) {
    const failed = fixture(() => new Response("withheld", { status }));
    await failure(failed.provider.sleep(date));
    assert.ok(failed.calls.length === 2);
  }
});

test("missing dates, partial fields and zero remain distinct without fictional fallback", async () => {
  for (const status of [204, 404]) {
    const { provider } = fixture(() => new Response(null, { status }));
    assert.deepEqual(await provider.sleep(date), missing);
  }
  for (const raw of [null, {}, { sleepTimeSeconds: null }, { calendarDate: date, deepSleepSeconds: 30 }]) {
    assert.deepEqual(await fixture(raw).provider.sleep(date), missing);
  }
  assert.deepEqual((await fixture({ sleepTimeSeconds: 0 }).provider.sleep(date)).record.sleepSeconds, available(0));
  assert.deepEqual(await fixture({ data: [] }).provider.movement(date), missing);
  for (const field of ["value", "distanceInMeters"]) {
    const result = await fixture({ data: [{ calendarDate: date, movement: { steps: { [field]: 0 } } }] }).provider.movement(date);
    assert.ok(result.status === "available");
    assert.deepEqual(result.record.steps, field === "value" ? available(0) : missing);
    assert.deepEqual(result.record.distanceMetres, field === "distanceInMeters" ? available(0) : missing);
  }
  const heart = await fixture({ calendarDate: date, restingHeartRate: 60 }).provider.heartRate(date);
  assert.deepEqual(heart.record, { date, restingBpm: available(60), minBpm: missing, maxBpm: missing });
  const activities = await fixture([rawActivity(1, date, { duration: null, distance: 0 })]).provider.recentActivities(1);
  assert.deepEqual(activities.record[0].durationSeconds, missing);
  assert.deepEqual(activities.record[0].distanceMetres, available(0));
});

test("Asia/Kolkata midnight and lastNight use Garmin's calendar date without UTC shifting", async () => {
  const today = localDate("Asia/Kolkata", new Date("2025-02-13T18:31:00Z"));
  assert.ok(today === date);
  const { provider, calls } = fixture({ sleepTimeSeconds: 1200 });
  await runTool(provider, "sleep", { date: "lastNight" }, today);
  assert.ok(calls.at(-1).query.get("date") === date);
  const early = await fixture([rawActivity(1, date, { startTimeLocal: `${date}T00:01:00.000`, startTimeGMT: "2025-02-13T18:31:00.000Z" })]).provider.recentActivities(1);
  assert.ok(early.record[0].date === date);
  const invalidInput = fixture({});
  await assert.rejects(invalidInput.provider.sleep("2025-02-30"), /Invalid Garmin calendar date/);
  assert.ok(invalidInput.calls.length === 0);
  await failure(fixture({ calendarDate: "2025-02-13", sleepTimeSeconds: 1200 }).provider.sleep(date));
  await failure(fixture({ data: [{ calendarDate: "2025-02-13" }] }).provider.movement(date));
  await failure(fixture({ calendarDate: "2025-02-13", restingHeartRate: 60 }).provider.heartRate(date));
});

test("activity pagination returns newest first, bounds pages and honors limits", async () => {
  const rows = [rawActivity(5), rawActivity(4, "2025-02-13"), rawActivity(3, "2025-02-12"), rawActivity(2, "2025-02-11"), rawActivity(1, "2025-02-10")];
  const { provider, calls } = fixture(u => {
    const start = Number(u.searchParams.get("start"));
    assert.ok(u.searchParams.get("limit") === "2");
    return Response.json(rows.slice(start, start + 2).reverse());
  });
  const result = await provider.recentActivities(5);
  assert.deepEqual(result.record.map(row => row.date), rows.map(row => row.startTimeLocal.slice(0, 10)));
  assert.deepEqual(calls.filter(c => c.method === "GET").map(c => c.query.get("start")), ["0", "2", "4"]);
  assert.ok((await fixture([]).provider.recentActivities(5)).record.length === 0);
  assert.ok((await fixture([rawActivity(1)]).provider.recentActivities(5)).record.length === 1);
  assert.ok((await fixture(rows.slice(0, 2)).provider.recentActivities(1)).record.length === 1);
  assert.throws(() => provider.recentActivities(6), /Invalid Garmin activity limit/);
});

test("duplicates, unstable activity pages and malformed dates or metrics are errors", async () => {
  await failure(fixture([rawActivity(1), rawActivity(1)]).provider.recentActivities(2));
  await failure(fixture(u => Response.json(u.searchParams.get("start") === "0"
    ? [rawActivity(1, "2025-02-12"), rawActivity(2, "2025-02-11")]
    : [rawActivity(3, date)])).provider.recentActivities(3));
  for (const raw of [rawActivity(1, "2025-02-30"), rawActivity(1, date, { startTimeLocal: `${date}T24:00:00` }), rawActivity(1, date, { distance: -1 }), rawActivity(1, date, { activityType: {} })]) {
    await failure(fixture([raw]).provider.recentActivities(1));
  }
  for (const raw of [{ sleepTimeSeconds: "1200" }, { sleepTimeSeconds: -1 }, { sleepTimeSeconds: 86401 }, { unexpected: true }, []]) {
    await failure(fixture(raw).provider.sleep(date));
  }
  await failure(fixture({ calendarDate: date, minHeartRate: 80, maxHeartRate: 60 }).provider.heartRate(date));
  await failure(fixture({ calendarDate: date, restingHeartRate: 0 }).provider.heartRate(date));
  await failure(fixture({ data: [{ calendarDate: date, movement: { steps: { value: 1.5 } } }] }).provider.movement(date));
  await failure(fixture({ data: [{ calendarDate: date }, { calendarDate: date }] }).provider.movement(date));
});

test("malformed JSON, oversized bodies, network errors and hanging bodies fail with sanitized errors", async () => {
  for (const data of [() => new Response("invalid JSON"), () => new Response(" ".repeat(524289)), () => { throw new Error("withheld upstream content"); }]) {
    await failure(fixture(data).provider.sleep(date));
  }
  const hanging = fixture((_u, init) => new Response(new ReadableStream({
    start(controller) { init.signal.addEventListener("abort", () => controller.error(new Error("withheld")), { once: true }); },
  })));
  const start = Date.now();
  await failure(hanging.provider.sleep(date));
  assert.ok(Date.now() - start < 4800);
});

test("token network timeouts are bounded and a failed shared exchange can be retried", async () => {
  let fail = true;
  const source = fixture({ sleepTimeSeconds: 1200 }, { tokenFetch: init => fail
    ? new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("withheld")), { once: true }))
    : new Response(jwt(epoch / 1000 + 3600)) });
  const start = Date.now();
  await failure(source.provider.sleep(date));
  assert.ok(Date.now() - start >= 9500 && Date.now() - start < 11000);
  fail = false;
  assert.ok((await source.provider.sleep(date)).status === "available");
  assert.ok(tokenCalls(source.calls) === 2);
});

test("Garmin authentication and total operation permit a slow exchange without changing tool timeouts", async () => {
  const source = fixture({ sleepTimeSeconds: 1200 }, { tokenFetch: async () => {
    await new Promise(resolve => setTimeout(resolve, 4200));
    return new Response(jwt(epoch / 1000 + 3600));
  } });
  assert.ok((await source.provider.sleep(date)).status === "available");
  assert.ok(tokenCalls(source.calls) === 1);
  assert.ok(toolDefinitions("https://fixture.invalid", "fixture").every(tool => tool.server.timeout_ms === 5000));
});

test("existing four tool contracts are identical with Garmin and reject upstream errors", async () => {
  const definitions = toolDefinitions("https://fixture.invalid", "fixture");
  assert.deepEqual(definitions.map(item => item.name), ["getSleep", "getDailyHeartRate", "getDailyMovement", "getRecentActivities"]);
  const { provider } = fixture({ sleepTimeSeconds: 1200 });
  const result = await runTool(provider, "sleep", { date: "today" }, date);
  assert.deepEqual(Object.keys(result).sort(), ["date", "measurements", "status"]);
  assert.deepEqual(Object.keys(result.measurements), ["sleepDuration"]);
  assert.ok(result.measurements.sleepDuration.unit === "seconds");
  await failure(runTool(fixture(() => new Response(null, { status: 500 })).provider, "sleep", { date: "today" }, date));
  assert.deepEqual(toolDefinitions("https://fixture.invalid", "fixture"), definitions);
});
