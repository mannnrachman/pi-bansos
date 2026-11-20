// Pure helpers for the KiloCode free fallback (used when OpenCode's daily
// free bucket is exhausted across egresses). Kept separate from index.ts so
// the request/response rewriting is unit-testable without booting the proxy.

export const DEFAULT_KILO_FALLBACK_MODEL = "kilo-auto/free";

/** Rebuild the caller's original request for Kilo's chat-completions API. */
export function buildKiloFallbackBody(
	rawBody: Buffer | string,
	fallbackModel: string,
): Record<string, unknown> | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawBody.toString());
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return null;
	}
	const body = { ...(parsed as Record<string, unknown>) };
	body.model = fallbackModel;
	// OpenCode-only bookkeeping must never reach Kilo.
	delete body.prompt_cache_key;
	delete body.__bansosToolAliases;
	return body;
}

/** Rewrite the `model` field of a non-streaming JSON completion. */
export function rewriteModelInJson(text: string, model: string): string {
	try {
		const json: unknown = JSON.parse(text);
		if (json && typeof json === "object" && !Array.isArray(json)) {
			(json as Record<string, unknown>).model = model;
			return JSON.stringify(json);
		}
	} catch {}
	return text;
}

/** Rewrite the `model` field of an SSE `data:` line (other lines untouched). */
export function rewriteModelInSseLine(line: string, model: string): string {
	if (!line.startsWith("data:")) return line;
	const safe = model.replace(/"/g, "");
	return line.replace(/"model"\s*:\s*"[^"]*"/, `"model":"${safe}"`);
}
