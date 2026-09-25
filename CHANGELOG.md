# Changelog

## Unreleased

### Added
- **`/bansos hide` / `/bansos show`** (and a menu item) toggle the `bansos` TUI status-bar entry. Saved as `statusBar` in `~/.pi/agent/pi-bansos-relay-state.json`; default shown.
- `/bansos status` also reports the proxy address or bind error and the number of models found at startup.

### Changed
- Startup failures (no models found, proxy bind failure) no longer print on stderr; the status bar shows `bansos: proxy down` / `bansos: no models` and `/bansos status` has the detail. `BANSOS_DEBUG=1` prints them again.
- `/bansos` re-reads the state file before each change, so it no longer overwrites a change made earlier in another running pi/OMP process with its stale copy (simultaneous changes are still last-write-wins). Saving creates `~/.pi/agent/` if missing and reports a failed save instead of ignoring it.

### Fixed
- **`MaxListenersExceededWarning: 11 listening listeners added to [Server]`** — the port bump registered a new `listening` callback per busy port; it now scans with one `listening`/`error` handler pair.
- **One proxy port per session** — every session start (OMP runs task subagents in-process) bound its own proxy, and a subagent's shutdown closed it. Sessions bound to the same loaded extension now share one proxy; it is `unref`'d and lives until the process exits, except that pi's `/reload` (which re-imports the extension) closes it first so the reloaded copy can bind again instead of leaking a port.
- **Requests sent to the wrong port when 18080 was taken** — the provider was first registered at `BANSOS_PORT` and re-registered at the bumped port on session start, but OMP keeps the session's already-resolved model URL, so chat requests kept going to the taken port (usually another process's proxy, or nothing). The proxy now binds at load and the provider is registered with the real port.

## [0.4.12] - 2026-09-22

### Fixed
- Startup chatter no longer prints on stderr during `pi` or `pi -p` (health checks, registered-model list, listen, relay status, shutdown). Failures still print. Set `BANSOS_DEBUG=1` for relay and rate-limit warnings.

## [0.4.11] - 2026-09-22

### Added
- OpenCode `mimo-v2.6-flash-free` (chat, vision). Catalog IN; inference ping 200. Specs from models.dev (200K / 32K).
- README **Update** section: pi `pi update npm:pi-bansos` / `--extensions`; OMP npm plugins via `omp install pi-bansos --force` (marketplace `plugin upgrade` does not apply).

## [0.4.10] - 2026-09-18

### Fixed
- **OpenCode free models 403 `FreeTierError`** — Zen now fingerprints the official client. Proxy sends `User-Agent: opencode/1.18.31`, canonical `ses_`/`msg_` ids, `Bearer public`, injects tool quartet `{bash, glob, grep, read}`, forces `stream: true`, and for Muse Responses sets `store: false` + strips prior reasoning items (same gates as 9router #4132).

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
