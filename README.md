# pi-pps-tps-mini

A minimal [Pi](https://pi.dev) extension that shows **prefill** and **generation**
speed in the status bar, plus a `/pps-tps` command with accumulated session
timings. Based on
[@qingwawangzi/pi-speedline](https://github.com/wangcheng666/pi-speedline),
stripped to the essentials — no live estimates, no calibration.

The status slot has three elements:

```
⏱️249pps 41tps      engine clocks: pps of this request, tps over the round
⚡249pps 34tps       fallback: spans measured in pi (same aggregation)
```

- **`⏱️` / `⚡`** — where the numbers come from: **`⏱️` = the engine reported
  its own timings for this request** (llama.cpp does), **`⚡` = computed from
  spans measured inside pi** (the fallback, used for every provider that
  reports no timings). No space after the icon.
- **`249pps`** — prefill speed: prompt tokens ÷ TTFT (request dispatch →
  first token). TTFT normalized by prompt length, so it answers "how fast
  is the provider eating my prompt" instead of "how long do I wait".
- **`34tps`** — tokens generated per second: exact output tokens
  (`usage.output`, includes thinking and tool-call tokens) ÷ pure streaming
  time (first→last delta span per message; tool runs and inter-call gaps
  excluded), summed over the current round.

## Where the numbers come from

Two sources, one per number — never mixed:

| source | pps | tps | glyph |
|---|---|---|---|
| engine timings | `prompt_n ÷ prompt_ms` | `predicted_n ÷ predicted_ms` | `⏱️` |
| measured in pi | `usage.input ÷ TTFT` | `Σ usage.output ÷ Σ delta span` | `⚡` |

`timings` is a non-standard object llama.cpp attaches to the **final SSE chunk**
of an OpenAI-compatible completion (`/v1/chat/completions`, `/v1/completions`,
streaming and not). Pi discards it while normalizing, so the extension reads it
from the raw `provider_stream_event`, before normalization. Its two clocks are
disjoint — `prompt_ms` is request start → first token, `predicted_ms` is first →
last token — so nothing is counted twice. When a provider reports no timings
(OpenAI, Anthropic, Strata, …) both numbers fall back to the measured spans.

The difference between the two views is a measurement in itself: it is reported
as **Delivery overhead** and **Pre-stream wait** in `/pps-tps`.

## Behavior

- Values are **exact** — provider usage, provider timings and measured spans —
  and update when each assistant message completes. Between messages the last
  final line stays visible.
- **Short prompts don't update pps.** When the newly processed prompt is
  under 1000 tokens (`usage.input` — or `prompt_n` when the engine reports
  timings), TTFT is dominated by network latency and the prefill rate is
  meaningless. The previous pps value stays on screen, rendered **slightly
  darker** (ghost). No previous value yet → placeholder `–pps`.
- The glyph follows the last finished message: `⏱️` when the engine reported
  timings for it, `⚡` when the numbers had to be measured here. Engine numbers
  are aggregated only over messages that carried timings, so the two views
  never blend into one average.
- Each LLM call of a round measures its own prefill; the displayed pps is
  the latest one. tps is accumulated across the whole round (one user
  prompt's agent loop).
- If a provider delivers a response in one chunk (a single delta), the stream
  span would be 0 — then the span falls back to the `message_end` clock so
  decode time is still measured.
Theme-neutral, distraction-free: everything renders in the footer's default
color (plain text). The only exception is stale pps — the previous value kept
after a short prompt — rendered **slightly darker** (~45%, the theme's text
color scaled down; ANSI "faint" as fallback), so it reads as "last known
value", not current.

## `/pps-tps` — accumulated session timings

```
⚡⏱️ session speed — this pi runtime (totals are not persisted)

Assistant calls:      4  (4 with measured prefill)
Prompt tokens:        216,000  (uncached part only)
Output tokens:        38,400

Prefill total:        46.9s       →  4606 t/s
Prefill w/o 1st:      5.70s       →  6316 t/s
Decode total:         1h 11m 49s  →  9 t/s
Engine decode:        1h 08m 02s  →  9 t/s
Delivery overhead:    3m 47s      →  5.9 ms/token
Pre-stream wait:      4.10s
Round wall time:      1h 12m 57s
Tools + gaps:         21.0s

MTP acceptance:       18,000 / 24,000 drafted  (75%)
```

- **Header glyphs** state the sources used by this runtime: `⚡` = every
  number was measured in pi, `⚡⏱️` = the provider also reported engine
  timings (the engine rows below are present).
- **Durations are humanized**: `0.42s`, `2.85s`, `10.0s`, `59.9s` under a
  minute, then whole seconds — `1m 08s`, `6m 52s`, `59m 59s`, `1h 02m 03s`.
  The duration column is padded to the widest value in the block, so the
  `→ rate` tails stay aligned whether the session ran 3 seconds or 3 hours.

- **Prefill total** — Σ TTFT of every assistant request in this pi runtime.
- **Prefill w/o 1st** — the same minus the runtime's **first** request, both
  time and tokens. That request usually carries server-side model load and a
  cold prompt cache, so it says little about steady-state throughput.
- **Decode total** — Σ pure streaming time (same clock as the `tps` slot).
- **Engine decode** — Σ `predicted_ms` from the provider's own timings: the
  engine's decode clock only. The row is omitted when the provider reports no
  timings.
- **Delivery overhead** — `Decode total − Engine decode`: everything the engine
  never saw (proxy and network transit, buffering, pi's own per-delta work), in
  seconds and in ms/token. Whether the footer shows `⏱️` or `⚡` tells you which
  view it is showing; this row tells you the size of the difference.
- **Pre-stream wait** — Σ over messages of `max(0, TTFT − prompt_ms)`: model
  load, queueing and network delay around the engine's prefill clock. The
  per-message clamp at zero absorbs server/client clock skew (the two clocks
  run on different machines).
- **MTP acceptance** — Σ `draft_n_accepted / draft_n` over the runtime, shown
  only when the engine drafted something: how often speculative decoding paid
  off.
- **Round wall time** — Σ `agent_start → agent_end`: LLM calls **plus** tool
  runs. **Tools + gaps** = wall − prefill − decode, i.e. everything that is
  neither prefill nor generation.
- Rates are **aggregate only**: Σtokens ÷ Σtime, one time-weighted number per
  metric. No mean of per-call rates, no percentiles — a single slow call cannot
  drag the number out of proportion the way a per-call average would.
- Aggregate pps is normally **lower** than the live `⚡` value: cache-heavy
  turns have a small uncached remainder yet still pay TTFT for the whole
  prefix. Expected, not a bug.
- Because TTFT is measured to the *first* delta, a non-streaming / one-shot
  provider makes TTFT ≈ the whole request time. Such turns inflate prefill time
  and their decode window partly overlaps it.
- Totals are **in-memory only**. Pi stores no timings in the session JSONL, so
  `/resume`, `/fork`, `/new` and `/reload` start from zero — as does the first
  command call in a resumed session, where the first request is a warm
  continuation rather than a cold prefill.
- `/pps-tps reset` clears the accumulators.

## Install

```bash
pi install git:github.com/kapojko/pi-pps-tps-mini
```

## Uninstall

```bash
pi remove git:github.com/kapojko/pi-pps-tps-mini
```
