import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Transpiler } from "bun";

// Load the real definitions and cache filter without starting a proxy or network calls.
const source = readFileSync(new URL("../extensions/index.ts", import.meta.url), "utf8");
const definitions = source.slice(source.indexOf("const KNOWN_MODELS:"), source.indexOf("// ── Whitelists"));
const filter = source.slice(source.indexOf("function modelsFromCache("), source.indexOf("// Each upstream publishes"));
const compiled = new Transpiler({ loader: "ts", target: "node" }).transformSync(`${definitions}\n${filter}`);
const { KNOWN_MODELS, KILO_MODELS, KILO_MODEL_IDS, modelsFromCache } = new Function(
  `${compiled}; return { KNOWN_MODELS, KILO_MODELS, KILO_MODEL_IDS, modelsFromCache };`,
)();

const opencode = ["deepseek-v4.1-flash-free", "glm-5.3-flash-free", "cat-jam-free", "ll-alpha-free", "nemotron-3.5-super-vl-free"];
const kilo = ["nvidia/nemotron-3.5-super-vl:free", "stealth/glyph-cluster", "stealth/cat-jam"];

test("new free models register from their own catalogs and route to the right upstream", () => {
  const models = modelsFromCache({ fetchedAt: 1, opencode, kilo });
  for (const id of opencode) {
    assert.ok(KNOWN_MODELS.some((model: { id: string }) => model.id === id));
    assert.equal(models.find((model: { id: string }) => model.id === id)?.source, "opencode");
    assert.equal(KILO_MODEL_IDS.has(id), false);
  }
  for (const id of kilo) {
    assert.ok(KILO_MODELS.some((model: { id: string }) => model.id === id));
    assert.equal(models.find((model: { id: string }) => model.id === id)?.source, "kilo");
    assert.equal(KILO_MODEL_IDS.has(id), true);
  }
  assert.equal(new Set([...KNOWN_MODELS, ...KILO_MODELS].map((model: { id: string }) => model.id)).size, 32);
  const swapped = modelsFromCache({ fetchedAt: 1, opencode: kilo, kilo: opencode });
  assert.equal(swapped.length, 1); // Only the existing pinned openrouter/free survives.
});

test("Muse retains Responses API; paid DeepSeek and GLM IDs stay excluded", () => {
  for (const model of KNOWN_MODELS.filter((model: { id: string }) => model.id.startsWith("muse-spark"))) {
    assert.equal(model.api, "openai-responses");
  }
  for (const id of ["deepseek-v4.1-flash", "glm-5.3-flash"]) {
    assert.equal(KNOWN_MODELS.some((model: { id: string }) => model.id === id), false);
  }
});
