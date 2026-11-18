/**
 * Cloudflare WARP /64 outbound hop engine (adapted from openhop & 9router #5727).
 *
 * Uses userspace `wgcf` (account registration + WireGuard profile) and
 * `wireproxy` (userspace WireGuard tunnel exposed as a local HTTP CONNECT proxy
 * on 127.0.0.1:42901). No root, no system-wide routing changes, no npm deps.
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { Readable } from "node:stream";
import tls from "node:tls";
import zlib from "node:zlib";

export const DEFAULT_WARP_PROXY_PORT =
	Number(process.env.WARP_PROXY_PORT) > 0
		? Number(process.env.WARP_PROXY_PORT)
		: 42901;
export const HOP_COOLDOWN_MS = 45_000;
export const READY_TIMEOUT_MS = 25_000;
export const DEFAULT_MAX_HOPS = 2;
const TRACE_URL = "https://www.cloudflare.com/cdn-cgi/trace";

/**
 * Normalize `wgcf-profile.conf` for `wireproxy`:
 * 1) `wgcf` emits comma-joined `Address = v4, v6` and `DNS = ...` lines, which
 *    `wireproxy` rejects unless split onto one `Key = Value` line each.
 * 2) Pin the tunnel interface to IPv6 (`Address`, `DNS`, `AllowedIPs` with `:`)
 *    matching openhop's IPv6-pinning proxy: WARP's IPv4 egress is a shared /24
 *    CGNAT pool, whereas IPv6 egress gives each WARP registration its own
 *    address/prefix while still carrying the outer WireGuard UDP over IPv4.
 */
export function normalizeWireguardProfile(raw: string): string {
	const out: string[] = [];
	const multiKeys = new Set(["Address", "DNS", "AllowedIPs"]);
	// Check whether the profile carries IPv6 addresses before stripping IPv4.
	const hasV6Address = raw
		.split(/\r?\n/)
		.some((l) => /^\s*Address\s*=.*:/i.test(l));

	for (const line of raw.split(/\r?\n/)) {
		const eq = line.indexOf("=");
		if (eq > 0 && !line.trimStart().startsWith("#")) {
			const key = line.slice(0, eq).trim();
			const rest = line.slice(eq + 1).trim();
			if (multiKeys.has(key)) {
				const parts = rest
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean);
				const filtered = hasV6Address
					? parts.filter((p) => p.includes(":"))
					: parts;
				for (const item of filtered.length ? filtered : parts) {
					out.push(`${key} = ${item}`);
				}
				continue;
			}
		}
		out.push(line);
	}
	return `${out.join("\n").replace(/\n+$/, "")}\n`;
}

/** Expand an IPv6 literal into 8 normalized 4-hex-digit groups, or null if invalid. */
export function expandIPv6(ip: string): string[] | null {
	const clean = ip.trim().replace(/^\[|\]$/g, "").split("%")[0] ?? "";
	if (!clean.includes(":")) return null;
	const halves = clean.split("::");
	if (halves.length > 2) return null;
	const parsePart = (part: string): string[] | null => {
		if (!part) return [];
		const segs = part.split(":");
		const out: string[] = [];
		for (let i = 0; i < segs.length; i++) {
			const s = segs[i]!;
			if (i === segs.length - 1 && s.includes(".")) {
				const octets = s.split(".").map((n) => Number(n));
				if (
					octets.length !== 4 ||
					octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
				) {
					return null;
				}
				out.push(
					(((octets[0]! << 8) | octets[1]!) >>> 0)
						.toString(16)
						.padStart(4, "0"),
				);
				out.push(
					(((octets[2]! << 8) | octets[3]!) >>> 0)
						.toString(16)
						.padStart(4, "0"),
				);
				continue;
			}
			if (!/^[0-9a-fA-F]{1,4}$/.test(s)) return null;
			out.push(s.toLowerCase().padStart(4, "0"));
		}
		return out;
	};
	const left = parsePart(halves[0]!);
	if (!left) return null;
	if (halves.length === 1) return left.length === 8 ? left : null;
	const right = parsePart(halves[1]!);
	if (!right) return null;
	const missing = 8 - left.length - right.length;
	if (missing < 1) return null;
	return [...left, ...Array<string>(missing).fill("0000"), ...right];
}

/**
 * Compare network blocks the way openhop does: IPv6 /64 (first 4 hextets)
 * and IPv4 /24 (first 3 octets).
 */
export function sameBlock(a: string | null | undefined, b: string | null | undefined): boolean {
	if (!a || !b) return false;
	const ta = a.trim();
	const tb = b.trim();
	if (!ta || !tb) return false;
	if (ta === tb) return true;
	if (ta.includes(":") && tb.includes(":")) {
		const ea = expandIPv6(ta);
		const eb = expandIPv6(tb);
		if (ea && eb) return ea.slice(0, 4).join(":") === eb.slice(0, 4).join(":");
		return ta.split(":").slice(0, 4).join(":") === tb.split(":").slice(0, 4).join(":");
	}
	if (!ta.includes(":") && !tb.includes(":")) {
		const pa = ta.split(".");
		const pb = tb.split(".");
		if (pa.length === 4 && pb.length === 4) {
			return pa.slice(0, 3).join(".") === pb.slice(0, 3).join(".");
		}
	}
	return false;
}

/** Open an HTTP CONNECT tunnel to `targetHost:targetPort` via `proxyUrl` and upgrade to TLS. */
export function openProxyTlsTunnel(opts: {
	proxyUrl: string;
	targetHost: string;
	targetPort: number;
	ciphers?: string;
	signal?: AbortSignal | null;
	timeoutMs?: number;
}): Promise<tls.TLSSocket> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const fail = (err: unknown) => {
			if (settled) return;
			settled = true;
			reject(err instanceof Error ? err : new Error(String(err)));
		};

		if (opts.signal?.aborted) {
			fail(opts.signal.reason ?? new Error("Aborted"));
			return;
		}

		let proxy: URL;
		try {
			proxy = new URL(opts.proxyUrl);
		} catch (e) {
			fail(new Error(`Invalid proxy URL ${opts.proxyUrl}: ${String(e)}`));
			return;
		}

		const connectHeaders: Record<string, string> = {
			Host: `${opts.targetHost}:${opts.targetPort}`,
		};
		if (proxy.username || proxy.password) {
			const creds = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
			connectHeaders["Proxy-Authorization"] =
				`Basic ${Buffer.from(creds).toString("base64")}`;
		}

		const connectReq = http.request({
			host: proxy.hostname,
			port: Number(proxy.port) || 8080,
			method: "CONNECT",
			path: `${opts.targetHost}:${opts.targetPort}`,
			headers: connectHeaders,
			agent: false,
		});

		const timeoutMs = opts.timeoutMs ?? 20_000;
		connectReq.setTimeout(timeoutMs, () => {
			connectReq.destroy(new Error(`Proxy CONNECT timeout after ${timeoutMs}ms`));
		});

		const onAbort = () => {
			connectReq.destroy(opts.signal?.reason ?? new Error("Aborted"));
			fail(opts.signal?.reason ?? new Error("Aborted"));
		};
		opts.signal?.addEventListener("abort", onAbort, { once: true });

		connectReq.once("error", (err) => {
			opts.signal?.removeEventListener("abort", onAbort);
			fail(err);
		});

		connectReq.once("connect", (res, socket, head) => {
			connectReq.setTimeout(0);
			if (res.statusCode !== 200) {
				opts.signal?.removeEventListener("abort", onAbort);
				socket.destroy();
				fail(new Error(`Proxy CONNECT failed with HTTP ${res.statusCode ?? 0}`));
				return;
			}
			if (head && head.length > 0) socket.unshift(head);

			const tlsSocket = tls.connect({
				socket,
				servername: opts.targetHost,
				ALPNProtocols: ["http/1.1"],
				...(opts.ciphers ? { ciphers: opts.ciphers } : {}),
			});
			const onTlsAbort = () => {
				tlsSocket.destroy(opts.signal?.reason ?? new Error("Aborted"));
				fail(opts.signal?.reason ?? new Error("Aborted"));
			};
			opts.signal?.removeEventListener("abort", onAbort);
			opts.signal?.addEventListener("abort", onTlsAbort, { once: true });

			const tlsTimer = setTimeout(() => {
				tlsSocket.destroy(new Error("TLS handshake timeout over proxy"));
			}, timeoutMs);

			tlsSocket.once("error", (err) => {
				clearTimeout(tlsTimer);
				opts.signal?.removeEventListener("abort", onTlsAbort);
				fail(err);
			});
			tlsSocket.once("secureConnect", () => {
				clearTimeout(tlsTimer);
				opts.signal?.removeEventListener("abort", onTlsAbort);
				if (settled) {
					tlsSocket.destroy();
					return;
				}
				settled = true;
				resolve(tlsSocket);
			});
		});

		connectReq.end();
	});
}

/**
 * HTTPS fetch with explicit TLS cipher control and optional HTTP CONNECT proxy.
 * Used both for BoringSSL JA4-preserved OpenCode requests and WARP trace checks.
 */
export async function tlsCustomFetch(
	url: string,
	opts: RequestInit = {},
	extra: { proxyUrl?: string; ciphers?: string; connectTimeoutMs?: number } = {},
): Promise<Response> {
	const u = new URL(url);
	const targetPort = Number(u.port) || 443;
	const headers: Record<string, string> = {};
	new Headers(opts.headers).forEach((v, k) => {
		headers[k] = v;
	});
	const bodyBuf =
		opts.body == null
			? undefined
			: Buffer.isBuffer(opts.body)
				? opts.body
				: typeof opts.body === "string"
					? Buffer.from(opts.body)
					: Buffer.from(opts.body as ArrayBuffer);
	if (bodyBuf && !headers["content-length"]) {
		headers["content-length"] = String(bodyBuf.length);
	}

	const preconnectedSocket = extra.proxyUrl
		? await openProxyTlsTunnel({
				proxyUrl: extra.proxyUrl,
				targetHost: u.hostname,
				targetPort,
				ciphers: extra.ciphers,
				signal: opts.signal,
				timeoutMs: extra.connectTimeoutMs,
			})
		: null;

	return new Promise<Response>((resolve, reject) => {
		// When `preconnectedSocket` is set, openProxyTlsTunnel has ALREADY
		// negotiated TLS (with explicit JA4 ciphers) over the HTTP CONNECT tunnel,
		// so `http.request` frames HTTP/1.1 directly onto that TLSSocket.
		const singleUseTlsAgent = preconnectedSocket
			? Object.assign(new http.Agent({ keepAlive: false }), {
					createConnection: () => preconnectedSocket,
				})
			: undefined;
		const req = preconnectedSocket
			? http.request(
					{
						method: opts.method || "GET",
						hostname: u.hostname,
						port: targetPort,
						path: `${u.pathname}${u.search}`,
						headers,
						agent: singleUseTlsAgent,
					},
					onResponse,
				)
			: https.request(
					{
						method: opts.method || "GET",
						hostname: u.hostname,
						port: targetPort,
						path: `${u.pathname}${u.search}`,
						headers,
						agent: false,
						...(extra.ciphers ? { ciphers: extra.ciphers } : {}),
					},
					onResponse,
				);
		function onResponse(res: http.IncomingMessage) {
			const status = res.statusCode ?? 502;
			const resHeaders = new Headers();
			for (const [k, v] of Object.entries(res.headers)) {
				if (typeof v === "string") resHeaders.set(k, v);
				else if (Array.isArray(v)) resHeaders.set(k, v.join(", "));
			}
			const nullBody = status === 204 || status === 205 || status === 304;
			resolve(
				new Response(
					nullBody
						? null
						: (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>),
					{
						status,
						statusText: res.statusMessage ?? "",
						headers: resHeaders,
					},
				),
			);
		}
		if (opts.signal) {
			if (opts.signal.aborted) {
				req.destroy(opts.signal.reason ?? new Error("Aborted"));
				preconnectedSocket?.destroy();
				return;
			}
			opts.signal.addEventListener(
				"abort",
				() => req.destroy(opts.signal?.reason ?? new Error("Aborted")),
				{ once: true },
			);
		}
		req.on("error", (err) => {
			preconnectedSocket?.destroy();
			reject(err);
		});
		if (bodyBuf) req.end(bodyBuf);
		else req.end();
	});
}

/** Extract a single named file from a `.tar.gz` buffer (POSIX USTAR / GNU tar). */
export function extractFileFromTarGz(
	tarGz: Buffer,
	fileName: string,
): Buffer {
	const tar = zlib.gunzipSync(tarGz);
	let offset = 0;
	while (offset + 512 <= tar.length) {
		const header = tar.subarray(offset, offset + 512);
		// Empty 512-byte block signals end-of-archive.
		if (header.every((b) => b === 0)) break;
		const rawName = header
			.subarray(0, 100)
			.toString("utf8")
			.replace(/\0.*$/, "");
		const prefix = header
			.subarray(345, 500)
			.toString("utf8")
			.replace(/\0.*$/, "");
		const fullName = prefix ? `${prefix}/${rawName}` : rawName;
		const sizeOctal = header
			.subarray(124, 136)
			.toString("utf8")
			.replace(/\0.*$/, "")
			.trim();
		const size = sizeOctal ? Number.parseInt(sizeOctal, 8) : 0;
		const typeFlag = header[156];
		const dataStart = offset + 512;
		const dataEnd = dataStart + size;
		// Normal file: '0' (48) or '\0' (0)
		if (
			(typeFlag === 48 || typeFlag === 0) &&
			path.posix.basename(fullName) === fileName &&
			dataEnd <= tar.length
		) {
			return Buffer.from(tar.subarray(dataStart, dataEnd));
		}
		offset = dataStart + Math.ceil(size / 512) * 512;
	}
	throw new Error(`Archive did not contain ${fileName}`);
}

type ReleaseAsset = { name: string; browser_download_url: string };
type ReleaseResponse = { tag_name?: string; assets?: ReleaseAsset[] };

function resolveTargetPlatform(
	platform = process.platform,
	arch = process.arch,
): { os: string; arch: string; ext: string } {
	const osMap: Record<string, string> = {
		linux: "linux",
		darwin: "darwin",
		win32: "windows",
	};
	const archMap: Record<string, string> = {
		x64: "amd64",
		arm64: "arm64",
	};
	const mappedOs = osMap[platform];
	const mappedArch = archMap[arch];
	if (!mappedOs || !mappedArch) {
		throw new Error(`Unsupported platform/arch for WARP binaries: ${platform}/${arch}`);
	}
	return {
		os: mappedOs,
		arch: mappedArch,
		ext: platform === "win32" ? ".exe" : "",
	};
}

function parseChecksums(text: string): Map<string, string> {
	const map = new Map<string, string>();
	for (const line of text.split(/\r?\n/)) {
		const m = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
		if (m) map.set(path.posix.basename(m[2]!.trim()), m[1]!.toLowerCase());
	}
	return map;
}

function verifySha256(buf: Buffer, expectedHex: string | undefined, label: string): void {
	if (!expectedHex) return;
	const actual = createHash("sha256").update(buf).digest("hex");
	if (actual !== expectedHex.toLowerCase()) {
		throw new Error(
			`SHA-256 mismatch for ${label}: expected ${expectedHex}, got ${actual}`,
		);
	}
}

export async function installWarpBinaries(
	binDir: string,
	onProgress?: (msg: string) => void,
): Promise<{ wgcfPath: string; wireproxyPath: string }> {
	const target = resolveTargetPlatform();
	fs.mkdirSync(binDir, { recursive: true });

	const fetchJson = async (url: string): Promise<ReleaseResponse> => {
		const res = await fetch(url, {
			headers: {
				Accept: "application/vnd.github+json",
				"User-Agent": "pi-bansos-warp-setup",
			},
			signal: AbortSignal.timeout(30_000),
		});
		if (!res.ok) {
			throw new Error(`GitHub release lookup failed (${res.status}) for ${url}`);
		}
		return (await res.json()) as ReleaseResponse;
	};

	const fetchBytes = async (url: string): Promise<Buffer> => {
		const res = await fetch(url, {
			headers: { "User-Agent": "pi-bansos-warp-setup" },
			signal: AbortSignal.timeout(120_000),
		});
		if (!res.ok) {
			throw new Error(`Download failed (${res.status}) for ${url}`);
		}
		return Buffer.from(await res.arrayBuffer());
	};

	// 1. wgcf (ViRb3/wgcf) — raw binary per OS/arch
	onProgress?.("Downloading wgcf release metadata…");
	const wgcfRel = await fetchJson(
		"https://api.github.com/repos/ViRb3/wgcf/releases/latest",
	);
	const wgcfRe = new RegExp(
		`^wgcf_[0-9.]+_${target.os}_${target.arch}${target.ext ? "\\.exe" : ""}$`,
	);
	const wgcfAsset = (wgcfRel.assets ?? []).find((a) => wgcfRe.test(a.name));
	if (!wgcfAsset) {
		throw new Error(
			`No wgcf binary found for ${target.os}/${target.arch} in ${wgcfRel.tag_name ?? "latest"}`,
		);
	}
	const wgcfSumsAsset = (wgcfRel.assets ?? []).find(
		(a) => a.name === "checksums.txt",
	);
	const wgcfSums = wgcfSumsAsset
		? parseChecksums((await fetchBytes(wgcfSumsAsset.browser_download_url)).toString("utf8"))
		: new Map<string, string>();

	onProgress?.(`Downloading ${wgcfAsset.name}…`);
	const wgcfBuf = await fetchBytes(wgcfAsset.browser_download_url);
	verifySha256(wgcfBuf, wgcfSums.get(wgcfAsset.name), wgcfAsset.name);
	const wgcfPath = path.join(binDir, `wgcf${target.ext}`);
	const wgcfTmp = `${wgcfPath}.${process.pid}.tmp`;
	fs.writeFileSync(wgcfTmp, wgcfBuf, { mode: 0o755 });
	fs.renameSync(wgcfTmp, wgcfPath);
	if (process.platform !== "win32") fs.chmodSync(wgcfPath, 0o755);

	// 2. wireproxy (windtf/wireproxy, redirected from pufferffish/wireproxy) — .tar.gz
	onProgress?.("Downloading wireproxy release metadata…");
	const wpRel = await fetchJson(
		"https://api.github.com/repos/windtf/wireproxy/releases/latest",
	);
	const wpArchiveName = `wireproxy_${target.os}_${target.arch}.tar.gz`;
	const wpAsset = (wpRel.assets ?? []).find((a) => a.name === wpArchiveName);
	if (!wpAsset) {
		throw new Error(
			`No wireproxy archive (${wpArchiveName}) in ${wpRel.tag_name ?? "latest"}`,
		);
	}
	const wpSumsAsset = (wpRel.assets ?? []).find(
		(a) => a.name === "checksums.txt",
	);
	const wpSums = wpSumsAsset
		? parseChecksums((await fetchBytes(wpSumsAsset.browser_download_url)).toString("utf8"))
		: new Map<string, string>();

	onProgress?.(`Downloading ${wpAsset.name}…`);
	const wpTarGz = await fetchBytes(wpAsset.browser_download_url);
	verifySha256(wpTarGz, wpSums.get(wpAsset.name), wpAsset.name);
	const wpBinName = `wireproxy${target.ext}`;
	const wpBuf = extractFileFromTarGz(wpTarGz, wpBinName);
	const wireproxyPath = path.join(binDir, wpBinName);
	const wpTmp = `${wireproxyPath}.${process.pid}.tmp`;
	fs.writeFileSync(wpTmp, wpBuf, { mode: 0o755 });
	fs.renameSync(wpTmp, wireproxyPath);
	if (process.platform !== "win32") fs.chmodSync(wireproxyPath, 0o755);

	return { wgcfPath, wireproxyPath };
}

export type CommandResult = { code: number; stdout: string; stderr: string };
export type TraceInfo = { ip: string | null; warp: string };
export type HopResult = {
	ok: boolean;
	ip?: string | null;
	samePrefix?: boolean;
	error?: string;
};
export type WarpStatus = {
	installed: boolean;
	running: boolean;
	pid: number | null;
	startedAt: string | null;
	proxyUrl: string;
	hops: number;
	lastHopAt: string | null;
	lastIp: string | null;
	lastError: string | null;
	dataDir: string;
};

export type WarpEngineDeps = {
	dataDir: string;
	proxyPort?: number;
	now?: () => number;
	runCmd?: (bin: string, args: string[], cwd: string, timeoutMs?: number) => Promise<CommandResult>;
	spawnDaemon?: (bin: string, args: string[], cwd: string) => ChildProcess;
	traceFn?: (proxyUrl: string) => Promise<TraceInfo | null>;
	killStaleFn?: (wireproxyConf: string) => Promise<void>;
	readyTimeoutMs?: number;
	readyPollMs?: number;
	onLog?: (level: "info" | "warn" | "error", msg: string, meta?: Record<string, unknown>) => void;
};

function defaultRunCmd(
	bin: string,
	args: string[],
	cwd: string,
	timeoutMs = 60_000,
): Promise<CommandResult> {
	return new Promise((resolve) => {
		const child = spawn(bin, args, { cwd, windowsHide: true });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			try {
				child.kill();
			} catch {}
			resolve({ code: 1, stdout, stderr: stderr || "timeout" });
		}, timeoutMs);
		child.stdout?.on("data", (d: Buffer) => {
			stdout += d.toString("utf8");
		});
		child.stderr?.on("data", (d: Buffer) => {
			stderr += d.toString("utf8");
		});
		child.on("error", (e) => {
			clearTimeout(timer);
			resolve({ code: 1, stdout, stderr: String(e) });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code: code ?? 1, stdout, stderr });
		});
	});
}

function defaultSpawnDaemon(bin: string, args: string[], cwd: string): ChildProcess {
	const child = spawn(bin, args, {
		cwd,
		windowsHide: true,
		stdio: "ignore",
	});
	child.unref();
	return child;
}

async function defaultTrace(proxyUrl: string): Promise<TraceInfo | null> {
	try {
		const res = await tlsCustomFetch(
			TRACE_URL,
			{ signal: AbortSignal.timeout(3_500) },
			{ proxyUrl, connectTimeoutMs: 3_500 },
		);
		if (!res.ok) return null;
		const text = await res.text();
		const kv = Object.fromEntries(
			text
				.split("\n")
				.map((l) => l.split("="))
				.filter((p) => p.length === 2),
		) as Record<string, string>;
		return kv.warp === "on" || kv.warp === "plus"
			? { ip: kv.ip || null, warp: kv.warp }
			: null;
	} catch {
		return null;
	}
}

async function defaultKillStale(wireproxyConf: string): Promise<void> {
	if (/['";`$]/.test(wireproxyConf)) return;
	try {
		if (process.platform === "win32") {
			const dir = path.dirname(wireproxyConf);
			await new Promise<void>((resolve) => {
				execFile(
					"powershell",
					[
						"-NoProfile",
						"-Command",
						`Get-CimInstance Win32_Process -Filter "Name='wireproxy.exe'" | Where-Object { $_.CommandLine -like '*${dir}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
					],
					{ windowsHide: true },
					() => resolve(),
				);
			});
		} else {
			await new Promise<void>((resolve) => {
				execFile("pkill", ["-f", wireproxyConf], () => resolve());
			});
		}
	} catch {}
}

function whichSync(binBase: string): string | null {
	const ext = process.platform === "win32" ? ".exe" : "";
	const target = `${binBase}${ext}`;
	const pathEnv = process.env.PATH || "";
	for (const seg of pathEnv.split(path.delimiter)) {
		if (!seg) continue;
		const full = path.join(seg, target);
		if (fs.existsSync(full)) return full;
	}
	return null;
}

export class WarpHopEngine {
	readonly dataDir: string;
	readonly binDir: string;
	readonly proxyPort: number;
	readonly proxyUrl: string;
	private readonly accountToml: string;
	private readonly profileConf: string;
	private readonly wireproxyConf: string;
	private readonly now: () => number;
	private readonly runCmd: NonNullable<WarpEngineDeps["runCmd"]>;
	private readonly spawnDaemon: NonNullable<WarpEngineDeps["spawnDaemon"]>;
	private readonly traceFn: NonNullable<WarpEngineDeps["traceFn"]>;
	private readonly killStaleFn: NonNullable<WarpEngineDeps["killStaleFn"]>;
	private readonly readyTimeoutMs: number;
	private readonly readyPollMs: number;
	private readonly onLog?: WarpEngineDeps["onLog"];

	private child: ChildProcess | null = null;
	private startedAt: string | null = null;
	private hops = 0;
	private lastHopAt = 0;
	private lastIp: string | null = null;
	private lastError: string | null = null;
	private starting: Promise<boolean> | null = null;
	private hopping: Promise<HopResult> | null = null;

	constructor(deps: WarpEngineDeps) {
		this.dataDir = deps.dataDir;
		this.binDir = path.join(this.dataDir, "bin");
		this.proxyPort = deps.proxyPort ?? DEFAULT_WARP_PROXY_PORT;
		this.proxyUrl = `http://127.0.0.1:${this.proxyPort}`;
		this.accountToml = path.join(this.dataDir, "wgcf-account.toml");
		this.profileConf = path.join(this.dataDir, "wgcf-profile.conf");
		this.wireproxyConf = path.join(this.dataDir, "wireproxy.conf");
		this.now = deps.now ?? Date.now;
		this.runCmd = deps.runCmd ?? defaultRunCmd;
		this.spawnDaemon = deps.spawnDaemon ?? defaultSpawnDaemon;
		this.traceFn = deps.traceFn ?? defaultTrace;
		this.killStaleFn = deps.killStaleFn ?? defaultKillStale;
		this.readyTimeoutMs = deps.readyTimeoutMs ?? READY_TIMEOUT_MS;
		this.readyPollMs = deps.readyPollMs ?? 750;
		this.onLog = deps.onLog;
	}

	findBin(name: "wgcf" | "wireproxy"): string | null {
		const envKey = `WARP_${name.toUpperCase()}_PATH`;
		const override = process.env[envKey]?.trim();
		if (override && fs.existsSync(override)) return override;
		const ext = process.platform === "win32" ? ".exe" : "";
		const local = path.join(this.binDir, `${name}${ext}`);
		if (fs.existsSync(local)) return local;
		return whichSync(name);
	}

	hasBinaries(): boolean {
		return Boolean(this.findBin("wgcf") && this.findBin("wireproxy"));
	}

	private ensureRuntime(): { wgcf: string; wireproxy: string } {
		const wgcf = this.findBin("wgcf");
		const wireproxy = this.findBin("wireproxy");
		if (!wgcf || !wireproxy) {
			throw new Error(
				`wgcf/wireproxy binaries not found in ${this.binDir} — run "/bansos warp setup" first`,
			);
		}
		return { wgcf, wireproxy };
	}

	async setupBinaries(
		onProgress?: (msg: string) => void,
	): Promise<{ wgcfPath: string; wireproxyPath: string }> {
		return installWarpBinaries(this.binDir, onProgress);
	}

	private writeWireproxyConf(): void {
		fs.mkdirSync(this.dataDir, { recursive: true });
		fs.writeFileSync(
			this.wireproxyConf,
			`WGConfig = ${this.profileConf}\n\n[http]\nBindAddress = 127.0.0.1:${this.proxyPort}\n`,
			{ mode: 0o600 },
		);
	}

	private spawnChild(wireproxy: string): ChildProcess {
		const child = this.spawnDaemon(
			wireproxy,
			["-c", this.wireproxyConf, "-s"],
			this.dataDir,
		);
		child.on("exit", () => {
			if (this.child === child) {
				this.child = null;
				this.startedAt = null;
			}
		});
		this.child = child;
		this.startedAt = new Date(this.now()).toISOString();
		return child;
	}

	private stopChild(): void {
		const child = this.child;
		this.child = null;
		this.startedAt = null;
		if (!child) return;
		try {
			child.kill();
		} catch {}
	}

	private async waitReady(): Promise<TraceInfo | null> {
		const deadline = this.now() + this.readyTimeoutMs;
		while (this.now() < deadline) {
			if (!this.child) return null;
			const trace = await this.traceFn(this.proxyUrl);
			if (trace) return trace;
			await new Promise((r) => setTimeout(r, this.readyPollMs));
		}
		return null;
	}

	private async registerNewAccount(): Promise<{ ok: true } | { ok: false; error: string }> {
		fs.mkdirSync(this.dataDir, { recursive: true });
		const backup = `${this.accountToml}.bak`;
		const hadAccount = fs.existsSync(this.accountToml);
		if (hadAccount) fs.copyFileSync(this.accountToml, backup);
		if (fs.existsSync(this.accountToml)) fs.rmSync(this.accountToml, { force: true });

		const { wgcf } = this.ensureRuntime();
		const reg = await this.runCmd(
			wgcf,
			["register", "--accept-tos"],
			this.dataDir,
		);
		if (reg.code !== 0 || !fs.existsSync(this.accountToml)) {
			if (hadAccount && fs.existsSync(backup)) {
				fs.copyFileSync(backup, this.accountToml);
			}
			return {
				ok: false,
				error: (reg.stderr || reg.stdout || "wgcf register failed")
					.trim()
					.slice(0, 300),
			};
		}
		return { ok: true };
	}

	private async generateProfile(): Promise<{ ok: true } | { ok: false; error: string }> {
		const { wgcf } = this.ensureRuntime();
		const gen = await this.runCmd(wgcf, ["generate"], this.dataDir);
		if (gen.code !== 0 || !fs.existsSync(this.profileConf)) {
			return {
				ok: false,
				error: (gen.stderr || gen.stdout || "wgcf generate failed")
					.trim()
					.slice(0, 300),
			};
		}
		try {
			const raw = fs.readFileSync(this.profileConf, "utf8");
			fs.writeFileSync(this.profileConf, normalizeWireguardProfile(raw), {
				mode: 0o600,
			});
		} catch (e) {
			return {
				ok: false,
				error: `failed to normalize profile: ${String(e)}`.slice(0, 300),
			};
		}
		return { ok: true };
	}

	private async startInternal(): Promise<TraceInfo> {
		const { wireproxy } = this.ensureRuntime();
		fs.mkdirSync(this.dataDir, { recursive: true });

		if (!fs.existsSync(this.accountToml)) {
			const reg = await this.registerNewAccount();
			if (!reg.ok) throw new Error(`WARP registration failed: ${reg.error}`);
		}
		if (!fs.existsSync(this.profileConf)) {
			const gen = await this.generateProfile();
			if (!gen.ok) throw new Error(`WARP profile generation failed: ${gen.error}`);
		} else {
			const raw = fs.readFileSync(this.profileConf, "utf8");
			const normalized = normalizeWireguardProfile(raw);
			if (normalized !== raw) {
				fs.writeFileSync(this.profileConf, normalized, { mode: 0o600 });
			}
		}

		this.writeWireproxyConf();
		await this.killStaleFn(this.wireproxyConf);
		this.spawnChild(wireproxy);
		const trace = await this.waitReady();
		if (!trace) {
			this.stopChild();
			throw new Error(
				`wireproxy tunnel not ready within ${Math.round(this.readyTimeoutMs / 1000)}s (port ${this.proxyPort} in use or WireGuard UDP blocked?)`,
			);
		}
		this.lastIp = trace.ip;
		this.lastError = null;
		this.onLog?.("info", "WARP tunnel up", {
			proxyUrl: this.proxyUrl,
			ip: trace.ip,
		});
		return trace;
	}

	async ensureStarted(): Promise<boolean> {
		if (this.child) return true;
		if (this.starting) return this.starting;
		this.starting = this.startInternal()
			.then(() => true)
			.catch((e: unknown) => {
				this.lastError = e instanceof Error ? e.message : String(e);
				this.onLog?.("warn", "WARP start failed", { error: this.lastError });
				return false;
			})
			.finally(() => {
				this.starting = null;
			});
		return this.starting;
	}

	/**
	 * Rotate the outbound /64 identity: stop wireproxy, register a fresh WARP
	 * account, regenerate profile, restart tunnel, and verify a new /64 block.
	 */
	async hop(opts: { force?: boolean; cooldownMs?: number } = {}): Promise<HopResult> {
		if (this.hopping) return this.hopping;
		this.hopping = this.hopInternal(opts).finally(() => {
			this.hopping = null;
		});
		return this.hopping;
	}

	private async hopInternal(
		opts: { force?: boolean; cooldownMs?: number } = {},
	): Promise<HopResult> {
		const cooldownMs = opts.cooldownMs ?? HOP_COOLDOWN_MS;
		const elapsed = this.now() - this.lastHopAt;
		if (!opts.force && this.lastHopAt > 0 && elapsed < cooldownMs) {
			return {
				ok: false,
				error: `cooldown (${Math.ceil((cooldownMs - elapsed) / 1000)}s remaining)`,
			};
		}
		this.lastHopAt = this.now();
		this.stopChild();

		const oldIp = this.lastIp;
		let last: HopResult = { ok: false, error: "no attempt" };

		for (let attempt = 1; attempt <= 3; attempt++) {
			let wireproxy: string;
			try {
				wireproxy = this.ensureRuntime().wireproxy;
			} catch (e) {
				last = { ok: false, error: e instanceof Error ? e.message : String(e) };
				break;
			}

			const reg = await this.registerNewAccount();
			if (!reg.ok) {
				last = { ok: false, error: reg.error };
				this.onLog?.("warn", "WARP registration failed during hop", {
					error: reg.error,
				});
				break;
			}

			const gen = await this.generateProfile();
			if (!gen.ok) {
				last = { ok: false, error: gen.error };
				this.onLog?.("warn", "WARP profile generation failed during hop", {
					error: gen.error,
				});
				break;
			}

			this.writeWireproxyConf();
			await this.killStaleFn(this.wireproxyConf);
			this.spawnChild(wireproxy);
			const trace = await this.waitReady();
			if (!trace) {
				this.stopChild();
				last = { ok: false, error: "tunnel not ready after hop" };
				break;
			}

			this.hops += 1;
			this.lastIp = trace.ip;
			this.lastError = null;
			const fresh = !oldIp || !sameBlock(oldIp, trace.ip);
			last = { ok: true, ip: trace.ip, samePrefix: !fresh };
			if (fresh) {
				this.onLog?.("info", "WARP hopped to fresh block", {
					from: oldIp,
					to: trace.ip,
					attempt,
				});
				break;
			}
			this.onLog?.("info", "WARP hop got same block, re-registering", {
				ip: trace.ip,
				attempt,
			});
			if (attempt < 3) this.stopChild();
		}

		if (!last.ok) {
			this.lastError = last.error ?? "hop failed";
			// Best effort: restore tunnel using preserved backup account if possible.
			try {
				await this.startInternal();
			} catch {}
		}
		return last;
	}

	async stop(): Promise<void> {
		this.stopChild();
		this.onLog?.("info", "WARP wireproxy stopped");
	}

	getStatus(): WarpStatus {
		return {
			installed: this.hasBinaries(),
			running: Boolean(this.child),
			pid: this.child?.pid ?? null,
			startedAt: this.startedAt,
			proxyUrl: this.proxyUrl,
			hops: this.hops,
			lastHopAt: this.lastHopAt ? new Date(this.lastHopAt).toISOString() : null,
			lastIp: this.lastIp,
			lastError: this.lastError,
			dataDir: this.dataDir,
		};
	}
}
