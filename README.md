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
- **25 models from 2 sources** — 11 OpenCode Zen + 14 KiloCode gateway
- **Instant startup** — the model catalog is cached locally and registered without waiting on upstream; it refreshes in the background
- **Auto health-check** — only catalog-listed models registered; dead ones skipped silently
- **Local-only proxy** — binds to `127.0.0.1`, nothing exposed externally; one proxy per loaded extension, shared by every session that uses it (including OMP's in-process subagents)
- **Optional relay egress with automatic failover** — route through a **Cloudflare Workers** (one command, free, no card) or Vercel relay to dodge per-IP rate limits; a 429/403/unreachable relay cools down (escalating backoff) and the request rolls to the next healthy relay or goes direct — toggled live via `/bansos`
- **OpenCode free-tier fingerprint kept current** — auto-tracks the live `opencode-ai` UA version, generates spec-correct session/request IDs (verified against opencode's own `Identifier`), and ships the tool-pair payload the 1.19.0 gate expects
- **Auto port bump** — if port 18080 is taken, automatically tries the next one (up to 18100)

## Models

**25 curated total: 11 OpenCode + 14 KiloCode.** All models are free. The provider is one `bansos` entry, but model names show their upstream: **OpenCode** or **KiloCode**. The startup check only verifies catalog membership; upstream access can still change between startup and a request.

### OpenCode Zen (11 models)

| Model ID                      | Name                        | Vision | API  | Context     | Max Output  | Reasoning |
| ----------------------------- | --------------------------- | ------ | ---- | ----------- | ----------- | --------- |
| `beam-free`                   | Beam Free                   | ❌     | chat | 262K tokens | 65K tokens  | ✅        |
| `minimax-m3.1-flash-free`     | MiniMax M3.1 Flash Free     | ✅     | chat | 1M tokens   | 524K tokens | ✅        |
| `mimo-v2.6-flash-free`        | MiMo V2.6 Flash Free        | ✅     | chat | 200K tokens | 32K tokens  | ✅        |
| `nemotron-3-ultra-free`       | Nemotron 3 Ultra Free       | ❌     | chat | 1M tokens   | 128K tokens | ✅        |
| `nemotron-3.5-lightning-free` | Nemotron 3.5 Lightning Free | ❌     | chat | 262K tokens | 262K tokens | ✅        |
| `big-pickle`                  | Big Pickle                  | ❌     | chat | 200K tokens | 32K tokens  | ✅        |
| `longcat-2.5-preview-free`    | LongCat 2.5 Preview         | ❌     | chat | 1M tokens   | 131K tokens | ✅        |
| `deepseek-v4.1-flash-free`    | DeepSeek V4.1 Flash Free    | ✅     | chat | 200K tokens | 32K tokens  | ✅        |
| `glm-5.3-flash-free`          | GLM 5.3 Flash Free          | ✅     | chat | 200K tokens | 32K tokens  | ✅        |
| `cat-jam-free`                | Cat Jam Free                | ❌     | chat | 1M tokens   | 131K tokens | ✅        |
| `nemotron-3.5-super-vl-free`  | Nemotron 3.5 Super VL Free  | ✅     | chat | 1M tokens   | 131K tokens | ✅        |


**Sweep 2026-10-20** (live probe, full fingerprint, of every registered id): upstream **deprecated** muse-spark-1.3/1.2, space-bunny and ll-alpha (`410` — space-bunny's deprecation notice itself names `minimax-m3.1-flash-free` as the replacement, registered here), and **removed** step-5-preview + ling-3.0/3.1 (`400` upstream-unavailable). `beam-free` and `minimax-m3.1-flash-free` are catalog-listed but **not yet chat-verified**: our probe IP currently hits OpenCode's new IP-level block (403 *"we've detected abusive traffic from this IP address"* — a different gate from `FreeTierError`), so their first verified chat needs a relay egress ([`/bansos deploy`](#bansos-deploy--one-command-relay)). The fingerprint itself passes the gate — the `410`/`400` verdicts above prove the requests reached the model layer.

**Muse note:** the muse-class models are 410-deprecated for now, but their Responses-API routing (`/v1/responses`) stays in place — if a muse-class id returns to the catalog it re-routes automatically, no code change needed.

### KiloCode Gateway (14 models)

Keyless — 200 requests/hour per IP. No `Authorization` header is sent; the free gateway rejects placeholder tokens.

| Model ID                                             | Name                             | Vision | Context     | Max Output  | Reasoning |
| ---------------------------------------------------- | -------------------------------- | ------ | ----------- | ----------- | --------- |
| `kilo-auto/free`                                     | Kilo Auto Free                   | ❌      | 256K tokens | 10K tokens  | ❌         |
| `minimax/minimax-m3.1-flash:free`                    | MiniMax M3.1 Flash Free          | ✅      | 1M tokens   | 524K tokens | ✅         |
| `xingchen-agi/xing4.0-29b-a4b:free`                  | Xing 4.0 29B A4B Free            | ❌      | 262K tokens | 236K tokens | ✅         |
| `nvidia/nemotron-3-ultra-550b-a55b:free`             | Nemotron 3 Ultra Free            | ❌      | 1M tokens   | 65K tokens  | ✅         |
| `nvidia/nemotron-3-super-120b-a12b:free`             | Nemotron 3 Super Free            | ❌      | 262K tokens | 236K tokens | ✅         |
| `dots-studio/dots-3-note-preview:free`               | Dots3-Note Preview Free          | ✅      | 512K tokens | 460K tokens | ✅         |
| `cohere/north-mini-code:free`                        | North Mini Code Free             | ❌      | 256K tokens | 64K tokens  | ❌         |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | Nemotron 3 Nano Omni Free        | ✅      | 256K tokens | 65K tokens  | ✅         |
| `openrouter/free`                                    | OpenRouter Free (auto)           | ✅      | 200K tokens | 65K tokens  | ❌         |
| `nvidia/nemotron-3.5-lightning:free`                 | Nemotron 3.5 Lightning Free      | ❌      | 1M tokens   | 65K tokens  | ✅         |
| `nvidia/nemotron-3.5-content-safety:free`            | Nemotron 3.5 Content Safety Free | ✅      | 128K tokens | 8K tokens   | ✅         |
| `poolside/laguna-s-2.1:free`                         | Laguna S 2.1 Free                | ❌      | 262K tokens | 32K tokens  | ✅         |
| `thinkingmachines/inkling-small:free`                | Inkling Small Free               | ✅      | 1M tokens   | 262K tokens | ✅         |
| `nvidia/nemotron-3.5-super-vl:free`                  | Nemotron 3.5 Super VL Free       | ✅      | 1M tokens   | 131K tokens | ✅         |

**Sweep 2026-10-20**: added `minimax/minimax-m3.1-flash:free` (chat 200) and `xingchen-agi/xing4.0-29b-a4b:free` (chat 200 — its Phala shared pool occasionally 429s under load; retry). Removed `stealth/glyph-cluster` and `stealth/cat-jam` (the stealth lane now answers `401 You need to sign in to use this model`), `poolside/laguna-xs-2.1:free` (consistent 429 shared-pool) and `liquid/lfm-2.5-2.6b:free` (consistent upstream 504). `thinkingmachines/inkling-small:free` stays: healthy apart from its own provider-side daily cap. Kilo's NVIDIA free endpoints may retain prompts or use them for training; do not send confidential data.


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

### Free model catalog update (0.6.4)

Adds eight chat-verified models: OpenCode DeepSeek V4.1 Flash, GLM 5.3 Flash,
Cat Jam, LL Alpha, and Nemotron 3.5 Super VL; KiloCode Nemotron 3.5 Super VL,
Glyph Cluster, and Cat Jam. The curated list now has 32 models; the picker only
shows those present in the upstream catalog (plus the existing pinned model).
Muse keeps its Responses API configuration unchanged.

Update the package, then restart pi or OMP. `/bansos refresh-models` refreshes
catalog membership only; it cannot add definitions missing from an older package.

### Streaming fix (0.6.3)

If 0.6.1 reports `malformed server-sent event JSON` with default tools enabled,
update to **0.6.3** (or later) and restart pi. Tool-alias rewriting now preserves
SSE line endings and empty event separators, and decodes split UTF-8 characters
incrementally. This does not resolve upstream model outages or rate limits
([issue #12](https://github.com/mannnrachman/pi-bansos/issues/12)).

`0.6.2` is the same fix in git history, but that version never became installable
on npm (registry staging lock). Install `pi-bansos@0.6.3`.

Maintainers can run the chunk-boundary regression suite with
`bun test tests/stream-framing.test.ts` (requires Bun; no extra dependencies).

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
| `/bansos deploy`              | **Deploy a fresh relay** (Cloudflare Workers or Vercel) and switch to it      |
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

> Both relays mask your IP behind the platform's edge IPs. Useful when your IP is rate-limited or flagged (OpenCode's newer 403 *"abusive traffic from this IP"* block is IP-level and passes with a different egress). If a relay's own egress gets flagged, pi-bansos cools it down (90 s, escalating) and rolls to the next healthy relay or goes direct. A relay is one fixed exit, not rotation — for more egress diversity deploy several and keep them in the saved list. The token input has no hidden/secret mode in the TUI, so it shows while typing — paste, deploy, done.

## Data files

pi-bansos writes two files into the **agent directory of the host that loaded it** — pi and OMP each keep their own state:

| Host | Directory          |
| ---- | ------------------ |
| pi   | `~/.pi/agent/`     |
| OMP  | `~/.omp/agent/`    |

| File                        | Purpose                                                                        |
| --------------------------- | ------------------------------------------------------------------------------ |
| `pi-bansos-relay-state.json` | Relay on/off, saved relays (incl. per-relay auth secrets), active relay, status-bar preference |
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
