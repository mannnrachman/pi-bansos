import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { transpileTs } from "./_transpile.ts";

// Load the real definitions and cache filter without starting a proxy or network calls.
const source = readFileSync(new URL("../extensions/index.ts", import.meta.url), "utf8");
const definitions = source.slice(source.indexOf("const KNOWN_MODELS:"), source.indexOf("// ── Whitelists"));
const filter = source.slice(source.indexOf("function modelsFromCache("), source.indexOf("// Each upstream publishes"));
const compiled = transpileTs(`${definitions}\n${filter}`);
const { KNOWN_MODELS, KILO_MODELS, KILO_MODEL_IDS, modelsFromCache } = new Function(
  `${compiled}; return { KNOWN_MODELS, KILO_MODELS, KILO_MODEL_IDS, modelsFromCache };`,
)();

// 2026-11-21 sweep: the live free catalogs (keyless chat-verified where the
// gateway allows probing; OpenCode ids cross-checked against zen /zen/v1/models
// cost=0 entries).
const opencode = ["beam-free", "hy4-flash-free", "longcat-2.5-free", "iceman-free", "flint-40b-free", "mimo-v2.6-flash-free", "nemotron-3.5-lightning-free", "big-pickle", "deepseek-v4.1-flash-free", "tidepool-alpha-free", "nemotron-3.5-super-vl-free"];
const kilo = ["kilo-auto/free", "nvidia/nemotron-3-ultra-550b-a55b:free", "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", "openrouter/free", "nvidia/nemotron-3.5-lightning:free", "nvidia/nemotron-3.5-super-vl:free", "reflection/beam-free", "baidu/ernie-5.5-flash-preview:free", "inclusionai/ling-3.2-flash:free", "liquid/lfm-3-1.7b:free", "particle-ai/particle-1:free", "recursive/flint-v1.0:free"];

test("live catalog ids all register and route to the right upstream", () => {
  const models = modelsFromCache({ fetchedAt: 1, opencode, kilo });
  for (const id of opencode) {
    assert.ok(KNOWN_MODELS.some((model: { id: string }) => model.id === id), `missing OC def: ${id}`);
    assert.equal(models.find((model: { id: string }) => model.id === id)?.source, "opencode");
    assert.equal(KILO_MODEL_IDS.has(id), false);
  }
  for (const id of kilo) {
    assert.ok(KILO_MODELS.some((model: { id: string }) => model.id === id), `missing Kilo def: ${id}`);
    assert.equal(models.find((model: { id: string }) => model.id === id)?.source, "kilo");
    assert.equal(KILO_MODEL_IDS.has(id), true);
  }
  assert.equal(new Set([...KNOWN_MODELS, ...KILO_MODELS].map((model: { id: string }) => model.id)).size, 23);
  const swapped = modelsFromCache({ fetchedAt: 1, opencode: kilo, kilo: opencode });
  assert.equal(swapped.length, 1); // Only the existing pinned openrouter/free survives.
});

test("2026-11-21 sweep: dead models are dropped from the curated lists", () => {
  const gone = [
    "crouton-alpha-free", "glm-5.3-flash-free", "inkling-2-small-free", // 2026-11-21: gone from zen /zen/v1/models
    "dots-studio/dots-3-note-preview:free", "cohere/north-mini-code:free", // 2026-11-21: gone from kilo gateway
    "muse-spark-1.3-contributor-free", "muse-spark-1.2-contributor-free", // 410 deprecated
    "space-bunny-free", "ll-alpha-free", // 410 deprecated
    "step-5-preview-free", "ling-3.0-flash-fin-free", "ling-3.1-flash-free", // 400 unavailable
    "minimax-m3.1-flash-free", "nemotron-3-ultra-free", "longcat-2.5-preview-free", "cat-jam-free", // gone from catalog
    "pulse-alpha-free", // 2026-11-07: gone from catalog, 400 Model is unavailable
    "stealth/glyph-cluster", "stealth/cat-jam", // 401 sign-in required
    "poolside/laguna-xs-2.1:free", // 429 shared pool, consistent
    "liquid/lfm-2.5-2.6b:free", // still absent (only lfm-3-1.7b returned, 2026-11-21)
    "minimax/minimax-m3.1-flash:free", // 404 model gone
    "thinkingmachines/inkling-small:free", // 404 unavailable
    "xingchen-agi/xing4.0-29b-a4b:free", // 2026-11-06: gone from catalog
    "nvidia/nemotron-3-super-120b-a12b:free", // 2026-11-06: gone from catalog
    "nvidia/nemotron-3.5-content-safety:free", // 2026-11-06: gone from catalog
    "poolside/laguna-s-2.1:free", // 2026-11-06: gone from catalog
  ];
  for (const id of gone) {
    assert.equal(KNOWN_MODELS.some((m: { id: string }) => m.id === id), false, `OC should have dropped ${id}`);
    assert.equal(KILO_MODELS.some((m: { id: string }) => m.id === id), false, `Kilo should have dropped ${id}`);
  }
});

test("paid stealth variants and unregistered catalog entries stay excluded", () => {
  for (const id of ["stealth/claude-opus-4.8", "stealth/claude-sonnet-4.6", "stealth/qwen3.6-plus", "muse-wonder-1.0", "jev-1.13-free", "test"]) {
    assert.equal(KILO_MODELS.some((m: { id: string }) => m.id === id), false);
  }
  // beam-free is OpenCode-only; its bare Kilo-style id must not exist there.
  assert.equal(KILO_MODEL_IDS.has("beam-free"), false);
});
