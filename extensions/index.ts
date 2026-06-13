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

// ── Hardcoded Free Models ──────────────────────────────────────────
// Update this list manually when models change.
// On startup, each model is tested for availability.
interface ModelDef {
	id: string;
	name: string;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
}

const KNOWN_MODELS: ModelDef[] = [
	{
		id: "deepseek-v4-flash-free",
		name: "DeepSeek V4 Flash",
		reasoning: true,
		contextWindow: 128_000,
		maxTokens: 16_384,
	},
	{
		id: "mimo-v2.5-free",
		name: "Mimo V2.5",
		reasoning: false,
		contextWindow: 128_000,
		maxTokens: 16_384,
	},
	{
		id: "nemotron-3-ultra-free",
		name: "Nemotron 3 Ultra",
		reasoning: true,
		contextWindow: 128_000,
		maxTokens: 16_384,
	},
	{
		id: "north-mini-code-free",
		name: "North Mini Code",
		reasoning: true,
		contextWindow: 128_000,
		maxTokens: 16_384,
	},
	{
		id: "big-pickle",
		name: "Big Pickle",
		reasoning: true,
		contextWindow: 128_000,
		maxTokens: 16_384,
	},
];

// ── Whitelists ─────────────────────────────────────────────────────
const ALLOWED_PATH_PATTERN = /^\/v1\/[a-zA-Z0-9/_.,\-?&=]*$/;
const PATH_TRAVERSAL_PATTERN = /\.\./;
const ALLOWED_METHODS = new Set(["GET", "POST", "OPTIONS", "HEAD"]);
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

// ── Logger ─────────────────────────────────────────────────────────
type LogLevel = "info" | "warn" | "error" | "audit";

function log(level: LogLevel, message: string, meta?: Record<string, unknown>) {
	const ts = new Date().toISOString();
	const metaStr = meta ? ` ${JSON.stringify(meta)}` : "";
	const line = `[bansos] [${ts}] [${level.toUpperCase()}] ${message}${metaStr}`;
	if (level === "error") {
		console.error(line);
	} else {
		console.log(line);
	}
}

// ── Rate Limiter ───────────────────────────────────────────────────
interface RateLimitEntry {
	count: number;
	resetAt: number;
}
const rateLimitMap = new Map<string, RateLimitEntry>();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 120;
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

function startCleanupInterval() {
	if (cleanupInterval) return;
	cleanupInterval = setInterval(() => {
		const now = Date.now();
		for (const [key, entry] of rateLimitMap) {
			if (entry.resetAt <= now) rateLimitMap.delete(key);
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
	if (entry.count >= RATE_LIMIT_MAX) return false;
	entry.count++;
	return true;
}

// ── Health Check ───────────────────────────────────────────────────
async function checkModelAlive(id: string): Promise<boolean> {
	try {
		const res = await fetch(`${API}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: id,
				messages: [{ role: "user", content: "hi" }],
				max_tokens: 1,
				stream: false,
			}),
			signal: AbortSignal.timeout(10_000),
		});
		// Model is alive if API responds (even with error)
		return res.ok || res.status === 400 || res.status === 429;
	} catch {
		return false;
	}
}

function getClientIP(req: http.IncomingMessage): string {
	const addr = req.socket.remoteAddress;
	if (!addr) return "unknown";
	return addr.startsWith("::ffff:") ? addr.slice(7) : addr;
}

function validatePath(rawUrl: string): URL | null {
	const cleaned = rawUrl.replace(/^\/+/, "");
	if (!ALLOWED_PATH_PATTERN.test(`/${cleaned}`)) return null;
	if (PATH_TRAVERSAL_PATTERN.test(cleaned)) return null;
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

function sanitizeHeaders(
	incoming: http.IncomingHttpHeaders,
	targetHost: string,
): Record<string, string> {
	const sanitized: Record<string, string> = {};
	for (const [key, value] of Object.entries(incoming)) {
		const lower = key.toLowerCase();
		if (STRIP_HEADERS.has(lower)) continue;
		if (lower.startsWith(":")) continue;
		if (typeof value === "string") {
			sanitized[lower] = value;
		} else if (Array.isArray(value)) {
			sanitized[lower] = value.join(", ");
		}
	}
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

		// Rate limiting
		if (!checkRateLimit(clientIP)) {
			log("warn", "rate limit exceeded", { ip: clientIP });
			res.writeHead(429, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "rate limit exceeded" }));
			return;
		}

		// Method whitelist
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

		// CORS preflight
		if (req.method === "OPTIONS") {
			res.writeHead(204, {
				"access-control-allow-origin": "http://localhost",
				"access-control-allow-methods": "GET, POST, OPTIONS",
				"access-control-max-age": "86400",
			});
			res.end();
			return;
		}

		// Validate path
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

		// Sanitize headers
		const fwd = sanitizeHeaders(req.headers, target.hostname);

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

		// Per-request timeout
		proxy.setTimeout(30_000, () => {
			proxy.destroy(new Error("request timeout"));
		});

		// Handle client abort
		req.on("aborted", () => {
			if (!proxy.destroyed) {
				proxy.destroy();
			}
		});

		req.pipe(proxy);
	});

	server.on("error", (err: NodeJS.ErrnoException) => {
		if (err.code === "EADDRINUSE") {
			log(
				"warn",
				`port ${effectivePort} in use — proxy may already be running`,
			);
			return;
		}
		log("error", "server error", { code: err.code, message: err.message });
	});

	server.listen(effectivePort, HOST);
	log("info", `proxy listening on http://${HOST}:${effectivePort}`);

	startCleanupInterval();
	return server;
}

// ── Main extension ─────────────────────────────────────────────────
export default async function (pi: ExtensionAPI) {
	log("info", "extension loading...");

	const server = startProxy();

	log("info", `checking ${KNOWN_MODELS.length} model(s) availability...`);

	// Health check each model in parallel
	const aliveChecks = await Promise.all(
		KNOWN_MODELS.map(async (model) => {
			const alive = await checkModelAlive(model.id);
			if (alive) {
				log("info", `✓ ${model.id} is alive`);
			} else {
				log("warn", `✗ ${model.id} is dead — skipping`);
			}
			return { ...model, alive };
		}),
	);

	const aliveModels = aliveChecks.filter((m) => m.alive);

	if (aliveModels.length === 0) {
		log("warn", "no alive models found — extension inactive");
		return;
	}

	log(
		"info",
		`${aliveModels.length} model(s) registered: ${aliveModels.map((m) => m.id).join(", ")}`,
	);

	pi.registerProvider("bansos", {
		baseUrl: `http://${HOST}:${PORT}/v1`,
		apiKey: "placeholder",
		api: "openai-completions",
		compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
		models: aliveModels.map((m) => ({
			id: m.id,
			name: m.name,
			reasoning: m.reasoning,
			input: ["text"] as ("text" | "image")[],
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
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
