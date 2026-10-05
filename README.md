# pi-bansos

[![npm version](https://img.shields.io/npm/v/pi-bansos.svg?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/pi-bansos)
[![npm downloads](https://img.shields.io/npm/d18m/pi-bansos.svg?style=flat-square&logo=npm&logoColor=white&label=downloads)](https://www.npmjs.com/package/pi-bansos)
[![npm downloads/month](https://img.shields.io/npm/dm/pi-bansos.svg?style=flat-square&logo=npm&logoColor=white&label=downloads)](https://www.npmjs.com/package/pi-bansos)

Free model provider for **[pi](https://pi.dev)** ([browse packages](https://pi.dev/packages)). It adds a `bansos` provider with live free models from **2 upstreams** — OpenCode Zen and KiloCode gateway — through a local OpenAI-compatible proxy.

## Contents

- [Features](#features)
- [Models](#models)
- [Install](#install)
- [Update](#update)
- [Usage](#usage)
- [Relay (optional)](#relay-optional)
- [Data files](#data-files)
- [Notes](#notes)
- [Uninstall](#uninstall)
- [License](#license)

## Features

- **Zero cost** — all models free, no API key needed for supported upstreams
- **29 models from 2 sources** — 12 OpenCode Zen + 17 KiloCode gateway
- **Instant startup** — the model catalog is cached locally and registered without waiting on upstream; it refreshes in the background
- **Auto health-check** — only catalog-listed models registered; dead ones skipped silently
- **Local-only proxy** — binds to `127.0.0.1`, nothing exposed externally; one proxy per loaded extension, shared by every session that uses it (including OMP's in-process subagents)
- **Optional relay egress with automatic failover** — route through a Vercel relay to dodge per-IP rate limits; a 429/unreachable relay cools down (escalating backoff) and the request rolls to the next healthy relay or goes direct — toggled live via `/bansos`
- **Auto port bump** — if port 18080 is taken, automatically tries the next one (up to 18100)

## Models

**29 total: 12 OpenCode + 17 KiloCode.** All models are free. The provider is one `bansos` entry, but model names show their upstream: **OpenCode** or **KiloCode**. The startup check only verifies catalog membership; upstream access can still change between startup and a request.

### OpenCode Zen (12 models)

| Model ID                          | Name                        | Vision | API       | Context     | Max Output  | Reasoning |
| --------------------------------- | --------------------------- | ------ | --------- | ----------- | ----------- | --------- |
| `muse-spark-1.3-contributor-free` | Muse Spark 1.3 Free         | ✅      | responses | 1M tokens   | 131K tokens | ✅         |
| `muse-spark-1.2-contributor-free` | Muse Spark 1.2 Free         | ✅      | responses | 1M tokens   | 131K tokens | ✅         |
| `mimo-v2.5-free`                  | MiMo V2.5 Free              | ✅      | chat      | 200K tokens | 32K tokens  | ✅         |
| `mimo-v2.6-flash-free`            | MiMo V2.6 Flash Free        | ✅      | chat      | 200K tokens | 32K tokens  | ✅         |
| `space-bunny-free`                | Space Bunny                 | ✅      | chat      | 1M tokens   | 524K tokens | ✅         |
| `ling-3.1-flash-free`             | Ling 3.1 Flash Free         | ❌      | chat      | 262K tokens | 32K tokens  | ✅         |
| `fledge-alpha-free`               | Fledge Alpha                | ❌      | chat      | 200K tokens | 65K tokens  | ✅         |
| `longcat-2.5-preview-free`        | LongCat 2.5 Preview         | ❌      | chat      | 1M tokens   | 131K tokens | ✅         |
| `ling-3.0-flash-fin-free`         | Ling 3.0 Flash Fin Free     | ❌      | chat      | 262K tokens | 32K tokens  | ✅         |
| `nemotron-3-ultra-free`           | Nemotron 3 Ultra Free       | ❌      | chat      | 1M tokens   | 128K tokens | ✅         |
| `nemotron-3.5-lightning-free`     | Nemotron 3.5 Lightning Free | ❌      | chat      | 262K tokens | 262K tokens | ✅         |
| `big-pickle`                      | Big Pickle                  | ❌      | chat      | 200K tokens | 32K tokens  | ✅         |

**Muse note:** Muse uses OpenAI Responses (`/v1/responses`), while the other OpenCode models use Chat Completions (`/v1/chat/completions`). pi-bansos selects the API per model and suppresses Muse's unsupported `reasoning.effort: "none"` value when reasoning is off.

Manual check: select `OpenCode · Muse Spark 1.3 Free` in `/model`, then ask it to `Reply with exactly OK.`

### KiloCode Gateway (17 models)

Keyless — 200 requests/hour per IP. No `Authorization` header is sent; the free gateway rejects placeholder tokens.

| Model ID                                             | Name                             | Vision | Context     | Max Output  | Reasoning |
| ---------------------------------------------------- | -------------------------------- | ------ | ----------- | ----------- | --------- |
| `kilo-auto/free`                                     | Kilo Auto Free                   | ❌      | 256K tokens | 10K tokens  | ❌         |
| `stepfun/step-3.7-flash:free`                        | Step 3.7 Flash Free              | ✅      | 262K tokens | 262K tokens | ✅         |
| `nvidia/nemotron-3-ultra-550b-a55b:free`             | Nemotron 3 Ultra Free            | ❌      | 1M tokens   | 65K tokens  | ✅         |
| `nvidia/nemotron-3-super-120b-a12b:free`             | Nemotron 3 Super Free            | ❌      | 262K tokens | 236K tokens | ✅         |
| `dots-studio/dots-3-note-preview:free`               | Dots3-Note Preview Free          | ✅      | 512K tokens | 460K tokens | ✅         |
| `cohere/north-mini-code:free`                        | North Mini Code Free             | ❌      | 256K tokens | 64K tokens  | ❌         |
| `poolside/laguna-xs-2.1:free`                        | Laguna XS 2.1 Free               | ❌      | 262K tokens | 32K tokens  | ✅         |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | Nemotron 3 Nano Omni Free        | ✅      | 256K tokens | 65K tokens  | ✅         |
| `openrouter/free`                                    | OpenRouter Free (auto)           | ✅      | 200K tokens | 65K tokens  | ❌         |
| `nvidia/nemotron-3.5-lightning:free`                 | Nemotron 3.5 Lightning Free      | ❌      | 1M tokens   | 65K tokens  | ✅         |
| `nvidia/nemotron-3.5-content-safety:free`            | Nemotron 3.5 Content Safety Free | ✅      | 128K tokens | 8K tokens   | ✅         |
| `inclusionai/ling-3.0-flash-sante:free`              | Ling 3.0 Flash Sante Free        | ❌      | 262K tokens | 32K tokens  | ✅         |
| `liquid/lfm-2.5-2.6b:free`                           | Liquid LFM 2.5 2.6B Free         | ❌      | 65K tokens  | 8K tokens   | ✅         |
| `poolside/laguna-s-2.1:free`                         | Laguna S 2.1 Free                | ❌      | 262K tokens | 32K tokens  | ✅         |
| `thinkingmachines/inkling-small:free`                | Inkling Small Free               | ✅      | 1M tokens   | 262K tokens | ✅         |
| `qwen/qwen3.8-27b:free`                              | Qwen3.8 27B Free                 | ✅      | 262K tokens | 236K tokens | ✅         |
| `apodex/apodex-1.1-mini:free`                        | Apodex 1.1 Mini Free             | ❌      | 262K tokens | 236K tokens | ✅         |

`openrouter/free` is **pinned**: it no longer appears in the `/models` catalog, but chat completions still serve it — so it stays registered.

Rate limiting is separated internally by upstream: OpenCode uses its UTC-day local guard and its own upstream free quota; Kilo uses a rolling-hour local guard matching its documented 200/hour/IP limit.

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

## Usage

```bash
pi   # or: omp
# /model → bansos → choose a free model
```

Startup is silent and instant: the model list comes from the local catalog cache (see [Data files](#data-files)), so nothing blocks on the network. The TUI status bar shows `relay: ON`/`OFF`, or `bansos: proxy down` / `bansos: no models` when startup failed; `/bansos status` gives the details (proxy address or bind error, models found at startup). Hide or show the status-bar entry with `/bansos hide` / `/bansos show`.

### Commands

Run `/bansos` any time:

| Command                       | What it does                                                                 |
| ----------------------------- | ---------------------------------------------------------------------------- |
| `/bansos`                     | Interactive menu (switch/remove relay, hide/show status bar, …)              |
| `/bansos on`                  | Route through the relay                                                      |
| `/bansos off`                 | Go direct (default)                                                          |
| `/bansos status`              | Relay state, request count, saved-relay count, proxy address, models found   |
| `/bansos url <URL>`           | Use a different relay (added to saved list)                                  |
| `/bansos use <URL>`           | Switch to a relay and enable it (added to saved list)                        |
| `/bansos list`                | Show all saved relays (★ = active)                                           |
| `/bansos remove <URL>`        | Forget a saved relay (the active one can't be removed)                       |
| `/bansos deploy`              | **Deploy a fresh Vercel relay** and switch to it                             |
| `/bansos hide` / `/bansos show` | Hide or show the `bansos` status-bar entry (default: shown)                |
| `/bansos refresh-models`      | Force a model-catalog re-fetch (warns when it fails; list may be stale)      |

### Environment variables

```bash
BANSOS_PORT=18081 pi   # custom proxy port (default 18080, bumps up to 18100)
BANSOS_DEBUG=1 pi      # print startup, relay and rate-limit diagnostics on stderr
BANSOS_OPENCODE_UA=x.y.z pi  # pin the opencode User-Agent version (default: auto-track npm latest, fallback 1.18.31)
```

## Relay (optional)

By default pi-bansos talks to the free upstreams **directly**. If your IP gets rate-limited or blocked, switch on a relay — requests then go out through a relay worker instead of your own IP. Toggle it live from inside pi, no restart.

The relay on/off switch, the saved relay list, and the status-bar preference live in the state file (see [Data files](#data-files)) and are remembered across restarts — you manage them only via `/bansos`, nothing in your shell. Each `/bansos` change re-reads the file at the moment it saves, applies only that change, writes it atomically, and then switches this process to the saved state — so settings changed meanwhile by another running pi/OMP process are kept, and that process's relay switch also takes effect here. Commands that only show state (`status`, `list`) don't re-read; other running processes pick up changes at their next session start or their next `/bansos` change. If saving fails, the change is not applied and the error is shown. Every relay you `deploy`, `use`, or `url` is **kept in a saved list**, so you can switch between them anytime without re-typing URLs. Any HTTP relay works (Vercel, Cloudflare, Deno, or your own). There is **no built-in default** — run `/bansos deploy` to create one or `/bansos url <URL>` to use your own.

**Switching between saved relays** (e.g. you deployed one and also have another):

```text
/bansos list
  Saved relays (2):
  ★ https://pi-bansos-relay-xxxx.vercel.app   [deployed relay-2026]
    https://vercel-relay-yyyy.vercel.app       [manual]

/bansos            → Switch relay… → pick one → active (live, no restart)
/bansos use https://vercel-relay-yyyy.vercel.app   # or switch directly
```

### `/bansos deploy` — one-command Vercel relay

Deploys your own Node.js relay to Vercel and activates it immediately. It asks for a **Vercel API token** (get one at [https://vercel.com/account/tokens](https://vercel.com/account/tokens)) and an optional project name, then uploads a tiny worker and waits for it to go live (~10–40 s). The new relay URL is saved and switched on; the token is used once and **never stored**.

```text
/bansos deploy
  Vercel API token (vercel-…): <paste>
  Project name (empty = auto):  relay-2026
  Uploading relay to Vercel…
  Waiting for deployment to go live…
  ✓ Deployed & active: https://relay-2026-xxx.vercel.app
```

> The Vercel relay masks your IP behind Vercel's dynamic edge IPs. Free tier: 100 GB bandwidth + 500 K invocations/month. Deploy on multiple accounts for more IP diversity. The token input has no hidden/secret mode in the TUI, so it shows while typing — paste, deploy, done.

> A relay is a single fixed exit IP, not rotation. Useful when your IP is limited; otherwise it just adds a small hop.

## Data files

pi-bansos writes two files into the **agent directory of the host that loaded it** — pi and OMP each keep their own state:

| Host | Directory          |
| ---- | ------------------ |
| pi   | `~/.pi/agent/`     |
| OMP  | `~/.omp/agent/`    |

| File                        | Purpose                                                                        |
| --------------------------- | ------------------------------------------------------------------------------ |
| `pi-bansos-relay-state.json` | Relay on/off, saved relays, active relay, status-bar preference               |
| `bansos-models.json`        | Cached upstream model catalog for instant startup, refreshed in background     |

Both live outside the package directory, so npm updates never wipe them. The host is detected from the extension's real install path, with a process-name fallback for symlinked installs (e.g. an OMP npm plugin symlinked into a repo checkout). If you use pi and OMP side by side, each has its own relay settings and catalog cache — deleting one leaves the other untouched.

## Notes

- Free upstream models are best-effort: promos can expire, model IDs can change, and rate limits may apply
- pi-bansos health-checks against the cached/live catalog at startup so unavailable models are skipped instead of registered
- KiloCode gateway: 200 req/hr per IP, keyless
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
