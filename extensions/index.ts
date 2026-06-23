/**
 * bansos — pi extension (with mimo-free support)
 *
 * OpenCode models + Mimo Free from xiaomi
 */
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import os from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Configuration ──────────────────────────────────────────────────
const UPSTREAM_OPENCODE = "https://opencode.ai/zen";
const MIMO_CHAT_URL = "https://api.xiaomimimo.com/api/free-ai/openai/chat";
const MIMO_BOOTSTRAP_URL = "https://api.xiaomimimo.com/api/free-ai/bootstrap";
const PORT = Number(process.env.BANSOS_PORT) || 18080;
const HOST = "127.0.0.1";
const API = `${UPSTREAM_OPENCODE}/v1`;
const MIMO_SYSTEM_MARKER = "You are MiMoCode, an interactive CLI tool that helps users with software engineering tasks.";

// Session affinity (per 9router mimo-free.js) — Xiaomi uses this for rate limit / anti-abuse
const SESSION_AFFINITY_PREFIX = "ses_";
const SESSION_ID_LENGTH = 24;
const SESSION_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

function generateSessionId(): string {
	let id = SESSION_AFFINITY_PREFIX;
	for (let i = 0; i < SESSION_ID_LENGTH; i++) {
		id += SESSION_CHARS[Math.floor(Math.random() * SESSION_CHARS.length)];
	}
	return id;
}

let cachedSessionId: string | null = null;
function getSessionId(): string {
	if (!cachedSessionId) cachedSessionId = generateSessionId();
	return cachedSessionId;
}

const JWT_EXPIRY_BUFFER_MS = 5 * 60 * 1000; // 5 min buffer (per 9router)

// ── Model Definitions ──────────────────────────────────────────────
interface ModelDef {
	id: string;
	name: string;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
}

// OpenCode models (existing)
const KNOWN_MODELS: ModelDef[] = [
	{ id: "deepseek-v4-flash-free", name: "DeepSeek V4 Flash", reasoning: true, contextWindow: 128_000, maxTokens: 16_384 },
	{ id: "mimo-v2.5-free", name: "Mimo V2.5 Free", reasoning: false, contextWindow: 128_000, maxTokens: 16_384 },
	{ id: "nemotron-3-ultra-free", name: "Nemotron 3 Ultra", reasoning: true, contextWindow: 128_000, maxTokens: 16_384 },
	{ id: "north-mini-code-free", name: "North Mini Code", reasoning: true, contextWindow: 128_000, maxTokens: 16_384 },
	{ id: "big-pickle", name: "Big Pickle", reasoning: true, contextWindow: 128_000, maxTokens: 16_384 },
];

// Mimo Free models (from xiaomi free API)
// Per 9router/open-sse/config/providerModels.js: "free channel only serves mimo-auto"
const MIMO_MODELS: ModelDef[] = [
	{ id: "mimo-auto", name: "MiMo Auto (Free)", reasoning: false, contextWindow: 128_000, maxTokens: 16_384 },
];

// ── Whitelists ─────────────────────────────────────────────────────
const ALLOWED_PATH_PATTERN = /^\/v1\/[a-zA-Z0-9/_.,\-?&=]*$/;
const PATH_TRAVERSAL_PATTERN = /\.\./;
const ALLOWED_METHODS = new Set(["GET", "POST", "OPTIONS", "HEAD"]);
const STRIP_HEADERS = new Set([
	"authorization", "host", "x-forwarded-for", "x-forwarded-host",
	"x-forwarded-proto", "x-real-ip", "x-client-ip", "x-originate-ip",
	"cookie", "set-cookie", "proxy-connection", "proxy-authorization",
]);

// ── Logger ─────────────────────────────────────────────────────────
type LogLevel = "info" | "warn" | "error" | "audit";
function log(level: LogLevel, message: string, meta?: Record<string, unknown>) {
	const ts = new Date().toISOString();
	const metaStr = meta ? ` ${JSON.stringify(meta)}` : "";
	const line = `[bansos] [${ts}] [${level.toUpperCase()}] ${message}${metaStr}`;
	if (level === "error") console.error(line);
	else console.log(line);
}

// ── Rate Limiter ───────────────────────────────────────────────────
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 120;
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

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

// ── Mimo Free JWT ──────────────────────────────────────────────────
let cachedJwt: string | null = null;
let jwtExpiresAt = 0;

function generateFingerprint(): string {
	const username = os.userInfo().username || "unknown";
	const cpu = os.cpus()[0]?.model || "unknown-cpu";
	const seed = `${os.hostname()}|${os.platform()}|${os.arch()}|${cpu}|${username}`;
	return createHash("sha256").update(seed).digest("hex");
}

// Parse JWT exp claim (per 9router mimo-free.js parseJwtExp)
function parseJwtExp(jwt: string): number {
	try {
		const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64").toString());
		if (payload.exp) return payload.exp * 1000;
	} catch {}
	return Date.now() + 50 * 60 * 1000; // fallback 50 min
}

async function bootstrapJwt(): Promise<string> {
	if (cachedJwt && Date.now() < jwtExpiresAt - JWT_EXPIRY_BUFFER_MS) return cachedJwt;

	try {
		const res = await fetch(MIMO_BOOTSTRAP_URL, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ client: generateFingerprint() }),
			signal: AbortSignal.timeout(10_000),
		});
		if (!res.ok) throw new Error(`bootstrap failed: ${res.status}`);
		const data = await res.json();
		if (!data.jwt) throw new Error("no jwt in response");

		cachedJwt = data.jwt;
		jwtExpiresAt = parseJwtExp(data.jwt);
		log("info", "mimo JWT obtained");
		return data.jwt;
	} catch (err) {
		log("error", "mimo bootstrap failed", { error: String(err) });
		throw err;
	}
}

function resetJwtCache(): void {
	cachedJwt = null;
	jwtExpiresAt = 0;
}

// ── Health Check ───────────────────────────────────────────────────
async function checkModelAlive(id: string, isMimo = false): Promise<boolean> {
	try {
		if (isMimo) {
			// For mimo, just check bootstrap works
			await bootstrapJwt();
			return true;
		}
		const res = await fetch(`${API}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: id, messages: [{ role: "user", content: "hi" }], max_tokens: 1, stream: false }),
			signal: AbortSignal.timeout(10_000),
		});
		return res.ok || res.status === 400 || res.status === 429;
	} catch {
		return false;
	}
}

// ── Helpers ────────────────────────────────────────────────────────
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
		if (decoded !== cleaned && !ALLOWED_PATH_PATTERN.test(`/${decoded}`)) return null;
	} catch { return null; }
	try {
		return new URL(cleaned, `${UPSTREAM_OPENCODE}/`);
	} catch { return null; }
}

function sanitizeHeaders(incoming: http.IncomingHttpHeaders, targetHost: string): Record<string, string> {
	const sanitized: Record<string, string> = {};
	for (const [key, value] of Object.entries(incoming)) {
		const lower = key.toLowerCase();
		if (STRIP_HEADERS.has(lower) || lower.startsWith(":")) continue;
		if (typeof value === "string") sanitized[lower] = value;
		else if (Array.isArray(value)) sanitized[lower] = value.join(", ");
	}
	sanitized.host = targetHost;
	sanitized["accept-encoding"] = "identity";
	sanitized.connection = "close";
	return sanitized;
}

function injectSystemMarker(body: any): any {
	const messages = body?.messages;
	if (!Array.isArray(messages)) return body;
	const hasMarker = messages.some((m: any) => m?.role === "system" && typeof m.content === "string" && m.content.includes(MIMO_SYSTEM_MARKER));
	if (hasMarker) return body;
	return { ...body, messages: [{ role: "system", content: MIMO_SYSTEM_MARKER }, ...messages] };
}

// ── Start local proxy ──────────────────────────────────────────────
function startProxy(overridePort?: number): http.Server {
	const effectivePort = overridePort ?? PORT;

	const server = http.createServer((req, res) => {
		const clientIP = getClientIP(req);
		const startTime = Date.now();

		if (!checkRateLimit(clientIP)) {
			log("warn", "rate limit exceeded", { ip: clientIP });
			res.writeHead(429, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "rate limit exceeded" }));
			return;
		}

		if (!ALLOWED_METHODS.has(req.method ?? "")) {
			res.writeHead(405, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "method not allowed" }));
			return;
		}

		if (req.method === "OPTIONS") {
			res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-max-age": "86400" });
			res.end();
			return;
		}

		const target = validatePath(req.url ?? "/");
		if (!target) {
			res.writeHead(403, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "forbidden" }));
			return;
		}

		// Read body to detect model for routing
		const bodyChunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => bodyChunks.push(chunk));
		req.on("end", async () => {
			const bodyStr = Buffer.concat(bodyChunks).toString();
			let isMimo = false;
			let parsedBody: any = null;
			
			try {
				parsedBody = JSON.parse(bodyStr);
				if (parsedBody.model === "mimo-auto") {
					isMimo = true;
				}
			} catch {}

			try {
				if (isMimo) {
					// Mimo Free routing (Xiaomi upstream)
					const isStream = parsedBody.stream === true;
					const jwt = await bootstrapJwt();
					const transformedBody = injectSystemMarker(parsedBody);

					const buildHeaders = (token: string) => ({
						"Content-Type": "application/json",
						"Authorization": `Bearer ${token}`,
						"X-Mimo-Source": "mimocode-cli-free",
						"x-session-affinity": getSessionId(),
						"Accept": isStream ? "text/event-stream" : "application/json",
					});

					const doFetch = (token: string) =>
						fetch(MIMO_CHAT_URL, {
							method: "POST",
							headers: buildHeaders(token),
							body: JSON.stringify(transformedBody),
							signal: AbortSignal.timeout(60_000),
						});

					let response = await doFetch(jwt);

					// Retry once on auth failure (per 9router mimo-free.js)
					if (response.status === 401 || response.status === 403) {
						log("warn", `mimo auth ${response.status}, re-bootstrapping`);
						resetJwtCache();
						const retryJwt = await bootstrapJwt();
						response = await doFetch(retryJwt);
					}

					// Pipe streaming SSE as-is, or buffer JSON
					if (isStream && response.body) {
						const ct = response.headers.get("content-type") || "text/event-stream";
						res.writeHead(response.status, {
							"content-type": ct,
							"cache-control": "no-cache",
							"x-accel-buffering": "no",
						});
						const nodeStream = Readable.fromWeb(response.body as unknown as import("stream/web").ReadableStream);
						nodeStream.pipe(res);
						req.on("aborted", () => { if (!nodeStream.destroyed) nodeStream.destroy(); });
						req.on("close", () => { if (!nodeStream.destroyed) nodeStream.destroy(); });
					} else {
						const data = await response.text();
						const ct = response.headers.get("content-type") || "application/json";
						res.writeHead(response.status, { "content-type": ct });
						res.end(data);
					}
				} else {
					// OpenCode routing (existing)
					const fwd = sanitizeHeaders(req.headers, target.hostname);
					const proxy = https.request({
						method: req.method,
						hostname: target.hostname,
						port: 443,
						path: target.pathname + target.search,
						headers: fwd,
					}, (upstream) => {
						const outHeaders: Record<string, string> = {};
						for (const h of ["content-type", "cache-control", "x-request-id"]) {
							const val = upstream.headers[h];
							if (typeof val === "string") outHeaders[h] = val;
						}
						outHeaders["x-content-type-options"] = "nosniff";
						res.writeHead(upstream.statusCode ?? 502, outHeaders);
						upstream.pipe(res);
					});
					proxy.on("error", () => { res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "upstream error" })); });
					proxy.setTimeout(30_000, () => { proxy.destroy(new Error("timeout")); });
					req.on("aborted", () => { if (!proxy.destroyed) proxy.destroy(); });
					// ponytail: body already buffered in bodyChunks above for model routing;
					// req is drained so pipe() would send an empty body → upstream hang → 502.
					proxy.end(Buffer.concat(bodyChunks));
				}
			} catch (err) {
				log("error", "proxy error", { error: String(err) });
				if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: "internal error" }));
			}
		});
	});

	server.on("error", (err: NodeJS.ErrnoException) => {
		if (err.code === "EADDRINUSE") { log("warn", `port ${effectivePort} in use`); return; }
		log("error", "server error", { code: err.code, message: err.message });
	});

	server.listen(effectivePort, HOST);
	log("info", `proxy listening on http://${HOST}:${effectivePort}`);
	return server;
}

// ── Main extension ─────────────────────────────────────────────────
export default async function (pi: ExtensionAPI) {
	log("info", "extension loading...");
	const server = startProxy();

	// Health check opencode models
	log("info", `checking ${KNOWN_MODELS.length} opencode model(s)...`);
	const opencodeChecks = await Promise.all(
		KNOWN_MODELS.map(async (model) => {
			const alive = await checkModelAlive(model.id, false);
			if (alive) log("info", `✓ ${model.id} is alive`);
			else log("warn", `✗ ${model.id} is dead — skipping`);
			return { ...model, alive };
		}),
	);

	// Health check mimo models
	log("info", `checking ${MIMO_MODELS.length} mimo model(s)...`);
	const mimoChecks = await Promise.all(
		MIMO_MODELS.map(async (model) => {
			const alive = await checkModelAlive(model.id, true);
			if (alive) log("info", `✓ ${model.id} (mimo-free) is alive`);
			else log("warn", `✗ ${model.id} (mimo-free) is dead — skipping`);
			return { ...model, alive };
		}),
	);

	const aliveModels = [...opencodeChecks, ...mimoChecks].filter((m) => m.alive);

	if (aliveModels.length === 0) {
		log("warn", "no alive models found — extension inactive");
		return;
	}

	log("info", `${aliveModels.length} model(s) registered: ${aliveModels.map((m) => m.id).join(", ")}`);

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
		if (cleanupInterval) { clearInterval(cleanupInterval); cleanupInterval = null; }
		log("info", "shutdown complete");
	});
}
