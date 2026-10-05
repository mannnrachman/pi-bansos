# Changelog

## [0.4.14] - 2026-10-05

Session log: catalog sweep 2026-10-05 (4 new models, 1 dead), zen free-tier gate root-caused (fingerprint hardened per pi-freeflow/bansos-router research), and relay failover added (spread rotation prototyped then dropped — Vercel relays share one NAT egress).

### Added
- OpenCode `ling-3.1-flash-free`, `fledge-alpha-free`, `longcat-2.5-preview-free` — catalog IN, chat 200 via the proxy (specs conservative: upstream publishes none).
- Kilo `apodex/apodex-1.1-mini:free` — reasoning-first research/forecasting mini (262K ctx / 236K out, text-only, `reasoning` field verified live).
- **Live UA tracking** (pi-freeflow pattern): the gate `User-Agent` version now follows the live `opencode-ai` npm release (background refresh at startup, disk cache, `BANSOS_OPENCODE_UA` env override, pinned `1.18.31` fallback) — a stricter gate can no longer strand users on a stale version.
- **Relay failover with escalating cooldown** (pi-freeflow / llm-keypool patterns): a relay that answers 429/408/5xx or drops the socket now cools down (429 → 90 s base, transport → 30 s, ×2 per consecutive failure, cap 15 min) and the request rolls to the next healthy relay, falling back to direct when the pool is exhausted. Previously a rate-limited relay surfaced its 429 straight to the session and a dead relay only fell back direct on a fetch *throw*. Client-error 4xx (except 429/408) return as-is: they are the payload's fault, not the relay's. Verified end-to-end with a simulated 429 relay rolling over to a pass-through relay. (A `spread` round-robin mode was prototyped and dropped: Vercel relays share one NAT egress pool, so extra relays add no per-IP diversity — failover alone is the real fix.)

### Changed — free-tier fingerprint hardened (patterns from [pi-freeflow](https://github.com/trefeon/pi-freeflow) & [bansos-router](https://github.com/ihsan-ramadhan/bansos-router))
- Fingerprint tool set expanded to the full sextet `{bash, glob, grep, read, edit, write}` (freeflow ships the same; bisect showed `bash`+`read` is the minimum the gate requires).
- Injected decoy tools now set `tool_choice: "none"` on the chat wire (bansos-router): the model can no longer burn a reply calling tools that don't exist downstream. Caller-declared tools are unaffected — pi sends its own list, which marks them present and skips injection.
- `x-opencode-project` now sends a 40-char hex project id (was `"global"`) plus `x-session-affinity`, `b3`, and `traceparent` distributed-tracing headers — the shape real opencode clients emit (9router #4111, bansos-router).

### Fixed
- **Root-caused the OpenCode free-tier 403 gate** (bisect, informed by 9router PRs [#4111](https://github.com/decolua/9router/pull/4111)/[#4146](https://github.com/decolua/9router/pull/4146)): beyond the UA/session fingerprint, the payload must carry the `bash` + `read` tool pair. Our fingerprint always satisfies it — `ling-3.1-flash-free` initially looked 403-gated but passes with the standard payload; it is now registered.

### Removed
- Kilo `inclusionai/ling-3.0-flash-fin:free` — gone from the live catalog (replaced by the OpenCode-side `ling-3.0-flash-fin-free`, which stays).

### Rejected after live testing (2026-10-05)
- OpenCode `jev-1.13-free` (500 upstream), `deepseek-v4-flash-free` (400 Model is unavailable).

## [0.4.13] - 2026-09-28

Everything from the Sept-28 working session: issues #5/#6/#7 (PRs #8/#9), the KiloCode 401 fix, catalog sync, per-host state files, and this README/CHANGELOG cleanup.

### Added — issue #5: instant startup via model-catalog caching

- **Model catalog caching (#5)** — startup registers models from the last-known catalog (`bansos-models.json` in the host's agent dir) **without waiting on upstream**, then refreshes in the background; a failed refresh keeps the previous catalog (a flaky connection no longer degrades startup). First run with no cache still fetches once from both upstreams.
- **`/bansos refresh-models`** — forces a catalog re-fetch; warns when it fails so you know the list may be stale.
- OpenCode `space-bunny-free` (stealth free model: reasoning, 1M context, 524K max output, text+image). Catalog IN; inference 200.
- Kilo `qwen/qwen3.8-27b:free` (reasoning, 262K context, text+image).

### Added — issue #7 via PR #9: status bar & silent startup

- **`/bansos hide` / `/bansos show`** (and a menu item) toggle the `bansos` TUI status-bar entry. Saved as `statusBar` in the relay state file; default shown.
- `/bansos status` also reports the proxy address or bind error and the number of models found at startup.
- Startup failures (no models found, proxy bind failure) no longer print on stderr; the status bar shows `bansos: proxy down` / `bansos: no models` and `/bansos status` has the detail. `BANSOS_DEBUG=1` prints them again.
- Each `/bansos` change re-reads the state file when it saves, applies only that change, and writes atomically (temp file + rename), so it no longer overwrites settings another running pi/OMP process changed in the meantime with its stale copy. Saving creates the agent dir if missing; a failed save is reported and the change is not applied.

### Fixed — issue #6 via PR #8: proxy port & listener hygiene

- **`MaxListenersExceededWarning: 11 listening listeners added to [Server]`** — the port bump registered a new `listening` callback per busy port; it now scans with one `listening`/`error` handler pair.
- **One proxy port per session** — every session start (OMP runs task subagents in-process) bound its own proxy, and a subagent's shutdown closed it. Sessions bound to the same loaded extension now share one proxy; it is `unref`'d and lives until the process exits, except that pi's `/reload` (which re-imports the extension) closes it first so the reloaded copy can bind again instead of leaking a port.
- **Requests sent to the wrong port when 18080 was taken** — the provider was first registered at `BANSOS_PORT` and re-registered at the bumped port on session start, but OMP keeps the session's already-resolved model URL, so chat requests kept going to the taken port (usually another process's proxy, or nothing). The proxy now binds at load and the provider is registered with the real port.

### Fixed — KiloCode 401 `INVALID_TOKEN`

- Requests no longer send the stale `Authorization: Bearer kilo-free` header; the free gateway is keyless and now rejects placeholder tokens with 401. Both the catalog fetch and chat proxying were affected — every Kilo model failed health-check and chat until this was dropped. Verified live after the fix: catalog 200, `north-mini-code:free` chat 200 via pi.

### Changed — per-host state files (pi vs OMP)

- Relay state **and** the new catalog cache now resolve per host: pi → `~/.pi/agent/`, OMP → `~/.omp/agent/`, detected from the extension's real install path with a process-name basename fallback for symlinked installs (OMP npm plugins are often symlinks into a repo checkout, so realpath alone misroutes to pi). Previously both were hardcoded to `~/.pi/agent/` — OMP users couldn't find their relay state. Each host now keeps its own files; deleting one leaves the other untouched.

### Removed — dead Kilo models

- Kilo `minimax/minimax-m3:free`, `minimax/minimax-m2.7:free`, `thinkingmachines/inkling:free` — gone from the live catalog. `openrouter/free` stays but is now **pinned**: absent from `/models` since 2026-09-28, yet chat completions still serve it (200), so catalog filtering alone would drop a working model.

### Docs

- README restructured with a clear header hierarchy (Contents, Features, Models, Install, Update, Usage → Commands/Environment variables, Relay → deploy, Data files, Notes, Uninstall, License). Model tables now state the real facts: **26 total (9 OpenCode + 17 Kilo)**, `space-bunny-free` and `qwen/qwen3.8-27b:free` in, three dead Kilo models out, `openrouter/free` pinning explained, and a new **Data files** section documents per-host state paths.

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
