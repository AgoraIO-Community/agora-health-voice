import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface BrowserAccessConfig { origin: string; passcode: string }

export function readBrowserAccessConfig(env: NodeJS.ProcessEnv): BrowserAccessConfig | undefined {
  const origin = env.MOBILE_BROWSER_ORIGIN;
  const passcode = env.MOBILE_BROWSER_PASSCODE;
  if (!origin && !passcode) return;
  let url: URL;
  try { url = new URL(origin ?? ""); } catch { throw new Error("Mobile browser access requires one exact HTTPS origin and a generated passcode."); }
  if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash || !/^[a-z0-9.-]+$/.test(url.hostname) ||
      !passcode || !/^[A-Za-z0-9_-]{43,128}$/.test(passcode)) {
    throw new Error("Mobile browser access requires one exact HTTPS origin and a generated passcode.");
  }
  return { origin, passcode };
}

const cookieName = "__Host-health-mobile";
const lifetime = 60 * 60 * 1000;
const digest = (value: string) => createHash("sha256").update(value).digest();
const equal = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));
const loginPage = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Agora Health Voice · Mobile access</title><style>html{color-scheme:light;background:#f6f9fa;color:#183b46;font:16px/1.6 system-ui}main{max-width:26rem;margin:12vh auto;padding:1.5rem}h1{font-size:1.8rem;line-height:1.2}label,input,button{display:block}input,button{box-sizing:border-box;width:100%;font:inherit;padding:.8rem;border:1px solid #adc8ca;border-radius:.5rem;margin:.6rem 0 1rem}button{background:#087f83;color:white;cursor:pointer}:focus-visible{outline:3px solid #087f83;outline-offset:3px}</style><main><h1>Agora Health Voice</h1><p>Temporary mobile access. Enter the passcode from your local setup. Access expires after one hour.</p><form action="/mobile/login" method="post"><label for="passcode">Mobile access passcode</label><input id="passcode" name="passcode" type="password" autocomplete="off" required maxlength="128" autocapitalize="none" spellcheck="false"><button type="submit">Continue</button></form></main></html>`;

// This gate runs only on the browser listener. It never handles tool callbacks.
export function createBrowserAccess(config?: BrowserAccessConfig, now = Date.now) {
  if (config) config = readBrowserAccessConfig({ MOBILE_BROWSER_ORIGIN: config.origin, MOBILE_BROWSER_PASSCODE: config.passcode });
  const sessions = new Map<string, number>();
  let failures = 0;
  let blockedUntil = 0;
  const publicHost = config && new URL(config.origin).host;
  const cookie = (token: string, seconds: number) => `${cookieName}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${seconds}`;

  return async (req: IncomingMessage, res: ServerResponse, localHosts: Set<string>): Promise<{ handled: boolean; origin?: string }> => {
    const host = req.headers.host;
    const remote = !!config && host === publicHost;
    const reject = (status: number, message: string) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: message }));
      return { handled: true };
    };
    if (!host || (!remote && !localHosts.has(host)) || req.headers.forwarded !== undefined ||
        (req.headers["x-forwarded-host"] !== undefined && (!remote || req.headers["x-forwarded-host"] !== publicHost)) ||
        (req.headers["x-forwarded-proto"] !== undefined && (!remote || req.headers["x-forwarded-proto"] !== "https"))) {
      return reject(403, "Open the app on localhost.");
    }
    if (!remote || !config) return { handled: false, origin: `http://${host}` };
    const origin = config.origin;
    if ((req.headers.origin !== undefined && req.headers.origin !== origin) ||
        (req.method !== "GET" && (req.headers.origin !== origin || req.headers["sec-fetch-site"] === "cross-site"))) {
      return reject(403, "Session controls require the approved browser origin.");
    }
    const path = new URL(req.url ?? "/", origin).pathname;
    for (const [token, expiry] of sessions) if (expiry <= now()) sessions.delete(token);
    const supplied = req.headers.cookie?.split(";").map(part => part.trim()).filter(part => part.startsWith(`${cookieName}=`)) ?? [];
    const token = supplied.length === 1 ? supplied[0]!.slice(cookieName.length + 1) : "";
    const authenticated = sessions.has(token);
    if (req.method === "POST" && path === "/mobile/login") {
      if (now() < blockedUntil) return reject(429, "Too many access attempts. Wait one minute and retry.");
      if (req.headers["content-type"]?.split(";")[0] !== "application/x-www-form-urlencoded") return reject(415, "Use the mobile access form.");
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > 1024) { res.setHeader("Connection", "close"); return reject(413, "Request body is too large."); }
        chunks.push(Buffer.from(chunk));
      }
      const values = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      if (values.getAll("passcode").length !== 1 || !equal(values.get("passcode") ?? "", config.passcode)) {
        if (++failures >= 5) { failures = 0; blockedUntil = now() + 60_000; }
        return reject(401, "Mobile access denied. Return to the access form and retry.");
      }
      failures = 0;
      const issued = randomBytes(32).toString("base64url");
      // Bound memory and keep issued access valid for at most one hour.
      if (sessions.size >= 8) sessions.delete(sessions.keys().next().value!);
      sessions.set(issued, now() + lifetime);
      res.writeHead(303, { Location: "/", "Set-Cookie": cookie(issued, lifetime / 1000), "Cache-Control": "no-store" });
      res.end();
      return { handled: true };
    }
    if (!authenticated) {
      if (req.method === "GET" && path === "/") {
        res.writeHead(401, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" });
        res.end(loginPage);
        return { handled: true };
      }
      return reject(401, "Mobile authentication required.");
    }
    if (req.method === "POST" && path === "/mobile/logout") {
      sessions.delete(token);
      res.writeHead(303, { Location: "/", "Set-Cookie": cookie("", 0), "Cache-Control": "no-store" });
      res.end();
      return { handled: true };
    }
    return { handled: false, origin };
  };
}
