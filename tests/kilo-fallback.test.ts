import assert from "node:assert/strict";
import test from "node:test";
import {
	buildKiloFallbackBody,
	DEFAULT_KILO_FALLBACK_MODEL,
	rewriteModelInJson,
	rewriteModelInSseLine,
} from "../extensions/kilo-fallback.ts";

test("Kilo fallback rebuilds the original request with its own model", () => {
	const raw = JSON.stringify({
		model: "deepseek-v4.1-flash-free",
		messages: [{ role: "user", content: "hi" }],
		tools: [
			{
				type: "function",
				function: { name: "shell", parameters: { type: "object" } },
			},
		],
		stream: true,
		prompt_cache_key: "ses_abc",
		__bansosToolAliases: { run_command: "shell" },
	});
	const body = buildKiloFallbackBody(raw, DEFAULT_KILO_FALLBACK_MODEL);
	assert.ok(body);
	assert.equal(body.model, DEFAULT_KILO_FALLBACK_MODEL);
	assert.equal(body.stream, true);
	assert.deepEqual(body.tools, [
		{
			type: "function",
			function: { name: "shell", parameters: { type: "object" } },
		},
	]);
	assert.equal("prompt_cache_key" in body, false);
	assert.equal("__bansosToolAliases" in body, false);
	// The caller's raw payload is not mutated.
	assert.equal(JSON.parse(raw).model, "deepseek-v4.1-flash-free");
});

test("Kilo fallback rejects bodies it cannot replay", () => {
	assert.equal(buildKiloFallbackBody("not json", "kilo-auto/free"), null);
	assert.equal(buildKiloFallbackBody("[]", "kilo-auto/free"), null);
	assert.equal(buildKiloFallbackBody("null", "kilo-auto/free"), null);
});

test("Kilo fallback restores the requested model in JSON responses", () => {
	const out = rewriteModelInJson(
		JSON.stringify({
			id: "x",
			model: "reflection/beam-free",
			choices: [{ message: { role: "assistant", content: "hello" } }],
		}),
		"deepseek-v4.1-flash-free",
	);
	const json = JSON.parse(out);
	assert.equal(json.model, "deepseek-v4.1-flash-free");
	assert.equal(json.choices[0].message.content, "hello");
	// Non-JSON payloads pass through untouched.
	assert.equal(rewriteModelInJson("not json", "m"), "not json");
});

test("Kilo fallback rewrites the model in SSE data lines only", () => {
	const chunk = `data: {"id":"x","model":"reflection/beam-free","choices":[]}`;
	const out = rewriteModelInSseLine(chunk, "deepseek-v4.1-flash-free");
	assert.match(out, /"model":"deepseek-v4\.1-flash-free"/);
	assert.equal(rewriteModelInSseLine("data: [DONE]", "m"), "data: [DONE]");
	assert.equal(rewriteModelInSseLine("event: message", "m"), "event: message");
});
