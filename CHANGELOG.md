# Changelog

## [0.4.3] - 2026-08-04

### Fixed
- **Proxy crash on upstream disconnect** — `proxy.on("error")` now guards `headersSent` before writing 502 response. Previously, upstream dropping connection mid-stream (rate limit, ECONNRESET, timeout) caused `ERR_HTTP_HEADERS_SENT` and terminated the entire Pi process (#1, thanks @totnormal)
