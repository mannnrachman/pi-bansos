import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Transpiler } from "bun";

// Exercise the real <env> fingerprint helpers without loading the extension.
const source = readFileSync(new URL("../extensions/index.ts", import.meta.url), "utf8");
const start = source.indexOf("// v2 gate (2026-10-25");
const end = source.indexOf("/** Rewrite OpenCode free-tier request body");
assert.ok(start >= 0 && end > start);
const compiled = new Transpiler({ loader: "ts", target: "node" }).transformSync(source.slice(start, end));
const { ensureEnvFingerprint, ENV_FINGERPRINT_NOTE } = new Function(
  "path", "tmpdir", `${compiled}; return { ensureEnvFingerprint, ENV_FINGERPRINT_NOTE };`,
)(path, tmpdir);

test("chat: appends the <env> block to the existing system message", () => {
  const body = { messages: [{ role: "system", content: "You are helpful." }, { role: "user", content: "hi" }] };
  ensureEnvFingerprint(body, false);
  const sys = body.messages[0];
  assert.ok(sys.content.startsWith("You are helpful."));
  assert.ok(sys.content.includes("<env>"));
  assert.ok(sys.content.includes("</env>"));
  assert.ok(sys.content.includes(`Working directory: ${process.cwd()}`));
  assert.ok(sys.content.includes(`Platform: ${process.platform}`));
  // The user message is untouched and stays last.
  assert.equal(body.messages[1].content, "hi");
});

test("chat: unshifts a system message when none exists", () => {
  const body = { messages: [{ role: "user", content: "hi" }] };
  ensureEnvFingerprint(body, false);
  assert.equal(body.messages[0].role, "system");
  assert.equal(body.messages[0].content, ENV_FINGERPRINT_NOTE);
  assert.equal(body.messages.length, 2);
});

test("chat: a prompt already carrying <env> passes through untouched", () => {
  const content = "agent prompt\n<env>\n  Platform: linux\n</env>";
  const body = { messages: [{ role: "system", content }, { role: "user", content: "hi" }] };
  ensureEnvFingerprint(body, false);
  assert.equal(body.messages[0].content, content);
  // Block-array system content is also detected and left alone.
  const blocked = { messages: [{ role: "system", content: [{ type: "text", text: "x <env> y" }] }] };
  ensureEnvFingerprint(blocked, false);
  assert.equal(blocked.messages[0].content.length, 1);
});

test("chat: block-array system content gets the note appended as a text block", () => {
  const body = { messages: [{ role: "system", content: [{ type: "text", text: "You are helpful." }] }] };
  ensureEnvFingerprint(body, false);
  const blocks = body.messages[0].content;
  assert.equal(blocks.length, 2);
  assert.equal(blocks[1].type, "text");
  assert.ok(blocks[1].text.includes("<env>"));
});

test("responses: instructions carries the block; existing <env> passes through", () => {
  const body = { instructions: "be terse" };
  ensureEnvFingerprint(body, true);
  assert.ok(body.instructions.startsWith("be terse"));
  assert.ok(body.instructions.includes("<env>"));
  const empty = {};
  ensureEnvFingerprint(empty, true);
  assert.equal(empty.instructions, ENV_FINGERPRINT_NOTE);
  const passthrough = { instructions: "keep <env> as is" };
  ensureEnvFingerprint(passthrough, true);
  assert.equal(passthrough.instructions, "keep <env> as is");
});
