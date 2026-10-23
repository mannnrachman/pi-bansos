/**
 * Upstream 429/403 triage + reactive cooldowns.
 *
 * Free-tier upstreams answer two unrelated problems with two different
 * errors, and conflating them is the classic misdiagnosis (live-captured
 * upstream bodies, 2026-10 — see ebouther/opencode-unlimited-proxy
 * docs/free-tier-gates.md and anomalyco/opencode #55816/#56719):
 *
 * - `429 FreeUsageLimitError` / "Rate limit exceeded" — QUOTA. The request
 *   ran; the budget (per model, per IP, and dynamic with upstream capacity —
 *   OpenCode deliberately does not publish the numbers) is spent. Backing
 *   off per model is the correct response; retrying immediately just digs
 *   the IP deeper into risk control.
 * - `403 FreeTierError` "…abusive traffic from this IP address" — EGRESS IP
 *   flagged. Backoff cannot fix this; the network needs a different egress
 *   (relay). Cooldown fails fast with that instruction instead of hammering.
 * - `403 FreeTierError` "…can only be used from within OpenCode" — SHAPE
 *   GATE. Deterministic fingerprint rejection: every retry fails identically
 *   on every egress, so no cooldown is recorded and the body is surfaced
 *   as-is (if this fires, the upstream gate changed — not a rate problem).
 *
 * Separate from the local request guard (flood protection with our own
 * numbers) and from relay pool cooldowns (egress health): this mirrors what
 * the upstream itself reported, keyed by what it meters.
 */

export type UpstreamErrorKind = "quota" | "ip-flagged" | "shape-gate" | "other";

/** Classify an upstream error response from its status + body text. */
export function classifyUpstreamError(
	status: number,
	body: string,
): UpstreamErrorKind {
	const text = body ?? "";
	if (status === 403 && /abusive traffic/i.test(text)) return "ip-flagged";
	if (status === 403 && /FreeTierError/i.test(text)) return "shape-gate";
	if (status === 429) return "quota";
	if (
		/FreeUsageLimitError|Free usage limit|rate_limit_error|Rate limit exceeded/i.test(
			text,
		)
	) {
		return "quota";
	}
	return "other";
}

/**
 * Parse a `Retry-After` header (delay-seconds or HTTP-date form).
 * Returns null when absent/unparseable. Values are clamped to [0, 3600]s so
 * a hostile/garbage header cannot wedge a model for hours.
 */
export function retryAfterSeconds(
	value: string | null | undefined,
	now = Date.now(),
): number | null {
	if (value == null) return null;
	const trimmed = value.trim();
	if (trimmed === "") return null;
	const n = Number(trimmed);
	if (Number.isFinite(n) && n >= 0) return Math.min(Math.floor(n), 3600);
	const date = Date.parse(trimmed);
	if (!Number.isNaN(date)) {
		return Math.min(Math.max(0, Math.ceil((date - now) / 1000)), 3600);
	}
	return null;
}

type Entry = { failures: number; until: number };

const QUOTA_BASE_MS = 90_000;
const QUOTA_CAP_MS = 15 * 60_000;
const EGRESS_BASE_MS = 5 * 60_000;
const EGRESS_CAP_MS = 30 * 60_000;
/** Ceiling for a server-provided Retry-After (keeps long hints sane). */
const SERVER_HINT_CAP_MS = 60 * 60_000;

export type Cooldown = {
	kind: "quota" | "ip-flagged";
	/** Epoch ms until the cooldown lifts. */
	until: number;
};

/**
 * Tracks reactive cooldowns per `upstream:model` (quota) and per upstream
 * egress (IP-flag). `now` is injectable for tests.
 */
export class UpstreamHealth {
	private models = new Map<string, Entry>();
	private egress = new Map<string, Entry>();

	/** Record a quota 429 for one model; returns the cooldown ms applied. */
	recordQuotaFailure(
		upstream: string,
		model: string,
		retryAfterSec: number | null,
		now = Date.now(),
	): number {
		return this.bump(
			this.models,
			`${upstream}:${model}`,
			QUOTA_BASE_MS,
			QUOTA_CAP_MS,
			retryAfterSec == null ? null : retryAfterSec * 1000,
			now,
		);
	}

	/** Record an IP-flag 403 for the whole upstream egress; returns cooldown ms. */
	recordEgressFailure(upstream: string, now = Date.now()): number {
		return this.bump(
			this.egress,
			upstream,
			EGRESS_BASE_MS,
			EGRESS_CAP_MS,
			null,
			now,
		);
	}

	/** Active cooldown for a model, or null. Egress flags win over quota. */
	cooldown(upstream: string, model: string, now = Date.now()): Cooldown | null {
		const e = this.egress.get(upstream);
		if (e && e.until > now) return { kind: "ip-flagged", until: e.until };
		const m = this.models.get(`${upstream}:${model}`);
		if (m && m.until > now) return { kind: "quota", until: m.until };
		return null;
	}

	/** A 2xx clears both the model's quota state and the egress flag. */
	recordSuccess(upstream: string, model: string): void {
		this.models.delete(`${upstream}:${model}`);
		this.egress.delete(upstream);
	}

	private bump(
		map: Map<string, Entry>,
		key: string,
		baseMs: number,
		capMs: number,
		serverHintMs: number | null,
		now: number,
	): number {
		const prev = map.get(key);
		const failures = (prev?.failures ?? 0) + 1;
		let ms = Math.min(baseMs * 2 ** (failures - 1), capMs);
		if (serverHintMs != null) {
			// A server-provided Retry-After outranks our escalation, but is
			// itself capped so a bad hint cannot wedge a model for a day.
			ms = Math.min(Math.max(ms, serverHintMs), SERVER_HINT_CAP_MS);
		}
		map.set(key, { failures, until: now + ms });
		return ms;
	}
}
