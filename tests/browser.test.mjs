import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';
import { transform } from 'esbuild';

// Execute the real browser entry point with a small DOM and RTC boundary stub.
// No microphone, network services, credentials or health records are used.
const source = (await readFile(new URL('../src/browser/main.ts', import.meta.url), 'utf8'))
  .replace(/import AgoraRTC,[\s\S]*?from "agora-rtc-sdk-ng";/, '')
  .replace(/import type .*?;\n/, '');
const { code } = await transform(source, { loader: 'ts', target: 'es2022' });
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function harness({ info = {}, micPromise, startPromise, stopPromise, stopFails = false, infoFails = false, micFails = false, startResponse, stopResponse, fetchFailure = false, readFailure = false, sdkFailure, sdkException, abortSignal = AbortSignal } = {}) {
  const elements = new Map();
  for (const id of ['#start', '#stop', '#playback', '#source', '#status', '#session', '#state-label', '.intro', '.examples']) {
    elements.set(id, { dataset: {}, hidden: id === '#playback', disabled: true, textContent: '', handlers: {}, addEventListener(event, fn) { this.handlers[event] = fn; } });
  }
  const calls = [];
  const rtcEvents = {}, sdkEvents = {}, windowEvents = {};
  const mic = { close() { calls.push('mic.close'); } };
  const audio = { play() { calls.push('audio.play'); }, stop() { calls.push('audio.stop'); } };
  const sdkError = () => { if (sdkException) throw sdkException; const error = new Error('PRIVATE-SDK-OBJECT-TOKEN'); error.name = 'SyntaxError'; throw error; };
  const client = { on(event, fn) { rtcEvents[event] = fn; }, async join() { calls.push('join'); if (sdkFailure === 'join') sdkError(); }, async publish(track) { assert.equal(track, mic); calls.push('publish'); if (sdkFailure === 'publish') sdkError(); }, async subscribe() {}, async leave() { calls.push('leave'); } };
  let timer;
  const context = {
    console: { log() { assert.fail("Unexpected browser log"); }, error() { assert.fail("Unexpected browser error log"); }, warn() { assert.fail("Unexpected browser warning log"); } },
    document: { querySelector: id => elements.get(id) }, crypto: { randomUUID: () => 'test-session' }, AbortSignal: abortSignal, Blob,
    navigator: { sendBeacon() { calls.push('beacon'); } }, location: { reload() {} },
    window: { setTimeout(fn) { timer = fn; return 1; }, clearTimeout() {}, addEventListener(event, fn) { windowEvents[event] = fn; } },
    AgoraRTC: { setLogLevel() {}, on(event, fn) { sdkEvents[event] = fn; }, createClient: () => { calls.push('createClient'); if (sdkFailure === 'create') sdkError(); return client; }, async createMicrophoneAudioTrack() { if (micFails) throw Error(); if (sdkFailure === 'microphone') sdkError(); return micPromise ? await micPromise : mic; } },
    fetch: async (path, options) => {
      calls.push(path);
      if (path === '/api/info') return { ok: !infoFails, json: async () => ({ synthetic: true, voiceConfigured: true, voiceMode: 'health', ...info }) };
      assert.equal(JSON.parse(options.body).id, 'test-session');
      if (path === '/api/start') {
        if (fetchFailure) throw new DOMException('PRIVATE-NETWORK-DETAIL', 'SyntaxError');
        if (startPromise) await startPromise;
        if (startResponse) return startResponse();
        if (readFailure) return { ok: true, status: 200, redirected: false, headers: new Headers({ 'content-type': 'application/json' }), text: async () => { throw new Error('PRIVATE-RESPONSE-BODY'); } };
        return new Response(JSON.stringify({ agentUid: 7, expiresAt: Date.now() + 180000 }), { headers: { 'content-type': 'application/json' } });
      }
      if (stopPromise) await stopPromise;
      if (stopFails) { stopFails = false; throw Error('Cleanup failed'); }
      return stopResponse ? stopResponse() : new Response('{}', { headers: { 'content-type': 'application/json' } });
    },
  };
  await vm.runInNewContext(`(async () => { ${code} })()`, context);
  const el = id => elements.get(id);
  return { el, calls, mic, audio, rtcEvents, sdkEvents, windowEvents, expire: () => timer(), click: async id => { await el(id).handlers.click(); await flush(); } };
}

test('provider labels reflect server mode and setup gates Start', async () => {
  for (const synthetic of [true, false]) {
    const h = await harness({ info: { synthetic, voiceConfigured: false } });
    assert.equal(h.el('#source').textContent, synthetic ? 'Synthetic Data — demonstration mode' : 'Garmin — live reference integration');
    assert.equal(h.el('#start').disabled, true);
    assert.equal(h.el('#stop').disabled, true);
    assert.equal(h.el('#state-label').textContent, 'Ready');
  }
  const h = await harness({ info: { synthetic: false, voiceMode: 'basic' } });
  assert.equal(h.el('#source').dataset.provider, 'garmin');
  assert.equal(h.el('.examples').hidden, true);
});

test('Start/Stop transitions use actual lifecycle and preserve playback recovery', async () => {
  const pending = deferred();
  const h = await harness({ startPromise: pending.promise });
  await h.click('#start');
  assert.equal(h.el('#state-label').textContent, 'Connecting');
  assert.equal(h.el('#start').disabled, true);
  assert.equal(h.el('#stop').disabled, false);
  pending.resolve(); await flush();
  assert.equal(h.el('#state-label').textContent, 'Active');
  assert.ok(h.calls.includes('publish'));
  await h.rtcEvents['user-published']({ uid: 7, audioTrack: h.audio }, 'audio'); await flush();
  h.sdkEvents['autoplay-failed']();
  assert.equal(h.el('#playback').hidden, false);
  await h.click('#playback');
  assert.equal(h.el('#playback').hidden, true);
  await h.click('#stop');
  assert.equal(h.el('#state-label').textContent, 'Ready');
  for (const call of ['mic.close', 'audio.stop', 'leave', '/api/stop']) assert.ok(h.calls.includes(call));
  assert.equal(h.el('#start').disabled, false);
});

test('Stop during microphone permission closes a late track without starting a session', async () => {
  const pending = deferred();
  const h = await harness({ micPromise: pending.promise });
  await h.click('#start');
  assert.match(h.el('#status').textContent, /permission/);
  await h.click('#stop');
  pending.resolve(h.mic); await flush();
  assert.ok(h.calls.includes('mic.close'));
  assert.ok(!h.calls.includes('/api/start'));
  assert.equal(h.el('#state-label').textContent, 'Ready');
});

test('Stop while server start is pending cleans up again when Start resolves', async () => {
  const pending = deferred();
  const h = await harness({ startPromise: pending.promise });
  await h.click('#start'); await h.click('#stop');
  pending.resolve(); await flush();
  assert.equal(h.calls.filter(call => call === '/api/stop').length, 2);
  assert.ok(!h.calls.includes('join'));
});

test('cleanup failure allows Stop retry and prevents another Start', async () => {
  const h = await harness({ stopFails: true });
  await h.click('#start'); await h.click('#stop');
  assert.equal(h.el('#state-label').textContent, 'Error');
  assert.equal(h.el('#start').disabled, true);
  assert.equal(h.el('#stop').disabled, false);
  await h.click('#stop');
  assert.equal(h.el('#state-label').textContent, 'Ready');
  assert.equal(h.el('#start').disabled, false);
});

test('permission and setup failures are actionable errors', async () => {
  const h = await harness({ micFails: true });
  await h.click('#start');
  assert.equal(h.el('#state-label').textContent, 'Error');
  assert.match(h.el('#status').textContent, /browser permissions/);
  assert.equal(h.el('#start').disabled, false);
  const failed = await harness({ infoFails: true });
  assert.equal(failed.el('#state-label').textContent, 'Error');
  assert.equal(failed.el('#source').textContent, 'Data source unavailable');
  assert.equal(failed.el('#start').disabled, true);
});

test('expiration, disconnect and page exit release the session', async () => {
  for (const reason of ['timer', 'disconnect', 'pagehide']) {
    const h = await harness(); await h.click('#start');
    if (reason === 'timer') h.expire();
    else if (reason === 'disconnect') h.rtcEvents['connection-state-change']('DISCONNECTED');
    else h.windowEvents.pagehide();
    await flush();
    assert.ok(h.calls.includes('mic.close'));
    assert.ok(h.calls.includes('leave'));
    if (reason === 'pagehide') assert.ok(h.calls.includes('beacon'));
    else assert.equal(h.el('#state-label').textContent, reason === 'timer' ? 'Ready' : 'Error');
  }
});

test('Stopping remains visible and locks controls until cleanup completes', async () => {
  const pending = deferred();
  const h = await harness({ stopPromise: pending.promise });
  await h.click('#start'); await h.click('#stop');
  assert.equal(h.el('#state-label').textContent, 'Stopping');
  assert.equal(h.el('#start').disabled, true);
  assert.equal(h.el('#stop').disabled, true);
  pending.resolve(); await flush();
  assert.equal(h.el('#state-label').textContent, 'Ready');
});

const jsonResponse = (body, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
const statusText = h => h.el('#status').textContent;

test('POST diagnostics distinguish network and response-read failures without exposing native errors', async () => {
  for (const options of [{ fetchFailure: true }, { readFailure: true }, { abortSignal: {} }]) {
    const h = await harness(options); await h.click('#start');
    assert.match(statusText(h), /Session start \(\/api\/start\) failed: Network/);
    assert.match(statusText(h), /HTTP (?:200|unavailable); content type (?:application\/json|unavailable); redirected (?:no|unavailable)/);
    assert.doesNotMatch(statusText(h), /PRIVATE|expected pattern/);
    assert.ok(!h.calls.includes('createClient'));
    assert.ok(h.calls.includes('mic.close'));
  }
});

test('HTTP errors preserve only approved backend JSON messages and safe metadata', async () => {
  for (const [status, error] of [[401, 'Mobile authentication required.'], [403, 'Session controls require the approved browser origin.'], [409, 'Another session is starting or active. Stop it or wait for it to expire.']]) {
    const h = await harness({ startResponse: jsonResponse({ error }, status) }); await h.click('#start');
    assert.match(statusText(h), /HTTP error/);
    assert.ok(statusText(h).includes(error));
    assert.ok(statusText(h).includes(`HTTP ${status}`));
    assert.match(statusText(h), /content type application\/json; redirected no/);
    assert.ok(!h.calls.includes('createClient'));
  }
  const h = await harness({ startResponse: jsonResponse({ error: 'PRIVATE-HEALTH-RECORD PRIVATE-TOKEN', agora: { token: 'PRIVATE-TOKEN' } }, 502) });
  await h.click('#start');
  assert.match(statusText(h), /HTTP error/);
  assert.doesNotMatch(statusText(h), /PRIVATE/);
  const agora = await harness({ startResponse: jsonResponse({ error: 'Agora could not start the voice session PRIVATE-UPSTREAM' }, 502) });
  await agora.click('#start');
  assert.match(statusText(agora), /Agora could not start the voice session/);
  assert.doesNotMatch(statusText(agora), /PRIVATE/);
});

test('empty, HTML, malformed and non-object JSON responses fail before RTC initialization', async () => {
  const cases = [
    [() => new Response(null, { status: 204, headers: { 'content-type': 'application/json' } }), /Empty JSON response/],
    [() => new Response('  ', { headers: { 'content-type': 'application/json' } }), /Empty JSON response/],
    [() => new Response('<html>PRIVATE-PROXY-BODY</html>', { headers: { 'content-type': 'text/html' } }), /Expected a JSON response/],
    [() => new Response('PRIVATE-INVALID-JSON', { headers: { 'content-type': 'application/json' } }), /Invalid JSON response/],
    [jsonResponse(null), /Invalid JSON response object/],
    [jsonResponse([]), /Invalid JSON response object/],
  ];
  for (const [startResponse, expected] of cases) {
    const h = await harness({ startResponse }); await h.click('#start');
    assert.match(statusText(h), expected);
    assert.doesNotMatch(statusText(h), /PRIVATE|expected pattern/);
    assert.ok(!h.calls.includes('createClient'));
    assert.ok(h.calls.includes('/api/stop'));
  }
});

test('non-JSON HTTP errors and redirects retain status but never echo headers or body content', async () => {
  const h = await harness({ startResponse: () => ({ ok: false, status: 502, redirected: true, headers: new Headers({ 'content-type': 'text/html; PRIVATE-HEADER=secret' }), text: async () => '<html>PRIVATE-BODY</html>' }) });
  await h.click('#start');
  assert.match(statusText(h), /HTTP error.*HTTP 502; content type text\/html; redirected yes/);
  assert.match(statusText(h), /Expected a JSON response/);
  assert.doesNotMatch(statusText(h), /PRIVATE|secret/);
  const other = await harness({ startResponse: () => new Response('PRIVATE-BODY', { headers: { 'content-type': 'application/private-secret' } }) });
  await other.click('#start');
  assert.match(statusText(other), /content type other/);
  assert.doesNotMatch(statusText(other), /private-secret|PRIVATE/);
});

test('WebKit-style native JSON exceptions are avoided by parsing response text safely', async () => {
  const h = await harness({ startResponse: () => ({ ok: true, status: 200, redirected: false, headers: new Headers({ 'content-type': 'application/json' }),
    json() { throw new DOMException('The string did not match the expected pattern.', 'SyntaxError'); },
    text: async () => 'PRIVATE-MALFORMED-JSON',
  }) });
  await h.click('#start');
  assert.match(statusText(h), /Invalid JSON response/);
  assert.doesNotMatch(statusText(h), /expected pattern|PRIVATE/);
});

test('every audio startup stage has a fixed label and suppresses raw SDK error text', async () => {
  for (const [sdkFailure, label] of [['microphone', 'Microphone access'], ['create', 'RTC client creation'], ['join', 'RTC join'], ['publish', 'Microphone publication']]) {
    const h = await harness({ sdkFailure }); await h.click('#start');
    assert.ok(statusText(h).includes(`${label} failed (SyntaxError)`));
    assert.doesNotMatch(statusText(h), /PRIVATE/);
    if (sdkFailure === 'microphone') assert.ok(!h.calls.includes('/api/start'));
    else assert.ok(h.calls.includes('/api/stop'));
  }
});

test('cleanup and repeated Stop failures retain the original startup failure and retry wiring', async () => {
  let attempts = 0;
  const h = await harness({ sdkFailure: 'join', stopResponse: () => {
    attempts++;
    return attempts < 3 ? new Response('PRIVATE-INVALID-STOP', { status: 502, headers: { 'content-type': 'text/html' } }) : new Response('{}', { headers: { 'content-type': 'application/json' } });
  } });
  await h.click('#start');
  const original = 'RTC join failed (SyntaxError)';
  assert.ok(statusText(h).startsWith(original));
  assert.match(statusText(h), /Cleanup failed: HTTP error.*\/api\/stop.*HTTP 502/);
  assert.equal(h.el('#start').disabled, true);
  assert.equal(h.el('#stop').disabled, false);
  await h.click('#stop');
  assert.ok(statusText(h).startsWith(original));
  assert.match(statusText(h), /Cleanup retry failed/);
  assert.doesNotMatch(statusText(h), /PRIVATE/);
  await h.click('#stop');
  assert.equal(h.el('#state-label').textContent, 'Ready');
  assert.equal(h.el('#start').disabled, false);
});

test('WebKit DOMException and non-Error SDK objects expose only recognized names', async () => {
  for (const sdkException of [new DOMException('PRIVATE-WEBKIT-DETAIL', 'NotAllowedError'), { name: 'PRIVATE-ERROR-NAME', message: 'PRIVATE-SDK-DATA', token: 'PRIVATE-TOKEN' }]) {
    const h = await harness({ sdkFailure: 'microphone', sdkException }); await h.click('#start');
    assert.match(statusText(h), /Microphone access failed/);
    if (sdkException.name === 'NotAllowedError') assert.match(statusText(h), /NotAllowedError/);
    assert.doesNotMatch(statusText(h), /PRIVATE/);
    assert.ok(!h.calls.includes('/api/start'));
  }
});
