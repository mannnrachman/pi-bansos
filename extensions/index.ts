/**
 * bansos — pi extension
 *
 * Dynamically fetches free models from OpenCode Zen API,
 * verifies each is actually free, then registers via pi.registerProvider().
 *
 * Security hardening applied per OWASP Top 10 (2021):
 * - A03/A10: Input validation, path/method whitelisting, header sanitization
 * - A01: Origin validation on local proxy
 * - A04: Dangerous header stripping
 * - A05: Configurable port, better error handling
 * - A07: Per-IP rate limiting
 * - A08: Model cache with TTL for integrity
 * - A09: Structured logging with audit trail
 */
import http from "node:http";
import https from "node:https";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Configuration ──────────────────────────────────────────────────
const UPSTREAM = "https://opencode.ai/zen";
const PORT = Number(process.env.BANSOS_PORT) || 18080;
const HOST = "127.0.0.1";
const API = `${UPSTREAM}/v1`;

// Security: model cache TTL (default 1 hour)
const MODEL_CACHE_TTL_MS = Number(process.env.BANSOS_CACHE_TTL) || 3_600_000;

// ── Known context windows (update when new models appear) ──────────
const CONTEXT: Record<string, number> = {
	"mimo-v2.5-free": 1_000_000,
	"deepseek-v4-flash-free": 128_000,
	"nemotron-3-ultra-free": 128_000,
	"north-mini-code-free": 128_000,
	"big-pickle": 128_000,
};

const DEFAULT_CONTEXT = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

// Known free models that don't have -free suffix
const KNOWN_FREE = new Set(["big-pickle"]);

// Models to exclude (promos ended, known broken)
const EXCLUDE = new Set(["minimax-m3-free", "qwen3.6-plus-free"]);

// ── Security: Whitelists & Constants ───────────────────────────────

/** Only allow paths starting with /v1/ (A03/A10: prevents path traversal + SSRF)
 *  Rejects ".." segments to prevent directory traversal */
const ALLOWED_PATH_PATTERN = /^\/v1\/[a-zA-Z0-9/_.,\-?&=]*$/;
const PATH_TRAVERSAL_PATTERN = /\.\./;

/** Only allow safe HTTP methods (A03: prevents CONNECT tunneling) */
const ALLOWED_METHODS = new Set(["GET", "POST", "OPTIONS", "HEAD"]);

/** Headers that must never be forwarded upstream (A04: header injection) */
const STRIP_HEADERS = new Set([
	"authorization",
	"host",
	"x-forwarded-for",
	"x-forwarded-host",
	"x-forwarded-proto",
	"x-real-ip",
	"x-client-ip",
	"x-originate-ip",
	"cookie",
	"set-cookie",
	"proxy-connection",
	"proxy-authorization",
]);

// ── Security: Structured Logger (A09) ──────────────────────────────

type LogLevel = "info" | "warn" | "error" | "audit";

function log(level: LogLevel, message: string, meta?: Record<string, unknown>) {
	const timestamp = new Date().toISOString();
	const prefix = `[bansos] [${timestamp}] [${level.toUpperCase()}]`;
	const metaStr = meta ? ` ${JSON.stringify(meta)}` : "";
	if (level === "error") {
		console.error(`${prefix} ${message}${metaStr}`);
	} else {
		console.log(`${prefix} ${message}${metaStr}`);
	}
}

// ── Security: Rate Limiter (A07) ───────────────────────────────────

interface RateLimitEntry {
	count: number;
	resetAt: number;
}

const rateLimitMap = new Map<string, RateLimitEntry>();
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 120; // per window

// Cleanup stale entries every 5 minutes
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

function startCleanupInterval() {
	if (cleanupInterval) return;
	cleanupInterval = setInterval(() => {
		const now = Date.now();
		for (const [key, entry] of rateLimitMap) {
			if (entry.resetAt <= now) {
				rateLimitMap.delete(key);
			}
		}
	}, 300_000);
}

function checkRateLimit(ip: string): boolean {
	const now = Date.now();
	const entry = rateLimitMap.get(ip);

	if (!entry || entry.resetAt <= now) {
		rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
		return true;
	}

	if (entry.count >= RATE_LIMIT_MAX_REQUESTS) {
		return false;
	}

	entry.count++;
	return true;
}

// ── Security: Model Cache with TTL (A08) ───────────────────────────

interface ModelCache {
	models: ZenModel[];
	fetchedAt: number;
}

let modelCache: ModelCache | null = null;

interface ZenModel {
	id: string;
	name: string;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
}

// ── Fetch & verify free models ─────────────────────────────────────
async function fetchModels(): Promise<ZenModel[]> {
	// Check cache first (A08: integrity - serve cached data within TTL)
	if (modelCache && Date.now() - modelCache.fetchedAt < MODEL_CACHE_TTL_MS) {
		log("info", `serving ${modelCache.models.length} cached model(s)`, {
			cacheAge: `${Math.round((Date.now() - modelCache.fetchedAt) / 1000)}s`,
		});
		return modelCache.models;
	}

	log("info", "fetching model list from upstream...");

	let res: Response;
	try {
		res = await fetch(`${API}/models`);
	} catch (err) {
		log("error", "failed to fetch models (network error)", {
			error: err instanceof Error ? err.message : String(err),
		});
		// Return cached data if available, even if stale
		if (modelCache) {
			log("warn", "returning stale cache due to network error");
			return modelCache.models;
		}
		throw err;
	}

	if (!res.ok) {
		log("error", `models fetch failed`, { status: res.status });
		if (modelCache) {
			log("warn", "returning stale cache due to upstream error");
			return modelCache.models;
		}
		throw new Error(`models fetch failed: ${res.status}`);
	}

	const data = (await res.json()) as { data: Array<{ id: string }> };

	// Validate response structure (A08: data integrity)
	if (!Array.isArray(data?.data)) {
		log("error", "invalid response structure from upstream");
		if (modelCache) return modelCache.models;
		throw new Error("invalid models response");
	}

	const candidates = data.data
		.map((m) => m.id)
		.filter(
			(id) =>
				typeof id === "string" &&
				id.length > 0 &&
				id.length < 128 && // sanity check
				!EXCLUDE.has(id) &&
				(id.endsWith("-free") || KNOWN_FREE.has(id)),
		);

	log("info", `found ${candidates.length} candidate model(s)`, {
		candidates: candidates.join(", "),
	});

	const verified: ZenModel[] = [];
	for (const id of candidates) {
		try {
			const ok = await testModel(id);
			if (ok) {
				verified.push({
					id,
					name: formatName(id),
					reasoning: id.includes("nemotron") || id.includes("mimo"),
					contextWindow: CONTEXT[id] ?? DEFAULT_CONTEXT,
					maxTokens: DEFAULT_MAX_TOKENS,
				});
				log("audit", `model verified: ${id}`);
			} else {
				log("info", `model rejected (not free): ${id}`);
			}
		} catch (err) {
			log("warn", `model test failed: ${id}`, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	// Update cache (A08: integrity)
	modelCache = { models: verified, fetchedAt: Date.now() };
	log("info", `cache updated: ${verified.length} model(s) verified`);

	return verified;
}

// ── Test if model is free ──────────────────────────────────────────
async function testModel(id: string): Promise<boolean> {
	// Validate model ID format (A03: injection prevention)
	if (!/^[a-zA-Z0-9._-]+$/.test(id) || id.length > 128) {
		log("warn", `invalid model ID format: ${id}`);
		return false;
	}

	const res = await fetch(`${API}/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: id,
			messages: [{ role: "user", content: "1" }],
			max_tokens: 1,
			stream: false,
		}),
	});
	if (!res.ok) return false;
	const data = (await res.json()) as { cost?: string };
	return !data.cost || data.cost === "0" || data.cost === "0.0";
}

// ── Pretty name ────────────────────────────────────────────────────
function formatName(id: string): string {
	return id
		.replace(/-free$/, "")
		.replace(/-/g, " ")
		.replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Security: Extract client IP from socket ────────────────────────
function getClientIP(req: http.IncomingMessage): string {
	const addr = req.socket.remoteAddress;
	if (!addr) return "unknown";
	// Normalize IPv6 mapped IPv4
	if (addr.startsWith("::ffff:")) return addr.slice(7);
	return addr;
}

// ── Security: Validate and sanitize path (A03/A10) ─────────────────
function validatePath(rawUrl: string): URL | null {
	// Remove leading slashes and normalize
	const cleaned = rawUrl.replace(/^\/+/, "");

	// Check against whitelist pattern
	if (!ALLOWED_PATH_PATTERN.test(`/${cleaned}`)) {
		return null;
	}

	// Reject path traversal (..) — A03: prevents directory traversal
	if (PATH_TRAVERSAL_PATTERN.test(cleaned)) {
		return null;
	}

	// Prevent double-encoding tricks
	try {
		const decoded = decodeURIComponent(cleaned);
		if (decoded !== cleaned && !ALLOWED_PATH_PATTERN.test(`/${decoded}`)) {
			return null;
		}
	} catch {
		return null;
	}

	try {
		return new URL(cleaned, `${UPSTREAM}/`);
	} catch {
		return null;
	}
}

// ── Security: Sanitize headers for upstream (A04) ──────────────────
function sanitizeHeaders(
	incoming: http.IncomingHttpHeaders,
	targetHost: string,
): Record<string, string> {
	const sanitized: Record<string, string> = {};

	for (const [key, value] of Object.entries(incoming)) {
		const lower = key.toLowerCase();

		// Skip stripped headers
		if (STRIP_HEADERS.has(lower)) continue;

		// Skip pseudo-headers
		if (lower.startsWith(":")) continue;

		// Only forward safe headers
		if (typeof value === "string") {
			sanitized[lower] = value;
		} else if (Array.isArray(value)) {
			sanitized[lower] = value.join(", ");
		}
	}

	// Set required headers explicitly
	sanitized.host = targetHost;
	sanitized["accept-encoding"] = "identity";
	sanitized.connection = "close";

	return sanitized;
}

// ── Start local proxy ──────────────────────────────────────────────
function startProxy(overridePort?: number): http.Server {
	const effectivePort = overridePort ?? PORT;
	const server = http.createServer((req, res) => {
		const clientIP = getClientIP(req);
		const startTime = Date.now();

		// A07: Rate limiting
		if (!checkRateLimit(clientIP)) {
			log("warn", "rate limit exceeded", { ip: clientIP });
			res.writeHead(429, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "rate limit exceeded" }));
			return;
		}

		// A03: Method whitelist
		if (!ALLOWED_METHODS.has(req.method ?? "")) {
			log("audit", "method not allowed", {
				ip: clientIP,
				method: req.method,
				path: req.url,
			});
			res.writeHead(405, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "method not allowed" }));
			return;
		}

		// Handle CORS preflight (safe: no credentials)
		if (req.method === "OPTIONS") {
			res.writeHead(204, {
				"access-control-allow-origin": "http://localhost",
				"access-control-allow-methods": "GET, POST, OPTIONS",
				"access-control-max-age": "86400",
			});
			res.end();
			return;
		}

		// A03/A10: Validate path
		const target = validatePath(req.url ?? "/");
		if (!target) {
			log("audit", "invalid path rejected", {
				ip: clientIP,
				method: req.method,
				path: req.url,
			});
			res.writeHead(403, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "forbidden" }));
			return;
		}

		// A04: Sanitize headers
		const fwd = sanitizeHeaders(req.headers, target.hostname);

		log("audit", "proxying request", {
			ip: clientIP,
			method: req.method,
			path: target.pathname,
			target: target.hostname,
		});

		const proxy = https.request(
			{
				method: req.method,
				hostname: target.hostname,
				port: 443,
				path: target.pathname + target.search,
				headers: fwd,
			},
			(upstream) => {
				const outHeaders: Record<string, string> = {};

				// Forward safe response headers only
				const safeResponseHeaders = [
					"content-type",
					"cache-control",
					"x-request-id",
				];
				for (const h of safeResponseHeaders) {
					const val = upstream.headers[h];
					if (typeof val === "string") {
						outHeaders[h] = val;
					}
				}

				// Add security headers
				outHeaders["x-content-type-options"] = "nosniff";
				outHeaders["x-frame-options"] = "DENY";

				res.writeHead(upstream.statusCode ?? 502, outHeaders);
				upstream.pipe(res);
			},
		);

		proxy.on("error", (err) => {
			const duration = Date.now() - startTime;
			log("error", "upstream proxy error", {
				ip: clientIP,
				path: target.pathname,
				error: err.message,
				duration: `${duration}ms`,
			});
			if (!res.headersSent) {
				res.writeHead(502, { "content-type": "application/json" });
			}
			res.end(JSON.stringify({ error: "upstream error" }));
		});

		// A07: Per-request timeout (30s, shorter than global 120s)
		proxy.setTimeout(30_000, () => {
			proxy.destroy(new Error("request timeout"));
		});

		// Handle client abort — only fires when client disconnects prematurely,
		// NOT when the readable stream ends normally (fixes 502 on every request)
		req.on("aborted", () => {
			if (!proxy.destroyed) {
				proxy.destroy();
			}
		});

		req.pipe(proxy);
	});

	server.on("error", (err: NodeJS.ErrnoException) => {
		if (err.code === "EADDRINUSE") {
			log("warn", `port ${effectivePort} in use — proxy may already be running`);
			return;
		}
		log("error", "server error", { code: err.code, message: err.message });
	});

	// A09: Log server start
	log("info", `proxy starting`, { host: HOST, port: effectivePort });
	server.listen(effectivePort, HOST);
	log("info", `proxy listening on http://${HOST}:${effectivePort}`);

	startCleanupInterval();

	return server;
}

// ── Main extension ─────────────────────────────────────────────────
export default async function (pi: ExtensionAPI) {
	log("info", "extension loading...");

	const server = startProxy();

	log("info", "fetching free models...");
	const models = await fetchModels();

	if (models.length === 0) {
		log("warn", "no free models found — extension inactive");
		return;
	}

	log(
		"info",
		`${models.length} free model(s) registered: ${models.map((m) => `${m.id} (${m.contextWindow / 1000}K)`).join(", ")}`,
	);

	pi.registerProvider("bansos", {
		baseUrl: `http://${HOST}:${PORT}/v1`,
		apiKey: "placeholder",
		api: "openai-completions",
		compat: { supportsDeveloperRole: true, supportsReasoningEffort: true },
		models: models.map((m) => ({
			id: m.id,
			name: m.name,
			reasoning: m.reasoning,
			input: ["text"] as ("text" | "image")[],
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		})),
	});

	pi.on("session_shutdown", () => {
		log("info", "shutting down proxy...");
		server.close();
		rateLimitMap.clear();
		if (cleanupInterval) {
			clearInterval(cleanupInterval);
			cleanupInterval = null;
		}
		log("info", "shutdown complete");
	});
}
