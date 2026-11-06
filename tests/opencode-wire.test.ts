import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Transpiler } from "bun";

// Exercise the real v3 wire helpers (headers + tool aliasing) without loading
// the extension. Slice boundaries ride on stable marker comments.
const source = readFileSync(new URL("../extensions/index.ts", import.meta.url), "utf8");

// ── Headers: v3 wire (9router #5381) ────────────────────────────────────────
const uaStart = source.indexOf("// OpenCode Zen free-tier client fingerprint.");
const headersEnd = source.indexOf("function toolNameOf(");
assert.ok(uaStart >= 0 && headersEnd > uaStart);
const headerHelpers = new Transpiler({ loader: "ts", target: "node" }).transformSync(`
const randomBytes = (n) => require("node:crypto").randomBytes(n);
${source.slice(uaStart, headersEnd)}
`);
const { getOpenCodeUA, opencodeHeaders, OPENCODE_UA_FALLBACK, OPENCODE_SESSION_RE } = new Function(
  "require",
  `${headerHelpers}; return { getOpenCodeUA, opencodeHeaders, OPENCODE_UA_FALLBACK, OPENCODE_SESSION_RE };`,
)(require);

test("v3 wire: UA is a dev-wire stamp, overridable via env", () => {
  delete process.env.BANSOS_OPENCODE_UA;
  assert.equal(getOpenCodeUA(), OPENCODE_UA_FALLBACK);
  assert.match(OPENCODE_UA_FALLBACK, /^opencode\/dev\/[\w.-]+\/opencode$/);
  process.env.BANSOS_OPENCODE_UA = "opencode/dev/0.0.0-dev-test/opencode";
  assert.equal(getOpenCodeUA(), "opencode/dev/0.0.0-dev-test/opencode");
  // Bare values are wrapped into the dev-wire shape.
  process.env.BANSOS_OPENCODE_UA = "1.19.0";
  assert.equal(getOpenCodeUA(), "opencode/1.19.0");
  delete process.env.BANSOS_OPENCODE_UA;
});

test("v3 wire: all four session headers + per-request id + cache key + client id", () => {
  const h = opencodeHeaders();
  const session = h["x-opencode-session"];
  assert.equal(h["x-opencode-client"], "opencode"); // was "desktop"
  assert.equal(h["x-opencode-session-id"], session);
  assert.equal(h["x-session-affinity"], session);
  assert.equal(h["X-Session-Id"], session); // the capitalized fourth
  assert.match(h["x-opencode-request"] ?? "", /^msg_[0-9A-Za-z]+$/); // required again
  assert.equal(h.prompt_cache_key, session); // bound to the session
  assert.match(h["x-opencode-project"] ?? "", /^[0-9a-f]{40}$/); // per-boot hex
  // Two calls mint distinct request ids on the same session.
  assert.notEqual(opencodeHeaders()["x-opencode-request"], h["x-opencode-request"]);
});

// ── Tool aliasing: "terminal" textual gate (9router #5328) ──────────────────
const toolsStart = source.indexOf("function toolNameOf(");
const toolsEnd = source.indexOf("function sanitizeResponsesItems(");
assert.ok(toolsStart >= 0 && toolsEnd > toolsStart);
const toolHelpers = new Transpiler({ loader: "ts", target: "node" }).transformSync(`
const OPENCODE_TOOL_NAMES = new Set(["bash", "read", "shell", "glob", "grep", "edit", "write", "patch", "webfetch", "list", "todowrite", "todoread"]);
const OPENCODE_EXACT_TOOLS = [
  { type: "function", function: { name: "read", description: "read", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "shell", description: "shell", parameters: { type: "object", properties: {} } } },
];
${source.slice(toolsStart, toolsEnd)}
`);
const { ensureChatFingerprintTools, ensureResponsesFingerprintTools } = new Function(
  `${toolHelpers}; return { ensureChatFingerprintTools, ensureResponsesFingerprintTools };`,
)();

test("chat: a declared 'terminal' tool is aliased off the wire", () => {
  const body = { tools: [{ type: "function", function: { name: "terminal", description: "run", parameters: {} } }] };
  ensureChatFingerprintTools(body);
  const names = body.tools.map((t: { function: { name: string } }) => t.function.name);
  assert.equal(names.includes("terminal"), false);
  assert.ok(names.includes("run_command")); // the alias
  assert.equal(body.__bansosToolAliases.run_command, "terminal");
  // The exact read+shell pair rides along untouched.
  assert.ok(names.includes("read"));
  assert.ok(names.includes("shell"));
});

test("chat: terminal as a substring is caught too (case-insensitive)", () => {
  const body = { tools: [
    { type: "function", function: { name: "Terminal", parameters: {} } },
    { type: "function", function: { name: "my_terminal_tool", parameters: {} } },
    { type: "function", function: { name: "safe_tool", parameters: {} } },
  ] };
  ensureChatFingerprintTools(body);
  const names = body.tools.map((t: { function: { name: string } }) => t.function.name);
  assert.equal(names.some((n: string) => n.toLowerCase().includes("terminal")), false);
  assert.equal(names.includes("safe_tool"), true); // untouched
  assert.equal(names.includes("run_command"), true);
  assert.equal(names.includes("run_command_2"), true); // deduped aliases
});

test("responses: the same terminal aliasing applies", () => {
  const body = { tools: [
    { type: "function", name: "terminal", description: "run", parameters: {} },
    { type: "function", name: "bash", description: "sh", parameters: {} },
  ] };
  ensureResponsesFingerprintTools(body);
  const names = body.tools.map((t: { name: string }) => t.name);
  assert.equal(names.some((n: string) => n.toLowerCase().includes("terminal")), false);
  assert.equal(names.includes("run_command"), true);
  assert.equal(names.includes("bash_pi"), true); // collision alias keeps _pi
  assert.equal(body.__bansosToolAliases.run_command, "terminal");
});

