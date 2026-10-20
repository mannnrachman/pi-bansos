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
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Configuration ──────────────────────────────────────────────────
const UPSTREAM_OPENCODE = "https://opencode.ai";
// OpenCode moved the free tier off /zen/v1 (gate 2026-10-14, 1.19.0+):
// /zen/v1/* now 403s every free request. /inference/v1 is the live surface.
// /zen/v1/models still answers 200 and stays our catalog source.
const UPSTREAM_OPENCODE_INFERENCE = "https://opencode.ai/inference/v1";
// KiloCode gateway — OpenAI-compatible; free models are keyless (200 req/hr per IP)
const KILO_CHAT_URL = "https://api.kilo.ai/api/gateway/chat/completions";
const PORT = Number(process.env.BANSOS_PORT) || 18080;
// Startup health lines go to stderr and bury `pi -p` output. Quiet unless asked.
const BANSOS_DEBUG = process.env.BANSOS_DEBUG === "1";
const HOST = "127.0.0.1";
const API = "https://opencode.ai/zen/v1"; // models catalog only — chat moved to /inference/v1

// OpenCode Zen free-tier client fingerprint (verified live 2026-09-18).
// Missing any one → 403 FreeTierError.
// UA version tracks the live opencode-ai npm release:
// env override > live version > disk cache > pinned fallback. The gate has
// rejected stale UA versions before; auto-refresh keeps us off that cliff.
const OPENCODE_UA_FALLBACK = "1.18.31";
const OPENCODE_UA_VERSION_RE = /^\d+\.\d+\.\d+$/;
const OPENCODE_USER_AGENT_ENV = "BANSOS_OPENCODE_UA";
const BASE62 =
	"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
// v2 gate (2026-10-14, live-bisected): the payload must carry opencode's own
// `read` + `shell` tools with EXACT description and parameters schema (source:
// opencode packages/core/src/tool/plugin/{read,shell}.ts @ dev). Stub
// descriptions or partial schemas → 403. Extra caller tools are fine EXCEPT
// when their name collides with a real opencode tool (bash/glob/grep/edit/
// write/patch/webfetch/…) — those get aliased with a `_pi` suffix on the wire.
const OPENCODE_EXACT_TOOLS = [
	{
		type: "function",
		function: {
			name: "read",
			description:
				"Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string", description: "File or directory to read" },
					offset: { type: "number", description: "The line or directory entry to start reading from (1-based)" },
					limit: { type: "number", description: "The maximum number of lines or directory entries to read (defaults to and capped at 2000)" },
				},
				required: ["path"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "shell",
			description:
				"Execute a shell command and return its output. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.",
			parameters: {
				type: "object",
				properties: {
					command: { type: "string", description: "Shell command string to execute" },
					workdir: { type: "string", description: "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead." },
					timeout: { type: "number", description: "Timeout in milliseconds. Set to 0 to disable the timeout." },
					background: { type: "boolean", description: "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion." },
				},
				required: ["command"],
			},
		},
	},
] as const;
// Real opencode tool names — a caller tool with one of these names would
// shadow/break the gate check, so it travels under an alias instead.
const OPENCODE_TOOL_NAMES = new Set([
	"read", "shell", "bash", "glob", "grep", "edit", "write", "patch",
	"webfetch", "websearch", "question", "skill", "subagent", "todowrite",
	"mcp-resource", "opencode",
]);
// Project id: zen clients send a 40-char hex project hash; a bare "global"
// still passes today but hex is the shape real clients emit — cheap
// insurance against a stricter gate.
const OPENCODE_PROJECT_ID = randomBytes(20).toString("hex");
const OPENCODE_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
// Muse went 410-deprecated in the 2026-10-20 sweep; the set and the
// `includes("muse-spark")` fallback in transformOpencodeBody stay so a
// returning muse-class model re-routes to /responses with no code change.
const OPENCODE_RESPONSES_MODELS = new Set<string>([
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

// Bit-exact port of opencode's Identifier.create() (packages/schema/src/
// identifier.ts, verified 1.19.0): value = descending ? ~(ts*4096+counter)
// : ts*4096+counter; prefix = low 48 bits as 12-hex. The mask here is
// equivalent to upstream's byte-slicing of the (possibly negative) bigint.
const OPENCODE_ID_MASK = (1n << 48n) - 1n;

function timeHexFrom(value: bigint): string {
	const v = value & OPENCODE_ID_MASK;
	return Array.from({ length: 6 }, (_, i) =>
		Number((v >> BigInt(40 - 8 * i)) & 0xffn)
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
	// Identifier.descending("session")
	const current = BigInt(timestamp) * 0x1000n + BigInt(sessionCounter);
	return `ses_${timeHexFrom(~current)}${unstableRandom()}`;
}

function generateRequestId(timestamp = Date.now()): string {
	// Identifier.ascending("message")
	const current = BigInt(timestamp) * 0x1000n + 1n;
	return `msg_${timeHexFrom(current)}${unstableRandom()}`;
}

// One stable session per process — shape must match OPENCODE_SESSION_RE.
const OPENCODE_SESSION = generateSessionId();
if (!OPENCODE_SESSION_RE.test(OPENCODE_SESSION)) {
	throw new Error("opencode session id generation failed shape check");
}

// Live UA resolution — offline-safe, never throws, never blocks.
// Precedence: env override > in-process live version > disk cache > pinned.
let liveOpenCodeVersion: string | null = null;
function getOpenCodeUA(): string {
	const override = process.env[OPENCODE_USER_AGENT_ENV]?.trim();
	if (override) return override.startsWith("opencode/") ? override : `opencode/${override}`;
	if (liveOpenCodeVersion && OPENCODE_UA_VERSION_RE.test(liveOpenCodeVersion))
		return `opencode/${liveOpenCodeVersion}`;
	return `opencode/${OPENCODE_UA_FALLBACK}`;
}
function uaVersionCacheFile(): string | null {
	try {
		return path.join(agentStateDir(), "bansos-opencode-version.json");
	} catch {
		return null;
	}
}
/** Fire-and-forget: track the live opencode-ai npm version so the gate never
 *  sees a stale UA. Failure keeps the pinned fallback. */
async function refreshOpenCodeUA(): Promise<void> {
	if (process.env[OPENCODE_USER_AGENT_ENV]?.trim()) return;
	try {
		const r = await fetch("https://registry.npmjs.org/opencode-ai/latest", {
			signal: AbortSignal.timeout(10_000),
		});
		if (!r.ok) return;
		const version = ((await r.json()) as { version?: unknown })?.version;
		if (typeof version !== "string" || !OPENCODE_UA_VERSION_RE.test(version)) return;
		if (version === liveOpenCodeVersion) return;
		liveOpenCodeVersion = version;
		const file = uaVersionCacheFile();
		if (file) {
			try {
				fs.mkdirSync(path.dirname(file), { recursive: true });
				fs.writeFileSync(file, JSON.stringify({ version, checkedAt: Date.now() }), {
					mode: 0o600,
				});
			} catch {}
		}
		log("info", "opencode UA version refreshed", { version });
	} catch {
		// offline / npm unreachable — pinned fallback keeps working
	}
}

function opencodeHeaders(withRequestHeader = false): Record<string, string> {
	const traceId = randomBytes(16).toString("hex");
	const spanId = randomBytes(8).toString("hex");
	const headers: Record<string, string> = {
		"User-Agent": getOpenCodeUA(),
		Authorization: "Bearer public",
		"x-opencode-client": "desktop",
		"x-opencode-project": OPENCODE_PROJECT_ID,
		"x-opencode-session": OPENCODE_SESSION,
		// v2 gate (2026-10-14): BOTH session headers must be present and equal.
		"x-opencode-session-id": OPENCODE_SESSION,
		"x-session-affinity": OPENCODE_SESSION,
		// Distributed-tracing headers real opencode clients emit.
		b3: `${traceId}-${spanId}-1-${spanId}`,
		traceparent: `00-${traceId}-${spanId}-01`,
		Accept: "text/event-stream",
	};
	// v2 gate REJECTS any x-opencode-request value — only sent when a caller
	// explicitly opts in (currently nothing does; kept for catalog calls that
	// still hit the v1 surface).
	if (withRequestHeader) headers["x-opencode-request"] = generateRequestId();
	return headers;
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
	if (!Array.isArray(body.tools)) body.tools = [];
	// 1) Alias caller tools whose names collide with real opencode tools —
	// the v2 gate 403s a payload carrying e.g. `bash` next to the exact pair.
	// `*_pi` on the wire; model replies referencing `bash_pi` are mapped back
	// in the response path (stripResponseAliases).
	const wireToCaller = new Map<string, string>();
	body.tools = (body.tools as unknown[]).map((tool) => {
		const name = toolNameOf(tool);
		if (!name || !OPENCODE_TOOL_NAMES.has(name.toLowerCase())) return tool;
		const alias = `${name}_pi`;
		wireToCaller.set(alias, name);
		if (tool && typeof tool === "object" && !Array.isArray(tool)) {
			const t = tool as Record<string, unknown>;
			if (t.function && typeof t.function === "object")
				(t.function as Record<string, unknown>).name = alias;
			else if (typeof t.name === "string") t.name = alias;
		}
		return tool;
	});
	if (wireToCaller.size) body.__bansosToolAliases = Object.fromEntries(wireToCaller);
	// 2) Append the exact opencode read+shell definitions (skipping any that
	// the caller already declared verbatim — the alias pass renames those).
	const present = new Set<string>();
	for (const tool of body.tools as unknown[]) {
		const name = toolNameOf(tool);
		if (name) present.add(name);
	}
	for (const t of OPENCODE_EXACT_TOOLS) {
		if (present.has(t.function.name)) continue;
		(body.tools as unknown[]).push(structuredClone(t));
	}
}

function ensureResponsesFingerprintTools(body: Record<string, unknown>): void {
	const present = new Set<string>();
	if (!Array.isArray(body.tools)) body.tools = [];
	for (const tool of body.tools as unknown[]) {
		const name = toolNameOf(tool);
		if (name) present.add(name);
	}
	for (const t of OPENCODE_EXACT_TOOLS) {
		const name = t.function.name;
		if (present.has(name)) continue;
		(body.tools as unknown[]).push({
			type: "function",
			name,
			description: t.function.description,
			parameters: t.function.parameters,
		});
	}
	// Responses wire rejects tool_choice:"none" (400 only-"auto"-supported);
	// injected calls are instead cloaked downstream when they appear.
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

/** Rewrite OpenCode free-tier request body to pass Zen client fingerprint gates.
 * Returns the upstream path segment to use ("/inference/v1/responses" for
 * muse-class Responses models, else chat completions under the inbound path). */
function transformOpencodeBody(
	body: Record<string, unknown>,
): { body: Record<string, unknown>; responsesPath: boolean } {
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
		return { body, responsesPath: true };
	}
	ensureChatFingerprintTools(body);
	return { body, responsesPath: false };
}

// ── Relay egress (vercel/cloudflare worker, x-relay-target pattern) ──────────
// When enabled, redirect upstream calls to a relay URL and inject
// x-relay-target / x-relay-path headers. Body untouched →
// SSE streaming passes through unchanged. Toggle live via /bansos command.
// No built-in default relay — a published package must not bake in any one
// user's personal relay URL. Bring your own via /bansos deploy or /bansos url.
const DEFAULT_RELAY_URL = "";
// State lives OUTSIDE the package dir so npm updates don't wipe it.
// Path follows the host that loaded the extension: pi → ~/.pi/agent/,
// OMP → ~/.omp/agent/. Two-layer detection because OMP installs are often
// symlinks to a repo (Node resolves those to the real path):
//   1. the extension's own install path, when it clearly sits under .pi/.omp
//   2. an explicit host marker (process title / argv of the running CLI)
// Otherwise (repo checkout, dev) fall back to ~/.pi/agent/.
function agentStateDir(): string {
	const home = homedir();
	const piDir = path.join(home, ".pi", "agent");
	const ompDir = path.join(home, ".omp", "agent");
	try {
		const self = fileURLToPath(import.meta.url);
		// realpath resolves symlinks inside the tree (e.g. OMP plugin symlinks)
		const real = fs.realpathSync(self);
		if (real.startsWith(`${piDir}${path.sep}`)) return piDir;
		if (real.startsWith(`${ompDir}${path.sep}`)) return ompDir;
	} catch {}
	const cmd = `${process.argv.join(" ")} ${process.title}`.toLowerCase();
	const basenames = process.argv
		.map((a) => path.basename(a).replace(/\.(js|mjs|cjs|ts)$/i, ""))
		.concat(process.title.replace(/\.(js|mjs|cjs|ts)$/i, ""));
	if (basenames.includes("omp")) return ompDir;
	return piDir;
}
function resolveRelayStatePath(): string {
	try {
		return path.join(
			agentStateDir(),
			"pi-bansos-relay-state.json",
		);
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

type KnownRelay = {
	url: string;
	label?: string;
	addedAt?: string;
	/** Shared secret for hardened workers (x-relay-auth). Empty = legacy relay. */
	auth?: string;
};
// TUI status-bar entry for the relay/proxy state; display preference only.
type StatusBar = "shown" | "hidden";
type RelayState = {
	enabled: boolean;
	url: string;
	relays: KnownRelay[];
	statusBar: StatusBar;
};
function loadRelayState(): RelayState {
	try {
		const s = JSON.parse(fs.readFileSync(RELAY_STATE_FILE, "utf8"));
		const relays: KnownRelay[] = Array.isArray(s?.relays) ? s.relays : [];
		return {
			enabled: Boolean(s?.enabled),
			url: typeof s?.url === "string" ? s.url.trim() : "",
			relays,
			statusBar: s?.statusBar === "hidden" ? "hidden" : "shown",
		};
	} catch {
		return { enabled: false, url: "", relays: [], statusBar: "shown" };
	}
}
type SaveResult = { ok: true } | { ok: false; error: string };
function saveRelayState(s: RelayState): SaveResult {
	// Other processes re-read this file on every change: write a temp file
	// and rename so they never see a half-written one.
	const tmp = `${RELAY_STATE_FILE}.${process.pid}.tmp`;
	try {
		fs.mkdirSync(path.dirname(RELAY_STATE_FILE), { recursive: true });
		fs.writeFileSync(tmp, JSON.stringify(s));
		fs.renameSync(tmp, RELAY_STATE_FILE);
		return { ok: true };
	} catch (e) {
		fs.rmSync(tmp, { force: true });
		log("warn", "could not persist relay state", { error: String(e) });
		return { ok: false, error: String(e) };
	}
}
// dedupe-add a relay to the known list (auth: shared secret for hardened workers)
function ensureRelay(s: RelayState, url: string, label?: string, auth?: string): void {
	if (!url) return;
	const existing = s.relays.find((r) => r.url === url);
	if (existing) {
		if (auth) existing.auth = auth;
		return;
	}
	s.relays.push({
		url,
		label,
		addedAt: new Date().toISOString(),
		...(auth ? { auth } : {}),
	});
}
function removeRelay(s: RelayState, url: string): void {
	s.relays = s.relays.filter((r) => r.url !== url);
}
function resolveRelayState(): RelayState {
	const s = loadRelayState();
	// migrate legacy {enabled,url}: seed the known list with default + active url
	if (!s.relays.length) {
		ensureRelay(s, DEFAULT_RELAY_URL, "default relay");
		if (s.url && s.url !== DEFAULT_RELAY_URL) ensureRelay(s, s.url, "previous");
	}
	if (!s.url) s.url = DEFAULT_RELAY_URL;
	return s;
}
let relayState: RelayState = resolveRelayState();
let relayHits = 0;

// ── Relay pool health & failover ───────
// A relay that 429s is out of quota for now. Vercel relays share one NAT
// egress pool, so extra relays do NOT add IP diversity — the value here is
// failover (roll to another relay / direct) and not hammering a dead one.
type RelayHealth = { consecutiveFailures: number; cooldownUntil: number };
const relayHealth = new Map<string, RelayHealth>();
function markRelaySuccess(url: string): void {
	relayHealth.delete(url);
}
function markRelayFailure(url: string, status?: number): void {
	const prev = relayHealth.get(url) ?? { consecutiveFailures: 0, cooldownUntil: 0 };
	const consecutive = prev.consecutiveFailures + 1;
	// 429 = quota hit: give it a real rest (90s base). 403 = egress IP flagged
	// by the upstream IP gate: same rest. Transport errors / 5xx are usually
	// transient: 30s. Escalate ×2 per consecutive failure so a dead relay
	// stops being re-hammered (cap 15 min).
	const base = status === 429 || status === 403 ? 90_000 : 30_000;
	const cooldownMs = Math.min(base * 2 ** (consecutive - 1), 15 * 60_000);
	relayHealth.set(url, {
		consecutiveFailures: consecutive,
		cooldownUntil: Date.now() + cooldownMs,
	});
	log("warn", "relay cooling down", { url, status: status ?? 0, cooldownMs });
}
function relayHealthy(url: string): boolean {
	const h = relayHealth.get(url);
	return !h || h.cooldownUntil <= Date.now();
}
/** Active relay first, then other known healthy relays, cooling ones last. */
function orderedRelayCandidates(): string[] {
	const urls = relayState.relays.map((r) => r.url).filter(Boolean);
	const ordered = urls.filter(relayHealthy);
	if (relayState.url) {
		const i = ordered.indexOf(relayState.url);
		if (i > 0) {
			ordered.splice(i, 1);
			ordered.unshift(relayState.url);
		}
	}
	return [...ordered, ...urls.filter((u) => !relayHealthy(u))];
}

// Catalog served at GET /v1/models — ONLY the alive free models we register.
// Set after health checks. Prevents paid/other upstream models from leaking
// through the proxy's /v1/models (opencode returns 60 models incl. 54 paid).
type RegisteredModel = ModelDef & { source: Upstream };
let aliveCatalog: RegisteredModel[] = [];

// Relay-aware fetch. Direct when disabled; otherwise try the relay pool in
// health order (rolling failover on 429/403-relay/5xx/socket errors) and fall
// back to direct only when every relay failed. The response body is consumed
// by the caller; failures are detected via status + copy of the body text.
// A 403 through a relay is attributed to the relay (its egress IP may be
// flagged by OpenCode's IP gate — distinct from a fingerprint FreeTierError,
// which 403s identically on every egress); it cools down and rolls once.
async function relayFetch(
	url: string,
	opts: RequestInit = {},
): Promise<Response> {
	if (!relayState.enabled) return fetch(url, opts);
	const candidates = orderedRelayCandidates();
	if (candidates.length === 0) return fetch(url, opts);
	const u = new URL(url);
	let lastError: unknown = null;
	for (const relay of candidates) {
		try {
			relayHits++;
			const headers = new Headers(opts.headers);
			headers.set("x-relay-target", `${u.protocol}//${u.host}`);
			headers.set("x-relay-path", `${u.pathname}${u.search}`);
			const relayAuth = relayState.relays.find((r) => r.url === relay)?.auth;
			if (relayAuth) headers.set("x-relay-auth", relayAuth);
			const res = await fetch(relay, { ...opts, headers });
			// 401 from a hardened worker = auth mismatch; distinct from the
			// upstream's own 401 (which reaches us as a 401 relay RESPONSE
			// body passthrough — but a bare 401 from the worker itself means
			// our stored secret is wrong/absent). Treat like a client error:
			// rolling won't fix the payload, surface it.
			if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 408 && res.status !== 403)) {
				// Success, or a client error that is OUR payload's fault (400/
				// 401/404…) — rolling to another relay would replay the same
				// failure. 4xx-except-429/408/403 returns as-is.
				markRelaySuccess(relay);
				return res;
			}
			// 429/408/403/5xx: this egress IP is limited/flagged or the relay
			// is unhealthy — cool it down and roll to the next candidate.
			markRelayFailure(relay, res.status);
			// Drain the error body so the socket is released before retrying.
			await res.arrayBuffer().catch(() => undefined);
			lastError = new Error(`relay ${relay} → HTTP ${res.status}`);
		} catch (e) {
			markRelayFailure(relay);
			lastError = e;
		}
	}
	log("warn", "all relays failed, falling back to direct", {
		url,
		error: String(lastError),
	});
	return fetch(url, opts);
}

// ── Deploy a fresh Vercel relay ──────────────────────────────────────────────
// Token is used in-memory only and NEVER persisted. Resulting URL is saved to
// the relay state and activated. Worker uses the x-relay-target/x-relay-path
// pattern — a standard edge worker fetch pass-through.
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
	// 3. poll until READY (3s interval, 120s timeout)
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

// ── Deploy a fresh Cloudflare Workers relay ─────────────────────────────────
// Token is used in-memory only and NEVER persisted. Deploy flow (accounts →
// PUT module worker → enable workers.dev routing → read account subdomain →
// assemble URL; delete the script on any post-upload failure so no worker
// with an embedded secret lingers). Deploy design adapted from
// trefeon/pi-freeflow (MIT) — https://github.com/trefeon/pi-freeflow
const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

/** Worker script names: [a-z0-9-] (also [a-z0-9_], max 58 chars). */
function cloudflareScriptName(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 58);
	return slug || `bansos-relay-${Date.now().toString(36)}`;
}

/** Hardened relay core: per-deploy 32-byte secret (x-relay-auth, constant-time
 * compare), method/payload guards, private-host + embedded-credential checks,
 * and an allowlist of exactly the two upstreams pi-bansos talks to. */
function buildCloudflareRelayWorker(relayAuth: string): string {
	return `// pi-bansos relay (cloudflare). Allowlist only — anything else is abuse.
const ALLOWED_TARGETS = ["https://opencode.ai", "https://api.kilo.ai"];
const RELAY_AUTH = ${JSON.stringify(relayAuth)};
const DENY_HEADERS = ["host", "connection", "content-length", "keep-alive", "proxy-connection", "proxy-authenticate", "proxy-authorization", "transfer-encoding", "te", "trailer", "upgrade", "x-relay-target", "x-relay-path"];
function timingSafeEqualStr(a, b) {
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
const json = (error, status) => new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json" } });
export default {
  async fetch(request) {
    if (!["GET", "POST", "HEAD", "OPTIONS"].includes(request.method)) return json("Method Not Allowed", 405);
    if (Number(request.headers.get("content-length") || 0) > 32 * 1024 * 1024) return json("Payload Too Large", 413);
    if (!RELAY_AUTH || !timingSafeEqualStr(request.headers.get("x-relay-auth") || "", RELAY_AUTH)) return json("unauthorized", 401);
    const target = request.headers.get("x-relay-target");
    if (!target) return json("Missing x-relay-target header", 400);
    let targetUrl;
    try { targetUrl = new URL(target); } catch { return json("invalid x-relay-target", 400); }
    if (targetUrl.protocol !== "https:") return json("forbidden x-relay-target protocol", 403);
    if (targetUrl.username || targetUrl.password) return json("forbidden x-relay-target (embedded credentials)", 403);
    const host = targetUrl.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".internal."))
      return json("forbidden x-relay-target (private/loopback host)", 403);
    if (host.includes(":") && (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe8") || host.startsWith("fe9") || host.startsWith("fea") || host.startsWith("feb")))
      return json("forbidden x-relay-target (private/loopback host)", 403);
    const v4 = host.match(/^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$/);
    if (v4) {
      const [a, b] = [Number(v4[1]), Number(v4[2])];
      if (a === 0 || a === 10 || a === 127) return json("forbidden x-relay-target (private/loopback host)", 403);
      if (a === 169 && b === 254) return json("forbidden x-relay-target (private/loopback host)", 403);
      if (a === 192 && b === 168) return json("forbidden x-relay-target (private/loopback host)", 403);
      if (a === 172 && b >= 16 && b <= 31) return json("forbidden x-relay-target (private/loopback host)", 403);
      if (a === 100 && b >= 64 && b <= 127) return json("forbidden x-relay-target (private/loopback host)", 403);
    }
    const cleanTarget = target.replace(/\\/$/, "");
    if (!ALLOWED_TARGETS.includes(cleanTarget)) return json("Forbidden target", 403);
    const relayPath = request.headers.get("x-relay-path") || "/";
    if (typeof relayPath !== "string" || relayPath.includes("@") || relayPath.includes("\\\\") || !relayPath.startsWith("/"))
      return json("forbidden x-relay-path", 403);
    let finalUrl;
    try { finalUrl = new URL(relayPath, targetUrl); } catch { return json("forbidden x-relay-path", 403); }
    if (finalUrl.hostname !== targetUrl.hostname || finalUrl.protocol !== targetUrl.protocol || finalUrl.port !== targetUrl.port || finalUrl.username || finalUrl.password)
      return json("forbidden x-relay-path (host mismatch)", 403);
    const headers = new Headers(request.headers);
    for (const h of DENY_HEADERS) headers.delete(h);
    headers.delete("x-relay-auth");
    try {
      const init = { method: request.method, headers };
      if (request.method !== "GET" && request.method !== "HEAD") { init.body = request.body; init.duplex = "half"; }
      const response = await fetch(finalUrl.toString(), init);
      return new Response(response.body, { status: response.status, headers: response.headers });
    } catch (error) {
      return json(String(error), 502);
    }
  },
};`;
}

async function cloudflareError(action: string, res: Response): Promise<Error> {
	const j = (await res
		.json()
		.catch(() => ({}))) as {
		errors?: Array<{ message?: string; code?: number }>;
	};
	const detail =
		j.errors
			?.map((e) => e.message)
			.filter(Boolean)
			.join("; ") || `HTTP ${res.status}`;
	if (res.status === 401 || res.status === 403)
		return new Error(
			`Cloudflare authentication failed while trying to ${action}: ${detail}. Check that your API token is valid and has Workers permissions.`,
		);
	if (res.status === 429)
		return new Error(
			`Cloudflare plan or usage limit hit while trying to ${action}: ${detail}. Check your Workers plan limits.`,
		);
	return new Error(`Failed to ${action} (HTTP ${res.status}): ${detail}`);
}

async function deployCloudflareRelay(
	token: string,
	name: string,
	onProgress?: (msg: string) => void,
): Promise<{ url: string; auth: string }> {
	const auth = { Authorization: `Bearer ${token}` };
	const scriptName = cloudflareScriptName(name);

	// 1. resolve the account scoped to this token
	onProgress?.("Resolving Cloudflare account…");
	const accRes = await fetch(`${CLOUDFLARE_API}/accounts`, { headers: auth });
	if (!accRes.ok) throw await cloudflareError("resolve Cloudflare account", accRes);
	const accJson = (await accRes.json()) as { result?: Array<{ id?: string }> };
	const accountId = accJson.result?.[0]?.id;
	if (!accountId) throw new Error("No Cloudflare account is accessible with this API token");

	// 2. upload the module worker (multipart: main module + metadata).
	// Private by default: mint a per-deployment secret embedded in the worker.
	// The client must send it back as x-relay-auth on every relayed request.
	onProgress?.("Uploading relay worker to Cloudflare…");
	const relayAuth = randomBytes(32).toString("hex");
	const formData = new FormData();
	formData.append(
		"index.js",
		new Blob([buildCloudflareRelayWorker(relayAuth)], {
			type: "application/javascript+module",
		}),
		"index.js",
	);
	formData.append(
		"metadata",
		new Blob(
			[
				JSON.stringify({
					main_module: "index.js",
					compatibility_date: "2024-03-20",
					observability: { enabled: true },
				}),
			],
			{ type: "application/json" },
		),
		"metadata.json",
	);
	const uploadRes = await fetch(
		`${CLOUDFLARE_API}/accounts/${accountId}/workers/scripts/${scriptName}`,
		{ method: "PUT", headers: auth, body: formData },
	);
	if (!uploadRes.ok) throw await cloudflareError("upload Worker to Cloudflare", uploadRes);

	// 3. enable workers.dev routing (non-fatal — some accounts pre-enable it)
	try {
		await fetch(
			`${CLOUDFLARE_API}/accounts/${accountId}/workers/scripts/${scriptName}/subdomain`,
			{
				method: "POST",
				headers: { ...auth, "Content-Type": "application/json" },
				body: JSON.stringify({ enabled: true }),
			},
		);
	} catch {}

	// 4. read the account-level workers.dev subdomain to assemble the public
	// URL. The script is already uploaded, so any failure below deletes it —
	// otherwise an unreachable worker (with its embedded secret) lingers.
	onProgress?.("Reading workers.dev routing…");
	const deleteScript = () =>
		fetch(
			`${CLOUDFLARE_API}/accounts/${accountId}/workers/scripts/${scriptName}`,
			{ method: "DELETE", headers: auth },
		).catch(() => undefined);
	let subRes: Response;
	try {
		subRes = await fetch(`${CLOUDFLARE_API}/accounts/${accountId}/workers/subdomain`, {
			headers: auth,
		});
	} catch (e) {
		await deleteScript();
		throw e;
	}
	if (!subRes.ok) {
		const err = await cloudflareError("retrieve workers.dev subdomain", subRes);
		await deleteScript();
		throw err;
	}
	const subJson = (await subRes.json()) as { result?: { subdomain?: string } };
	const subdomain = subJson.result?.subdomain;
	if (!subdomain) {
		await deleteScript();
		throw new Error(
			"Worker deployed but workers.dev subdomain is unavailable. Enable a workers.dev subdomain for your account in the Cloudflare dashboard.",
		);
	}
	onProgress?.("Relay live — you're behind Cloudflare's egress now");
	return { url: `https://${scriptName}.${subdomain}.workers.dev`, auth: relayAuth };
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
// Sweep 2026-10-20: upstream deprecated muse-spark-1.3/1.2, space-bunny (410,
// "use minimax-m3.1-flash-free instead") and ll-alpha (410); step-5-preview,
// ling-3.0/3.1 are gone upstream (400 "Model is unavailable"). Added beam-free
// and minimax-m3.1-flash-free — catalog-listed today but NOT chat-verified:
// our test IP hit the new IP-level gate (403 "abusive traffic from this IP
// address", distinct from FreeTierError). Fingerprint itself passes (410/400
// responses prove the gate let the request through).
// Previously: 2026-10-16 chat-verified the dropped entries; exo-free (410),
// jev-1.13-free (protocol unsupported), deepseek-v4-flash-free (400) rejected.
const KNOWN_MODELS: ModelDef[] = [
	{
		id: "beam-free",
		name: "Beam Free",
		reasoning: true,
		contextWindow: 262_144,
		maxTokens: 65_536,
	},
	{
		id: "minimax-m3.1-flash-free",
		name: "MiniMax M3.1 Flash Free",
		reasoning: true,
		contextWindow: 1_000_000,
		maxTokens: 524_288,
		input: ["text", "image"],
	},
	{
		id: "mimo-v2.6-flash-free",
		name: "MiMo V2.6 Flash Free",
		reasoning: true,
		contextWindow: 200_000,
		maxTokens: 32_000,
		input: ["text", "image"],
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
	{
		id: "longcat-2.5-preview-free",
		name: "LongCat 2.5 Preview",
		reasoning: true,
		contextWindow: 1_000_000,
		maxTokens: 131_072,
	},
	{
		id: "deepseek-v4.1-flash-free",
		name: "DeepSeek V4.1 Flash Free",
		reasoning: true,
		contextWindow: 200_000,
		maxTokens: 32_000,
		input: ["text", "image"],
	},
	{
		id: "glm-5.3-flash-free",
		name: "GLM 5.3 Flash Free",
		reasoning: true,
		contextWindow: 200_000,
		maxTokens: 32_000,
		input: ["text", "image"],
	},
	{
		id: "cat-jam-free",
		name: "Cat Jam Free",
		reasoning: true,
		contextWindow: 1_048_576,
		maxTokens: 131_072,
	},
	{
		id: "nemotron-3.5-super-vl-free",
		name: "Nemotron 3.5 Super VL Free",
		reasoning: true,
		contextWindow: 1_048_576,
		maxTokens: 131_072,
		input: ["text", "image"],
	},
];

// KiloCode gateway free models (keyless — https://kilo.ai/docs/gateway).
// Sweep 2026-10-20: stealth/cat-jam and stealth/glyph-cluster now answer 401
// PAID_MODEL_AUTH_REQUIRED (stealth lane went sign-in). poolside/laguna-xs
// 429s consistently (shared pool) and liquid/lfm-2.5 504s consistently —
// dropped. Added minimax/minimax-m3.1-flash:free (chat 200, image+video in)
// and xingchen-agi/xing4.0-29b-a4b:free (chat 200 on retry — shared-pool
// 429s under load, treat flaky). inkling-small kept: healthy except its own
// provider-side rpd cap. thinkingmachines/inkling-*-large variants are
// catalog-listed but per-day capped and slow — not registered.
const KILO_MODELS: ModelDef[] = [
	{
		id: "kilo-auto/free",
		name: "Kilo Auto Free",
		reasoning: false,
		contextWindow: 256_000,
		maxTokens: 10_000,
	},
	{
		id: "minimax/minimax-m3.1-flash:free",
		name: "MiniMax M3.1 Flash Free",
		reasoning: true,
		contextWindow: 1_000_000,
		maxTokens: 524_288,
		input: ["text", "image"],
		thinkingLevelMap: {
			off: null,
			minimal: "low",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		},
	},
	{
		id: "xingchen-agi/xing4.0-29b-a4b:free",
		name: "Xing 4.0 29B A4B Free",
		reasoning: true,
		contextWindow: 262_144,
		maxTokens: 235_929,
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
		id: "poolside/laguna-s-2.1:free",
		name: "Laguna S 2.1 Free",
		reasoning: true,
		contextWindow: 262_144,
		maxTokens: 32_768,
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
		id: "nvidia/nemotron-3.5-super-vl:free",
		name: "Nemotron 3.5 Super VL Free",
		reasoning: true,
		contextWindow: 1_000_000,
		maxTokens: 131_072,
		input: ["text", "image"],
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
	if (!BANSOS_DEBUG && level !== "error") return;
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
const MODELS_CACHE_FILE = path.join(agentStateDir(), "bansos-models.json");
type CatalogCache = { fetchedAt: number; opencode?: string[]; kilo?: string[] };
function loadCatalogCache(): CatalogCache {
	try {
		const data: unknown = JSON.parse(fs.readFileSync(MODELS_CACHE_FILE, "utf8"));
		if (!data || typeof data !== "object" || Array.isArray(data)) return { fetchedAt: 0 };
		const raw = data as Record<string, unknown>;
		const valid = (value: unknown): value is string[] =>
			Array.isArray(value) && value.every((id) => typeof id === "string");
		return {
			fetchedAt: typeof raw.fetchedAt === "number" ? raw.fetchedAt : 0,
			...(valid(raw.opencode) ? { opencode: raw.opencode } : {}),
			...(valid(raw.kilo) ? { kilo: raw.kilo } : {}),
		};
	} catch {
		return { fetchedAt: 0 };
	}
}
function saveCatalogCache(next: CatalogCache): void {
	try {
		fs.mkdirSync(path.dirname(MODELS_CACHE_FILE), { recursive: true });
		const file = `${MODELS_CACHE_FILE}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
		try {
			fs.writeFileSync(file, JSON.stringify(next), { mode: 0o600 });
			fs.renameSync(file, MODELS_CACHE_FILE);
		} finally {
			if (fs.existsSync(file)) fs.unlinkSync(file);
		}
	} catch (error) {
		log("warn", "model cache save failed", { error: String(error) });
	}
}
async function refreshCatalogCache(): Promise<CatalogCache> {
	// A failed source keeps its own last-known catalog, not an empty list.
	const [opencode, kilo] = await Promise.all([opencodeCatalog(), kiloCatalog()]);
	const prior = loadCatalogCache();
	const next: CatalogCache = {
		fetchedAt: opencode || kilo ? Date.now() : prior.fetchedAt,
		...(opencode ? { opencode: [...opencode] } : prior.opencode ? { opencode: prior.opencode } : {}),
		...(kilo ? { kilo: [...kilo] } : prior.kilo ? { kilo: prior.kilo } : {}),
	};
	if (opencode || kilo) saveCatalogCache(next);
	return next;
}
function modelsFromCache(cache: CatalogCache): RegisteredModel[] {
	const opencode = new Set(cache.opencode ?? []);
	const kilo = new Set(cache.kilo ?? []);
	// Catalog absence is not proof of death: some free models stay callable
	// after leaving /models (openrouter/free, verified 200). Keep catalog-listed
	// models plus pinned extras; chat time (300s) surfaces real failures.
	const pinnedKilo = new Set<string>(["openrouter/free"]);
	return [
		...KNOWN_MODELS.filter((model) => opencode.has(model.id)).map((model) => ({ ...model, source: "opencode" as const })),
		...KILO_MODELS.filter((model) => kilo.has(model.id) || pinnedKilo.has(model.id)).map((model) => ({ ...model, source: "kilo" as const })),
	];
}
// Each upstream publishes a model list; fetch it ONCE (cached) and check
// membership. A 1-token chat probe per model was too slow (large models need
// 10s+ for the first token). Real usability is validated at chat time (300s).
function catalogIds(data: unknown): Set<string> | null {
	if (!data || typeof data !== "object" || !Array.isArray((data as { data?: unknown }).data)) return null;
	const items = (data as { data: unknown[] }).data;
	if (!items.every((m) => m && typeof m === "object" && typeof (m as { id?: unknown }).id === "string")) return null;
	return new Set(items.map((m) => (m as { id: string }).id));
}
async function opencodeCatalog(): Promise<Set<string> | null> {
	try {
		// /zen/v1/models still answers 200 (chat moved to /inference/v1, the
		// models fetcher did not). Keep the request header on this v1 surface.
		const r = await fetch(`${API}/models`, {
			headers: opencodeHeaders(true),
			signal: AbortSignal.timeout(10_000),
		});
		return r.ok ? catalogIds(await r.json()) : null;
	} catch {
		return null;
	}
}
async function kiloCatalog(): Promise<Set<string> | null> {
	try {
		const r = await fetch(KILO_CHAT_URL.replace("/chat/completions", "/models"), {
			signal: AbortSignal.timeout(10_000),
		});
		return r.ok ? catalogIds(await r.json()) : null;
	} catch {
		return null;
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
// When `aliases` is set (caller tools renamed for the v2 gate), SSE lines are
// scanned for the wire names and restored to the caller's names before flush.
function pipeUpstreamStream(
	nodeStream: Readable,
	res: http.ServerResponse,
	req: http.IncomingMessage,
	aliases?: Record<string, string>,
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
	if (aliases && Object.keys(aliases).length) {
		const decoder = new StringDecoder("utf8");
		let carry = "";
		nodeStream.on("data", (chunk: Buffer) => {
			const text = carry + decoder.write(chunk);
			const lines = text.split("\n");
			carry = lines.pop() ?? "";
			const out = lines
				.map((line) =>
					line.includes("_pi")
						? line.replace(/([A-Za-z0-9_-]+)_pi\b/g, (_m, base) => aliases[`${base}_pi`] ?? `${base}_pi`)
						: line,
				)
				.join("\n");
			// Preserve terminators even when the completed line is empty:
			// blank lines delimit SSE events, including across chunk boundaries.
			if (lines.length && !res.writableEnded) res.write(out + "\n");
		});
		nodeStream.on("end", () => {
			carry += decoder.end();
			const tail = carry.replace(/([A-Za-z0-9_-]+)_pi\b/g, (_m, base) => aliases[`${base}_pi`] ?? `${base}_pi`);
			if (tail && !res.writableEnded) res.write(tail);
			res.end();
		});
	} else {
		nodeStream.pipe(res);
	}
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
): Promise<ProxyHandle> {
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
					let museResponses = false;
					if (parsedBody) {
						museResponses = transformOpencodeBody(parsedBody).responsesPath;
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

					// Extract the alias map the transform stored on the body —
					// stripped before send (upstream rejects unknown fields).
					let toolAliases: Record<string, string> | undefined;
					if (parsedBody && parsedBody.__bansosToolAliases) {
						toolAliases = parsedBody.__bansosToolAliases as Record<string, string>;
						delete parsedBody.__bansosToolAliases;
						opencodeBody = Buffer.from(JSON.stringify(parsedBody));
					}

					if (relayState.enabled && relayState.url) {
						// Free-tier chat lives on /inference/v1 (v2 gate). Inbound
						// /v1/chat/completions from pi is rewritten to the live
						// surface; muse-class models take /inference/v1/responses.
						const inbound = req.url ?? "/";
						let upstreamPath: string;
						if (museResponses) {
							upstreamPath = "/inference/v1/responses";
						} else if (inbound.startsWith("/v1/")) {
							upstreamPath = `/inference/v1${inbound.slice(3)}`;
						} else {
							upstreamPath = inbound;
						}
						const fullUrl = `${UPSTREAM_OPENCODE}${upstreamPath}`;
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
									toolAliases,
								);
							} else {
								let data = await response.text();
								if (toolAliases)
									data = data.replace(/([A-Za-z0-9_-]+)_pi\b/g, (m, base) => toolAliases?.[`${base}_pi`] ?? m);
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
					// Same rewrite as the relay path (muse → responses surface).
					const directPath = museResponses
						? "/inference/v1/responses"
						: (req.url ?? "").startsWith("/v1/")
							? `/inference/v1${(req.url ?? "").slice(3)}`
							: (req.url ?? "/");
					const proxy = https.request(
						{
							method: req.method,
							hostname: target.hostname,
							port: 443,
							path: directPath,
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
						// Reuse the same alias-restore pipe as the relay path.
						// The https response is a Node IncomingMessage (a Readable),
						// so it drops straight into pipeUpstreamStream.
						pipeUpstreamStream(
							upstream as unknown as Readable,
							res,
							req,
							toolAliases,
						);
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

	// ponytail: auto-bump to next free port so multiple pi processes on one
	// machine don't fight over 18080. cap at 20 to avoid infinite scan.
	// One listening/error handler pair covers the whole scan: listen(port, cb)
	// per attempt stacks a `listening` listener for every busy port
	// (MaxListenersExceededWarning once 11 ports are taken).
	const { promise, resolve, reject } = Promise.withResolvers<ProxyHandle>();
	let port = basePort;
	let attempt = 0;
	const onError = (err: NodeJS.ErrnoException) => {
		if (err.code === "EADDRINUSE" && attempt < 20) {
			attempt++;
			log("info", `port ${port} taken — trying ${port + 1}`);
			port++;
			server.listen(port, HOST);
			return;
		}
		server.off("listening", onListening);
		server.off("error", onError);
		// Startup failure: kept off stderr (it lands in the TUI); recorded in
		// proxyState and shown by the status bar and `/bansos status`.
		if (BANSOS_DEBUG)
			log("error", "server error", { code: err.code, message: err.message });
		reject(err);
	};
	const onListening = () => {
		server.off("error", onError);
		// Post-bind errors must not become an uncaught 'error' that kills pi.
		server.on("error", (err: NodeJS.ErrnoException) =>
			log("error", "server error", { code: err.code, message: err.message }),
		);
		// Lives until process exit (or pi's /reload, see session_shutdown);
		// unref'd so it never keeps a finished CLI (`pi -p`, `omp install`) alive.
		server.unref();
		const addr = server.address();
		resolve({
			server,
			port: addr && typeof addr === "object" ? addr.port : port,
		});
	};
	server.on("error", onError);
	server.once("listening", onListening);
	server.listen(port, HOST);
	return promise;
}

// ── Shared proxy ───────────────────────────────────────────────────
// One loopback proxy per loaded module, shared by every session the factory
// is bound to. Hosts such as omp run task subagents in-process and call the
// factory + session_start for each of them, so a per-session server leaks a
// port per subagent and a subagent's session_shutdown would close the proxy
// its parent still uses. Module scope (not globalThis) because the request
// handler reads this module's relayState/aliveCatalog. The server ends with
// the process (unref'd above).
type ProxyHandle = { server: http.Server; port: number };
type ProxyState =
	| { kind: "idle" }
	| { kind: "starting"; ready: Promise<ProxyHandle> }
	| { kind: "listening"; handle: ProxyHandle }
	| { kind: "failed"; error: string };
let proxyState: ProxyState = { kind: "idle" };

function sharedProxy(): Promise<ProxyHandle> {
	switch (proxyState.kind) {
		case "listening":
			return Promise.resolve(proxyState.handle);
		case "starting":
			return proxyState.ready;
		case "idle":
		case "failed": {
			// A failed bind is retried by the next session.
			const ready = startProxy();
			proxyState = { kind: "starting", ready };
			// Only settle the bind this state still points at: a pi /reload may
			// have released it meanwhile.
			ready.then(
				(handle) => {
					if (proxyState.kind === "starting" && proxyState.ready === ready)
						proxyState = { kind: "listening", handle };
				},
				(err: unknown) => {
					if (proxyState.kind === "starting" && proxyState.ready === ready)
						proxyState = {
							kind: "failed",
							error: err instanceof Error ? err.message : String(err),
						};
				},
			);
			return ready;
		}
	}
}

function describeProxy(state: ProxyState): string {
	switch (state.kind) {
		case "idle":
			return "proxy: not started";
		case "starting":
			return "proxy: starting";
		case "listening":
			return `proxy: ${HOST}:${state.handle.port}`;
		case "failed":
			return `proxy: bind failed (${state.error})`;
	}
}

// ── TUI status bar ─────────────────────────────────────────────────
type StatusUi = {
	setStatus?: (key: string, text: string | undefined) => void;
};
function statusText(transient?: string): string | undefined {
	if (relayState.statusBar === "hidden") return undefined;
	if (transient) return transient;
	if (proxyState.kind === "failed") return "bansos: proxy down";
	if (aliveCatalog.length === 0) return "bansos: no models";
	return `relay: ${relayState.enabled ? "ON" : "OFF"}`;
}
// `undefined` removes the entry, so hidden also clears a previous render.
function renderStatus(ui: StatusUi | undefined, transient?: string): void {
	ui?.setStatus?.("bansos", statusText(transient));
}

// ── Main extension ─────────────────────────────────────────────────
// The provider baseUrl must carry the proxy's real port before any session
// resolves a bansos model: hosts bind the session's Model (baseUrl included)
// when the session is created, and omp does not re-read a re-registered
// baseUrl. So bind here, then register. Loads without a session (`omp install`
// validation, `pi --list-models`) stay safe: the server is unref'd.
export default async function (pi: ExtensionAPI) {
	// Port this instance's provider baseUrl points at; the shared proxy owns
	// the real one.
	let providerPort: number | undefined;

	// Register cached models without waiting for upstream. Refresh inline only
	// when the cache is empty/invalid OR yields no models (pinned extras alone
	// don't count — they'd otherwise mask a never-populated cache).
	const cached = loadCatalogCache();
	let aliveModels = modelsFromCache(cached);
	const cacheUsable = (cached.opencode?.length ?? 0) + (cached.kilo?.length ?? 0) > 0;
	if (!cacheUsable) {
		aliveModels = modelsFromCache(await refreshCatalogCache());
	}
	aliveCatalog = aliveModels;

	const registerBansos = (port: number) => {
		providerPort = port;
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
		// Kept off stderr at startup; the status bar and `/bansos status` show it.
		if (BANSOS_DEBUG)
			log(
				"error",
				"no alive models found — provider inactive; /bansos still available to switch relay off / go direct",
			);
	}
	// A failed bind is retried (and reported) by session_start.
	await sharedProxy().then(
		({ port }) => registerBansos(port),
		() => undefined,
	);
	if (cached.opencode || cached.kilo) {
		void refreshCatalogCache().catch((error) =>
			log("warn", "model catalog refresh failed", { error: String(error) }),
		);
	}
	// Keep the gate UA fresh without blocking startup.
	void refreshOpenCodeUA().catch(() => undefined);

	// ── /bansos command: toggle relay egress live (on|off|status|url [URL]) ───
	pi.registerCommand("bansos", {
		description:
			"Relay egress: on | off | status | url [URL] | deploy | list | use <URL> | remove <URL> | hide | show | refresh-models",
		getArgumentCompletions: (prefix: string) =>
			[
				"on",
				"off",
				"status",
				"url",
				"deploy",
				"list",
				"use",
				"remove",
				"hide",
				"show",
				"refresh-models",
			]
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
			// The state file is the source of truth and other pi processes write
			// it too, so every change re-reads it, applies one mutation, writes it
			// back, and only then adopts the result (which also drives routing).
			// A failed save leaves this process unchanged.
			const commit = (mutate: (s: RelayState) => void): boolean => {
				const next = resolveRelayState();
				mutate(next);
				const saved = saveRelayState(next);
				if (saved.ok) relayState = next;
				else
					ctx.ui.notify(
						`Could not save ${RELAY_STATE_FILE}: ${saved.error}`,
						"error",
					);
				renderStatus(ctx.ui);
				return saved.ok;
			};
			const setStatusBar = (statusBar: StatusBar) => {
				if (
					commit((s) => {
						s.statusBar = statusBar;
					})
				)
					ctx.ui.notify(`bansos status bar ${statusBar}`, "info");
			};
			// mutate in place so the saved-relays list is preserved across switches
			const setRelay = (
				s: RelayState,
				enabled: boolean,
				url: string,
				addLabel?: string,
				auth?: string,
			) => {
				s.enabled = enabled;
				s.url = (url || "").trim() || DEFAULT_RELAY_URL;
				if (s.url) ensureRelay(s, s.url, addLabel, auth);
			};
			const doDeploy = async (platform?: string) => {
				// Token prompted (not stored). pi's input has no secret mode — shows while typing.
				const target =
					platform ||
					(await ctx.ui.select("Deploy relay to", [
						"Cloudflare Workers (recommended — free, IP diversity)",
						"Vercel (needs an account; Hobby caps bandwidth)",
					])) ||
					"";
				const isCloudflare = target.startsWith("Cloudflare");
				const defaultName = `relay-${Date.now().toString(36)}`;
				const token = (
					await ctx.ui.input(
						isCloudflare
							? "Cloudflare API token (dash.cloudflare.com → My Profile → API Tokens):"
							: "Vercel API token (vercel-…):",
						"",
					)
				)?.trim();
				if (!token) {
					ctx.ui.notify("Deploy cancelled — no token", "warning");
					return;
				}
				const name =
					(
						await ctx.ui.input("Project name (empty = auto):", defaultName)
					)?.trim() || defaultName;
				renderStatus(ctx.ui, "deploying relay…");
				try {
					if (isCloudflare) {
						const { url, auth } = await deployCloudflareRelay(
							token,
							name,
							(m) => ctx.ui.notify(m, "info"),
						);
						if (commit((s) => setRelay(s, true, url, `deployed ${name}`, auth)))
							ctx.ui.notify(`✓ Deployed & active: ${url}`, "info");
						else
							ctx.ui.notify(
								`Deployed ${url} but not saved — run /bansos use ${url} once the state file is writable`,
								"warning",
							);
					} else {
						const url = await deployVercelRelay(token, name, (m) =>
							ctx.ui.notify(m, "info"),
						);
						if (commit((s) => setRelay(s, true, url, `deployed ${name}`)))
							ctx.ui.notify(`✓ Deployed & active: ${url}`, "info");
						else
							ctx.ui.notify(
								`Deployed ${url} but not saved — run /bansos use ${url} once the state file is writable`,
								"warning",
							);
					}
				} catch (e) {
					renderStatus(ctx.ui);
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
				if (commit((s) => setRelay(s, true, match.url))) flash();
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
				if (commit((s) => removeRelay(s, match.url)))
					ctx.ui.notify(`Removed: ${match.url}`, "info");
			};

			if (sub === "on") {
				if (commit((s) => setRelay(s, true, s.url || DEFAULT_RELAY_URL)))
					flash();
			} else if (sub === "off") {
				if (
					commit((s) => {
						s.enabled = false;
					})
				)
					flash();
			} else if (sub === "status") {
				ctx.ui.notify(
					[
						`Relay ${relayState.enabled ? `ON → ${relayState.url}` : "OFF (direct)"} | hits=${relayHits} | saved=${relayState.relays.length}`,
						describeProxy(proxyState),
						`models found at startup: ${aliveCatalog.length}${aliveCatalog.length === 0 ? " (restart to re-check)" : ""}`,
						`status bar: ${relayState.statusBar}`,
					].join("\n"),
					proxyState.kind === "failed" || aliveCatalog.length === 0
						? "warning"
						: "info",
				);
			} else if (sub === "refresh-models") {
				const before = loadCatalogCache().fetchedAt;
				const cache = await refreshCatalogCache();
				if (cache.fetchedAt === before) {
					ctx.ui.notify(
						"Refresh failed — keeping the previous catalog; models may be stale.",
						"warning",
					);
					return;
				}
				const updated = modelsFromCache(cache);
				ctx.ui.notify(
					`Model catalog refreshed: ${updated.length} known free models. Restart pi to update the model picker.`,
					"info",
				);
			} else if (sub === "hide") {
				setStatusBar("hidden");
			} else if (sub === "show") {
				setStatusBar("shown");
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
				if (commit((s) => setRelay(s, true, url, "manual"))) flash();
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
				if (commit((s) => removeRelay(s, url)))
					ctx.ui.notify(`Removed: ${url}`, "info");
			} else if (sub === "url") {
				const input =
					rest ||
					(await ctx.ui.input(
						"Relay URL (empty = default):",
						relayState.url || DEFAULT_RELAY_URL,
					));
				if (
					commit((s) =>
						setRelay(
							s,
							s.enabled,
							(input || "").trim() || DEFAULT_RELAY_URL,
							"manual",
						),
					)
				)
					flash();
			} else if (sub === "deploy") {
				await doDeploy(rest || undefined);
			} else {
				const statusBarItem =
					relayState.statusBar === "shown"
						? "Hide status bar"
						: "Show status bar";
				const choice = await ctx.ui.select("bansos relay", [
					`Relay: ${relayState.enabled ? "ON" : "OFF"} → ${relayState.url || "direct"}`,
					"Turn ON",
					"Turn OFF",
					"Switch relay…",
					"Remove relay…",
					"Set URL",
					"Deploy relay… (Cloudflare / Vercel)",
					"List saved relays",
					statusBarItem,
				]);
				if (choice === "Turn ON") {
					if (commit((s) => setRelay(s, true, s.url || DEFAULT_RELAY_URL)))
						flash();
				} else if (choice === "Turn OFF") {
					if (
						commit((s) => {
							s.enabled = false;
						})
					)
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
					if (
						commit((s) =>
							setRelay(
								s,
								s.enabled,
								(input || "").trim() || DEFAULT_RELAY_URL,
								"manual",
							),
						)
					)
						flash();
				} else if (choice === "Deploy relay… (Cloudflare / Vercel)") {
					await doDeploy();
				} else if (choice === "List saved relays") {
					showList();
				} else if (choice === "Hide status bar") {
					setStatusBar("hidden");
				} else if (choice === "Show status bar") {
					setStatusBar("shown");
				}
			}
		},
	});

	// Retry a bind that failed at load; normally the proxy is already up.
	pi.on("session_start", async (_event, ctx) => {
		try {
			const { port } = await sharedProxy();
			if (port !== providerPort) registerBansos(port);
		} catch {
			// Startup failure: kept off stderr; proxyState carries it to the
			// status bar and `/bansos status`.
			if (BANSOS_DEBUG)
				log(
					"error",
					"proxy inactive — could not bind port. resolve the conflict and restart.",
				);
		}
		relayState = resolveRelayState();
		renderStatus(ctx.ui);
	});

	// pi's /reload emits session_shutdown{reason:"reload"} and then re-imports
	// this module (fresh module scope, new factory, new bind). Hand the port
	// back first or every reload leaks one. Any other shutdown (omp subagent
	// dispose — omp's event has no reason —, /new, /resume, quit) keeps the
	// proxy other sessions still use. Not awaited: close() waits for the
	// client's keep-alive sockets.
	pi.on("session_shutdown", (event) => {
		if (event.reason !== "reload") return;
		const released = proxyState;
		proxyState = { kind: "idle" };
		const close = ({ server }: ProxyHandle) => {
			server.close();
			server.closeIdleConnections?.();
		};
		switch (released.kind) {
			case "listening":
				close(released.handle);
				break;
			case "starting":
				released.ready.then(close, () => undefined);
				break;
			case "idle":
			case "failed":
				break;
		}
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
}
