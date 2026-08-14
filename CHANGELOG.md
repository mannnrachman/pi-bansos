# Changelog

## [0.4.5] - 2026-08-14

### Changed
- Removed the retired MiMo upstream and ignored local Pi subagent artifacts.
- Added OpenCode CLI fingerprint headers for more reliable free-model requests.
- Kept relay state outside the package directory so npm updates preserve it.

## [0.4.4] - 2026-08-05

### Fixed
- **Vercel relay deploy fails with "Function Runtimes must have a valid version"** — vercel.json no longer declares a `functions.runtime`; relay worker runs on `runtime: "edge"` (same proven pattern as 9Router). Deployment now succeeds instead of ERRORing in build
- **Vercel relay rejects large `max_tokens`** — requests with `max_tokens > 131072` through the relay returned 400 "Upstream request failed" (Vercel response size/duration limits). Added `RELAY_MAX_TOKENS` clamp at the relay layer: only activated when relay is enabled, direct mode stays unconstrained, and model config (`KNOWN_MODELS`, e.g. `deepseek-v4-flash-free` at 384000) remains accurate

### Changed
- Relay worker runtime: `nodejs` → `edge`
- vercel.json: removed `functions` block (only `rewrites` remains)

## [0.4.3] - 2026-08-04

### Fixed
- **Proxy crash on upstream disconnect** — `proxy.on("error")` now guards `headersSent` before writing 502 response. Previously, upstream dropping connection mid-stream (rate limit, ECONNRESET, timeout) caused `ERR_HTTP_HEADERS_SENT` and terminated the entire Pi process (#1, thanks @totnormal)
