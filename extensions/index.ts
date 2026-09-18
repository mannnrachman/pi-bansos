/**
 * bansos — pi extension (with KiloCode free support)
 *
 * OpenCode models + KiloCode gateway free models
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { homedir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Configuration ──────────────────────────────────────────────────
const UPSTREAM_OPENCODE = "https://opencode.ai/zen";
// KiloCode gateway — OpenAI-compatible; free models are keyless (200 req/hr per IP)
const KILO_CHAT_URL = "https://api.kilo.ai/api/gateway/chat/completions";
const PORT = Number(process.env.BANSOS_PORT) || 18080;
const HOST = "127.0.0.1";
const API = `${UPSTREAM_OPENCODE}/v1`;

// OpenCode Zen free-tier client fingerprint (verified live 2026-09-18; same
// gates as 9router PR #4132). Missing any one → 403 FreeTierError.
const OPENCODE_UA = "opencode/1.18.31";
const OPENCODE_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const BASE62 =
	"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const OPENCODE_FINGERPRINT_TOOLS = ["bash", "glob", "grep", "read"] as const;
const OPENCODE_RESPONSES_MODELS = new Set([
	"muse-spark-1.2-contributor-free",
	"muse-spark-1.3-contributor-free",
]);

let lastSessionTs = 0;
let sessionCounter = 0;

function unstableRandom(): string {
	const bytes = randomBytes(14);
	let out = "";
	for (let i = 0; i < 14; i++) out += BASE62[bytes[i]! % 62];
	return out;
}

function timeHexFrom(value: bigint): string {
	return Array.from({ length: 6 }, (_, i) =>
		Number((value >> BigInt(40 - 8 * i)) & 0xffn)
			.toString(16)
			.padStart(2, "0"),
	).join("");
}

function generateSessionId(timestamp = Date.now()): string {
	if (timestamp !== lastSessionTs) {
		lastSessionTs = timestamp;
		sessionCounter = 0;
	}
	sessionCounter++;
	const current = BigInt(timestamp) * 0x1000n + BigInt(sessionCounter);
	return `ses_${timeHexFrom(~current)}${unstableRandom()}`;
}

function generateRequestId(timestamp = Date.now()): string {
	const current = BigInt(timestamp) * 0x1000n + 1n;
	return `msg_${timeHexFrom(current)}${unstableRandom()}`;
}

// One stable session per process — shape must match OPENCODE_SESSION_RE.
const OPENCODE_SESSION = generateSessionId();
if (!OPENCODE_SESSION_RE.test(OPENCODE_SESSION)) {
	throw new Error("opencode session id generation failed shape check");
}

function opencodeHeaders(): Record<string, string> {
	return {
		"User-Agent": OPENCODE_UA,
		Authorization: "Bearer public",
		"x-opencode-client": "desktop",
		"x-opencode-project": "global",
		"x-opencode-session": OPENCODE_SESSION,
		"x-opencode-request": generateRequestId(),
		Accept: "text/event-stream",
	};
}

function toolNameOf(tool: unknown): string {
	if (!tool || typeof tool !== "object" || Array.isArray(tool)) return "";
	const t = tool as Record<string, unknown>;
	const fn =
		t.function && typeof t.function === "object" && !Array.isArray(t.function)
			? (t.function as Record<string, unknown>)
			: null;
	const raw =
		typeof t.name === "string"
			? t.name
			: typeof fn?.name === "string"
				? fn.name
				: "";
	return raw.trim();
}

function ensureChatFingerprintTools(body: Record<string, unknown>): void {
	const present = new Set<string>();
	if (!Array.isArray(body.tools)) body.tools = [];
	for (const tool of body.tools as unknown[]) {
		const name = toolNameOf(tool);
		if (name) present.add(name);
	}
	for (const name of OPENCODE_FINGERPRINT_TOOLS) {
		if (present.has(name)) continue;
		(body.tools as unknown[]).push({
			type: "function",
			function: {
				name,
				description: `OpenCode built-in ${name} tool`,
				parameters: { type: "object", properties: {} },
			},
		});
	}
}

function ensureResponsesFingerprintTools(body: Record<string, unknown>): void {
	const present = new Set<string>();
	if (!Array.isArray(body.tools)) body.tools = [];
	for (const tool of body.tools as unknown[]) {
		const name = toolNameOf(tool);
		if (name) present.add(name);
	}
	for (const name of OPENCODE_FINGERPRINT_TOOLS) {
		if (present.has(name)) continue;
		(body.tools as unknown[]).push({
			type: "function",
			name,
			description: `OpenCode built-in ${name} tool`,
			parameters: { type: "object", properties: {} },
		});
	}
}

function sanitizeResponsesItems(body: Record<string, unknown>): void {
	if (!Array.isArray(body.input)) return;
	body.input = (body.input as unknown[]).filter((item) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) return true;
		const it = item as Record<string, unknown>;
		// Drop prior-turn reasoning: pooled Bearer public cannot decrypt
		// encrypted_content across rotated Console accounts (400).
		if (it.type === "reasoning") return false;
		delete it.encrypted_content;
		delete it.reasoning_encrypted_content;
		return true;
	});
}

/** Rewrite OpenCode free-tier request body to pass Zen client fingerprint gates. */
function transformOpencodeBody(
	body: Record<string, unknown>,
): Record<string, unknown> {
	// Gate: stream:false → 403 even with valid UA/session/tools.
	body.stream = true;
	const model = typeof body.model === "string" ? body.model : "";
	if (OPENCODE_RESPONSES_MODELS.has(model) || model.includes("muse-spark")) {
		if (body.max_output_tokens === undefined) {
			if (typeof body.max_completion_tokens === "number")
				body.max_output_tokens = body.max_completion_tokens;
			else if (typeof body.max_tokens === "number")
				body.max_output_tokens = body.max_tokens;
		}
		delete body.max_tokens;
		delete body.max_completion_tokens;
		body.store = false;
		ensureResponsesFingerprintTools(body);
		sanitizeResponsesItems(body);
	} else {
		ensureChatFingerprintTools(body);
	}
	return body;
}

// ── Relay egress (vercel/cloudflare worker, x-relay-target pattern) ──────────
// Same logic as 9router ProxyFetch: when enabled, redirect upstream calls to a
// relay URL and inject x-relay-target / x-relay-path headers. Body untouched →
// SSE streaming passes through unchanged. Toggle live via /bansos command.
// No built-in default relay — a published package must not bake in any one
// user's personal relay URL. Bring your own via /bansos deploy or /bansos url.
const DEFAULT_RELAY_URL = "";
// State lives OUTSIDE the package dir so npm updates don't wipe it.
// Uses ~/.pi/agent/pi-bansos-relay-state.json (stable), falls back to
// package-root .relay-state.json for dev/local installs.
function resolveRelayStatePath(): string {
	try {
		return path.join(homedir(), ".pi", "agent", "pi-bansos-relay-state.json");
	} catch {
		// homedir() unavailable — fallback to package root (dev mode)
		return path.join(
			path.dirname(fileURLToPath(import.meta.url)),
			"..",
			".relay-state.json",
		);
	}
}
const RELAY_STATE_FILE = resolveRelayStatePath();

type KnownRelay = { url: string; label?: string; addedAt?: string };
type RelayState = { enabled: boolean; url: string; relays: KnownRelay[] };
function loadRelayState(): RelayState {
	try {
		const s = JSON.parse(fs.readFileSync(RELAY_STATE_FILE, "utf8"));
		const relays: KnownRelay[] = Array.isArray(s?.relays) ? s.relays : [];
		return {
			enabled: Boolean(s?.enabled),
			url: typeof s?.url === "string" ? s.url.trim() : "",
			relays,
		};
	} catch {
		return { enabled: false, url: "", relays: [] };
	}
}
function saveRelayState(s: RelayState): void {
	try {
		fs.writeFileSync(RELAY_STATE_FILE, JSON.stringify(s));
	} catch (e) {
		log("warn", "could not persist relay state", { error: String(e) });
	}
}
// dedupe-add a relay to the known list
function ensureRelay(s: RelayState, url: string, label?: string): void {
	if (!url || s.relays.some((r) => r.url === url)) return;
	s.relays.push({ url, label, addedAt: new Date().toISOString() });
}
function removeRelay(s: RelayState, url: string): void {
	s.relays = s.relays.filter((r) => r.url !== url);
}
function resolveRelayState(): RelayState {
	const s = loadRelayState();
	// migrate legacy {enabled,url}: seed the known list with default + active url
	if (!s.relays.length) {
		ensureRelay(s, DEFAULT_RELAY_URL, "9Router default");
		if (s.url && s.url !== DEFAULT_RELAY_URL) ensureRelay(s, s.url, "previous");
	}
	if (!s.url) s.url = DEFAULT_RELAY_URL;
	return s;
}
let relayState: RelayState = resolveRelayState();
let relayHits = 0;

// Catalog served at GET /v1/models — ONLY the alive free models we register.
// Set after health checks. Prevents paid/other upstream models from leaking
// through the proxy's /v1/models (opencode returns 60 models incl. 54 paid).
type RegisteredModel = ModelDef & { source: Upstream };
let aliveCatalog: RegisteredModel[] = [];

// Relay-aware fetch. Direct when disabled; otherwise POST to relay URL with the
// two relay headers. Falls back to direct on relay error (non-strict).
async function relayFetch(
	url: string,
	opts: RequestInit = {},
): Promise<Response> {
	if (!relayState.enabled || !relayState.url) return fetch(url, opts);
	try {
		const u = new URL(url);
		relayHits++;
		const headers = new Headers(opts.headers);
		headers.set("x-relay-target", `${u.protocol}//${u.host}`);
		headers.set("x-relay-path", `${u.pathname}${u.search}`);
		return await fetch(relayState.url, { ...opts, headers });
	} catch (e) {
		log("warn", "relay fetch failed, falling back to direct", {
			url,
			error: String(e),
		});
		return fetch(url, opts);
	}
}

// ── Deploy a fresh Vercel relay (same flow as 9Router) ───────────────────────
// Token is used in-memory only and NEVER persisted. Resulting URL is saved to
// the relay state and activated. Worker uses the x-relay-target/x-relay-path
// pattern, identical to the cloudflare/vercel relays 9Router deploys.
const VERCEL_API = "https://api.vercel.com";
const VERCEL_RELAY_WORKER = `// Only the 2 upstreams pi-bansos talks to. Anything else = open proxy abuse.
const ALLOWED_TARGETS = ["https://opencode.ai", "https://api.kilo.ai"];
export const config = { runtime: "edge" };
export default async function handler(req) {
  const target = req.headers.get("x-relay-target");
  const relayPath = req.headers.get("x-relay-path") || "/";
  if (!target) return new Response(JSON.stringify({ error: "Missing x-relay-target header" }), { status: 400, headers: { "content-type": "application/json" } });
  const cleanTarget = target.replace(/\\/$/, "");
  if (!ALLOWED_TARGETS.includes(cleanTarget)) return new Response(JSON.stringify({ error: "Forbidden target" }), { status: 403, headers: { "content-type": "application/json" } });
  if (!relayPath.startsWith("/")) return new Response(JSON.stringify({ error: "Bad path" }), { status: 400, headers: { "content-type": "application/json" } });
  const targetUrl = cleanTarget + relayPath;
  const headers = new Headers(req.headers);
  headers.delete("x-relay-target"); headers.delete("x-relay-path"); headers.delete("host");
  const response = await fetch(targetUrl, { method: req.method, headers, body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined, duplex: "half" });
  return new Response(response.body, { status: response.status, headers: response.headers });
}`;

async function deployVercelRelay(
	token: string,
	name: string,
	onProgress?: (msg: string) => void,
): Promise<string> {
	const auth = {
		Authorization: `Bearer ${token}`,
		"Content-Type": "application/json",
	};
	// 1. create deployment (3 inline files, no git repo)
	onProgress?.("Uploading relay to Vercel…");
	const dep = await fetch(`${VERCEL_API}/v13/deployments`, {
		method: "POST",
		headers: auth,
		body: JSON.stringify({
			name,
			files: [
				{ file: "api/relay.js", data: VERCEL_RELAY_WORKER },
				{
					file: "package.json",
					data: JSON.stringify({ name, version: "1.0.0" }),
				},
				{
					file: "vercel.json",
					data: JSON.stringify({
						rewrites: [{ source: "/(.*)", destination: "/api/relay" }],
					}),
				},
			],
			projectSettings: { framework: null },
			target: "production",
		}),
	});
	if (!dep.ok) {
		const e = await dep
			.json()
			.catch(() => ({}) as { error?: { message?: string } });
		throw new Error(
			e?.error?.message || `Vercel deploy failed (HTTP ${dep.status})`,
		);
	}
	const depJson = await dep.json();
	const depId = depJson.id || depJson.uid;
	const projectId = depJson.projectId || name;
	// 2. make the deployment public (disable SSO protection)
	await fetch(`${VERCEL_API}/v9/projects/${projectId}`, {
		method: "PATCH",
		headers: auth,
		body: JSON.stringify({ ssoProtection: null }),
	});
	// 3. poll until READY (3s interval, 120s timeout — same as 9Router)
	onProgress?.("Waiting for deployment to go live…");
	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline) {
		const s = await fetch(`${VERCEL_API}/v13/deployments/${depId}`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		const j = await s.json();
		if (j.readyState === "READY") return `https://${j.url}`;
		if (j.readyState === "ERROR" || j.readyState === "CANCELED")
			throw new Error(`Deployment failed: ${j.readyState}`);
		await new Promise((r) => setTimeout(r, 3000));
	}
	throw new Error("Deployment timed out (120s)");
}

// ── Model Definitions ──────────────────────────────────────────────
type ProviderApi = "openai-completions" | "openai-responses";
type Upstream = "opencode" | "kilo";

interface ModelDef {
	id: string;
	name: string;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
	api?: ProviderApi;
	input?: ("text" | "image")[];
	thinkingFormat?: "openrouter";
	thinkingLevelMap?: Partial<
		Record<
			"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
			string | null
		>
	>;
}

// OpenCode Zen free models verified against the live catalog and inference APIs.
// Last verified: 2026-09-18 — free-tier client fingerprint gates (UA ≥1.17, ses_ shape, tool quartet, stream:true).
const KNOWN_MODELS: ModelDef[] = [
	{
		id: "muse-spark-1.3-contributor-free",
		name: "Muse Spark 1.3 Free",
		reasoning: true,
		contextWindow: 1_048_576,
		maxTokens: 131_072,
		api: "openai-responses",
		input: ["text", "image"],
		thinkingLevelMap: {
			off: null,
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		},
	},
	{
		id: "muse-spark-1.2-contributor-free",
		name: "Muse Spark 1.2 Free",
		reasoning: true,
		contextWindow: 1_048_576,
		maxTokens: 131_072,
		api: "openai-responses",
		input: ["text", "image"],
		thinkingLevelMap: {
			off: null,
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		},
	},
	{
		id: "mimo-v2.5-free",
		name: "MiMo V2.5 Free",
		reasoning: true,
		contextWindow: 200_000,
		maxTokens: 32_000,
		input: ["text", "image"],
	},
	{
		id: "ling-3.0-flash-fin-free",
		name: "Ling 3.0 Flash Fin Free",
		reasoning: true,
		contextWindow: 262_144,
		maxTokens: 32_768,
	},
	{
		id: "nemotron-3-ultra-free",
		name: "Nemotron 3 Ultra Free",
		reasoning: true,
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	},
	{
		id: "nemotron-3.5-lightning-free",
		name: "Nemotron 3.5 Lightning Free",
		reasoning: true,
		contextWindow: 262_144,
		maxTokens: 262_144,
	},
	{
		id: "big-pickle",
		name: "Big Pickle",
		reasoning: true,
		contextWindow: 200_000,
		maxTokens: 32_000,
	},
];

// KiloCode gateway free models (keyless — https://kilo.ai/docs/gateway).
// Specs match the live catalog fetched on 2026-09-07.
const KILO_MODELS: ModelDef[] = [
	{
		id: "kilo-auto/free",
		name: "Kilo Auto Free",
		reasoning: false,
		contextWindow: 256_000,
		maxTokens: 10_000,
	},
	{
		id: "stepfun/step-3.7-flash:free",
		name: "Step 3.7 Flash Free",
		reasoning: true,
		contextWindow: 262_144,
		maxTokens: 262_144,
		input: ["text", "image"],
		thinkingFormat: "openrouter",
	},
	{
		id: "nvidia/nemotron-3-ultra-550b-a55b:free",
		name: "Nemotron 3 Ultra Free",
		reasoning: true,
		contextWindow: 1_000_000,
		maxTokens: 65_536,
		thinkingFormat: "openrouter",
	},
	// ponytail: nemotron-super emits output in `reasoning` field (not `content`) under pi's payload → renders blank in agent use; gateway-direct works. Left registered, known-broken via pi until upstream changes.
	{
		id: "nvidia/nemotron-3-super-120b-a12b:free",
		name: "Nemotron 3 Super Free",
		reasoning: true,
		contextWindow: 262_144,
		maxTokens: 235_929,
		thinkingFormat: "openrouter",
	},
	{
		id: "dots-studio/dots-3-note-preview:free",
		name: "Dots3-Note Preview Free",
		reasoning: true,
		contextWindow: 512_000,
		maxTokens: 460_800,
		input: ["text", "image"],
		thinkingFormat: "openrouter",
	},
	{
		id: "cohere/north-mini-code:free",
		name: "North Mini Code Free",
		reasoning: false,
		contextWindow: 256_000,
		maxTokens: 64_000,
	},
	{
		id: "poolside/laguna-xs-2.1:free",
		name: "Laguna XS 2.1 Free",
		reasoning: true,
		contextWindow: 262_144,
		maxTokens: 32_768,
		thinkingFormat: "openrouter",
	},
	{
		id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
		name: "Nemotron 3 Nano Omni Free",
		reasoning: true,
		contextWindow: 256_000,
		maxTokens: 65_536,
		input: ["text", "image"],
		thinkingFormat: "openrouter",
	},
	{
		id: "openrouter/free",
		name: "OpenRouter Free (auto)",
		reasoning: false,
		contextWindow: 200_000,
		maxTokens: 65_536,
		input: ["text", "image"],
	},
	{
		id: "nvidia/nemotron-3.5-lightning:free",
		name: "Nemotron 3.5 Lightning Free",
		reasoning: true,
		contextWindow: 1_000_000,
		maxTokens: 65_536,
		thinkingFormat: "openrouter",
	},
	{
		id: "nvidia/nemotron-3.5-content-safety:free",
		name: "Nemotron 3.5 Content Safety Free",
		reasoning: true,
		contextWindow: 128_000,
		maxTokens: 8_192,
		input: ["text", "image"],
		thinkingFormat: "openrouter",
	},
	{
		id: "inclusionai/ling-3.0-flash-sante:free",
		name: "Ling 3.0 Flash Sante Free",
		reasoning: true,
		contextWindow: 262_144,
		maxTokens: 32_768,
		thinkingFormat: "openrouter",
	},
	{
		id: "inclusionai/ling-3.0-flash-fin:free",
		name: "Ling 3.0 Flash Fin Free",
		reasoning: true,
		contextWindow: 262_144,
		maxTokens: 32_768,
		thinkingFormat: "openrouter",
	},
	{
		id: "liquid/lfm-2.5-2.6b:free",
		name: "Liquid LFM 2.5 2.6B Free",
		reasoning: true,
		contextWindow: 65_536,
		maxTokens: 8_192,
		thinkingFormat: "openrouter",
	},
	{
		id: "poolside/laguna-s-2.1:free",
		name: "Laguna S 2.1 Free",
		reasoning: true,
		contextWindow: 262_144,
		maxTokens: 32_768,
		thinkingFormat: "openrouter",
	},
	{
		id: "minimax/minimax-m3:free",
		name: "MiniMax M3 Free",
		reasoning: true,
		contextWindow: 1_048_576,
		maxTokens: 943_718,
		input: ["text", "image"],
		thinkingFormat: "openrouter",
	},
	{
		id: "thinkingmachines/inkling-small:free",
		name: "Inkling Small Free",
		reasoning: true,
		contextWindow: 1_048_576,
		maxTokens: 262_144,
		input: ["text", "image"],
		thinkingFormat: "openrouter",
	},
	{
		id: "thinkingmachines/inkling:free",
		name: "Inkling Free",
		reasoning: true,
		contextWindow: 1_048_576,
		maxTokens: 262_144,
		input: ["text", "image"],
		thinkingFormat: "openrouter",
	},
	{
		id: "minimax/minimax-m2.7:free",
		name: "MiniMax M2.7 Free",
		reasoning: true,
		contextWindow: 196_608,
		maxTokens: 176_947,
		thinkingFormat: "openrouter",
	},
];
const KILO_MODEL_IDS = new Set(KILO_MODELS.map((m) => m.id));

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
	// Always stderr: omp RPC multiplexes JSON on stdout; console.log breaks the frame parser.
	console.error(line);
}

// ── Rate Limiter ───────────────────────────────────────────────────
// Kilo documents 200 free requests/hour/IP. OpenCode owns its own daily quota;
// local limits only stop one Pi process from flooding either upstream.
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_MAX: Record<Upstream, number> = {
	opencode: 200, // public free quota: requests per UTC day/IP
	kilo: 200, // documented gateway quota: requests per one-hour window/IP
};

function rateLimitResetAt(upstream: Upstream, now: number): number {
	if (upstream === "kilo") return now + 60 * 60_000;
	const nextUtcDay = new Date(now);
	nextUtcDay.setUTCHours(24, 0, 0, 0);
	return nextUtcDay.getTime();
}

function rateLimitKey(upstream: Upstream, ip: string, now: number): string {
	if (upstream === "kilo") return `${upstream}:${ip}`;
	return `${upstream}:${new Date(now).toISOString().slice(0, 10)}:${ip}`;
}

// ponytail: Vercel relay rejects requests that ask for very large max_tokens
// (response body / duration limits). Clamp at relay layer so direct mode stays
// unconstrained and model config stays accurate.
const RELAY_MAX_TOKENS = 131_072;

function checkRateLimit(ip: string, upstream: Upstream): boolean {
	const now = Date.now();
	const key = rateLimitKey(upstream, ip, now);
	const entry = rateLimitMap.get(key);
	if (!entry || entry.resetAt <= now) {
		rateLimitMap.set(key, {
			count: 1,
			resetAt: rateLimitResetAt(upstream, now),
		});
		return true;
	}
	if (entry.count >= RATE_LIMIT_MAX[upstream]) return false;
	entry.count++;
	return true;
}

// ── Health Check (OpenCode/Kilo catalogs; no per-model inference) ──
// Each upstream publishes a model list; fetch it ONCE (cached) and check
// membership. A 1-token chat probe per model was too slow (large models need
// 10s+ for the first token). Real usability is validated at chat time (300s).
let opencodeCatalogP: Promise<Set<string> | null> | null = null;
function opencodeCatalog(): Promise<Set<string> | null> {
	if (!opencodeCatalogP)
		opencodeCatalogP = (async () => {
			try {
				const r = await fetch(`${API}/models`, {
					headers: opencodeHeaders(),
					signal: AbortSignal.timeout(10_000),
				});
				if (!r.ok) return null;
				const d = await r.json();
				return new Set<string>(
					(d?.data ?? []).map((m: { id: string }) => m.id),
				);
			} catch {
				return null;
			}
		})();
	return opencodeCatalogP;
}
let kiloCatalogP: Promise<Set<string> | null> | null = null;
function kiloCatalog(): Promise<Set<string> | null> {
	if (!kiloCatalogP)
		kiloCatalogP = (async () => {
			try {
				const r = await fetch(
					KILO_CHAT_URL.replace("/chat/completions", "/models"),
					{
						headers: { Authorization: "Bearer kilo-free" },
						signal: AbortSignal.timeout(10_000),
					},
				);
				if (!r.ok) return null;
				const d = await r.json();
				return new Set<string>(
					(d?.data ?? []).map((m: { id: string }) => m.id),
				);
			} catch {
				return null;
			}
		})();
	return kiloCatalogP;
}

async function checkModelAlive(id: string): Promise<boolean> {
	try {
		const cat = await opencodeCatalog();
		return cat ? cat.has(id) : false;
	} catch {
		return false;
	}
}

async function checkKiloAlive(id: string): Promise<boolean> {
	try {
		const cat = await kiloCatalog();
		return cat ? cat.has(id) : false;
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
		if (decoded !== cleaned && !ALLOWED_PATH_PATTERN.test(`/${decoded}`))
			return null;
	} catch {
		return null;
	}
	try {
		return new URL(cleaned, `${UPSTREAM_OPENCODE}/`);
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
		if (STRIP_HEADERS.has(lower) || lower.startsWith(":")) continue;
		if (typeof value === "string") sanitized[lower] = value;
		else if (Array.isArray(value)) sanitized[lower] = value.join(", ");
	}
	sanitized.host = targetHost;
	Object.assign(sanitized, opencodeHeaders());
	sanitized["accept-encoding"] = "identity";
	sanitized.connection = "close";
	return sanitized;
}

// ponytail: shared stream pipe — upstream abort/timeout must end response,
// not become an uncaught exception that crashes pi.
function pipeUpstreamStream(
	nodeStream: Readable,
	res: http.ServerResponse,
	req: http.IncomingMessage,
): void {
	nodeStream.on("error", (e: unknown) => {
		log("error", "upstream stream error", { error: String(e) });
		try {
			const canSendError = !res.headersSent;
			if (canSendError)
				res.writeHead(502, { "content-type": "application/json" });
			res.end(
				canSendError
					? JSON.stringify({ error: "upstream stream error" })
					: undefined,
			);
		} catch {}
	});
	nodeStream.pipe(res);
	req.on("aborted", () => {
		if (!nodeStream.destroyed) nodeStream.destroy();
	});
	req.on("close", () => {
		if (!nodeStream.destroyed) nodeStream.destroy();
	});
}

// ── Start local proxy ──────────────────────────────────────────────
function startProxy(
	overridePort?: number,
): Promise<{ server: http.Server; port: number }> {
	const basePort = overridePort ?? PORT;

	const server = http.createServer((req, res) => {
		const clientIP = getClientIP(req);

		if (!ALLOWED_METHODS.has(req.method ?? "")) {
			res.writeHead(405, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "method not allowed" }));
			return;
		}

		if (req.method === "OPTIONS") {
			res.writeHead(204, {
				"access-control-allow-origin": "*",
				"access-control-allow-methods": "GET, POST, OPTIONS",
				"access-control-max-age": "86400",
			});
			res.end();
			return;
		}

		// Serve ONLY our registered free models. Never forward /v1/models to
		// upstream (that would leak ~54 paid models into the picker).
		if (
			req.method === "GET" &&
			(req.url === "/v1/models" || req.url === "/v1/models/")
		) {
			const body = JSON.stringify({
				object: "list",
				data: aliveCatalog.map((m) => ({
					id: m.id,
					object: "model",
					created: 0,
					owned_by: m.source === "kilo" ? "kilocode" : "opencode",
				})),
			});
			res.writeHead(200, {
				"content-type": "application/json",
				"content-length": Buffer.byteLength(body),
			});
			res.end(body);
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
			let isKilo = false;
			let parsedBody: Record<string, unknown> | null = null;

			try {
				parsedBody = JSON.parse(bodyStr);
				if (
					typeof parsedBody?.model === "string" &&
					KILO_MODEL_IDS.has(parsedBody.model)
				) {
					isKilo = true;
				}
			} catch {}

			const upstream: Upstream = isKilo ? "kilo" : "opencode";
			if (!checkRateLimit(clientIP, upstream)) {
				log("warn", "rate limit exceeded", { ip: clientIP, upstream });
				res.writeHead(429, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: `${upstream} rate limit exceeded` }));
				return;
			}

			try {
				if (isKilo && parsedBody) {
					// KiloCode gateway routing (free models are keyless)
					const isStream = parsedBody.stream === true;
					const response = await relayFetch(KILO_CHAT_URL, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Authorization: "Bearer kilo-free",
						},
						body: JSON.stringify(parsedBody),
						signal: AbortSignal.timeout(300_000),
					});
					if (isStream && response.body) {
						const ct =
							response.headers.get("content-type") || "text/event-stream";
						res.writeHead(response.status, {
							"content-type": ct,
							"cache-control": "no-cache",
							"x-accel-buffering": "no",
						});
						pipeUpstreamStream(
							Readable.fromWeb(
								response.body as unknown as import("stream/web").ReadableStream,
							),
							res,
							req,
						);
					} else {
						const data = await response.text();
						const ct =
							response.headers.get("content-type") || "application/json";
						res.writeHead(response.status, { "content-type": ct });
						res.end(data);
					}
				} else {
					// OpenCode routing — apply free-tier fingerprint before relay/direct.
					let opencodeBody = bodyChunks.length
						? Buffer.concat(bodyChunks)
						: Buffer.alloc(0);
					if (parsedBody) {
						transformOpencodeBody(parsedBody);
						if (relayState.enabled && relayState.url) {
							const mt =
								parsedBody.max_tokens ??
								parsedBody.maxTokens ??
								parsedBody.max_output_tokens;
							if (typeof mt === "number" && mt > RELAY_MAX_TOKENS) {
								if ("max_output_tokens" in parsedBody)
									parsedBody.max_output_tokens = RELAY_MAX_TOKENS;
								else parsedBody.max_tokens = RELAY_MAX_TOKENS;
								log(
									"info",
									`clamped max_tokens ${mt} → ${RELAY_MAX_TOKENS} for relay`,
								);
							}
						}
						opencodeBody = Buffer.from(JSON.stringify(parsedBody));
					}

					if (relayState.enabled && relayState.url) {
						const fullUrl = `${UPSTREAM_OPENCODE}${req.url ?? "/"}`;
						const relayHeaders = sanitizeHeaders(
							req.headers,
							new URL(relayState.url).host,
						);
						relayHeaders["content-length"] = String(opencodeBody.length);
						try {
							const response = await relayFetch(fullUrl, {
								method: req.method || "POST",
								headers: relayHeaders,
								body: opencodeBody.length ? opencodeBody : undefined,
								signal: AbortSignal.timeout(300_000),
							});
							const ct =
								response.headers.get("content-type") || "application/json";
							if (response.body) {
								res.writeHead(response.status, {
									"content-type": ct,
									"cache-control": "no-cache",
									"x-accel-buffering": "no",
								});
								pipeUpstreamStream(
									Readable.fromWeb(
										response.body as unknown as import("stream/web").ReadableStream,
									),
									res,
									req,
								);
							} else {
								const data = await response.text();
								res.writeHead(response.status, { "content-type": ct });
								res.end(data);
							}
							return; // relay handled the response
						} catch (e) {
							log("warn", "opencode relay failed, falling back to direct", {
								error: String(e),
							});
							if (res.headersSent) return; // can't recover mid-stream
						}
					}
					// direct path
					const fwd = sanitizeHeaders(req.headers, target.hostname);
					fwd["content-length"] = String(opencodeBody.length);
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
							for (const h of [
								"content-type",
								"cache-control",
								"x-request-id",
							]) {
								const val = upstream.headers[h];
								if (typeof val === "string") outHeaders[h] = val;
							}
							outHeaders["x-content-type-options"] = "nosniff";
							res.writeHead(upstream.statusCode ?? 502, outHeaders);
							upstream.pipe(res);
						},
					);
					proxy.on("error", () => {
						if (!res.headersSent) {
							res.writeHead(502, { "content-type": "application/json" });
							res.end(JSON.stringify({ error: "upstream error" }));
						} else if (!res.writableEnded) {
							res.end();
						}
					});
					// Streaming free models can exceed 30s; keep connection alive longer.
					proxy.setTimeout(300_000, () => {
						proxy.destroy(new Error("timeout"));
					});
					req.on("aborted", () => {
						if (!proxy.destroyed) proxy.destroy();
					});
					proxy.end(opencodeBody);
				}
			} catch (err) {
				log("error", "proxy error", { error: String(err) });
				if (!res.headersSent)
					res.writeHead(502, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: "internal error" }));
			}
		});
	});

	return new Promise((resolve, reject) => {
		// ponytail: auto-bump to next free port so multiple pi sessions on one
		// machine don't fight over 18080. cap at 20 to avoid infinite scan.
		// use server.address() for the real port: a failed listen()'s callback
		// still fires on the next successful listen, so the closure `port` is stale.
		let attempt = 0;
		let settled = false;
		const tryListen = (port: number) => {
			server.once("error", (err: NodeJS.ErrnoException) => {
				if (settled) return;
				if (err.code === "EADDRINUSE" && attempt < 20) {
					attempt++;
					log("warn", `port ${port} taken — trying ${port + 1}`);
					tryListen(port + 1);
					return;
				}
				settled = true;
				log("error", "server error", { code: err.code, message: err.message });
				reject(err);
			});
			server.listen(port, HOST, () => {
				if (settled) return;
				settled = true;
				const addr = server.address();
				const realPort = addr && typeof addr === "object" ? addr.port : port;
				log("info", `proxy listening on http://${HOST}:${realPort}`);
				resolve({ server, port: realPort });
			});
		};
		tryListen(basePort);
	});
}

// ── Main extension ─────────────────────────────────────────────────
// ponytail: factory may run during `omp install` / `pi --list-models` with no
// session — never listen here (open socket keeps the CLI process alive).
export default async function (pi: ExtensionAPI) {
	log("info", "extension loading...");
	let server: http.Server | undefined;

	// Health check opencode models
	log("info", `checking ${KNOWN_MODELS.length} opencode model(s)...`);
	const opencodeChecks = await Promise.all(
		KNOWN_MODELS.map(async (model) => {
			const alive = await checkModelAlive(model.id);
			if (alive) log("info", `✓ ${model.id} is alive`);
			else log("warn", `✗ ${model.id} is dead — skipping`);
			return { ...model, alive, source: "opencode" as const };
		}),
	);

	// Health check kilo models
	log("info", `checking ${KILO_MODELS.length} kilo model(s)...`);
	const kiloChecks = await Promise.all(
		KILO_MODELS.map(async (model) => {
			const alive = await checkKiloAlive(model.id);
			if (alive) log("info", `✓ ${model.id} (kilo) is alive`);
			else log("warn", `✗ ${model.id} (kilo) is dead — skipping`);
			return { ...model, alive, source: "kilo" as const };
		}),
	);

	const aliveModels = [...opencodeChecks, ...kiloChecks].filter((m) => m.alive);
	aliveCatalog = aliveModels;

	const registerBansos = (port: number) => {
		if (aliveModels.length === 0) return;
		pi.registerProvider("bansos", {
			baseUrl: `http://${HOST}:${port}/v1`,
			apiKey: "placeholder",
			api: "openai-completions",
			compat: { supportsDeveloperRole: false },
			models: aliveModels.map((m) => ({
				id: m.id,
				name: `${m.source === "kilo" ? "KiloCode" : "OpenCode"} · ${m.name}`,
				api: m.api,
				reasoning: m.reasoning,
				thinkingLevelMap: m.thinkingLevelMap,
				input: m.input ?? ["text"],
				contextWindow: m.contextWindow,
				maxTokens: m.maxTokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				compat: m.thinkingFormat
					? { supportsDeveloperRole: false, thinkingFormat: m.thinkingFormat }
					: m.api === "openai-responses"
						? { sessionAffinityFormat: "openai-nosession" }
						: m.source === "kilo"
							? { supportsDeveloperRole: false, supportsReasoningEffort: false }
							: { supportsDeveloperRole: false, supportsReasoningEffort: true },
			})),
		});
	};

	if (aliveModels.length === 0) {
		// Don't bail: still register /bansos below so the user can recover
		// (e.g. switch the relay off) instead of being stranded with no command.
		log(
			"warn",
			"no alive models found — provider inactive; /bansos still available to switch relay off / go direct",
		);
	} else {
		log(
			"info",
			`${aliveModels.length} model(s) registered: ${aliveModels.map((m) => m.id).join(", ")}`,
		);
		registerBansos(PORT);
	}

	// ── /bansos command: toggle relay egress live (on|off|status|url [URL]) ───
	pi.registerCommand("bansos", {
		description:
			"Relay egress: on | off | status | url [URL] | deploy | list | use <URL> | remove <URL>",
		getArgumentCompletions: (prefix: string) =>
			["on", "off", "status", "url", "deploy", "list", "use", "remove"]
				.filter((s) => s.startsWith(prefix))
				.map((s) => ({ value: s, label: s })),
		handler: async (args: string, ctx) => {
			const parts = String(args || "")
				.trim()
				.split(/\s+/);
			const sub = parts[0] || "";
			const rest = parts.slice(1).join(" ");

			const flash = () =>
				ctx.ui.notify(
					`Relay ${relayState.enabled ? "ON" : "OFF"}${relayState.enabled ? ` → ${relayState.url}` : " (direct)"} | hits=${relayHits} | saved=${relayState.relays.length}`,
					"info",
				);
			const persist = () => {
				saveRelayState(relayState);
				ctx.ui.setStatus(
					"bansos",
					`relay: ${relayState.enabled ? "ON" : "OFF"}`,
				);
			};
			// mutate in place so the saved-relays list is preserved across switches
			const setRelay = (enabled: boolean, url: string, addLabel?: string) => {
				relayState.enabled = enabled;
				relayState.url = (url || "").trim() || DEFAULT_RELAY_URL;
				if (relayState.url) ensureRelay(relayState, relayState.url, addLabel);
			};
			const doDeploy = async () => {
				// Token prompted (not stored). pi's input has no secret mode — shows while typing.
				const defaultName = `relay-${Date.now().toString(36)}`;
				const token = (
					await ctx.ui.input("Vercel API token (vercel-…):", "")
				)?.trim();
				if (!token) {
					ctx.ui.notify("Deploy cancelled — no token", "warning");
					return;
				}
				const name =
					(
						await ctx.ui.input("Project name (empty = auto):", defaultName)
					)?.trim() || defaultName;
				ctx.ui.setStatus("bansos", "deploying relay…");
				try {
					const url = await deployVercelRelay(token, name, (m) =>
						ctx.ui.notify(m, "info"),
					);
					setRelay(true, url, `deployed ${name}`);
					persist();
					ctx.ui.notify(`✓ Deployed & active: ${url}`, "info");
				} catch (e) {
					ctx.ui.setStatus(
						"bansos",
						`relay: ${relayState.enabled ? "ON" : "OFF"}`,
					);
					ctx.ui.notify(`Deploy failed: ${(e as Error).message}`, "error");
				}
			};
			const switchRelay = async () => {
				if (!relayState.relays.length) {
					ctx.ui.notify("No saved relays yet", "warning");
					return;
				}
				const fmt = (r: KnownRelay) =>
					`${r.url === relayState.url ? "★ " : "  "}${r.url}${r.label ? `  (${r.label})` : ""}`;
				const opts = relayState.relays.map(fmt);
				const choice = await ctx.ui.select("Switch relay", opts);
				if (!choice) return;
				const match = relayState.relays.find((r) => fmt(r) === choice);
				if (!match) return;
				setRelay(true, match.url);
				persist();
				flash();
			};
			const showList = () => {
				if (!relayState.relays.length) {
					ctx.ui.notify("No saved relays", "info");
					return;
				}
				const lines = relayState.relays.map(
					(r) =>
						`${r.url === relayState.url ? "★" : " "} ${r.url}${r.label ? `  [${r.label}]` : ""}`,
				);
				ctx.ui.notify(
					`Saved relays (${relayState.relays.length}):\n${lines.join("\n")}`,
					"info",
				);
			};
			const removeRelayMenu = async () => {
				const removable = relayState.relays.filter(
					(r) => r.url !== relayState.url,
				);
				if (!removable.length) {
					ctx.ui.notify(
						"Nothing to remove — the active relay can't be removed (switch first)",
						"warning",
					);
					return;
				}
				const fmt = (r: KnownRelay) =>
					`${r.url}${r.label ? `  (${r.label})` : ""}`;
				const choice = await ctx.ui.select("Remove relay", removable.map(fmt));
				if (!choice) return;
				const match = removable.find((r) => fmt(r) === choice);
				if (!match) return;
				removeRelay(relayState, match.url);
				persist();
				ctx.ui.notify(`Removed: ${match.url}`, "info");
			};

			if (sub === "on") {
				setRelay(true, relayState.url || DEFAULT_RELAY_URL);
				persist();
				flash();
			} else if (sub === "off") {
				relayState.enabled = false;
				persist();
				flash();
			} else if (sub === "status") {
				flash();
			} else if (sub === "list") {
				showList();
			} else if (sub === "use") {
				const url = (
					rest ||
					(await ctx.ui.input("Relay URL to activate:", "")) ||
					""
				).trim();
				if (!url) {
					ctx.ui.notify("No URL given", "warning");
					return;
				}
				setRelay(true, url, "manual");
				persist();
				flash();
			} else if (sub === "remove") {
				const url = (
					rest ||
					(await ctx.ui.input("Relay URL to remove:", "")) ||
					""
				).trim();
				if (!url) {
					ctx.ui.notify("No URL given", "warning");
					return;
				}
				if (url === relayState.url) {
					ctx.ui.notify(
						"Can't remove the active relay — switch first",
						"warning",
					);
					return;
				}
				if (!relayState.relays.some((r) => r.url === url)) {
					ctx.ui.notify("Not in saved list", "warning");
					return;
				}
				removeRelay(relayState, url);
				persist();
				ctx.ui.notify(`Removed: ${url}`, "info");
			} else if (sub === "url") {
				const input =
					rest ||
					(await ctx.ui.input(
						"Relay URL (empty = default):",
						relayState.url || DEFAULT_RELAY_URL,
					));
				setRelay(
					relayState.enabled,
					(input || "").trim() || DEFAULT_RELAY_URL,
					"manual",
				);
				persist();
				flash();
			} else if (sub === "deploy") {
				await doDeploy();
			} else {
				const choice = await ctx.ui.select("bansos relay", [
					`Relay: ${relayState.enabled ? "ON" : "OFF"} → ${relayState.url || "direct"}`,
					"Turn ON",
					"Turn OFF",
					"Switch relay…",
					"Remove relay…",
					"Set URL",
					"Deploy Vercel relay…",
					"List saved relays",
				]);
				if (choice === "Turn ON") {
					setRelay(true, relayState.url || DEFAULT_RELAY_URL);
					persist();
					flash();
				} else if (choice === "Turn OFF") {
					relayState.enabled = false;
					persist();
					flash();
				} else if (choice === "Switch relay…") {
					await switchRelay();
				} else if (choice === "Remove relay…") {
					await removeRelayMenu();
				} else if (choice === "Set URL") {
					const input = await ctx.ui.input(
						"Relay URL (empty = default):",
						relayState.url || DEFAULT_RELAY_URL,
					);
					setRelay(
						relayState.enabled,
						(input || "").trim() || DEFAULT_RELAY_URL,
						"manual",
					);
					persist();
					flash();
				} else if (choice === "Deploy Vercel relay…") {
					await doDeploy();
				} else if (choice === "List saved relays") {
					showList();
				}
			}
		},
	});

	// Bind proxy only when a session actually starts (not during install/list-models).
	pi.on("session_start", async (_event, ctx) => {
		if (!server) {
			try {
				const r = await startProxy();
				server = r.server;
				if (r.port !== PORT) registerBansos(r.port);
			} catch {
				log(
					"error",
					"proxy inactive — could not bind port. resolve the conflict and restart.",
				);
			}
		}
		relayState = resolveRelayState();
		ctx.ui?.setStatus?.(
			"bansos",
			`relay: ${relayState.enabled ? "ON" : "OFF"}`,
		);
		log(
			"info",
			`relay ${relayState.enabled ? "ON" : "OFF"} → ${relayState.url || "direct"}`,
		);
	});

	// Pi normally pauses after threshold compaction. Queue a follow-up while the
	// original run is still active so the core agent continues automatically.
	pi.on("session_compact", (event, ctx) => {
		if (
			event.reason !== "threshold" ||
			event.willRetry ||
			ctx.isIdle() ||
			ctx.hasPendingMessages()
		) {
			return;
		}
		pi.sendUserMessage(
			"Continue the current task from the compacted context. Do not wait for another user message; proceed with the next required step.",
			{ deliverAs: "followUp" },
		);
	});

	pi.on("session_shutdown", () => {
		if (!server) return;
		log("info", "shutting down proxy...");
		server.close();
		server = undefined;
		rateLimitMap.clear();
		log("info", "shutdown complete");
	});
}
