import assert from "node:assert/strict";
import { test } from "node:test";
import {
	UpstreamHealth,
	classifyUpstreamError,
	retryAfterSeconds,
} from "../extensions/upstream-health.ts";

// Upstream bodies below are the live-captured free-tier refusals the triage
// is built on (anomalyco/opencode #55816/#56719, 9router #4983).
const quota429 =
	'{"type":"error","error":{"type":"FreeUsageLimitError","message":"Free usage limit reached. Subscribe to OpenCode Go to keep going: https://opencode.ai/go"}}';
const rateLimit429 =
	'{"code":null,"message":"OpenCode Zen: Rate limit exceeded. Please try again later.","param":null,"type":"rate_limit_error"}';
const ipFlag403 =
	'{"type":"error","error":{"type":"FreeTierError","message":"OpenCode\'s free models aren\'t available from your current network because we\'ve detected abusive traffic from this IP address. This isn\'t related to your account."}}';
const shapeGate403 =
	'{"type":"error","error":{"type":"FreeTierError","message":"OpenCode\'s free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building."}}';

test("classifies the four upstream error axes from real bodies", () => {
	assert.equal(classifyUpstreamError(429, quota429), "quota");
	assert.equal(classifyUpstreamError(429, rateLimit429), "quota");
	assert.equal(classifyUpstreamError(429, ""), "quota");
	// 429 "Endpoint is unavailable" (glm capacity) is still a quota-class backoff.
	assert.equal(
		classifyUpstreamError(429, "Upstream request failed: Endpoint is unavailable"),
		"quota",
	);
	assert.equal(classifyUpstreamError(403, ipFlag403), "ip-flagged");
	assert.equal(classifyUpstreamError(403, shapeGate403), "shape-gate");
	// Message beats status: a quota body that arrived with a 403 stays quota.
	assert.equal(classifyUpstreamError(403, quota429), "quota");
	assert.equal(classifyUpstreamError(426, "Upgrade Required"), "other");
	assert.equal(classifyUpstreamError(200, ""), "other");
	assert.equal(classifyUpstreamError(400, "bad request"), "other");
});

test("parses Retry-After in seconds and HTTP-date form, clamped", () => {
	assert.equal(retryAfterSeconds(null), null);
	assert.equal(retryAfterSeconds(""), null);
	assert.equal(retryAfterSeconds("garbage"), null);
	assert.equal(retryAfterSeconds("0"), 0);
	assert.equal(retryAfterSeconds("120"), 120);
	assert.equal(retryAfterSeconds("99999"), 3600);
	const now = Date.parse("2026-10-23T12:00:00Z");
	assert.equal(retryAfterSeconds("120", now), 120);
	// 90 s in the future → 90; already past → 0.
	assert.equal(
		retryAfterSeconds(
			new Date(now + 90_000).toUTCString(),
			now,
		),
		90,
	);
	assert.equal(
		retryAfterSeconds(new Date(now - 60_000).toUTCString(), now),
		0,
	);
});

test("quota cooldown is per upstream+model only", () => {
	const h = new UpstreamHealth();
	const t0 = 1_000_000;
	h.recordQuotaFailure("opencode", "glm-5.3-flash-free", null, t0);
	assert.equal(h.cooldown("opencode", "glm-5.3-flash-free", t0 + 1)?.kind, "quota");
	// Other model, other upstream: unaffected.
	assert.equal(h.cooldown("opencode", "deepseek-v4.1-flash-free", t0 + 1), null);
	assert.equal(h.cooldown("kilo", "glm-5.3-flash-free", t0 + 1), null);
	// Lifts once the window passes.
	assert.equal(h.cooldown("opencode", "glm-5.3-flash-free", t0 + 90_001), null);
});

test("quota cooldown escalates and honors a longer server Retry-After", () => {
	const h = new UpstreamHealth();
	const t0 = 1_000_000;
	assert.equal(h.recordQuotaFailure("opencode", "m", null, t0), 90_000);
	assert.equal(h.recordQuotaFailure("opencode", "m", null, t0), 180_000);
	// Server hint (300 s) outranks the 90 s base but is capped at 1 h.
	assert.equal(h.recordQuotaFailure("opencode", "m2", 300, t0), 300_000);
	assert.equal(h.recordQuotaFailure("opencode", "m3", 7200, t0), 3_600_000);
	// A short hint never shortens the escalated floor.
	assert.equal(h.recordQuotaFailure("opencode", "m", 5, t0), 360_000);
});

test("egress flag blocks the whole upstream and wins over quota", () => {
	const h = new UpstreamHealth();
	const t0 = 1_000_000;
	h.recordQuotaFailure("opencode", "m", null, t0);
	h.recordEgressFailure("opencode", t0);
	assert.equal(h.cooldown("opencode", "m", t0 + 1)?.kind, "ip-flagged");
	assert.equal(h.cooldown("opencode", "other-model", t0 + 1)?.kind, "ip-flagged");
	assert.equal(h.cooldown("kilo", "m", t0 + 1), null);
	// Base 5 min, escalating (fresh tracker: the one above already failed once).
	const esc = new UpstreamHealth();
	assert.equal(esc.recordEgressFailure("opencode", t0), 300_000);
	assert.equal(esc.recordEgressFailure("opencode", t0), 600_000);
});

test("a 2xx clears both the model quota and the egress flag", () => {
	const h = new UpstreamHealth();
	const t0 = 1_000_000;
	h.recordQuotaFailure("opencode", "m", null, t0);
	h.recordEgressFailure("opencode", t0);
	h.recordSuccess("opencode", "m");
	assert.equal(h.cooldown("opencode", "m", t0 + 1), null);
});
