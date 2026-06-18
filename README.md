# pi-bansos

Free model provider for **pi**. It adds a `bansos` provider with live free models from OpenCode Zen and Xiaomi MiMo Free through a local OpenAI-compatible proxy.

## Why

- No user API key required for supported free upstreams
- Auto-checks model availability on every pi startup
- Registers only models that are currently alive
- Supports OpenCode free models and `mimo-auto`
- Local-only proxy binds to `127.0.0.1`

## Education & responsible use

`pi-bansos` is made for learning how pi extensions, local proxies, OpenAI-compatible providers, and free-model routing work. Use it responsibly: respect upstream terms, avoid abuse or traffic flooding, and expect free access to change or stop anytime.

## Install

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

## Notes

Free upstream models are best-effort: promos can expire, model IDs can change, and rate limits may apply. `pi-bansos` health-checks them at startup so unavailable models are skipped instead of registered.

## Uninstall

```bash
pi remove pi-bansos
```

## License

MIT
