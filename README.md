# pi-bansos

[![npm version](https://img.shields.io/npm/v/pi-bansos.svg?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/pi-bansos)
[![npm downloads](https://img.shields.io/npm/d18m/pi-bansos.svg?style=flat-square&logo=npm&logoColor=white&label=downloads)](https://www.npmjs.com/package/pi-bansos)
[![npm downloads/month](https://img.shields.io/npm/dm/pi-bansos.svg?style=flat-square&logo=npm&logoColor=white&label=downloads)](https://www.npmjs.com/package/pi-bansos)

Free model provider for **[pi](https://pi.dev)** ([browse packages](https://pi.dev/packages)) and **OMP (Oh My Pi)**. It adds a `bansos` provider with live free models from **2 upstreams** — OpenCode Zen and KiloCode gateway — through a local OpenAI-compatible proxy.

## Contents

- [Features](#features)
- [Models](#models)
- [Requirements](#requirements)
- [Install](#install)
- [Update](#update)
- [Usage](#usage)
- [WARP /64 hop (optional)](#warp-64-hop-optional)
- [Relay (optional)](#relay-optional)
- [Data files](#data-files)
- [Notes](#notes)
- [Uninstall](#uninstall)
- [License](#license)

## Features

- **Zero cost** — all models free, no API key needed for supported upstreams
- **19 models from 2 sources** — 11 OpenCode Zen + 8 KiloCode gateway
- **Works in both `pi` and `OMP`** — compatible with both Node.js (`pi`) and Bun (`omp`) runtimes, keeping separate per-host state in `~/.pi/agent/` and `~/.omp/agent/`
- **Instant startup** — the model catalog is cached locally and registered without waiting on upstream; it refreshes in the background
- **Auto health-check** — only catalog-listed models registered; dead ones skipped silently
- **Local-only proxy** — binds to `127.0.0.1`, nothing exposed externally; one proxy per loaded extension, shared by every session that uses it (including OMP's in-process subagents)
- **Optional WARP `/64` outbound hop engine (no cloud account, no root)** — route OpenCode traffic through a local userspace WireGuard proxy (`wgcf` + `wireproxy` on `127.0.0.1:42901`, pinned to dedicated IPv6 `/64` blocks while keeping BoringSSL JA4 TLS ciphers intact); when an IP hits a `429` quota or `403` IP-flag wall, it automatically rotates to a fresh `/64` and retries the turn — **reactively, even before `/bansos warp on`** (binaries auto-install on first need; opt out with `/bansos warp off` or `BANSOS_WARP_AUTO=0`). If the fresh `/64` is already spent too (WARP blocks are shared), the turn is replayed on the **KiloCode free gateway** instead of failing.
- **Optional cloud relay egress with automatic failover** — route through a **Cloudflare Workers** (one command, free, no card) or Vercel relay to dodge per-IP rate limits; a 429/403/unreachable relay cools down (escalating backoff) and the request rolls to the next healthy relay or goes direct — toggled live via `/bansos`
- **OpenCode free-tier fingerprint hardened (all 5 gates)** — auto-tracks the live `opencode-ai` dev-wire UA, matches BoringSSL JA4 ClientHello ciphers (`5b57614c22b0`), isolates `ses_…` sessions per downstream client, injects `<env>` and verbatim `read` + `shell` schemas, and round-trip aliases gated tool names/pairs/schemas (`terminal`, Claude Code `ReportFindings`, Codex `exec_command`, `Edit`/`Read`, and colliding names) across both SSE replies and multi-turn history
- **Smart 429/403 triage + transient overload retry** — transient `429 "The inference service is overloaded"` responses are retried automatically in-place (up to 8×, `800 → 4000 ms` backoff) without burning your session or triggering a cooldown; real quota `429 FreeUsageLimitError` cools just that model and, after a WARP hop still hits a spent `/64`, is replayed on the KiloCode free gateway so the client gets a `200`; IP-flag `403 "abusive traffic"` fails fast with an egress switch hint (`/bansos warp on` or `/bansos deploy`), and shape-gate `403` rotates the session and surfaces the error cleanly
- **Auto port bump** — if port 18080 is taken, automatically tries the next one (up to 18100)

## Models

**23 curated total: 11 OpenCode + 12 KiloCode.** All models are free. The provider is one `bansos` entry, but model names show their upstream: **OpenCode** or **KiloCode**. The startup check only verifies catalog membership; upstream access can still change between startup and a request.

### OpenCode Zen (11 models)

| Model ID                      | Name                        | Vision | API  | Context     | Max Output  | Reasoning |
| ----------------------------- | --------------------------- | ------ | ---- | ----------- | ----------- | --------- |
| `beam-free`                   | Beam Free                   | ❌     | chat | 1M tokens   | 131K tokens | ✅        |
| `hy4-flash-free`              | Hy4 Flash Free              | ✅     | chat | 1M tokens   | 65K tokens  | ✅        |
| `iceman-free`                 | Iceman Free                 | ❌     | chat | 262K tokens | 131K tokens | ✅        |
| `longcat-2.5-free`            | LongCat 2.5 Free            | ✅     | chat | 1M tokens   | 262K tokens | ✅        |
| `mimo-v2.6-flash-free`        | MiMo V2.6 Flash Free        | ✅     | chat | 200K tokens | 32K tokens  | ✅        |
| `nemotron-3.5-lightning-free` | Nemotron 3.5 Lightning Free | ❌     | chat | 262K tokens | 262K tokens | ✅        |
| `big-pickle`                  | Big Pickle                  | ❌     | chat | 200K tokens | 32K tokens  | ✅        |
| `deepseek-v4.1-flash-free`    | DeepSeek V4.1 Flash Free    | ✅     | chat | 320K tokens | 64K tokens  | ✅        |
| `flint-40b-free`              | Flint 40B Free              | ❌     | chat | 262K tokens | 65K tokens  | ✅        |
| `tidepool-alpha-free`         | Tidepool Alpha Free         | ❌     | chat | 1M tokens   | 131K tokens | ✅        |
| `nemotron-3.5-super-vl-free`  | Nemotron 3.5 Super VL Free  | ✅     | chat | 1M tokens   | 131K tokens | ✅        |

**Hardening 2026-11-18 (0.9.0)**: added bypasses for all 5 hidden OpenCode free-tier fingerprint gates (`terminal`, Claude Code `ReportFindings` pair, Codex `exec_command` pair, `Edit`/`Read` schema gates, and per-client `x-opencode-session` isolation), fixed full wire-alias restoration (`*_pi`, `run_command*`, `file_edit`, `file_read`) across SSE chunks and multi-turn `tool_calls` history, added automatic 8-attempt retries on transient `429 "overloaded"` bursts, and shipped the optional userspace **WARP `/64` hop engine** (`/bansos warp on`) — live-verified turning a `429 FreeUsageLimitError` on a spent `/64` into an immediate `200 OK` after rotating to a fresh IPv6 `/64`.

**Sweep 2026-11-07 (0.8.1)**: added `iceman-free` (262K/131K) and `inkling-2-small-free` (1M/131K, vision); dropped `pulse-alpha-free` (gone from catalog, `400 Model is unavailable`). Direct OpenCode requests pass `ciphers: OPENCODE_CIPHER_LIST` + `agent: false` to match OpenCode's BoringSSL JA4 cipher-list hash (`5b57614c22b0`).

**Sweep 2026-11-21 (0.9.2)**: added `hy4-flash-free` (1M/65K, vision), `longcat-2.5-free` (1M/262K, vision), and `tidepool-alpha-free` (1M/131K) — all zero-cost in the live zen catalog; dropped `crouton-alpha-free`, `glm-5.3-flash-free`, and `inkling-2-small-free` (all gone from the catalog). `jev-1.13-free` is cataloged at cost 0 but skipped: it is a decision-type model with no tool support, so it cannot serve pi turns.

**Muse note:** the muse-class models are 410-deprecated for now, but their Responses-API routing (`/v1/responses`) stays in place — if a muse-class id returns to the catalog it re-routes automatically, no code change needed.

### KiloCode Gateway (12 models)

Keyless — 200 requests/hour per IP. No `Authorization` header is sent; the free gateway rejects placeholder tokens.

| Model ID                                             | Name                             | Vision | Context     | Max Output  | Reasoning |
| ---------------------------------------------------- | -------------------------------- | ------ | ----------- | ----------- | --------- |
| `kilo-auto/free`                                     | Kilo Auto Free                   | ❌      | 256K tokens | 10K tokens  | ❌         |
| `nvidia/nemotron-3-ultra-550b-a55b:free`             | Nemotron 3 Ultra Free            | ❌      | 1M tokens   | 65K tokens  | ✅         |
| `reflection/beam-free`                               | Beam Free (Kilo)                 | ❌      | 1M tokens   | 131K tokens | ✅         |
| `baidu/ernie-5.5-flash-preview:free`                 | ERNIE 5.5 Flash Preview Free     | ❌      | 1M tokens   | 921K tokens | ✅         |
| `inclusionai/ling-3.2-flash:free`                    | Ling 3.2 Flash Free              | ✅      | 1M tokens   | 262K tokens | ✅         |
| `liquid/lfm-3-1.7b:free`                             | LFM 3 1.7B Free                  | ❌      | 262K tokens | 8K tokens   | ✅         |
| `particle-ai/particle-1:free`                        | Particle 1 Free                  | ✅      | 1M tokens   | 131K tokens | ✅         |
| `recursive/flint-v1.0:free`                          | Flint v1.0 Free                  | ❌      | 262K tokens | 235K tokens | ✅         |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | Nemotron 3 Nano Omni Free        | ✅      | 256K tokens | 65K tokens  | ✅         |
| `openrouter/free`                                    | OpenRouter Free (auto)           | ✅      | 200K tokens | 65K tokens  | ❌         |
| `nvidia/nemotron-3.5-lightning:free`                 | Nemotron 3.5 Lightning Free      | ❌      | 1M tokens   | 65K tokens  | ✅         |
| `nvidia/nemotron-3.5-super-vl:free`                  | Nemotron 3.5 Super VL Free       | ✅      | 1M tokens   | 131K tokens | ✅         |

**Sweep 2026-11-06**: all 8 survivors chat-verified 200. KiloCode's NVIDIA free endpoints may retain prompts or use them for training; do not send confidential data.

**Sweep 2026-11-21 (0.9.2)**: dropped `dots-studio/dots-3-note-preview:free` and `cohere/north-mini-code:free` (gone from the gateway); added six keyless chat-verified-200 entries — `reflection/beam-free`, `baidu/ernie-5.5-flash-preview:free`, `inclusionai/ling-3.2-flash:free`, `liquid/lfm-3-1.7b:free`, `particle-ai/particle-1:free`, and `recursive/flint-v1.0:free` (back from the 2026-11-06 removal, now with the `:free` suffix). The other `kilo-auto/*` routers (`balanced`, `efficient`, `frontier`, `small`) are NOT free (dynamic or metered pricing) and stay unregistered. `openrouter/free` stays pinned: catalog-absent but still callable.

Rate limiting is separated internally by upstream: OpenCode uses its UTC-day local guard and its own upstream free quota; Kilo uses a rolling-hour local guard matching its documented 200/hour/IP limit.

## Requirements

Nothing extra is required for normal usage — install in `pi` or `OMP` and pick a model. Optional egress modes have minimal prerequisites:

| Mode                              | What you need to prepare                                                                                                                                           | Needed?  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| **Default (Direct)**              | **[pi](https://pi.dev)** (Node.js) or **OMP (Oh My Pi)** (Bun). **No** API key, **no** account, **no** extra binaries.                                             | Required |
| **WARP `/64` Hop** (`/bansos warp on`) | **Nothing manual** — **no** Cloudflare account/token, **no** `warp-cli` app, **no** `sudo`/root, and **no** native IPv6 ISP needed. Linux/macOS/Windows (`x64`/`arm64`) with outbound UDP `2408` open; `wgcf` + `wireproxy` are auto-downloaded & SHA-256-verified on first use (or bring your own via `WARP_WGCF_PATH` / `WARP_WIREPROXY_PATH`). | Optional |
| **Cloud Relay** (`/bansos deploy`) | A free **Cloudflare** account + *Edit Cloudflare Workers* API token (no credit card), or a **Vercel** API token — useful on networks blocking WireGuard UDP or for KiloCode egress diversity. | Optional |
| **Custom Proxy** (`BANSOS_OPENCODE_PROXY`) | Any HTTP `CONNECT` proxy URL (`http://host:port` or `http://user:pass@host:port`).                                                                                | Optional |
| **Running tests** (maintainers)   | Node.js `>= 22.6` (`npm test`) or Bun (`bun test`), zero extra npm packages.                                                                                       | Dev only |

## Install

### pi

Requires [pi](https://pi.dev/docs/latest/quickstart).

```bash
pi install npm:pi-bansos
```

### OMP (Oh My Pi)

```bash
omp install pi-bansos
# same as: omp plugin install pi-bansos

# or link a local checkout during development:
omp plugin link /path/to/pi-bansos
```

Restart OMP after install. Then `/model` → `bansos` → pick a free model.

## Update

There is no separate “update pi-bansos” product command. You refresh the npm package with the host tool (pi or OMP), then restart so the extension reloads.

### pi

Official package docs (`pi update`):

```bash
# update only this package
pi update npm:pi-bansos
# same idea:
pi update --extension npm:pi-bansos

# or update every installed extension
pi update --extensions
```

Notes (from pi packages docs):

- Unpinned installs (`pi install npm:pi-bansos`) get the latest npm version on update.
- Pinned installs (`pi install npm:pi-bansos@0.4.13`) are **skipped** by `pi update --extensions` / `pi update --all` until you change the pin (install a newer `@x.y.z` or drop the pin).
- After update, restart pi (quit and start again) so the new extension code loads.

### OMP (Oh My Pi)

`omp plugin upgrade` only upgrades **marketplace** plugins (`name@marketplace`). npm plugins like `pi-bansos` are not that format.

Refresh npm plugins with install `--force`, or uninstall then install:

```bash
omp install pi-bansos --force
# same as: omp plugin install pi-bansos --force

# alternative
omp plugin uninstall pi-bansos
omp install pi-bansos
```

Restart OMP after. Check version: `omp plugin list` (should show `pi-bansos@…`).

### Running tests (maintainers)

The 33-test suite runs with zero extra packages under either Node.js (`>= 22.6`) or Bun (`omp`):

```bash
npm test
# or with Bun / OMP's embedded runtime:
bun test
```

## Usage

```bash
pi   # or: omp
# /model → bansos → choose a free model
```

Startup is silent and instant: the model list comes from the local catalog cache (see [Data files](#data-files)), so nothing blocks on the network. The TUI status bar shows `relay: ON`/`OFF`, `warp: ON`, or `warp+relay: ON` (or `bansos: proxy down` / `bansos: no models` when startup failed); `/bansos status` gives the full details (relay state, WARP tunnel IP & hop count, proxy address, models found at startup). Hide or show the status-bar entry with `/bansos hide` / `/bansos show`.

### Commands

Run `/bansos` any time (works identically in **pi** and **OMP**):

| Command                         | What it does                                                                              |
| ------------------------------- | ----------------------------------------------------------------------------------------- |
| `/bansos`                       | Interactive menu (toggle relay, open WARP menu, switch/deploy relay, status bar, …)       |
| `/bansos warp`                  | Interactive WARP `/64` hop menu (turn ON/OFF, hop `/64` now, install binaries, status)    |
| `/bansos warp setup`            | Download & SHA-256-verify `wgcf` + `wireproxy` into `<agentDir>/bansos-warp/bin/`         |
| `/bansos warp on`               | Start userspace WARP IPv6 tunnel & enable auto-hop on `429`/`403` (auto-runs setup once)  |
| `/bansos warp off`              | Stop WARP `wireproxy`, disable WARP routing, and opt out of reactive auto-hop              |
| `/bansos warp hop`              | Immediately rotate to a fresh Cloudflare WARP IPv6 `/64` block and mint a fresh session   |
| `/bansos warp status`           | Show WARP tunnel PID, active egress IPv6, hop count, and binary status                    |
| `/bansos on`                    | Route through the active cloud relay                                                      |
| `/bansos off`                   | Disable cloud relay                                                                       |
| `/bansos status`                | Relay state, WARP state & IP, request counts, proxy address, and models found             |
| `/bansos url <URL>`             | Set a relay URL (added to saved list)                                                     |
| `/bansos use <URL>`             | Switch to a relay and enable it (added to saved list)                                     |
| `/bansos list`                  | Show all saved relays (★ = active)                                                        |
| `/bansos remove <URL>`          | Forget a saved relay (the active one can't be removed)                                    |
| `/bansos deploy`                | **Deploy a fresh relay** (Cloudflare Workers or Vercel) and switch to it                  |
| `/bansos hide` / `/bansos show` | Hide or show the `bansos` status-bar entry (default: shown)                               |
| `/bansos refresh-models`        | Force a model-catalog re-fetch (warns when it fails; list may be stale)                   |

### Environment variables

```bash
BANSOS_PORT=18081 pi                         # custom proxy port (default 18080, bumps up to 18100)
BANSOS_DEBUG=1 pi                            # print startup, relay, WARP, and triage diagnostics on stderr
BANSOS_OPENCODE_UA=x.y.z pi                  # override OpenCode User-Agent (default: auto-track npm latest)
BANSOS_OPENCODE_PROXY=http://127.0.0.1:8080 pi # route OpenCode via a custom HTTP CONNECT proxy (JA4 preserved)
WARP_PROXY_PORT=42901 pi                     # local wireproxy port for /bansos warp (default 42901)
WARP_WGCF_PATH=/path/to/wgcf pi              # custom wgcf binary path
WARP_WIREPROXY_PATH=/path/to/wireproxy pi    # custom wireproxy binary path
BANSOS_WARP_AUTO=0 pi                        # disable reactive WARP auto-hop on 429/403
BANSOS_WARP_AUTO_SETUP=0 pi                  # never auto-download WARP binaries (manual /bansos warp setup)
BANSOS_KILO_FALLBACK=0 pi                    # disable replaying a spent OpenCode 429 on Kilo's free gateway
BANSOS_KILO_FALLBACK_MODEL=kilo-auto/free pi # Kilo router used by the fallback (default kilo-auto/free)
```

## WARP /64 hop (optional)

When your network's real IP exhausts OpenCode's daily free quota (`429 FreeUsageLimitError`) or sits on a flagged CGNAT/VPN range (`403 abusive traffic`), pi-bansos solves it locally **without needing a Cloudflare/Vercel account, API token, or `sudo`/root**. This works reactively: the first recoverable `429`/`403` triggers a `/64` hop automatically, even if you never ran `/bansos warp on` (the WARP binaries are downloaded and SHA-256-verified on demand).

```text
/bansos warp on
  WARP binaries missing — running "/bansos warp setup" first…
  Downloading wgcf_2.3.1_linux_amd64…
  Downloading wireproxy_linux_amd64.tar.gz…
  ✓ WARP ON → http://127.0.0.1:42901 | egress=2a09:bac5:… | auto-hop=/64
```

How it works (adapted from [openhop](https://openhop.cfd/source/) and 9router [#5727](https://github.com/decolua/9router/pull/5727)):

1. **Isolated to OpenCode only** — `wireproxy` runs in userspace and binds `127.0.0.1:42901`. Your browser, SSH, games, and other apps stay on your normal connection and never drop when WARP rotates.
2. **Dedicated IPv6 `/64` pinning (even on IPv4-only ISPs)** — WARP's IPv4 egress shares a small `/24` CGNAT pool, whereas IPv6 assigns a fresh `/64` block per registration. `pi-bansos` pins the inner WireGuard interface to IPv6 while carrying the outer UDP tunnel over your normal IPv4/IPv6 link, and tunnels TLS with `OPENCODE_CIPHER_LIST` so OpenCode's JA4 check passes.
3. **Automatic recovery on 429/403** — if a turn hits a `429` quota wall or `403` IP flag, `pi-bansos` automatically registers a fresh WARP `/64` (verifying `sameBlock` changed, with `wgcf-account.toml.bak` rollback if registration fails), rotates `x-opencode-session`, and retries your request transparently. Reactive hops bypass the 45 s manual-hop cooldown (`force`) and retry the turn once with a fresh session even when the hop itself cannot run.
4. **OpenCode-safe `Retry-After`** — upstream free-tier 429s carry countdowns up to ~23 h (`retry-after-ms=63008000`). OpenCode aborts with `Provider requested …ms wait, exceeds retry.maxDelayMs (300000ms)` when it sees one. The proxy now clamps every `Retry-After` it returns to **240 s**, so OpenCode keeps retrying instead of failing the turn; the real upstream hint still drives the internal cooldown.
5. **KiloCode free fallback when a `/64` is already spent** — WARP assigns shared blocks, and a fresh registration can already be exhausted by other users. After the first hop still returns `429 FreeUsageLimitError`, `pi-bansos` replays the turn on Kilo's keyless free gateway (`kilo-auto/free` by default) instead of waiting out the countdown. The reply keeps the requested model name in JSON and SSE, carries `x-bansos-fallback: kilo:kilo-auto/free`, and parks OpenCode for 5 minutes so the next turns skip the known-bad hop and go straight to Kilo before probing OpenCode again. Disable with `BANSOS_KILO_FALLBACK=0`; pick another router with `BANSOS_KILO_FALLBACK_MODEL`.
6. **Priority & graceful fallback** — when both WARP and a cloud relay are enabled, OpenCode prefers WARP first (no Vercel `max_tokens` clamp) and falls back to your relay or direct connection if WireGuard UDP is blocked on the current Wi-Fi.

## Relay (optional)

By default pi-bansos talks to the free upstreams **directly**. As an alternative (or fallback) to WARP `/64` hopping — especially on networks whose firewall blocks WireGuard UDP, or for KiloCode gateway traffic — you can route through a cloud relay worker instead of your own IP. Toggle it live from inside pi or OMP, no restart.

The relay on/off switch, WARP preference, the saved relay list, and the status-bar preference live in the state file (see [Data files](#data-files)) and are remembered across restarts — you manage them only via `/bansos`, nothing in your shell. Each `/bansos` change re-reads the file at the moment it saves, applies only that change, writes it atomically, and then switches this process to the saved state — so settings changed meanwhile by another running pi/OMP process are kept. Every relay you `deploy`, `use`, or `url` is **kept in a saved list**, so you can switch between them anytime without re-typing URLs.

**Switching between saved relays**:

```text
/bansos list
  Saved relays (2):
  ★ https://relay-2026.your-subdomain.workers.dev  [deployed relay-2026]
    https://vercel-relay-yyyy.vercel.app            [manual]

/bansos            → Switch relay… → pick one → active (live, no restart)
/bansos use https://vercel-relay-yyyy.vercel.app   # or switch directly
```

### `/bansos deploy` — one-command relay (Cloudflare or Vercel)

Deploys your own relay and activates it immediately. Pick a platform, paste an API token (used once, **never stored**), optionally name the project — the relay URL is saved and switched on when it goes live.

**Cloudflare Workers (recommended)** — free plan, no credit card, 100 K requests/day (one LLM turn = one relay request, so the daily ceiling is ~20–50× a heavy agentic day). Get a token at [dash.cloudflare.com](https://dash.cloudflare.com) → My Profile → API Tokens → *Create Token* → **Edit Cloudflare Workers** template (or a custom token with Workers Scripts **Edit** + Account Settings **Read**). A free Cloudflare account is enough.

```text
/bansos deploy
  Deploy relay to: Cloudflare Workers (recommended — free, IP diversity)
  Cloudflare API token: <paste>
  Project name (empty = auto):  relay-2026
  Resolving Cloudflare account…
  Uploading relay worker to Cloudflare…
  Reading workers.dev routing…
  ✓ Deployed & active: https://relay-2026.<your-subdomain>.workers.dev
```

The generated worker is **hardened**: it embeds a random 32-byte secret minted per deployment and answers `401` to any request without the matching `x-relay-auth` header (pi-bansos sends it automatically for relays it deployed), forwards only to the pi-bansos upstreams (`https://opencode.ai`, `https://api.kilo.ai`) with private-host and path checks, and caps request size at 32 MB. Deploy design adapted from [trefeon/pi-freeflow](https://github.com/trefeon/pi-freeflow) (MIT).

**Vercel** — needs a Vercel account and token ([vercel.com/account/tokens](https://vercel.com/account/tokens)); Hobby plans cap fast-origin bandwidth (~10 GB), after which deployments return HTTP 402, so treat it as fallback.

```text
/bansos deploy
  Deploy relay to: Vercel (needs an account; Hobby caps bandwidth)
  Vercel API token (vercel-…): <paste>
  Project name (empty = auto):  relay-2026
  Uploading relay to Vercel…
  Waiting for deployment to go live…
  ✓ Deployed & active: https://relay-2026-xxx.vercel.app
```

## Data files

pi-bansos writes its state into the **agent directory of the host that loaded it** — pi and OMP each keep their own isolated state:

| Host | Directory          |
| ---- | ------------------ |
| pi   | `~/.pi/agent/`     |
| OMP  | `~/.omp/agent/`    |

| File / Directory                | Purpose                                                                                      |
| ------------------------------- | -------------------------------------------------------------------------------------------- |
| `pi-bansos-relay-state.json`    | Relay on/off, saved relays (incl. auth secrets), WARP toggle, and status-bar preference      |
| `bansos-models.json`            | Cached upstream model catalog for instant startup, refreshed in background                   |
| `bansos-opencode-version.json`  | Cached latest `opencode-ai` dev-wire User-Agent stamp                                        |
| `bansos-warp/`                  | Optional WARP `/64` hop binaries (`bin/wgcf`, `bin/wireproxy`) and WireGuard/wireproxy state |

All state lives outside the package directory, so npm updates never wipe it. The host is detected from the extension's real install path, with a process-name fallback for symlinked installs (e.g. `omp plugin link`).

## Notes

- Free upstream models are best-effort: promos can expire, model IDs can change, and rate limits may apply
- pi-bansos health-checks against the cached/live catalog at startup so unavailable models are skipped instead of registered
- KiloCode gateway: 200 req/hr per IP, keyless
- Upstream refusals are triaged, not replayed blindly: transient `429 "overloaded"` responses are retried automatically (~20 s window); quota `429 FreeUsageLimitError` auto-hops to a fresh WARP `/64` (reactive even before `/bansos warp on`) and rotates the client's session, or cools just that model when WARP is unavailable; while that quota cooldown runs — or the 5-minute fallback park is active — eligible turns are served from the Kilo fallback BEFORE the local guards, so a recorded OpenCode cooldown never hides a Kilo that is still alive and circuit-served turns burn no OpenCode rate-limit budget; IP-flag `403 "abusive traffic"` fails fast with a switch-egress hint (`/bansos warp on` or `/bansos deploy`) when neither WARP nor a relay is active; any 2xx clears cooldowns
- Every `Retry-After` returned to OpenCode is clamped to **240 s** so a multi-hour upstream quota countdown never trips `retry.maxDelayMs`; the unclamped hint is still used internally for cooldown escalation
- OpenCode's free limits are dynamic and metered per account/workspace/network — a shared or CGNAT IP can be flagged because of *other* users, which is where `/bansos warp on` or `/bansos deploy` helps immediately
- Catalog specs (context, max output, modalities) come from the curated model lists in the extension; the cache only stores which IDs are alive

## Uninstall

### pi

```bash
pi remove npm:pi-bansos
```

### OMP

```bash
omp plugin uninstall pi-bansos
```

## License

MIT
