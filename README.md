# pi-bansos

Free model provider for pi. Uses a local proxy to bypass auth headers, allowing access to free-tier models from OpenCode Zen.

## Install

```bash
pi install npm:pi-bansos
```

## Usage

```bash
pi
# /model → bansos → pick any free model
```

## How it works

1. Starts a local proxy that strips auth headers
2. Fetches available models from upstream API
3. Detects and verifies which models are free
4. Registers them automatically via `pi.registerProvider()`
5. Free models update on each pi restart — expired promos are removed

## Uninstall

```bash
pi remove pi-bansos
```

## License

MIT
