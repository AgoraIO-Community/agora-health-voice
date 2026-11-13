// Native browser regression, without browser dependencies or real credentials:
//   npm run build && node tests/native-login.fixture.mjs
// Open http://localhost:3105, enter the dummy value below, and submit Continue.
// PASS requires a browser-generated same-origin POST, a 303 authentication
// response with protected cookie attributes, and an authenticated redirect GET.
// The fixture prints only pass/fail evidence, never cookies or request bodies.
// Stop with Ctrl-C. This fixture is not included in the offline *.test.mjs suite.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createBrowserAccess } from '../dist/browser-access.js';

const port = 3105;
const browserOrigin = `http://localhost:${port}`;
const gateOrigin = `https://localhost:${port}`;
const dummyPasscode = 'native-form-regression-only-'.padEnd(43, 'x');
const gate = createBrowserAccess({ origin: gateOrigin, passcode: dummyPasscode });
let nativePostPassed = false;
let authenticatedPostPassed = false;

// HTTPS terminates at a tunnel in production. For this isolated loopback test,
// translate only an EXACT, browser-generated HTTP origin to the gate's HTTPS
// origin. Missing, null and foreign origins remain untouched and rejected.
// Browser cookie/TLS behavior over a real HTTPS tunnel needs device validation.
const server = createServer((req, res) => {
  void (async () => {
    if (req.method === 'GET' && req.url === '/favicon.ico') { res.writeHead(404); res.end(); return; }
    const nativePost = req.method === 'POST' && req.url === '/mobile/login' && req.headers['sec-fetch-mode'] === 'navigate';
    if (nativePost) {
      assert.equal(req.headers.origin, browserOrigin, 'Native form must send the real page origin');
      assert.equal(req.headers['sec-fetch-site'], 'same-origin');
      nativePostPassed = true;
      let issuedCookie;
      const writeHead = res.writeHead;
      res.writeHead = function (status, headers) {
        issuedCookie = headers?.['Set-Cookie'];
        return writeHead.call(this, status, headers);
      };
      res.once('finish', () => {
        try {
          assert.equal(res.statusCode, 303);
          const cookie = String(issuedCookie);
          for (const attribute of ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=3600']) assert.ok(cookie.includes(attribute));
          assert.ok(!cookie.includes(dummyPasscode));
          authenticatedPostPassed = true;
          console.log('PASS: native form Origin matched; authentication returned 303 and a protected opaque cookie.');
        } catch { console.error('FAIL: native form did not authenticate with a protected cookie.'); process.exitCode = 1; }
      });
    }
    if (req.headers.origin === browserOrigin) req.headers.origin = gateOrigin;
    const access = await gate(req, res, new Set());
    if (!access.handled) {
      assert.equal(req.url, '/');
      assert.ok(nativePostPassed && authenticatedPostPassed);
      // Gate accepted the browser's cookie on the redirected request.
      console.log('PASS: browser followed the redirect and loaded the authenticated page.');
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      res.end('Native login regression passed: correct Origin, successful authentication, and authenticated redirect.');
    }
  })().catch(() => {
    console.error('FAIL: native form regression; no request values displayed.');
    process.exitCode = 1;
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Native login regression failed.');
  });
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Native form regression ready at ${browserOrigin}. Dummy passcode: native-form-regression-only- followed by 16 x characters.`);
});
