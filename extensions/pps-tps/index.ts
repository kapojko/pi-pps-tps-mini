/**
 * pi-pps-tps-mini — minimal prefill/generation speedometer for the pi coding agent.
 *
 * Based on @qingwawangzi/pi-speedline, stripped to the essentials.
 * One status slot, three elements, exact per-turn values only:
 *
 *   ⚡ 249pps 34tgs
 *
 *   pps — prefill speed: prompt tokens ÷ TTFT (request dispatch → first
 *         token), analogous to TTFT but normalized by prompt length.
 *         Computed ONLY when the prompt is not short (usage.input ≥
 *         MIN_PROMPT_TOKENS) — for short prompts TTFT is dominated by
 *         network latency and the rate is meaningless. There the previous
 *         value stays on screen, slightly darker (ghost). No previous
 *         value yet → ghost placeholder "–pps".
 *   tgs — tokens generated per second: Σ usage.output ÷ Σ pure streaming
 *         time (first→last delta span per message; tool runs and
 *         inter-call gaps excluded) across the current round.
 *
 * Everything is exact (provider usage + measured spans), no live estimates,
 * no calibration. The display updates when each assistant message completes;
 * between messages the last final line stays visible.
 *
 * Session totals (see /pps-tgs): accumulated prefill time, decode time and
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
const ICON = "⚡";
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

// Session totals for /pps-tgs (in-memory only; reset on session boundaries).
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

function resetMessage() {
	reqAnchorAt = undefined;
	msgFirstDeltaAt = undefined;
	msgLastDeltaAt = undefined;
}

function resetRound() {
	roundOutputTokens = 0;
	roundStreamSpanMs = 0;
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
	ctx.ui.setStatus(STATUS_KEY, `${ICON} ${paint("–pps", true)} ${paint("–tgs", true)}`);
}

/** Final line after a completed assistant message. */
function renderFinal(ctx: SpeedCtx) {
	if (!ctx.hasUI) return;
	const paint = getPaint(ctx.ui.theme);
	const pps =
		ppsValue !== undefined
			? paint(`${Math.round(ppsValue)}pps`, ppsStale)
			: paint("–pps", true);
	const tgs =
		roundStreamSpanMs > 0
			? paint(`${Math.round(roundOutputTokens / (roundStreamSpanMs / 1000))}tgs`)
			: paint("–tgs", true);
	ctx.ui.setStatus(STATUS_KEY, `${ICON} ${pps} ${tgs}`);
}

// ── Session totals report (/pps-tgs) ───────────────────────────────────
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
	// label, duration, tokens whose rate to show (0 = no rate line)
	const rows: [string, number, number][] = [
		["Prefill total:", prefillMs, prefillTokens],
		["Prefill w/o 1st:", prefillMsExclFirst, prefillTokensExclFirst],
		["Decode total:", decodeMs, decodeTokens],
		["Round wall time:", roundWallMs, 0],
		["Tools + gaps:", Math.max(0, roundWallMs - prefillMs - decodeMs), 0],
	];
	// Duration column padded to the widest value → the "→ rate" tails line up
	// whether the session ran 3 seconds or 3 hours.
	const tw = Math.max(9, ...rows.map((r) => dur(r[1]).length));

	const lines: string[] = [];
	lines.push(`${ICON} session speed — this pi runtime (totals are not persisted)`);
	lines.push("");
	lines.push(pad("Assistant calls:", w) + `${calls}  (${prefillsMeasured} with measured prefill)`);
	lines.push(pad("Prompt tokens:", w) + `${num(inputTokens)}  (uncached part only)`);
	lines.push(pad("Output tokens:", w) + num(outputTokens));
	lines.push("");
	for (const [label, ms, tokens] of rows) {
		const tail = tokens > 0 ? `  →  ${rate(tokens, ms)}` : "";
		lines.push((pad(label, w) + pad(dur(ms), tw) + tail).trimEnd());
	}
	lines.push("");
	lines.push("Rates are aggregate: Σtokens ÷ Σtime. Cache-heavy turns have a small");
	lines.push("uncached remainder but pay TTFT for the whole prefix, so the session");
	lines.push("aggregate sits below the live ⚡ value — normal, not a bug.");
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
	// sweeping tool runs and inter-call gaps into tgs.
	pi.on("before_provider_request", async () => {
		reqAnchorAt = Date.now();
		msgFirstDeltaAt = undefined;
		msgLastDeltaAt = undefined;
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
		if (input > 0 && ttftMs !== undefined) {
			if (input >= MIN_PROMPT_TOKENS) {
				ppsValue = input / (ttftMs / 1000);
				ppsStale = false;
			} else if (ppsValue !== undefined) {
				ppsStale = true;
			}
		}

		const out = m.usage?.output ?? 0;
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

		if (roundOutputTokens > 0 || ppsValue !== undefined) renderFinal(ctx);
	});

	pi.registerCommand("pps-tgs", {
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
