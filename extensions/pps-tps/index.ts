/**
 * pi-pps-tps-mini — minimal prefill/generation speedometer for the pi coding agent.
 *
 * Based on @qingwawangzi/pi-speedline, stripped to the essentials.
 * One status slot, three elements, exact per-turn values only:
 *
 *   ⏱️249pps 41tps      engine clocks: pps of this request, tps over the round
 *   ⚡249pps 34tps       fallback: spans measured in pi (same aggregation)
 *
 *   The glyph states the SOURCE of the numbers: ⏱️ = the engine's own clocks
 *   for this request, ⚡ = spans measured here. Both are exact and they answer
 *   different questions (engine speed vs. delivered speed); the difference is
 *   reported as "Delivery overhead" in /pps-tps. No space after the glyph.
 *
 *   pps — prefill speed: prompt tokens ÷ TTFT (request dispatch → first
 *         token), analogous to TTFT but normalized by prompt length.
 *         Computed ONLY when the prompt is not short (usage.input ≥
 *         MIN_PROMPT_TOKENS) — for short prompts TTFT is dominated by
 *         network latency and the rate is meaningless. There the previous
 *         value stays on screen, slightly darker (ghost). No previous
 *         value yet → ghost placeholder "–pps".
 *   tps — tokens generated per second: Σ usage.output ÷ Σ pure streaming
 *         time (first→last delta span per message; tool runs and
 *         inter-call gaps excluded) across the current round.
 *
 * When the provider reports its own timings — llama.cpp attaches a `timings`
 * object to the final SSE chunk of an OpenAI-compatible completion — pps and
 * tps come from the ENGINE instead: prompt_n ÷ prompt_ms and predicted_n ÷
 * predicted_ms, aggregated over the round. Those two clocks are disjoint
 * (prefill, then decode), so nothing is counted twice. The measured spans then
 * only serve as the fallback, and the gap between the two views is itself
 * informative: /pps-tps reports it as Delivery overhead (client span beyond the
 * engine's decode clock) and Pre-stream wait (TTFT beyond the engine's prefill
 * clock: model load, queueing, network). Everything is exact (provider usage,
 * provider timings, measured spans), no live estimates, no calibration. The
 * display updates when each assistant message completes; between messages the
 * last final line stays visible.
 *
 * Session totals (see /pps-tps): accumulated prefill time, decode time and
 * round wall time for the current pi runtime, plus aggregate rates computed
 * as Σtokens ÷ Σtime (single time-weighted number per metric — no mean of
 * per-call rates, no percentiles). "w/o 1st" drops the runtime's FIRST
 * assistant request from both the time and the token numerator: it usually
 * carries server-side model load / cold cache and says little about steady
 * state. Totals are in-memory only — pi stores no timings in the session
 * JSONL, so /resume, /fork and /reload start from zero.
 *
 * Color: everything renders in the footer's default color (plain text, no
 * color escapes). The only exception is stale pps — the previous value kept
 * when the current prompt was too short to measure — rendered ~45% darker.
 *
 * Prompt tokens and the cache: pi normalizes provider usage so `usage.input`
 * EXCLUDES cache-read and cache-write tokens (Anthropic reports them
 * separately; for OpenAI-compatible APIs cached_tokens is subtracted from
 * prompt_tokens). pps therefore measures the speed of prefilling the NEW,
 * uncached part of the prompt — cache-heavy turns naturally have small
 * uncached remainders and fall under MIN_PROMPT_TOKENS, keeping the last
 * good value on screen instead of a meaningless spike.
 */
import type { ExtensionAPI, ThemeColor } from "@earendil-works/pi-coding-agent";

// ── Tunables ────────────────────────────────────────────────────────────
const STATUS_KEY = "pps-tps";
/**
 * Footer glyphs. Two constraints, both load-bearing: the glyph must be
 * East-Asian-wide (2 cells) and it must satisfy pi's own width test, which
 * counts a grapheme as 2 only when it matches \p{RGI_Emoji}. Bare ⚡ (U+26A1)
 * qualifies. Bare ⏱ (U+23F1) does NOT — it is text-presentation, so pi measures
 * it as 1 cell while the terminal draws 2, and the number is then drawn on top
 * of the glyph. The U+FE0F presentation selector fixes exactly that. Never drop
 * it here, and never add one to ⚡ (that would make pi measure ⚡ as 1).
 */
const ICON_LOCAL = "⚡"; // computed from the spans measured here
const ICON_SERVER = "⏱\uFE0F"; // reported by the engine for this request
const MIN_PROMPT_TOKENS = 1000; // below this, TTFT ≈ latency → skip pps update

// ── Paint ───────────────────────────────────────────────────────────────
// Plain text everywhere → the footer's default (grey) color. Ghost (stale
// pps, placeholders) = the theme's resolved "text" foreground scaled down
// by GHOST; if that color can't be parsed, ANSI "faint" as a fallback.
const GHOST = 0.55;

let paintCache: { key: string; paint: (t: string, ghost?: boolean) => string } | null = null;

function rgb256ToRgb(n: number): [number, number, number] {
	if (n < 16) {
		const base: [number, number, number][] = [
			[0, 0, 0], [205, 0, 0], [0, 205, 0], [205, 205, 0], [0, 0, 238],
			[205, 0, 205], [0, 205, 205], [229, 229, 229], [127, 127, 127],
			[255, 0, 0], [0, 255, 0], [255, 255, 0], [92, 92, 255], [255, 0, 255],
			[0, 255, 255], [255, 255, 255],
		];
		return base[n]!;
	}
	if (n < 232) {
		const v = n - 16;
		const ch = (x: number) => (x === 0 ? 0 : 55 + x * 40);
		return [ch((v / 36) | 0), ch(((v / 6) | 0) % 6), ch(v % 6)];
	}
	const g = (n - 232) * 10 + 8;
	return [g, g, g] as [number, number, number];
}

function nearest256([r, g, b]: [number, number, number]): number {
	let best = 0;
	let bestD = Infinity;
	for (let n = 0; n < 256; n++) {
		const [cr, cg, cb] = rgb256ToRgb(n);
		const d = (cr - r) ** 2 * 2 + (cg - g) ** 2 * 4 + (cb - b) ** 2 * 3;
		if (d < bestD) {
			bestD = d;
			best = n;
		}
	}
	return best;
}

function parseFgAnsi(ansi: string): [number, number, number] | null {
	const m24 = ansi.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/);
	if (m24) return [+m24[1]!, +m24[2]!, +m24[3]!];
	const m256 = ansi.match(/\x1b\[38;5;(\d+)m/);
	if (m256) return rgb256ToRgb(+m256[1]!);
	return null;
}

function getPaint(theme: SpeedCtx["ui"]["theme"]) {
	const ansi = typeof theme.getFgAnsi === "function" ? theme.getFgAnsi("text") : "";
	const mode = typeof theme.getColorMode === "function" ? theme.getColorMode() : "truecolor";
	const key = `${ansi}|${mode}`;
	if (paintCache?.key === key) return paintCache.paint;
	const textRgb = parseFgAnsi(ansi);
	const to256 = mode !== "truecolor";
	const paint: (t: string, ghost?: boolean) => string = (t, ghost) => {
		if (!ghost) return t; // plain → footer default color
		if (!textRgb) return `\x1b[2m${t}\x1b[0m`; // faint fallback
		const out: [number, number, number] = [
			Math.round(textRgb[0] * GHOST),
			Math.round(textRgb[1] * GHOST),
			Math.round(textRgb[2] * GHOST),
		];
		const code = to256 ? `38;5;${nearest256(out)}` : `38;2;${out.join(";")}`;
		return `\x1b[${code}m${t}\x1b[0m`;
	};
	paintCache = { key, paint };
	return paint;
}

// ── Engine-reported timings (optional) ─────────────────────────────────
// llama.cpp puts a non-standard `timings` object on the FINAL SSE chunk of a
// chat completion (/v1/chat/completions and /v1/completions, streaming or not).
// pi drops it while normalizing, so it is read from the raw provider stream
// event. Its clocks are disjoint: prompt_ms = request start → first token,
// predicted_ms = first token → last token, and its counters are the engine's
// own (prompt_n excludes cache hits, predicted_n is every generated token).
interface ServerTimings {
	prompt_n: number;
	prompt_ms: number;
	prompt_per_second: number;
	predicted_n: number;
	predicted_ms: number;
	predicted_per_second: number;
	draft_n?: number;
	draft_n_accepted?: number;
}

function field(o: Record<string, unknown>, key: string): number | undefined {
	return typeof o[key] === "number" ? (o[key] as number) : undefined;
}

/** Narrow one raw stream chunk to ServerTimings; undefined when absent. */
function asServerTimings(data: unknown): ServerTimings | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const raw = (data as { timings?: unknown }).timings;
	if (typeof raw !== "object" || raw === null) return undefined;
	const t = raw as Record<string, unknown>;
	const prompt_n = field(t, "prompt_n");
	const prompt_ms = field(t, "prompt_ms");
	const prompt_per_second = field(t, "prompt_per_second");
	const predicted_n = field(t, "predicted_n");
	const predicted_ms = field(t, "predicted_ms");
	const predicted_per_second = field(t, "predicted_per_second");
	if (
		prompt_n === undefined ||
		prompt_ms === undefined ||
		prompt_per_second === undefined ||
		predicted_n === undefined ||
		predicted_ms === undefined ||
		predicted_per_second === undefined
	) {
		return undefined;
	}
	return {
		prompt_n,
		prompt_ms,
		prompt_per_second,
		predicted_n,
		predicted_ms,
		predicted_per_second,
		draft_n: field(t, "draft_n"),
		draft_n_accepted: field(t, "draft_n_accepted"),
	};
}

// ── Minimal structural ctx type (keeps helpers decoupled) ──────────────
interface SpeedCtx {
	hasUI: boolean;
	ui: {
		setStatus: (key: string, text: string) => void;
		theme: {
			fg: (color: ThemeColor, text: string) => string;
			getFgAnsi?: (color: ThemeColor) => string;
			getColorMode?: () => "truecolor" | "256color";
		};
	};
}

// ── State (plain data only; reset on session boundaries) ───────────────
// Per-round (one user prompt's agent loop: agent_start … agent_end).
// pi's "turn" is narrower — one LLM call + its tool batch — so a round
// spans several turns; never reset on turn_start.
let roundOutputTokens = 0; // Σ usage.output of the round's assistant messages
let roundStreamSpanMs = 0; // Σ (lastDelta - firstDelta) per message — pure streaming time

// Last computed prefill speed + whether the latest message was too short
// to update it (→ previous value stays, rendered dimmed).
let ppsValue: number | undefined;
let ppsStale = false;

// Engine-reported aggregates. Only messages that actually carried timings
// contribute, so these stay an engine-only view — never a blend with spans.
let roundServerTokens = 0; // Σ predicted_n over the current round
let roundServerMs = 0; // Σ predicted_ms over the current round
let srvDecodeTokens = 0; // Σ predicted_n, session
let srvDecodeMs = 0; // Σ predicted_ms, session
let deliveryMs = 0; // Σ (client span − predicted_ms) — signed: latencies cancel
let serverWaitMs = 0; // Σ (TTFT − prompt_ms) — model load / queue / network
let draftTokens = 0; // Σ draft_n
let draftAccepted = 0; // Σ draft_n_accepted
let countMismatch = 0; // messages where usage.output ≠ predicted_n
let countMismatchDelta = 0;

// Session totals for /pps-tps (in-memory only; reset on session boundaries).
// Every accumulator is a Σ over assistant messages of THIS pi runtime.
let calls = 0; // assistant messages finalized (the "1st" is calls === 1)
let prefillsMeasured = 0;
let prefillMs = 0;
let prefillTokens = 0;
let prefillMsExclFirst = 0;
let prefillTokensExclFirst = 0;
let decodeMs = 0;
let decodeTokens = 0; // only output tokens of messages with a measured span
let outputTokens = 0;
let inputTokens = 0;
let roundWallMs = 0; // Σ (agent_start → agent_end): LLM calls + tool runs
let roundStartAt: number | undefined;

// Per-message (current streaming LLM call)
let reqAnchorAt: number | undefined; // this request's before_provider_request
let msgFirstDeltaAt: number | undefined;
let msgLastDeltaAt: number | undefined;
let msgTimings: ServerTimings | undefined; // engine timings of this request

function resetMessage() {
	reqAnchorAt = undefined;
	msgFirstDeltaAt = undefined;
	msgLastDeltaAt = undefined;
	msgTimings = undefined;
}

function resetRound() {
	roundOutputTokens = 0;
	roundStreamSpanMs = 0;
	roundServerTokens = 0;
	roundServerMs = 0;
	resetMessage();
	// ppsValue/ppsStale deliberately survive: a short prompt keeps showing
	// the previous value.
}

function resetSessionTotals() {
	calls = 0;
	prefillsMeasured = 0;
	prefillMs = 0;
	prefillTokens = 0;
	prefillMsExclFirst = 0;
	prefillTokensExclFirst = 0;
	decodeMs = 0;
	decodeTokens = 0;
	outputTokens = 0;
	inputTokens = 0;
	roundWallMs = 0;
	roundStartAt = undefined;
	roundServerTokens = 0;
	roundServerMs = 0;
	srvDecodeTokens = 0;
	srvDecodeMs = 0;
	deliveryMs = 0;
	serverWaitMs = 0;
	draftTokens = 0;
	draftAccepted = 0;
	countMismatch = 0;
	countMismatchDelta = 0;
}

function resetAll() {
	roundOutputTokens = 0;
	roundStreamSpanMs = 0;
	ppsValue = undefined;
	ppsStale = false;
	resetMessage();
	resetSessionTotals();
}

// ── Rendering (all UI writes happen inside event handlers — never a timer) ──
/** Skeleton for states without any data (fresh session). */
function renderSkeleton(ctx: SpeedCtx) {
	if (!ctx.hasUI) return;
	const paint = getPaint(ctx.ui.theme);
	ctx.ui.setStatus(STATUS_KEY, `${ICON_LOCAL}${paint("–pps", true)} ${paint("–tps", true)}`);
}

/**
 * Final line after a completed assistant message. `serverSource` selects the
 * glyph and the tps aggregate: engine clocks or measured spans, never a mix.
 */
function renderFinal(ctx: SpeedCtx, serverSource: boolean) {
	if (!ctx.hasUI) return;
	const paint = getPaint(ctx.ui.theme);
	const pps =
		ppsValue !== undefined
			? paint(`${Math.round(ppsValue)}pps`, ppsStale)
			: paint("–pps", true);
	const tpsMs = serverSource ? roundServerMs : roundStreamSpanMs;
	const tpsTokens = serverSource ? roundServerTokens : roundOutputTokens;
	const tps =
		tpsMs > 0
			? paint(`${Math.round(tpsTokens / (tpsMs / 1000))}tps`)
			: paint("–tps", true);
	ctx.ui.setStatus(STATUS_KEY, `${serverSource ? ICON_SERVER : ICON_LOCAL}${pps} ${tps}`);
}

// ── Session totals report (/pps-tps) ───────────────────────────────────
const pad = (s: string, w: number) => s.padEnd(w);
const num = (n: number) => n.toLocaleString("en-US");
/**
 * Duration, humanized: 0.42s / 2.85s / 10.0s / 59.9s / 1m 08s / 6m 52s /
 * 1h 02m 03s. Fractional seconds are kept only under a minute — above that
 * they are noise compared with TTFT measurement jitter.
 */
const dur = (ms: number): string => {
	if (ms < 10_000) return `${(ms / 1000).toFixed(2)}s`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const total = Math.round(ms / 1000);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
	return `${m}m ${String(s).padStart(2, "0")}s`;
};
const rate = (tokens: number, ms: number) =>
	tokens > 0 && ms > 0 ? `${Math.round(tokens / (ms / 1000))} t/s` : "– t/s";

function renderTotals(ctx: { ui: { notify: (message: string, level?: "info" | "warning" | "error") => void } }) {
	const w = 22;
	// label, duration, tokens whose rate to show (0 = no rate line), extra tail
	const rows: [string, number, number, string?][] = [
		["Prefill total:", prefillMs, prefillTokens],
		["Prefill w/o 1st:", prefillMsExclFirst, prefillTokensExclFirst],
		["Decode total:", decodeMs, decodeTokens],
	];
	if (srvDecodeMs !== 0) {
		rows.push(["Engine decode:", srvDecodeMs, srvDecodeTokens]);
		rows.push([
			"Delivery overhead:",
			deliveryMs,
			0,
			srvDecodeTokens > 0 ? `${(deliveryMs / srvDecodeTokens).toFixed(1)} ms/token` : "",
		]);
	}
	if (serverWaitMs > 0) rows.push(["Pre-stream wait:", serverWaitMs, 0]);
	rows.push(["Round wall time:", roundWallMs, 0]);
	rows.push(["Tools + gaps:", Math.max(0, roundWallMs - prefillMs - decodeMs), 0]);
	// Duration column padded to the widest value → the "→ rate" tails line up
	// whether the session ran 3 seconds or 3 hours.
	const tw = Math.max(9, ...rows.map((r) => dur(r[1]).length));

	const lines: string[] = [];
	// Header glyphs state the sources used by this runtime: measured here
	// only, or measured + engine-reported (the engine rows are present).
	const glyphs = srvDecodeMs > 0 ? `${ICON_LOCAL}${ICON_SERVER}` : ICON_LOCAL;
	lines.push(`${glyphs} session speed — this pi runtime (totals are not persisted)`);
	lines.push("");
	lines.push(pad("Assistant calls:", w) + `${calls}  (${prefillsMeasured} with measured prefill)`);
	lines.push(pad("Prompt tokens:", w) + `${num(inputTokens)}  (uncached part only)`);
	lines.push(pad("Output tokens:", w) + num(outputTokens));
	lines.push("");
	for (const [label, ms, tokens, extra] of rows) {
		const tail = tokens > 0 ? `  →  ${rate(tokens, ms)}` : extra ? `  →  ${extra}` : "";
		lines.push((pad(label, w) + pad(dur(ms), tw) + tail).trimEnd());
	}
	if (draftTokens > 0) {
		lines.push("");
		lines.push(
			pad("MTP acceptance:", w) +
				`${num(draftAccepted)} / ${num(draftTokens)} drafted  (${Math.round(
					(draftAccepted / draftTokens) * 100,
				)}%)`,
		);
	}
	if (countMismatch > 0) {
		lines.push(
			pad("Token count diff:", w) +
				`${countMismatch} msg, Σ ${countMismatchDelta > 0 ? "+" : ""}${num(countMismatchDelta)}`,
		);
	}
	lines.push("");
	lines.push("Rates are aggregate: Σtokens ÷ Σtime. Cache-heavy turns have a small");
	lines.push("uncached remainder but pay TTFT for the whole prefix, so the session");
	lines.push(`aggregate sits below the live ${ICON_LOCAL} value — normal, not a bug.`);
	lines.push("Engine rows come from the provider's own timings (⏱️); when a provider");
	lines.push("reports none they are omitted and every rate is measured here (⚡).");
	ctx.ui.notify(lines.join("\n"), "info");
}

// ── Extension ───────────────────────────────────────────────────────────
export default function piPpsTpsMini(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		resetAll();
		renderSkeleton(ctx); // keep the slot occupied from the very start
	});

	pi.on("session_shutdown", async () => {
		resetAll();
	});

	// A round = one user prompt's agent loop (agent_start … agent_end).
	// pi's "turn" is narrower (each LLM call + its tool batch), so rounds
	// are NOT reset on turn_start. The previous round's final display
	// stays on screen; the next message_end updates it.
	pi.on("agent_start", async () => {
		resetRound();
		if (roundStartAt === undefined) roundStartAt = Date.now();
	});

	// Wall clock of one low-level run (its LLM calls + tool runs). Paired with
	// agent_start; if a run is torn down without agent_end the session boundary
	// resets it anyway.
	pi.on("agent_end", async () => {
		if (roundStartAt !== undefined) {
			roundWallMs += Date.now() - roundStartAt;
			roundStartAt = undefined;
		}
	});

	// TTFT anchor: fires right before the HTTP request goes out. (pi's
	// assistant message_start fires at the FIRST SSE event — ≈ the first
	// token — so it cannot measure TTFT.) Overwritten per request: every
	// LLM call of a round gets its own prefill measurement. The per-message
	// delta clock is also reset here — without this, msgFirstDeltaAt from
	// the round's first message leaks into every later message's span,
	// sweeping tool runs and inter-call gaps into tps.
	pi.on("before_provider_request", async () => {
		reqAnchorAt = Date.now();
		msgFirstDeltaAt = undefined;
		msgLastDeltaAt = undefined;
		msgTimings = undefined;
	});

	// Engine timings arrive with the stream (on its last chunk), so they are
	// captured per chunk from the raw event — pi discards them while
	// normalizing. One property read per chunk: this handler must never become
	// part of the overhead it is measuring.
	pi.on("provider_stream_event", (event) => {
		const timings = asServerTimings(event.data);
		if (timings !== undefined) msgTimings = timings;
	});

	pi.on("message_update", async (event) => {
		const ev = event.assistantMessageEvent;
		if (ev.type !== "text_delta" && ev.type !== "thinking_delta" && ev.type !== "toolcall_delta") {
			return;
		}
		const now = Date.now();
		if (msgFirstDeltaAt === undefined) msgFirstDeltaAt = now;
		msgLastDeltaAt = now;
	});

	pi.on("message_end", async (event, ctx) => {
		const m = event.message;
		if (m?.role !== "assistant") return;

		// Pure streaming time of this message (tool runs and inter-call gaps
		// stay out of it). Degenerate case: a provider that delivers everything
		// in one chunk produces a single delta → span would be 0, so fall back
		// to the message_end clock (it also absorbs finalize latency and other
		// extensions' message_end handlers — only used when deltas give nothing).
		let spanMs: number | undefined;
		if (msgFirstDeltaAt !== undefined && msgLastDeltaAt !== undefined) {
			spanMs = msgLastDeltaAt - msgFirstDeltaAt;
			if (spanMs <= 0) spanMs = Math.max(0, Date.now() - msgFirstDeltaAt);
		}
		if (spanMs !== undefined) roundStreamSpanMs += spanMs;

		// Prefill: prompt tokens ÷ TTFT of THIS request. Short prompts
		// (TTFT ≈ network latency) don't update pps — the previous value
		// stays, rendered dimmed.
		const rawTtftMs =
			reqAnchorAt !== undefined && msgFirstDeltaAt !== undefined
				? msgFirstDeltaAt - reqAnchorAt
				: undefined;
		const ttftMs = rawTtftMs !== undefined && rawTtftMs > 0 ? rawTtftMs : undefined;
		const input = m.usage?.input ?? 0;
		const out = m.usage?.output ?? 0;

		// Source of this message's numbers: the engine's own clocks when the
		// provider reported them, otherwise the spans measured here.
		const timing =
			msgTimings !== undefined && msgTimings.predicted_n > 0 ? msgTimings : undefined;
		msgTimings = undefined;
		const serverSource = timing !== undefined;

		if (timing !== undefined) {
			// pps = prompt_n ÷ prompt_ms, tps = predicted_n ÷ predicted_ms.
			// Engine-side clocks, so delivery is excluded by construction.
			if (timing.prompt_n >= MIN_PROMPT_TOKENS) {
				ppsValue = timing.prompt_per_second;
				ppsStale = false;
			} else if (ppsValue !== undefined) {
				ppsStale = true;
			}
			roundServerTokens += timing.predicted_n;
			roundServerMs += timing.predicted_ms;
			srvDecodeTokens += timing.predicted_n;
			srvDecodeMs += timing.predicted_ms;
			if (timing.draft_n !== undefined && timing.draft_n > 0) {
				draftTokens += timing.draft_n;
				draftAccepted += timing.draft_n_accepted ?? 0;
			}
			// What the engine never saw: the client span beyond its decode
			// clock, and TTFT beyond its prefill clock (load/queue/network).
			if (spanMs !== undefined) deliveryMs += spanMs - timing.predicted_ms;
			if (ttftMs !== undefined) serverWaitMs += Math.max(0, ttftMs - timing.prompt_ms);
			if (out > 0 && out !== timing.predicted_n) {
				countMismatch++;
				countMismatchDelta += out - timing.predicted_n;
			}
		} else if (input > 0 && ttftMs !== undefined) {
			if (input >= MIN_PROMPT_TOKENS) {
				ppsValue = input / (ttftMs / 1000);
				ppsStale = false;
			} else if (ppsValue !== undefined) {
				ppsStale = true;
			}
		}

		if (out > 0) roundOutputTokens += out;

		// Session accumulators. The first assistant request of this runtime is
		// skipped for the "w/o 1st" variant even when it is a continuation (a
		// resumed session has no way to tell cold prefill from warm one).
		calls++;
		const isFirstCall = calls === 1;
		inputTokens += input;
		outputTokens += out;
		if (ttftMs !== undefined && input > 0) {
			prefillsMeasured++;
			prefillMs += ttftMs;
			prefillTokens += input;
			if (!isFirstCall) {
				prefillMsExclFirst += ttftMs;
				prefillTokensExclFirst += input;
			}
		}
		if (spanMs !== undefined) {
			decodeMs += spanMs;
			decodeTokens += out;
		}

		if (roundOutputTokens > 0 || ppsValue !== undefined) renderFinal(ctx, serverSource);
	});

	pi.registerCommand("pps-tps", {
		description: "Session speed totals: accumulated prefill/decode time and aggregate rates",
		getArgumentCompletions: (prefix) =>
			["reset"].filter((a) => a.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			if (args.trim() === "reset") {
				resetSessionTotals();
				ctx.ui.notify("Session speed totals reset.", "info");
				return;
			}
			renderTotals(ctx);
		},
	});
}
