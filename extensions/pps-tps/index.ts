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
 * no calibration, no commands. The display updates when each assistant
 * message completes; between messages the last final line stays visible.
 */
import type { ExtensionAPI, ThemeColor } from "@earendil-works/pi-coding-agent";

// ── Tunables ────────────────────────────────────────────────────────────
const STATUS_KEY = "pps-tps";
const ICON = "⚡";
const MIN_PROMPT_TOKENS = 1000; // below this, TTFT ≈ latency → skip pps update

// ── Palette (from pi-speedline) ─────────────────────────────────────────
// gold = pps, jade = tgs (bold), ghost variants (55%) for dimmed/absent.
type Field = "gold" | "jade" | "coral";

const DARK_PAL: Record<Field, [number, number, number]> = {
	gold: [227, 186, 110],
	jade: [78, 199, 166],
	coral: [217, 126, 85],
};
const LIGHT_PAL: Record<Field, [number, number, number]> = {
	gold: [166, 120, 42],
	jade: [23, 132, 104],
	coral: [176, 82, 36],
};
const GHOST = 0.55;

let paintCache: {
	key: string;
	paint: (f: Field, t: string, opts?: { ghost?: boolean; bold?: boolean }) => string;
} | null = null;

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
	// Bright text color ⇒ dark terminal background ⇒ dark palette (and vice versa).
	const lum = textRgb
		? (0.2126 * textRgb[0] + 0.7152 * textRgb[1] + 0.0722 * textRgb[2]) / 255
		: 0;
	const pal = lum > 0.5 ? DARK_PAL : LIGHT_PAL;
	const to256 = mode !== "truecolor";
	const codeCache: Record<string, string> = {};
	const codeFor = (rgb: [number, number, number]) => {
		const k = rgb.join(",");
		if (!codeCache[k]) codeCache[k] = to256 ? `38;5;${nearest256(rgb)}` : `38;2;${rgb.join(";")}`;
		return codeCache[k]!;
	};
	const paint: (f: Field, t: string, opts?: { ghost?: boolean; bold?: boolean }) => string = (f, t, opts) => {
		const rgb = pal[f]!;
		const out: [number, number, number] = opts?.ghost
			? [Math.round(rgb[0] * GHOST), Math.round(rgb[1] * GHOST), Math.round(rgb[2] * GHOST)]
			: rgb;
		const bold = opts?.bold ? "\x1b[1m" : "";
		return `${bold}\x1b[${codeFor(out)}m${t}\x1b[0m${bold ? "\x1b[22m" : ""}`;
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

function resetAll() {
	roundOutputTokens = 0;
	roundStreamSpanMs = 0;
	ppsValue = undefined;
	ppsStale = false;
	resetMessage();
}

// ── Rendering (all UI writes happen inside event handlers — never a timer) ──
function iconOf(ctx: SpeedCtx): string {
	return ctx.ui.theme.fg("accent", ICON);
}

/** Skeleton for states without any data (fresh session). */
function renderSkeleton(ctx: SpeedCtx) {
	if (!ctx.hasUI) return;
	const paint = getPaint(ctx.ui.theme);
	ctx.ui.setStatus(
		STATUS_KEY,
		`${iconOf(ctx)} ${paint("gold", "–pps", { ghost: true })} ${paint("jade", "–tgs", { ghost: true })}`,
	);
}

/** Final line after a completed assistant message. */
function renderFinal(ctx: SpeedCtx) {
	if (!ctx.hasUI) return;
	const paint = getPaint(ctx.ui.theme);
	const pps =
		ppsValue !== undefined
			? paint("gold", `${Math.round(ppsValue)}pps`, { ghost: ppsStale })
			: paint("gold", "–pps", { ghost: true });
	const tgs =
		roundStreamSpanMs > 0
			? paint("jade", `${Math.round(roundOutputTokens / (roundStreamSpanMs / 1000))}tgs`, { bold: true })
			: paint("jade", "–tgs", { ghost: true });
	ctx.ui.setStatus(STATUS_KEY, `${iconOf(ctx)} ${pps} ${tgs}`);
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
	});

	// TTFT anchor: fires right before the HTTP request goes out. (pi's
	// assistant message_start fires at the FIRST SSE event — ≈ the first
	// token — so it cannot measure TTFT.) Overwritten per request: every
	// LLM call of a round gets its own prefill measurement.
	pi.on("before_provider_request", async () => {
		reqAnchorAt = Date.now();
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

		// Accumulate this message's pure streaming time (tool runs and
		// inter-call gaps stay out of tgs).
		if (msgFirstDeltaAt !== undefined && msgLastDeltaAt !== undefined) {
			roundStreamSpanMs += msgLastDeltaAt - msgFirstDeltaAt;
		}

		// Prefill: prompt tokens ÷ TTFT of THIS request. Short prompts
		// (TTFT ≈ network latency) don't update pps — the previous value
		// stays, rendered dimmed.
		const ttftMs =
			reqAnchorAt !== undefined && msgFirstDeltaAt !== undefined
				? msgFirstDeltaAt - reqAnchorAt
				: undefined;
		const input = m.usage?.input ?? 0;
		if (input > 0 && ttftMs !== undefined && ttftMs > 0) {
			if (input >= MIN_PROMPT_TOKENS) {
				ppsValue = input / (ttftMs / 1000);
				ppsStale = false;
			} else if (ppsValue !== undefined) {
				ppsStale = true;
			}
		}

		const out = m.usage?.output ?? 0;
		if (out > 0) roundOutputTokens += out;

		if (roundOutputTokens > 0 || ppsValue !== undefined) renderFinal(ctx);
	});
}
