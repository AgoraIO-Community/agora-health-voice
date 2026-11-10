import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createAgoraGateway, readAgoraConfig } from "../dist/agora.js";
import { createHandlers } from "../dist/server.js";
import { loadSyntheticProvider } from "../dist/providers/synthetic.js";
import { runTool, localDate } from "../dist/tools.js";

const source = await loadSyntheticProvider();
const run = (name, args) => runTool(source.provider, name, args, source.demoDate);

test("synthetic tools return dated normalized values for the four example prompts", async () => {
  assert.deepEqual(await run("sleep", { date: "lastNight" }), {
    status: "available", date: "2025-02-14",
    measurements: { sleepDuration: { status: "available", value: 26640, unit: "seconds" } },
  });
  const heart = await run("heart-rate", { date: "yesterday" });
  assert.equal(heart.date, "2025-02-13");
  assert.deepEqual(heart.measurements.restingHeartRate, { status: "available", value: 56, unit: "bpm" });
  const movement = await run("movement", { date: "yesterday" });
  assert.equal(movement.measurements.steps.value, 8240);
  assert.equal(movement.measurements.recordedMovementDistance.value, 5910);
  const activities = await run("activities", { limit: 2 });
  assert.deepEqual(activities.activities.map(item => item.type), ["Run", "Strength training"]);
  assert.equal(activities.activities[1].distance.status, "unsupported");
});

test("strict dates, invalid input, partial records and zeros stay distinct", async () => {
  assert.deepEqual(await run("sleep", { date: "2025-02-12" }), { status: "missing", date: "2025-02-12" });
  const partial = await run("heart-rate", { date: "2025-02-12" });
  assert.equal(partial.measurements.restingHeartRate.value, 59);
  assert.equal(partial.measurements.minimumHeartRate.status, "missing");
  assert.deepEqual((await run("movement", { date: "2025-02-12" })).measurements.steps,
    { status: "available", value: 0, unit: "steps" });
  await assert.rejects(run("sleep", { date: "2025-02-30" }), /Choose today/);
  await assert.rejects(run("movement", { date: "lastNight" }), /Choose today/);
  await assert.rejects(run("activities", { limit: 6 }), /activity limit/);
  await assert.rejects(run("sleep", { date: "today", extra: true }), /Invalid tool arguments/);
  assert.equal(localDate("Asia/Kolkata", new Date("2025-02-13T23:00:00Z")), "2025-02-14");
});

test("invalid custom credentials or an unknown provider exit before binding ports", () => {
  for (const [provider, message] of [
    ["custom", /Garmin API key configuration is invalid/],
    ["unknown", /must be synthetic or custom/],
  ]) {
    const child = spawnSync(process.execPath, ["dist/server.js"], {
      env: { HEALTH_DATA_PROVIDER: provider, GARMIN_PERSONAL_API_KEY: "" }, encoding: "utf8", timeout: 3000,
    });
    assert.equal(child.status, 1);
    assert.match(child.stderr, message);
  }
});

const config = readAgoraConfig({
  AGORA_APP_ID: "a".repeat(32),
  AGORA_APP_CERTIFICATE: "b".repeat(32),
  AGORA_CUSTOMER_ID: "test-id",
  AGORA_CUSTOMER_SECRET: "test-secret",
  MURF_API_KEY: "test-murf",
  TOOL_CALLBACK_ORIGIN: "https://test.invalid",
});
const agentId = "c".repeat(32);
test("Agora request uses the fixed pipeline and expiring authenticated tools", async () => {
  const calls = [];
  const gateway = createAgoraGateway(config, async (url, request) => {
    calls.push([url, request]);
    return url.endsWith("/leave") ? new Response(null, { status: 200 }) : (!request.method || request.method === "GET") ? Response.json({ status: "STOPPED" }) : Response.json({ agent_id: agentId });
  });
  const started = await gateway.start({ id: randomUUID(), channel: "fixture-channel", callbackBearer: "fixture-bearer" });
  const payload = JSON.parse(calls[0][1].body);
  assert.match(calls[0][0], /\/join$/);
  assert.equal(payload.properties.asr.vendor, "ares");
  assert.equal(payload.properties.llm.params.model, "gpt-4o-mini");
  assert.equal(payload.properties.tts.vendor, "murf");
  assert.equal(payload.properties.idle_timeout, 30);
  assert.equal(payload.properties.advanced_features.enable_tools, true);
  assert.equal(payload.properties.parameters.opt_out, true);
  assert.deepEqual(payload.properties.remote_rtc_uids, [String(started.rtc.uid)]);
  assert.notEqual(started.rtc.token, payload.properties.token);
  assert.deepEqual(payload.properties.llm.tools.map(tool => tool.function.name),
    ["getSleep", "getDailyHeartRate", "getDailyMovement", "getRecentActivities"]);
  for (const [index, tool] of payload.properties.llm.tools.entries()) {
    assert.deepEqual(Object.keys(tool).sort(), ["execution", "function", "server", "type"]);
    assert.equal(tool.type, "function");
    assert.match(tool.function.name, /^[A-Za-z][A-Za-z0-9]{0,63}$/);
    assert.ok(tool.function.description.length > 0);
    const schema = tool.function.parameters;
    const key = index === 3 ? "limit" : "date";
    assert.equal(schema.type, "object");
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, [key]);
    assert.deepEqual(Object.keys(schema.properties), [key]);
    assert.equal(schema.properties[key].type, index === 3 ? "integer" : "string");
    if (index === 3) {
      assert.equal(schema.properties.limit.minimum, 1);
      assert.equal(schema.properties.limit.maximum, 5);
    }
    assert.deepEqual(tool.execution, { mode: "sync" });
    assert.equal(tool.server.method, "POST");
    const route = ["sleep", "heart-rate", "movement", "activities"][index];
    assert.equal(tool.server.url, `https://test.invalid/tools/${route}`);
    assert.deepEqual(tool.server.body, { [key]: `{{args.${key}}}` });
    assert.equal(Array.isArray(tool.server.headers), false);
    assert.deepEqual(tool.server.headers, {
      Authorization: "Bearer fixture-bearer",
      "Content-Type": "application/json",
    });
    assert.ok(Object.values(tool.server.headers).every(value => typeof value === "string"));
    assert.equal(tool.server.timeout_ms, 5000);
  }
  assert.ok(payload.properties.llm.tools.every(tool => tool.server.headers.Authorization === "Bearer fixture-bearer"));
  assert.equal(payload.properties.llm.tools[0].server.body.date, "{{args.date}}");
  await gateway.stop(started.agentId);
  assert.match(calls[1][0], new RegExp(`/agents/${agentId}/leave$`));
  assert.equal(calls[1][1].method, "POST");
  assert.equal(Object.hasOwn(calls[1][1], "body"), false);
});

async function request(handler, path, { method = "POST", data = {}, headers = {} } = {}) {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(data))]), {
    url: path,
    method,
    headers: { host: "localhost:3000", origin: "http://localhost:3000", "content-type": "application/json", ...headers },
  });
  const res = Object.assign(new EventEmitter(), {
    code: 0, destroyed: false, writableEnded: false, writableFinished: false,
    writeHead(code) { this.code = code; this.statusCode = code; },
    end(value) {
      this.writableEnded = this.writableFinished = true;
      this.emit("finish", { status: this.code, body: JSON.parse(value) });
    },
  });
  const done = once(res, "finish");
  handler(req, res);
  return (await done)[0];
}

const rtc = { token: "mock-rtc-token", uid: 43, agentUid: 42, channel: "mock-channel", appId: "mock-app" };
function handlers(gateway, durationMs) {
  return createHandlers({
    ...source, timeZone: "UTC", gateway, durationMs,
    localPort: 3000, html: Buffer.alloc(0), script: Buffer.alloc(0),
  });
}

test("local controls and callback listener stay isolated and Stop revokes access", async () => {
  let bearer;
  let stopped = 0;
  const app = handlers({
    async start(session) { bearer = session.callbackBearer; return { agentId, rtc }; },
    async stop() { stopped++; },
    async find() { assert.fail("Unexpected recovery lookup"); },
  });
  const id = randomUUID();
  assert.equal((await request(app.callbacks, "/api/start", { data: { id } })).status, 404);
  assert.equal((await request(app.callbacks, "/", { method: "GET" })).status, 404);
  assert.equal((await request(app.local, "/tools/sleep", { data: { date: "today" } })).status, 404);
  assert.equal((await request(app.local, "/api/start", { data: { id }, headers: { origin: "https://other.invalid" } })).status, 403);
  assert.equal((await request(app.local, "/api/start", { data: { id }, headers: { host: "other.invalid" } })).status, 403);

  const started = await request(app.local, "/api/start", { data: { id } });
  assert.equal(started.status, 200);
  assert.deepEqual(Object.keys(started.body).sort(), [...Object.keys(rtc), "expiresAt"].sort());
  assert.equal((await request(app.local, "/api/start", { data: { id: randomUUID() } })).status, 409);
  const tool = (auth) => request(app.callbacks, "/tools/sleep", {
    data: { date: "lastNight" }, headers: { authorization: auth },
  });
  assert.equal((await tool(undefined)).status, 401);
  assert.equal((await tool(`Bearer ${"x".repeat(bearer.length)}`)).status, 401);
  assert.equal((await tool(`Bearer ${bearer}`)).body.date, "2025-02-14");
  assert.equal((await request(app.local, "/api/stop", { data: { id } })).status, 200);
  assert.equal(stopped, 1);
  assert.equal((await tool(`Bearer ${bearer}`)).status, 401);
  await app.shutdown();
});

test("expiry revokes callbacks and stops the agent", { timeout: 2000 }, async () => {
  let bearer;
  let stopped = 0;
  const app = handlers({
    async start(session) { bearer = session.callbackBearer; return { agentId, rtc }; },
    async stop() { stopped++; },
    async find() { assert.fail("Unexpected recovery lookup"); },
  }, 40);
  await request(app.local, "/api/start", { data: { id: randomUUID() } });
  await delay(70);
  assert.equal(stopped, 1);
  assert.equal((await request(app.callbacks, "/tools/sleep", {
    data: { date: "today" }, headers: { authorization: `Bearer ${bearer}` },
  })).status, 401);
  await app.shutdown();
});

test("a lost start response triggers recovery and remote stop", async () => {
  let channel;
  let stopped;
  const app = handlers({
    async start(session) { channel = session.channel; throw new Error("mock connection lost"); },
    async find(value) { assert.equal(value, channel); return agentId; },
    async stop(id) { stopped = id; },
  });
  assert.equal((await request(app.local, "/api/start", { data: { id: randomUUID() } })).status, 502);
  await app.shutdown();
  assert.equal(stopped, agentId);
});

test("Agora validation diagnostics withhold secrets, URLs and echoed payloads", async () => {
  const gateway = createAgoraGateway(config, async () => Response.json({
    reason: "InvalidArgument",
    detail: "agent.pipeline.tts.params: private-value https://private.invalid/token",
    payload: { token: "do-not-expose" },
  }, { status: 400 }));
  await assert.rejects(gateway.start({ id: randomUUID(), channel: "test", callbackBearer: "secret" }), error => {
    assert.equal(error.status, 400);
    assert.match(error.diagnostic, /InvalidArgument/);
    assert.match(error.diagnostic, /Field agent.pipeline.tts.params/);
    assert.doesNotMatch(error.diagnostic, /private|secret|token|payload/);
    return true;
  });
  const app = handlers(gateway);
  const result = await request(app.local, "/api/start", { data: { id: randomUUID() } });
  assert.equal(result.status, 502);
  assert.match(result.body.error, /InvalidArgument/);
  assert.doesNotMatch(result.body.error, /private-value|private.invalid|do-not-expose/);
  await app.shutdown();
});

test("unknown, oversized and non-JSON Agora errors retain status without raw text", async () => {
  for (const body of [
    JSON.stringify({ reason: "secret-credential", message: "https://private.invalid" }),
    "<html>private upstream data</html>",
    "x".repeat(17000),
  ]) {
    const gateway = createAgoraGateway(config, async () => new Response(body, { status: 400 }));
    await assert.rejects(gateway.start({ id: randomUUID(), channel: "test", callbackBearer: "secret" }), error => {
      assert.equal(error.status, 400);
      assert.equal(error.diagnostic, undefined);
      return true;
    });
  }
});

test("Preview tool validation retains safe subfields without exposing echoed values", async () => {
  const gateway = createAgoraGateway(config, async () => Response.json({
    reason: "MissingRequiredField",
    detail: "agent.pipeline.llm.tools[0].function.name: private-value",
  }, { status: 400 }));
  await assert.rejects(gateway.start({ id: randomUUID(), channel: "test", callbackBearer: "secret" }), error => {
    assert.match(error.diagnostic, /Field agent\.pipeline\.llm\.tools\[0\]\.function\.name\./);
    assert.doesNotMatch(error.diagnostic, /private-value/);
    return true;
  });
});

test("Agora request ID and structured errors survive without raw messages or inputs", async () => {
  const gateway = createAgoraGateway(config, async () => Response.json({
    reason: "InvalidArgument",
    details: [{
      type: "dict_type",
      loc: ["agent", "pipeline", "llm", "tools", 0, "server", "headers"],
      msg: "private message",
      input: { Authorization: "private token" },
    }, { type: "private token", field: "https://private.invalid", code: "secret" }],
  }, { status: 400, headers: { "Agora-Request-Id": "mock-request-123" } }));
  const app = handlers(gateway);
  const response = await request(app.local, "/api/start", { data: { id: randomUUID() } });
  assert.equal(response.body.agora.requestId, "mock-request-123");
  assert.equal(response.body.agora.status, 400);
  assert.ok(Number.isFinite(Date.parse(response.body.agora.timestamp)));
  assert.deepEqual(response.body.agora.validationDetails, [
    { code: "InvalidArgument" },
    { type: "dict_type", field: "agent.pipeline.llm.tools.0.server.headers" },
  ]);
  assert.doesNotMatch(JSON.stringify(response.body), /private|secret/);
  await app.shutdown();
});

test("non-JSON Agora failures still retain the request ID", async () => {
  const gateway = createAgoraGateway(config, async () => new Response("private text", {
    status: 400, headers: { "Agora-Request-Id": "mock-request-456" },
  }));
  await assert.rejects(gateway.start({ id: randomUUID(), channel: "test", callbackBearer: "secret" }), error => {
    assert.equal(error.requestId, "mock-request-456");
    assert.equal(error.diagnostic, undefined);
    assert.deepEqual(error.validationDetails, []);
    return true;
  });
});

test("Basic Voice omits tools while preserving the existing voice pipeline and RTC settings", async () => {
  const payloads = [];
  const transport = async (_url, init) => {
    payloads.push(JSON.parse(init.body));
    return Response.json({ agent_id: agentId });
  };
  const session = { id: randomUUID(), channel: "test-basic", callbackBearer: "fixture-bearer" };
  await createAgoraGateway(config, transport).start(session);
  await createAgoraGateway(config, transport, "basic").start(session);
  const [health, basic] = payloads;
  assert.equal(basic.properties.llm.system_messages[0].content, "You are a friendly voice assistant. Answer briefly.");
  assert.equal(Object.hasOwn(basic.properties.llm, "tools"), false);
  assert.doesNotMatch(JSON.stringify(basic), /fixture-bearer|callback|\/tools\//);
  const healthPipeline = structuredClone(health.properties);
  delete healthPipeline.llm.tools;
  delete healthPipeline.llm.system_messages;
  delete healthPipeline.llm.greeting_message;
  delete healthPipeline.advanced_features;
  delete healthPipeline.token;
  const basicPipeline = structuredClone(basic.properties);
  delete basicPipeline.llm.system_messages;
  delete basicPipeline.llm.greeting_message;
  delete basicPipeline.advanced_features;
  delete basicPipeline.token;
  assert.deepEqual(basicPipeline, healthPipeline);
  assert.equal(health.properties.llm.tools.length, 4);
  assert.equal(basic.properties.idle_timeout, health.properties.idle_timeout);
  assert.deepEqual(basic.properties.remote_rtc_uids, health.properties.remote_rtc_uids);
  assert.equal(basic.properties.agent_rtc_uid, health.properties.agent_rtc_uid);
});

test("single-tool probe uses the original callback headers and enforces authentication", async () => {
  let payload;
  await createAgoraGateway(config, async (_url, init) => {
    payload = JSON.parse(init.body);
    return Response.json({ agent_id: agentId });
  }, "single-tool").start({ id: randomUUID(), channel: "single-test", callbackBearer: "fixture-bearer" });
  const tools = payload.properties.llm.tools;
  assert.equal(tools.length, 1);
  assert.equal(tools[0].function.name, "getFictionalSteps");
  assert.deepEqual(tools[0].function.parameters, { type: "object", properties: {}, required: [], additionalProperties: false });
  assert.deepEqual(tools[0].server.headers, {
    Authorization: "Bearer fixture-bearer", "Content-Type": "application/json",
  });
  assert.equal(Object.hasOwn(tools[0].server, "body"), false);
  assert.equal(tools[0].server.url, "https://test.invalid/tools/fictional-steps");
  let bearer;
  const app = createHandlers({
    ...source, voiceMode: "single-tool", timeZone: "UTC", localPort: 3000,
    html: Buffer.alloc(0), script: Buffer.alloc(0),
    gateway: {
      async start(session) { bearer = session.callbackBearer; return { agentId, rtc }; },
      async stop() {},
      async find() {},
    },
  });
  const id = randomUUID();
  await request(app.local, "/api/start", { data: { id } });
  assert.equal((await request(app.callbacks, "/tools/fictional-steps")).status, 401);
  const authorized = await request(app.callbacks, "/tools/fictional-steps", {
    headers: { authorization: `Bearer ${bearer}` },
  });
  assert.deepEqual(authorized.body, { status: "available", fictional: true, steps: 1234 });
  await app.shutdown();
});

test("Stop confirms terminal state despite inconclusive leave and asynchronous status", async () => {
  for (const leaveOutcome of ["error", "lost", "accepted"]) {
    let queries = 0;
    const gateway = createAgoraGateway(config, async (url, init) => {
      if (url.endsWith("/join")) return Response.json({ agent_id: agentId });
      if (url.endsWith("/leave")) {
        assert.equal(Object.hasOwn(init, "body"), false);
        if (leaveOutcome === "lost") throw new Error("mock lost response");
        return new Response(null, { status: leaveOutcome === "error" ? 409 : 200 });
      }
      queries++;
      return Response.json({ status: queries === 1 ? "STOPPING" : "STOPPED" });
    });
    await gateway.start({ id: randomUUID(), channel: "stop-test", callbackBearer: "fixture-bearer" });
    await gateway.stop(agentId);
    assert.equal(queries, 2);
  }
});

test("Stop retains a genuine failure when terminal state cannot be confirmed", async () => {
  for (const outcome of ["RUNNING", "STOPPING", "missing", "unreadable"]) {
    let queries = 0;
    const gateway = createAgoraGateway(config, async url => {
      if (url.endsWith("/join")) return Response.json({ agent_id: agentId });
      if (url.endsWith("/leave")) return new Response(null, { status: 200 });
      queries++;
      if (outcome === "missing") return new Response(null, { status: 404 });
      if (outcome === "unreadable") return new Response("not JSON");
      return Response.json({ status: outcome });
    });
    await gateway.start({ id: randomUUID(), channel: "stop-test", callbackBearer: "fixture-bearer" });
    await assert.rejects(gateway.stop(agentId), /could not be confirmed/);
    assert.equal(queries, 3);
  }
});

test("local Stop succeeds when an inconclusive leave is followed by confirmed STOPPED", async () => {
  const gateway = createAgoraGateway(config, async url => {
    if (url.endsWith("/join")) return Response.json({ agent_id: agentId });
    if (url.endsWith("/leave")) return new Response(null, { status: 409 });
    return Response.json({ status: "STOPPED" });
  });
  const app = handlers(gateway);
  const id = randomUUID();
  await request(app.local, "/api/start", { data: { id } });
  const result = await request(app.local, "/api/stop", { data: { id } });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { stopped: true });
  await app.shutdown();
});

test("callback diagnostics show each stage and never include request or measurement values", async () => {
  const logs = [];
  const original = console.info;
  console.info = value => logs.push(JSON.parse(value));
  let bearer;
  const app = createHandlers({
    ...source, healthDebug: true, timeZone: "UTC", localPort: 3000, html: Buffer.alloc(0), script: Buffer.alloc(0),
    provider: { ...source.provider, async movement(date) {
      if (date === "2025-02-11") throw new Error("private provider failure");
      return source.provider.movement(date);
    } },
    gateway: {
      async start(session) { bearer = session.callbackBearer; return { agentId, rtc }; },
      async stop() {},
      async find() {},
    },
  });
  try {
    await request(app.local, "/api/start", { data: { id: randomUUID() } });
    await request(app.callbacks, "/tools/movement", {
      data: { date: "yesterday" }, headers: { authorization: "Bearer private-secret" },
    });
    await request(app.callbacks, "/tools/movement", {
      data: { date: "yesterday" }, headers: { authorization: `Bearer ${bearer}` },
    });
    await request(app.callbacks, "/tools/movement", {
      data: { date: "2025-02-11" }, headers: { authorization: `Bearer ${bearer}` },
    });
    await request(app.callbacks, "/tools/movement", {
      data: { date: "private input" }, headers: { authorization: `Bearer ${bearer}` },
    });
    const first = logs.filter(entry => entry.callback === 1);
    assert.deepEqual(first.map(entry => entry.event), [
      "health_tool_arrived", "health_tool_function", "health_tool_authentication", "health_tool_response",
    ]);
    assert.equal(first[1].function, "getDailyMovement");
    assert.equal(first[2].outcome, "failed");
    assert.equal(first[3].status, 401);
    assert.ok(logs.some(entry => entry.callback === 2 && entry.event === "health_tool_provider" &&
      entry.outcome === "succeeded" && entry.status === "available"));
    assert.ok(logs.some(entry => entry.callback === 3 && entry.event === "health_tool_provider" &&
      entry.outcome === "failed"));
    assert.ok(logs.some(entry => entry.callback === 4 && entry.event === "health_tool_response" && entry.status === 400));
    const serialized = JSON.stringify(logs);
    for (const value of [bearer, "private-secret", "private input", "private provider failure", "8240", "5910", "yesterday", "2025-02-11"]) {
      assert.equal(serialized.includes(value), false);
    }
  } finally {
    console.info = original;
    await app.shutdown();
  }
});

test("callback diagnostics are disabled by default and when explicitly disabled", async () => {
  const logs = [];
  const original = console.info;
  console.info = value => logs.push(value);
  try {
    for (const settings of [{}, { healthDebug: false }]) {
      let bearer;
      const app = createHandlers({
        ...source, ...settings, timeZone: "UTC", localPort: 3000,
        html: Buffer.alloc(0), script: Buffer.alloc(0),
        gateway: {
          async start(session) { bearer = session.callbackBearer; return { agentId, rtc }; },
          async stop() {},
          async find() {},
        },
      });
      try {
        await request(app.local, "/api/start", { data: { id: randomUUID() } });
        const callback = await request(app.callbacks, "/tools/movement", {
          data: { date: "yesterday" }, headers: { authorization: `Bearer ${bearer}` },
        });
        assert.equal(callback.status, 200);
        assert.equal(callback.body.measurements.steps.value, 8240);
        assert.equal((await request(app.callbacks, "/tools/movement")).status, 401);
      } finally {
        await app.shutdown();
      }
    }
    assert.deepEqual(logs, []);
  } finally {
    console.info = original;
  }
});
