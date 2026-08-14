# pi-bansos

Free model provider for [**pi**](https://pi.dev) ([browse packages](https://pi.dev/packages)). It adds a `bansos` provider with live free models from **2 upstreams** — OpenCode Zen and KiloCode gateway — through a local OpenAI-compatible proxy.

## Models (20 total)

All models are **free, no API key required**. pi-bansos health-checks every model at startup and only registers the ones that are currently alive.

### OpenCode Zen (7 models)

| Model ID | Name | Context | Max Output | Reasoning |
|----------|------|---------|------------|-----------|
| `deepseek-v4-flash-free` | DeepSeek V4 Flash | 1M tokens | 384K tokens | ✅ |
| `mimo-v2.5-free` | Mimo V2.5 Free | 1M tokens | 131K tokens | ❌ |
| `nemotron-3-ultra-free` | Nemotron 3 Ultra | 1M tokens | 65K tokens | ✅ |
| `north-mini-code-free` | North Mini Code | 256K tokens | 64K tokens | ✅ |
| `big-pickle` | Big Pickle | 200K tokens | 32K tokens | ✅ |
| `ling-3.0-flash-free` | Ling 3.0 Flash | 262K tokens | 32K tokens | ✅ |
| `laguna-s-2.1-free` | Laguna S 2.1 | 262K tokens | 32K tokens | ✅ |

### KiloCode Gateway (13 models)

Keyless — no API key needed. 200 requests/hour per IP.

| Model ID | Name | Context | Max Output | Reasoning |
|----------|------|---------|------------|-----------|
| `kilo-auto/free` | Kilo Auto Free | 256K tokens | 10K tokens | ❌ |
| `stepfun/step-3.7-flash:free` | Step 3.7 Flash Free | 262K tokens | 262K tokens | ❌ |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | Nemotron 3 Ultra Free | 1M tokens | 65K tokens | ✅ |
| `nvidia/nemotron-3-super-120b-a12b:free` | Nemotron 3 Super Free | 262K tokens | 262K tokens | ✅ ⚠️ |
| `nvidia/nemotron-3.5-lightning:free` | Nemotron 3.5 Lightning Free | 1M tokens | 65K tokens | ✅ |
| `nvidia/nemotron-3.5-content-safety:free` | Nemotron 3.5 Content Safety Free | 128K tokens | 8K tokens | ✅ |
| `tencent/hy3:free` | Tencent Hy3 Free | 262K tokens | 128K tokens | ✅ |
| `liquid/lfm-2.5-2.6b:free` | Liquid LFM 2.5 2.6B Free | 128K tokens | 8K tokens | ❌ |
| `poolside/laguna-s-2.1:free` | Laguna S 2.1 Free | 262K tokens | 32K tokens | ✅ |
| `cohere/north-mini-code:free` | North Mini Code Free | 256K tokens | 64K tokens | ❌ |
| `poolside/laguna-xs-2.1:free` | Laguna XS 2.1 Free | 262K tokens | 32K tokens | ❌ |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | Nemotron 3 Nano Omni Free | 256K tokens | 65K tokens | ✅ |
| `openrouter/free` | OpenRouter Free (auto) | 200K tokens | 65K tokens | ❌ |

> ⚠️ **Nemotron 3 Super Free** — known issue: emits output in `reasoning` field instead of `content`. May render blank in some clients until upstream fixes this.

## Why pi-bansos

- **Zero cost** — all models free, no API key needed for supported upstreams
- **Auto health-check** — only alive models registered at startup; dead ones skipped silently
- **20 models from 2 sources** — OpenCode Zen + KiloCode gateway
- **Local-only proxy** — binds to `127.0.0.1`, nothing exposed externally
- **Optional relay egress** — route through a Vercel/Cloudflare relay to dodge per-IP rate limits, toggled live via `/bansos`
- **Auto port bump** — if port 18080 is taken, automatically tries the next one (up to 18100)

## Install

Requires [pi](https://pi.dev/docs/latest/quickstart).

```bash
pi install npm:pi-bansos
```

## Usage

```bash
pi
# /model → bansos → choose a free model
```

Run `/bansos` any time to toggle relay egress or switch between saved relays (see [Relay](#relay-optional)).

Optional custom port:

```bash
BANSOS_PORT=18081 pi
```

## Relay (optional)

By default pi-bansos talks to the free upstreams **directly**. If your IP gets rate-limited or blocked, switch on a relay — requests then go out through a relay worker instead of your own IP. Toggle it live from inside pi, no restart:

| Command | What it does |
| --- | --- |
| `/bansos on` | Route through the relay |
| `/bansos off` | Go direct (default) |
| `/bansos status` | Show current state, request count, and saved-relay count |
| `/bansos url <URL>` | Use a different relay (added to saved list) |
| `/bansos use <URL>` | Switch to a relay and enable it (added to saved list) |
| `/bansos list` | Show all saved relays (★ = active) |
| `/bansos remove <URL>` | Forget a saved relay (the active one can't be removed) |
| `/bansos deploy` | **Deploy a fresh Vercel relay** and switch to it |
| `/bansos` | Interactive menu (incl. **Switch** / **Remove relay…**) |

The state is saved at the package root (`.relay-state.json`, next to the `extensions/` folder) and remembered across restarts — you manage it only via `/bansos`, nothing in your shell. Every relay you `deploy`, `use`, or `url` is **kept in a saved list**, so you can switch between them anytime without re-typing URLs. Any HTTP relay works (Vercel, Cloudflare, Deno, or your own). There is **no built-in default** — run `/bansos deploy` to create one or `/bansos url <URL>` to use your own.

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

Deploys your own Node.js relay to Vercel and activates it immediately. It asks for a **Vercel API token** (get one at https://vercel.com/account/tokens) and an optional project name, then uploads a tiny worker and waits for it to go live (~10–40 s). The new relay URL is saved and switched on; the token is used once and **never stored**.

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

## Notes

- Free upstream models are best-effort: promos can expire, model IDs can change, and rate limits may apply
- pi-bansos health-checks at startup so unavailable models are skipped instead of registered
- KiloCode gateway: 200 req/hr per IP, keyless

## Uninstall

```bash
pi remove npm:pi-bansos
```

## License

MIT
