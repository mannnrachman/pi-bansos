import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { test } from "node:test";
import { Transpiler } from "bun";

// Exercise the actual helper without loading the extension's Pi dependencies.
const source = readFileSync(new URL("../extensions/index.ts", import.meta.url), "utf8");
const start = source.indexOf("function pipeUpstreamStream(");
const end = source.indexOf("// ── Start local proxy", start);
assert.ok(start >= 0 && end > start);
const compiled = new Transpiler({ loader: "ts", target: "node" }).transformSync(source.slice(start, end));
const pipe = new Function("StringDecoder", "log", `${compiled}; return pipeUpstreamStream;`)(
  StringDecoder, () => {},
);

async function collect(chunks: Buffer[], aliases?: Record<string, string>): Promise<string> {
  const output: Buffer[] = [];
  const response = new Writable({
    write(chunk, _encoding, callback) { output.push(Buffer.from(chunk)); callback(); },
  });
  const done = new Promise<void>((resolve, reject) => {
    response.on("finish", resolve);
    response.on("error", reject);
  });
  pipe(Readable.from(chunks), response, new EventEmitter(), aliases);
  await done;
  return Buffer.concat(output).toString("utf8");
}

const fixtures = [
  'data: {"name":"bash_pi"}\n\ndata: {"x":2}\n\n',
  'data: {"name":"bash_pi"}\r\n\r\ndata: {"x":2}\r\n\r\n',
  'data: {"name":"bash_pi","text":"你好 café 🐦"}\n\n',
  'data: {"name":"bash_pi"}\n\ndata: {"text":"akhir"}',
  '\n\ndata: {"name":"bash_pi"}\n\n\n',
];
for (const [index, fixture] of fixtures.entries()) {
  test(`alias framing fixture ${index}: every byte boundary and one-byte chunks`, async () => {
    const bytes = Buffer.from(fixture);
    const expected = fixture.replaceAll("bash_pi", "bash");
    const partitions = [[bytes], ...Array.from({ length: bytes.length + 1 }, (_, i) => [bytes.subarray(0, i), bytes.subarray(i)]), Array.from(bytes, b => Buffer.from([b]))];
    for (const chunks of partitions) assert.equal(await collect(chunks, { bash_pi: "bash" }), expected);
  });
}
test("no-alias UTF-8 passthrough", async () => {
  const fixture = Buffer.from('data: {"text":"你好 🐦","name":"bash_pi"}\n\n');
  assert.equal(await collect(Array.from(fixture, b => Buffer.from([b]))), fixture.toString());
});
