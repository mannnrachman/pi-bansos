import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import zlib from "node:zlib";
import {
	extractFileFromTarGz,
	expandIPv6,
	normalizeWireguardProfile,
	sameBlock,
	WarpHopEngine,
} from "../extensions/warp-hop.ts";

test("normalizeWireguardProfile splits comma-joined wgcf fields and pins IPv6 interface", () => {
	const raw = [
		"[Interface]",
		"PrivateKey = secret",
		"Address = 172.16.0.2/32, 2606:4700:110:811b::1/128",
		"DNS = 1.1.1.1, 1.0.0.1, 2606:4700:4700::1111, 2606:4700:4700::1001",
		"MTU = 1280",
		"[Peer]",
		"PublicKey = pub",
		"AllowedIPs = 0.0.0.0/0, ::/0",
		"Endpoint = engage.cloudflareclient.com:2408",
	].join("\n");
	const norm = normalizeWireguardProfile(raw);
	assert.equal(norm.includes("172.16.0.2"), false);
	assert.equal(norm.includes("0.0.0.0/0"), false);
	assert.ok(norm.includes("Address = 2606:4700:110:811b::1/128"));
	assert.ok(norm.includes("DNS = 2606:4700:4700::1111\nDNS = 2606:4700:4700::1001"));
	assert.ok(norm.includes("AllowedIPs = ::/0"));
	assert.ok(norm.includes("Endpoint = engage.cloudflareclient.com:2408"));
});

test("expandIPv6 and sameBlock compare IPv6 /64 (incl. compressed forms) and IPv4 /24", () => {
	assert.deepEqual(expandIPv6("2606:4700:110::1")?.slice(0, 4), [
		"2606",
		"4700",
		"0110",
		"0000",
	]);
	// Compressed vs uncompressed in the same /64 block → true
	assert.equal(
		sameBlock("2606:4700:110::1", "2606:4700:0110:0000:abcd:1234:5678:9999"),
		true,
	);
	// Different /64 hextet → false
	assert.equal(
		sameBlock("2606:4700:110:1::a", "2606:4700:110:2::a"),
		false,
	);
	// IPv4 /24
	assert.equal(sameBlock("104.28.14.12", "104.28.14.200"), true);
	assert.equal(sameBlock("104.28.14.12", "104.28.15.12"), false);
	assert.equal(sameBlock(null, "104.28.14.12"), false);
});

test("extractFileFromTarGz unpacks a single file from a USTAR tar.gz archive", () => {
	const payload = Buffer.from("#!/bin/sh\necho wireproxy\n", "utf8");
	const header = Buffer.alloc(512, 0);
	header.write("bin/wireproxy", 0, "utf8");
	header.write("0000755\0", 100, "utf8");
	header.write(`${payload.length.toString(8).padStart(11, "0")}\0`, 124, "utf8");
	header.write("0", 156, "utf8"); // regular file
	header.write("ustar\0", 257, "utf8");
	// Checksum field treated as spaces before summing
	header.fill(0x20, 148, 156);
	let sum = 0;
	for (const b of header) sum += b;
	header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "utf8");

	const pad = Buffer.alloc((512 - (payload.length % 512)) % 512, 0);
	const eof = Buffer.alloc(1024, 0);
	const tarGz = zlib.gzipSync(Buffer.concat([header, payload, pad, eof]));

	const extracted = extractFileFromTarGz(tarGz, "wireproxy");
	assert.deepEqual(extracted, payload);
	assert.throws(() => extractFileFromTarGz(tarGz, "nonexistent"));
});

test("WarpHopEngine: start, fresh /64 hop, cooldown guard, and account backup restore on failure", async () => {
	const dir = fs.mkdtempSync(path.join(tmpdir(), "bansos-warp-test-"));
	try {
		const binDir = path.join(dir, "bin");
		fs.mkdirSync(binDir, { recursive: true });
		const ext = process.platform === "win32" ? ".exe" : "";
		fs.writeFileSync(path.join(binDir, `wgcf${ext}`), "stub", { mode: 0o755 });
		fs.writeFileSync(path.join(binDir, `wireproxy${ext}`), "stub", { mode: 0o755 });

		let clock = 1_000_000;
		let regCounter = 0;
		let failNextRegister = false;
		const ips = [
			"2606:4700:110:1::10", // initial start
			"2606:4700:110:1::99", // hop attempt 1: same /64 → triggers re-register!
			"2606:4700:110:2::10", // hop attempt 2: fresh /64 ✓
			"2606:4700:110:2::10", // fallback restart after failed register
		];
		let ipIdx = 0;

		const engine = new WarpHopEngine({
			dataDir: dir,
			proxyPort: 43999,
			now: () => clock,
			readyPollMs: 5,
			readyTimeoutMs: 500,
			killStaleFn: async () => {},
			runCmd: async (_bin, args, cwd) => {
				if (args[0] === "register") {
					if (failNextRegister) {
						return { code: 1, stdout: "", stderr: "429 Too Many Registrations" };
					}
					regCounter++;
					fs.writeFileSync(
						path.join(cwd, "wgcf-account.toml"),
						`device_id = "dev-${regCounter}"\n`,
					);
					return { code: 0, stdout: "ok", stderr: "" };
				}
				if (args[0] === "generate") {
					fs.writeFileSync(
						path.join(cwd, "wgcf-profile.conf"),
						"[Interface]\nPrivateKey = dummy\n",
					);
					return { code: 0, stdout: "ok", stderr: "" };
				}
				return { code: 1, stdout: "", stderr: "unexpected" };
			},
			spawnDaemon: () => {
				const fake = new EventEmitter() as any;
				fake.pid = 12345;
				fake.kill = () => fake.emit("exit", 0);
				return fake;
			},
			traceFn: async () => ({
				ip: ips[Math.min(ipIdx++, ips.length - 1)]!,
				warp: "on",
			}),
		});

		assert.equal(await engine.ensureStarted(), true);
		assert.equal(engine.getStatus().running, true);
		assert.equal(engine.getStatus().lastIp, "2606:4700:110:1::10");

		// Hop: attempt 1 gets same /64 (:1::99), attempt 2 gets fresh /64 (:2::10)
		const hop1 = await engine.hop();
		assert.equal(hop1.ok, true);
		assert.equal(hop1.samePrefix, false);
		assert.equal(hop1.ip, "2606:4700:110:2::10");
		assert.equal(regCounter, 3); // 1 initial + 2 during hop

		// Cooldown guard blocks immediate non-forced hop
		clock += 10_000;
		const cooled = await engine.hop();
		assert.equal(cooled.ok, false);
		assert.match(cooled.error ?? "", /cooldown/);

		// Failed registration restores wgcf-account.toml from backup and brings tunnel back up
		clock += 50_000;
		const savedBeforeFail = fs.readFileSync(
			path.join(dir, "wgcf-account.toml"),
			"utf8",
		);
		failNextRegister = true;
		const failedHop = await engine.hop();
		assert.equal(failedHop.ok, false);
		assert.equal(
			fs.readFileSync(path.join(dir, "wgcf-account.toml"), "utf8"),
			savedBeforeFail,
		);
		assert.equal(engine.getStatus().running, true);

		await engine.stop();
		assert.equal(engine.getStatus().running, false);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("WarpHopEngine: cold hop starts the tunnel and force bypasses the manual cooldown", async () => {
	const dir = fs.mkdtempSync(path.join(tmpdir(), "bansos-warp-cold-"));
	try {
		const binDir = path.join(dir, "bin");
		fs.mkdirSync(binDir, { recursive: true });
		const ext = process.platform === "win32" ? ".exe" : "";
		fs.writeFileSync(path.join(binDir, `wgcf${ext}`), "stub", { mode: 0o755 });
		fs.writeFileSync(path.join(binDir, `wireproxy${ext}`), "stub", { mode: 0o755 });

		let clock = 1_000_000;
		let regCounter = 0;
		const ips = ["2606:4700:110:10::1", "2606:4700:110:20::1"];
		let ipIdx = 0;
		const engine = new WarpHopEngine({
			dataDir: dir,
			proxyPort: 43998,
			now: () => clock,
			readyPollMs: 5,
			readyTimeoutMs: 500,
			killStaleFn: async () => {},
			runCmd: async (_bin, args, cwd) => {
				if (args[0] === "register") {
					regCounter++;
					fs.writeFileSync(
						path.join(cwd, "wgcf-account.toml"),
						`device_id = "cold-${regCounter}"\n`,
					);
					return { code: 0, stdout: "ok", stderr: "" };
				}
				if (args[0] === "generate") {
					fs.writeFileSync(
						path.join(cwd, "wgcf-profile.conf"),
						"[Interface]\nPrivateKey = dummy\n",
					);
					return { code: 0, stdout: "ok", stderr: "" };
				}
				return { code: 1, stdout: "", stderr: "unexpected" };
			},
			spawnDaemon: () => {
				const fake = new EventEmitter() as any;
				fake.pid = 22222;
				fake.kill = () => fake.emit("exit", 0);
				return fake;
			},
			traceFn: async () => ({
				ip: ips[Math.min(ipIdx++, ips.length - 1)]!,
				warp: "on",
			}),
		});

		// No ensureStarted(): the reactive 429 path calls hop() directly.
		const first = await engine.hop({ force: true });
		assert.equal(first.ok, true);
		assert.equal(first.samePrefix, false);
		assert.equal(engine.getStatus().running, true);
		assert.equal(engine.getStatus().lastIp, ips[0]);

		// The manual 45 s cooldown still applies to a normal hop...
		clock += 1_000;
		const cooled = await engine.hop();
		assert.equal(cooled.ok, false);
		assert.match(cooled.error ?? "", /cooldown/);

		// ...but the automatic recovery path forces a fresh /64 immediately.
		const forced = await engine.hop({ force: true });
		assert.equal(forced.ok, true);
		assert.equal(forced.samePrefix, false);
		assert.equal(forced.ip, ips[1]);
		assert.equal(regCounter, 2);

		await engine.stop();
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("HTTP CONNECT tunnel rejects cleanly on non-200 proxy status", async () => {
	const { openProxyTlsTunnel } = await import("../extensions/warp-hop.ts");
	const server = http.createServer();
	server.on("connect", (_req, clientSocket: net.Socket) => {
		clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
		clientSocket.end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as net.AddressInfo).port;
	try {
		await assert.rejects(
			() =>
				openProxyTlsTunnel({
					proxyUrl: `http://127.0.0.1:${port}`,
					targetHost: "opencode.ai",
					targetPort: 443,
					timeoutMs: 2_000,
				}),
			/Proxy CONNECT failed with HTTP 502/,
		);
	} finally {
		server.close();
	}
});
