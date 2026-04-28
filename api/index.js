export const config = { runtime: "edge" };

const ORIGIN_BASE_URL = (process.env.TARGET_DOMAIN || "").replace(/\/$/, "");
const REQUEST_TIMEOUT_MS = 30_000;
const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const HOP_BY_HOP_HEADERS = new Set([
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

function buildUpstreamUrl(requestUrl) {
  const pathStartIndex = requestUrl.indexOf("/", 8);
  return pathStartIndex === -1
    ? `${ORIGIN_BASE_URL}/`
    : `${ORIGIN_BASE_URL}${requestUrl.slice(pathStartIndex)}`;
}

function buildUpstreamHeaders(incomingHeaders) {
  const upstreamHeaders = new Headers();
  let forwardedClientIp = null;

  for (const [headerName, headerValue] of incomingHeaders) {
    if (HOP_BY_HOP_HEADERS.has(headerName)) continue;
    if (headerName.startsWith("x-vercel-")) continue;
    if (headerName === "x-real-ip") {
      forwardedClientIp = headerValue;
      continue;
    }
    if (headerName === "x-forwarded-for") {
      if (!forwardedClientIp) forwardedClientIp = headerValue;
      continue;
    }
    upstreamHeaders.set(headerName, headerValue);
  }

  if (forwardedClientIp) upstreamHeaders.set("x-forwarded-for", forwardedClientIp);
  return upstreamHeaders;
}

export default async function handler(req) {
  if (!ORIGIN_BASE_URL) {
    return new Response("Misconfigured: TARGET_DOMAIN is not set", { status: 500 });
  }

  if (!ALLOWED_METHODS.has(req.method)) {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => abortController.abort(), REQUEST_TIMEOUT_MS);

  try {
    const upstreamUrl = buildUpstreamUrl(req.url);
    const upstreamHeaders = buildUpstreamHeaders(req.headers);
    const requestHasBody = req.method !== "GET" && req.method !== "HEAD";

    const upstreamRequest = {
      method: req.method,
      headers: upstreamHeaders,
      redirect: "manual",
      signal: abortController.signal,
    };

    if (requestHasBody) {
      upstreamRequest.body = req.body;
      upstreamRequest.duplex = "half";
    }

    return await fetch(upstreamUrl, upstreamRequest);
  } catch (err) {
    const isTimeoutError = err?.name === "AbortError";
    console.error("edge relay request failed:", err);
    return new Response(isTimeoutError ? "Gateway Timeout" : "Bad Gateway", {
      status: isTimeoutError ? 504 : 502,
    });
  } finally {
    clearTimeout(timeoutHandle);
  }
}
