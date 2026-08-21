# Changelog

## Unreleased

## [0.4.7] - 2026-08-21

### Added
- Verified free models from OpenCode Zen and KiloCode Gateway for a 22-model catalog.
- Muse Spark 1.2 Contributor Free with OpenAI Responses API support.
- KiloCode Dots3-Note Preview Free.

### Changed
- Show OpenCode/KiloCode labels in the shared `bansos` provider.
- Separate OpenCode and KiloCode local rate-limit buckets.
- Document Muse's API difference and manual verification steps.

### Removed
- OpenCode DeepSeek V4 Flash, North Mini Code, and Ling 3.0 Flash after direct inference failures.

## [0.4.6] - 2026-08-14

### Added
- 5 new KiloCode free models: `nvidia/nemotron-3.5-lightning:free`, `nvidia/nemotron-3.5-content-safety:free`, `tencent/hy3:free`, `liquid/lfm-2.5-2.6b:free`, `poolside/laguna-s-2.1:free` (specs verified against the live KiloCode API).

### Removed
- `poolside/laguna-m.1:free` — no longer exists in the KiloCode API.

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
