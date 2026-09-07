# Changelog

## Unreleased

## [0.4.9] - 2026-09-07

### Added
- OpenCode `muse-spark-1.3-contributor-free` (Responses API) and `ling-3.0-flash-fin-free` (chat). Verified against live Zen catalog + inference ping.
- KiloCode `inclusionai/ling-3.0-flash-sante:free` and `inclusionai/ling-3.0-flash-fin:free`.

### Removed
- OpenCode `hy3-free` and `laguna-s-2.1-free` — catalog OUT, inference 401 `Model is not supported`.
- KiloCode `tencent/hy3:free` (404 unavailable) and `meituan/longcat-2.0-free` (paid only).

## [0.4.8] - 2026-08-27

### Fixed
- **`omp install` hangs after "Installed"** — proxy HTTP server no longer starts in the extension factory (which runs during install / `--list-models`). Bind is deferred to `session_start`; `session_shutdown` still closes it. Catalog health-check + `registerProvider` stay in the factory.

### Added
- 5 new KiloCode free models: `minimax/minimax-m3:free`, `minimax/minimax-m2.7:free`, `thinkingmachines/inkling:free`, `thinkingmachines/inkling-small:free`, `meituan/longcat-2.0-free`. Catalog now 26 models (7 OpenCode + 19 KiloCode).

### Changed
- Updated KiloCode model specs to match live catalog (Dots3-Note max output 460K, Nemotron 3 Super max output 236K, LongCat 2.0 context 1M).
- Added vision (image input) flags for `stepfun/step-3.7-flash:free`, `dots-studio/dots-3-note-preview:free`, `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`, `openrouter/free`, `nvidia/nemotron-3.5-content-safety:free`, `minimax/minimax-m3:free`, `thinkingmachines/inkling:free`, `thinkingmachines/inkling-small:free`.
- Enabled reasoning for `stepfun/step-3.7-flash:free`, `poolside/laguna-xs-2.1:free`, `liquid/lfm-2.5-2.6b:free`.
- Renamed `Step 3.7 Flash Free` → `Step 3.7 Flash Free`, `Liquid LFM 2.5 2.6B Free` label updated.

### Removed
- OpenCode `x-preview-f-free` (Ox Alpha Free) — dropped from live catalog.

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
