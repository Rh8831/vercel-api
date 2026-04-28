export const config = { runtime: "edge" };

const ORIGIN_BASE_URL = normalizeOrigin(process.env.TARGET_DOMAIN || "");
const REQUEST_TIMEOUT_MS = parsePositiveInt(process.env.UPSTREAM_TIMEOUT_MS, 30000);
const ALLOWED_METHODS = new Set((process.env.ALLOWED_METHODS || "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS")
  .split(",")
  .map((m) => m.trim().toUpperCase())
  .filter(Boolean));
const TRUST_CLIENT_IP = (process.env.TRUST_CLIENT_IP || "false").toLowerCase() === "true";
const STRIP_TRACKING_HEADERS = (process.env.STRIP_TRACKING_HEADERS || "true").toLowerCase() !== "false";

const BLOCKED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "forwarded",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
]);

const TRACKING_HEADERS = new Set([
  "cf-connecting-ip",
  "cf-ray",
  "x-vercel-id",
  "x-vercel-ip-country",
  "x-vercel-ip-city",
  "x-vercel-ip-latitude",
  "x-vercel-ip-longitude",
  "x-vercel-ip-timezone",
]);

function normalizeOrigin(rawOrigin) {
  const trimmed = rawOrigin.trim().replace(/\/$/, "");
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    if (!/^https?:$/.test(url.protocol)) return "";
    return `${url.protocol}//${url.host}`;
  } catch {
    return "";
  }
}

function parsePositiveInt(rawValue, fallback) {
  const parsed = Number.parseInt(rawValue || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function extractPathAndQuery(requestUrl) {
  const firstSlash = requestUrl.indexOf("/", 8);
  return firstSlash === -1 ? "/" : requestUrl.slice(firstSlash);
}

function buildUpstreamUrl(requestUrl) {
  return `${ORIGIN_BASE_URL}${extractPathAndQuery(requestUrl)}`;
}

function shouldDropHeader(name) {
  if (BLOCKED_REQUEST_HEADERS.has(name)) return true;
  if (name.startsWith("x-vercel-")) return true;
  if (STRIP_TRACKING_HEADERS && TRACKING_HEADERS.has(name)) return true;
  return false;
}

function buildUpstreamHeaders(incomingHeaders) {
  const headers = new Headers();
  let forwardedClientIp = null;

  for (const [name, value] of incomingHeaders) {
    if (shouldDropHeader(name)) continue;

    if (name === "x-real-ip" || name === "x-forwarded-for") {
      if (!forwardedClientIp) forwardedClientIp = value;
      continue;
    }

    headers.set(name, value);
  }

  if (TRUST_CLIENT_IP && forwardedClientIp) {
    headers.set("x-forwarded-for", forwardedClientIp);
  }

  return headers;
}

function buildErrorResponse(status, message, requestId) {
  return new Response(JSON.stringify({ error: message, requestId }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function createRequestId() {
  return crypto.randomUUID();
}

export default async function handler(req) {
  const requestId = createRequestId();

  if (!ORIGIN_BASE_URL) {
    return buildErrorResponse(500, "Misconfigured target origin", requestId);
  }

  if (!ALLOWED_METHODS.has(req.method)) {
    return buildErrorResponse(405, "Method not allowed", requestId);
  }

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const requestHasBody = req.method !== "GET" && req.method !== "HEAD";
    const upstreamRequest = {
      method: req.method,
      headers: buildUpstreamHeaders(req.headers),
      redirect: "manual",
      signal: controller.signal,
    };

    if (requestHasBody) {
      upstreamRequest.body = req.body;
      upstreamRequest.duplex = "half";
    }

    const upstreamResponse = await fetch(buildUpstreamUrl(req.url), upstreamRequest);
    const responseHeaders = new Headers(upstreamResponse.headers);
    responseHeaders.set("x-relay-request-id", requestId);
    responseHeaders.set("x-relay", "vercel-edge");

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    const timeout = error?.name === "AbortError";
    console.error("relay_error", { requestId, timeout, message: String(error?.message || error) });
    return buildErrorResponse(timeout ? 504 : 502, timeout ? "Upstream timeout" : "Upstream request failed", requestId);
  } finally {
    clearTimeout(timeoutHandle);
  }
}
