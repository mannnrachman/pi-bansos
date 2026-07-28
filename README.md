# pi-bansos

Free model provider for [**pi**](https://pi.dev) ([browse packages](https://pi.dev/packages)). It adds a `bansos` provider with live free models from OpenCode Zen, Xiaomi MiMo Free, and the KiloCode gateway through a local OpenAI-compatible proxy.

## Why

- No user API key required for supported free upstreams
- Auto-checks model availability on every pi startup
- Registers only models that are currently alive
- Supports OpenCode free models, `mimo-auto`, and KiloCode gateway free models (keyless, 200 req/hr per IP)
- Local-only proxy binds to `127.0.0.1`
- Optional **relay egress** — route upstream calls through a Vercel/Cloudflare relay to dodge per-IP rate limits, toggled live via `/bansos`

## Education & responsible use

`pi-bansos` is made for learning how pi extensions, local proxies, OpenAI-compatible providers, and free-model routing work. Use it responsibly: respect upstream terms, avoid abuse or traffic flooding, and expect free access to change or stop anytime.

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

**Switching between saved relays** (e.g. you deployed one and also have the default):

```text
/bansos list
  Saved relays (2):
  ★ https://pi-bansos-relay-xxxx.vercel.app   [deployed relay-2026]
    https://vercel-relay-yyyy.vercel.app       [9Router default]

/bansos            → Switch relay… → pick one → active (live, no restart)
/bansos use https://vercel-relay-yyyy.vercel.app   # or switch directly
```

### `/bansos deploy` — one-command Vercel relay

Deploys your own edge relay to Vercel (same flow 9Router uses) and activates it immediately. It asks for a **Vercel API token** (get one at https://vercel.com/account/tokens) and an optional project name, then uploads a tiny edge function and waits for it to go live (~10–40 s). The new relay URL is saved and switched on; the token is used once and **never stored**.

```text
/bansos deploy
  Vercel API token (vercel-…): <paste>
  Project name (empty = auto):  relay-2026
  Uploading relay to Vercel…
  Waiting for deployment to go live…
  ✓ Deployed & active: https://relay-2026-xxx.vercel.app
```

> The Vercel edge relay masks your IP behind Vercel's dynamic edge IPs (hundreds across 20+ regions). Free tier: 100 GB bandwidth + 500 K invocations/month. Deploy on multiple accounts for more IP diversity. The token input has no hidden/secret mode in the TUI, so it shows while typing — paste, deploy, done.

> A relay is a single fixed exit IP, not rotation. Useful when your IP is limited; otherwise it just adds a small hop.

## Notes

Free upstream models are best-effort: promos can expire, model IDs can change, and rate limits may apply. `pi-bansos` health-checks them at startup so unavailable models are skipped instead of registered.

## Uninstall

```bash
pi remove npm:pi-bansos
```

## License

MIT
