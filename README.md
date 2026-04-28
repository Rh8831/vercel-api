# vercel-edge-stream-relay

A minimal **Vercel Edge Function** that relays **streaming HTTP** traffic to
your own backend service. It focuses on efficient request/response streaming
while preserving method, path, query string, and most headers.

If you're using **xray-core with `xhttp`**, this relay stays compatible with
that model because it forwards streaming request/response bodies end-to-end.

> ⚠️ **HTTP(S) transport only.** This project is an HTTP relay built on Edge
> `fetch` streaming APIs. It does **not** support raw TCP/UDP tunneling or
> WebSocket upgrade handling.

## Disclaimer

**This repository is for education, experimentation, and personal testing
only.** It is **not** production software: there is no SLA, no security
audit, no ongoing maintenance guarantee, and no support channel.

- **Do not rely on it for production** workloads, critical infrastructure,
  or anything where availability, confidentiality, or integrity must be
  assured. You deploy and operate it **entirely at your own risk**.
- **Compliance is your responsibility.** Laws, regulations, and acceptable
  use policies (including your host's and Vercel's) vary by jurisdiction
  and service. The authors and contributors are **not** responsible for how
  you use this code or for any damages, losses, or legal consequences that
  arise from it.
- **Vercel's terms of service** apply to anything you run on their
  platform. A generic HTTP relay may violate their rules or acceptable use
  if misused; read and follow [Vercel's policies](https://vercel.com/legal)
  yourself.
- **No warranty.** The software is provided "as is", without warranty of
  any kind, express or implied. The authors accept no liability for its
  use or misuse.

If you need something production-grade, build or buy a properly engineered
solution with monitoring, hardening, legal review, and operational ownership.

---

## How It Works

```
┌──────────┐   TLS / SNI: *.vercel.app    ┌──────────────────┐    HTTP/2     ┌──────────────┐
│  Client  │ ───────────────────────────► │  Vercel Edge     │ ───────────►  │  Your backend│
│ (browser/│   streaming HTTP request     │  (V8 isolate,    │  streams       │  HTTP origin │
│ SDK/API) │   (POST/GET/PUT/...)         │  streams body)   │  forwarded     │              │
└──────────┘                              └──────────────────┘               └──────────────┘
```

1. A client opens a streaming HTTP request to a Vercel domain
   (`your-app.vercel.app`, or any custom domain pointed at Vercel).
2. The TLS handshake uses **Vercel's certificate / SNI**, so to a censor it
   looks like ordinary traffic to a legitimate Vercel-hosted site.
3. The Edge function pipes the request body to your backend origin
   (`TARGET_DOMAIN`) as a `ReadableStream` — no buffering — and pipes the
   upstream response back the same way.

## Why Edge Runtime for HTTP Relays?

- **True bidirectional streaming** via WebStreams (`req.body` →
  `fetch(..., { duplex: "half" })` → upstream response). First byte out as
  soon as first byte in. This matches streaming HTTP's chunked POST/GET model
  exactly.
- **~5–50 ms cold starts.** Edge functions run in V8 isolates, not AWS
  Lambda microVMs — roughly 10× faster to start than the equivalent
  Rust/Go serverless function.
- **Runs at every Vercel PoP globally.** Anycast routing puts your relay
  within a few ms of every client, regardless of where your origin lives.
- **No buildtime, no toolchain, no native deps.** A single ~60-line JS
  file.

## High-load tuning baked in

The handler is written for sustained throughput:

- `TARGET_DOMAIN` is read **once at cold start** and cached at module
  scope — no env lookup per request.
- URL parsing is skipped entirely — `req.url.indexOf("/", 8)` + `slice`
  extracts the path+query without allocating a `URL` object.
- Headers are filtered in a **single pass**: hop-by-hop headers
  (`connection`, `keep-alive`, `transfer-encoding`, …), Vercel telemetry
  (`x-vercel-*`), and Vercel-edge `x-forwarded-host/proto/port` are
  dropped. The client's real IP (`x-real-ip` or original
  `x-forwarded-for`) is forwarded as `x-forwarded-for`.
- `fetch(targetUrl, options)` is called directly — no extra
  `new Request(...)` allocation.
- `redirect: "manual"` keeps Vercel from chasing 3xx upstream and
  breaking the streaming HTTP framing.
- `duplex: "half"` is sent only when a request body exists, avoiding extra
  request options for bodyless methods.

---

## Setup & Deployment

### 1. Requirements

- A working public HTTP backend (this is your `TARGET_DOMAIN`).
- [Vercel CLI](https://vercel.com/docs/cli): `npm i -g vercel`
- A Vercel account (Pro recommended for higher bandwidth and concurrent
  invocation limits).

### 2. Configure Environment Variable

In the Vercel Dashboard → your project → **Settings → Environment
Variables**, add:

| Name            | Example                         | Description                                          |
| --------------- | ------------------------------- | ---------------------------------------------------- |
| `TARGET_DOMAIN` | `https://api.example.com` | Full base URL of your upstream HTTP origin. |

Notes:

- Use `https://` if your backend terminates TLS, `http://` if plain.
- Include a non-default port if needed.
- Trailing slashes are stripped automatically.

### 3. Deploy

```bash
git clone https://github.com/ramynn/vercel-edge-stream-relay.git
cd vercel-edge-stream-relay

vercel --prod
```

After deployment Vercel gives you a URL like `your-app.vercel.app`.

---

## Client Configuration

Point your HTTP client, SDK, or frontend app to your Vercel deployment URL.
The relay preserves path/query and forwards the stream to `TARGET_DOMAIN`.

### Example request

```
curl -X POST https://your-app.vercel.app/api/events --data-binary @payload.bin
```

### Tips

- You can use **any Vercel-fronted hostname** for SNI as long as the TLS
  handshake reaches Vercel. Custom domains pointed at Vercel work too.
- Use a custom domain in Vercel for clearer branding and production setups.

---

## Limitations

- **streaming HTTP only.** WebSocket / gRPC / raw TCP / mKCP / QUIC do **not** work
  on Vercel's Edge runtime regardless of how the relay is implemented.
- **Edge per-invocation CPU budget** (~50 ms compute on Hobby, more on
  Pro). I/O wait time doesn't count, so streaming proxies stay well within
  budget — but a stuck upstream can hit the wall-clock limit.
- **Bandwidth quotas.** All traffic counts against your Vercel account's
  quota. Heavy use → upgrade to Pro/Enterprise.
- **Logging.** Vercel logs request metadata (path, IP, status). The body
  is not logged, but be aware of the trust model.

## Project Layout

```
.
├── api/index.js     # Edge function: streams request → TARGET_DOMAIN, streams response back
├── package.json     # Project metadata (no runtime deps; fetch/Headers are globals)
├── vercel.json      # Routes all paths → /api/index
└── README.md
```

## License

MIT.
