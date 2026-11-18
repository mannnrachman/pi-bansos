import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { transpileTs } from "./_transpile.ts";

const req = createRequire(import.meta.url);

// Exercise the real v3 wire helpers (headers + session isolation + 5 fingerprint gates)
// without loading the extension. Slice boundaries ride on stable marker comments.
const source = readFileSync(new URL("../extensions/index.ts", import.meta.url), "utf8");

// ── Headers & Session Isolation: v3 wire (9router #5381 + #5725) ────────────
const uaStart = source.indexOf("// OpenCode Zen free-tier client fingerprint.");
const headersEnd = source.indexOf("function toolNameOf(");
assert.ok(uaStart >= 0 && headersEnd > uaStart);
const headerHelpers = transpileTs(`
const randomBytes = (n) => require("node:crypto").randomBytes(n);
${source.slice(uaStart, headersEnd)}
`);
const {
  getOpenCodeUA,
  opencodeHeaders,
  clientSessionKey,
  currentOpenCodeSession,
  burnOpenCodeSession,
  OPENCODE_UA_FALLBACK,
  OPENCODE_SESSION_RE,
} = new Function(
  "require",
  `${headerHelpers}; return { getOpenCodeUA, opencodeHeaders, clientSessionKey, currentOpenCodeSession, burnOpenCodeSession, OPENCODE_UA_FALLBACK, OPENCODE_SESSION_RE };`,
)(req);

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

test("v3 wire: all four session headers + per-request id + client id (prompt_cache_key in body, not headers)", () => {
  const h = opencodeHeaders();
  const session = h["x-opencode-session"];
  assert.equal(h["x-opencode-client"], "opencode"); // was "desktop"
  assert.equal(h["x-opencode-session-id"], session);
  assert.equal(h["x-session-affinity"], session);
  assert.equal(h["X-Session-Id"], session); // the capitalized fourth
  assert.match(h["x-opencode-request"] ?? "", /^msg_[0-9A-Za-z]+$/); // required again
  assert.equal("prompt_cache_key" in h, false); // body field, never HTTP header
  assert.match(h["x-opencode-project"] ?? "", /^[0-9a-f]{40}$/); // per-boot hex
  // Two calls mint distinct request ids on the same session.
  assert.notEqual(opencodeHeaders()["x-opencode-request"], h["x-opencode-request"]);
  // BoringSSL JA4 cipher list is wired onto direct https.request calls.
  assert.ok(source.includes("ciphers: OPENCODE_CIPHER_LIST"));
  assert.ok(source.includes("TLS_AES_128_GCM_SHA256"));
  assert.ok(source.includes("body.prompt_cache_key = currentOpenCodeSession()"));
});

test("gate 1 (9router #5725): isolates sessions per downstream client UA/auth and burns only matching session", () => {
  const claudeKey = clientSessionKey({ "user-agent": "claude-cli/2.1.325", authorization: "Bearer shared" });
  const codexKey = clientSessionKey({ "user-agent": "codex-cli/0.42.0", authorization: "Bearer shared" });
  const sClaude = currentOpenCodeSession(claudeKey);
  const sCodex = currentOpenCodeSession(codexKey);
  assert.match(sClaude, OPENCODE_SESSION_RE);
  assert.match(sCodex, OPENCODE_SESSION_RE);
  assert.notEqual(sClaude, sCodex);
  // Stable across repeated calls for the same client.
  assert.equal(currentOpenCodeSession(claudeKey), sClaude);
  assert.equal(opencodeHeaders(claudeKey)["x-opencode-session"], sClaude);
  // Burning with a stale rejectedSession leaves a newer replacement untouched.
  const rotated = burnOpenCodeSession(claudeKey, sClaude);
  assert.notEqual(rotated, sClaude);
  assert.equal(burnOpenCodeSession(claudeKey, sClaude), rotated);
  // Codex session was unaffected by Claude's rotation.
  assert.equal(currentOpenCodeSession(codexKey), sCodex);
});

// ── Tool aliasing: 5 fingerprint gates + history rewrite (#5328 + #5725) ────
const toolsStart = source.indexOf("function toolNameOf(");
const toolsEnd = source.indexOf("function sanitizeResponsesItems(");
assert.ok(toolsStart >= 0 && toolsEnd > toolsStart);
const toolHelpers = transpileTs(`
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

test("gate 2: a declared 'terminal' tool (and substring) is aliased off the wire", () => {
  const body: Record<string, any> = {
    tools: [
      { type: "function", function: { name: "Terminal", parameters: {} } },
      { type: "function", function: { name: "my_terminal_tool", parameters: {} } },
      { type: "function", function: { name: "safe_tool", parameters: {} } },
    ],
  };
  ensureChatFingerprintTools(body);
  const names = body.tools.map((t: { function: { name: string } }) => t.function.name);
  assert.equal(names.some((n: string) => n.toLowerCase().includes("terminal")), false);
  assert.equal(names.includes("safe_tool"), true);
  assert.equal(names.includes("run_command"), true);
  assert.equal(names.includes("run_command_2"), true);
  assert.equal(body.__bansosToolAliases.run_command, "Terminal");
  assert.equal(body.__bansosToolAliases.run_command_2, "my_terminal_tool");
  assert.ok(names.includes("read"));
  assert.ok(names.includes("shell"));
});

test("gates 3 & 5 (#5725): aliases Claude Code ReportFindings pair and Codex exec_command pair", () => {
  const claudeBody: Record<string, any> = {
    tools: [
      { type: "function", function: { name: "ReportFindings", parameters: {} } },
      { type: "function", function: { name: "ScheduleWakeup", parameters: {} } },
      { type: "function", function: { name: "DeferredToolPlaceholder", parameters: {} } },
    ],
  };
  ensureChatFingerprintTools(claudeBody);
  const claudeNames = claudeBody.tools.map((t: any) => t.function.name);
  assert.equal(claudeNames.includes("ReportFindings"), false);
  assert.equal(claudeNames.includes("ScheduleWakeup"), true);
  assert.equal(claudeBody.__bansosToolAliases.run_command, "ReportFindings");

  const codexBody: Record<string, any> = {
    tools: [
      { type: "function", name: "exec_command", parameters: {} },
      { type: "function", name: "write_stdin", parameters: {} },
    ],
    input: [{ type: "function_call", name: "exec_command", arguments: "{}" }],
  };
  ensureResponsesFingerprintTools(codexBody);
  const codexNames = codexBody.tools.map((t: any) => t.name);
  assert.equal(codexNames.includes("exec_command"), false);
  assert.equal(codexNames.includes("write_stdin"), true);
  assert.equal(codexBody.__bansosToolAliases.run_command, "exec_command");
  // History function_call items are rewritten to match the wire alias.
  assert.equal(codexBody.input[0].name, "run_command");
});

test("gate 4 (#5725): aliases Edit/Read name+schema fingerprints and rewrites chat history tool_calls", () => {
  const body: Record<string, any> = {
    tools: [
      {
        type: "function",
        function: {
          name: "Edit",
          parameters: { type: "object", properties: { file_path: {}, old_string: {}, new_string: {} } },
        },
      },
      {
        type: "function",
        function: {
          name: "Read",
          parameters: { type: "object", properties: { file_path: {} } },
        },
      },
      {
        type: "function",
        function: { name: "bash", parameters: {} },
      },
    ],
    messages: [
      {
        role: "assistant",
        tool_calls: [
          { id: "tc1", type: "function", function: { name: "Edit", arguments: "{}" } },
          { id: "tc2", type: "function", function: { name: "bash", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "tc1", name: "Edit", content: "ok" },
    ],
  };
  ensureChatFingerprintTools(body);
  const names = body.tools.map((t: any) => t.function.name);
  assert.ok(names.includes("file_edit"));
  assert.ok(names.includes("file_read"));
  assert.ok(names.includes("bash_pi"));
  assert.equal(body.__bansosToolAliases.file_edit, "Edit");
  assert.equal(body.__bansosToolAliases.file_read, "Read");
  assert.equal(body.__bansosToolAliases.bash_pi, "bash");
  assert.equal(body.messages[0].tool_calls[0].function.name, "file_edit");
  assert.equal(body.messages[0].tool_calls[1].function.name, "bash_pi");
  assert.equal(body.messages[1].name, "file_edit");
});

test("responses: initializes missing tools[] and aliases terminal + colliding tools", () => {
  const emptyBody: Record<string, any> = {};
  ensureResponsesFingerprintTools(emptyBody);
  assert.equal(emptyBody.tools.length, 2);

  const body: Record<string, any> = {
    tools: [
      { type: "function", name: "terminal", description: "run", parameters: {} },
      { type: "function", name: "bash", description: "sh", parameters: {} },
    ],
  };
  ensureResponsesFingerprintTools(body);
  const names = body.tools.map((t: { name: string }) => t.name);
  assert.equal(names.some((n: string) => n.toLowerCase().includes("terminal")), false);
  assert.equal(names.includes("run_command"), true);
  assert.equal(names.includes("bash_pi"), true);
  assert.equal(body.__bansosToolAliases.run_command, "terminal");
});
