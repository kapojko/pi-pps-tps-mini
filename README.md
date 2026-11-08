# pi-pps-tps-mini

A minimal [Pi](https://pi.dev) extension that shows **prefill** and **generation**
speed in the status bar, plus a `/pps-tgs` command with accumulated session
timings. Based on
[@qingwawangzi/pi-speedline](https://github.com/wangcheng666/pi-speedline),
stripped to the essentials — no live estimates, no calibration.

The status slot has three elements:

```
⚡ 249pps 34tgs
```

- **`⚡`** — lightning icon (theme accent color)
- **`249pps`** — prefill speed: prompt tokens ÷ TTFT (request dispatch →
  first token). TTFT normalized by prompt length, so it answers "how fast
  is the provider eating my prompt" instead of "how long do I wait".
- **`34tgs`** — tokens generated per second: exact output tokens
  (`usage.output`, includes thinking and tool-call tokens) ÷ pure streaming
  time (first→last delta span per message; tool runs and inter-call gaps
  excluded), summed over the current round.

## Behavior

- Values are **exact** — taken from provider usage and measured spans — and
  update when each assistant message completes. Between messages the last
  final line stays visible.
- **Short prompts don't update pps.** When `usage.input < 1000` tokens, TTFT
  is dominated by network latency and the prefill rate is meaningless. The
  previous pps value stays on screen, rendered **slightly darker** (ghost).
  No previous value yet → placeholder `–pps`.
- Each LLM call of a round measures its own prefill; the displayed pps is
  the latest one. tgs is accumulated across the whole round (one user
  prompt's agent loop).
- If a provider delivers a response in one chunk (a single delta), the stream
  span would be 0 — then the span falls back to the `message_end` clock so
  decode time is still measured.
Theme-neutral, distraction-free: everything renders in the footer's default
color (plain text). The only exception is stale pps — the previous value kept
after a short prompt — rendered **slightly darker** (~45%, the theme's text
color scaled down; ANSI "faint" as fallback), so it reads as "last known
value", not current.

## `/pps-tgs` — accumulated session timings

```
⚡ session speed — this pi runtime (totals are not persisted)

Assistant calls:      4  (4 with measured prefill)
Prompt tokens:        216,000  (uncached part only)
Output tokens:        38,400

Prefill total:        46.9s       →  4606 t/s
Prefill w/o 1st:      5.70s       →  6316 t/s
Decode total:         1h 11m 49s  →  9 t/s
Round wall time:      1h 12m 57s
Tools + gaps:         21.0s
```

- **Durations are humanized**: `0.42s`, `2.85s`, `10.0s`, `59.9s` under a
  minute, then whole seconds — `1m 08s`, `6m 52s`, `59m 59s`, `1h 02m 03s`.
  The duration column is padded to the widest value in the block, so the
  `→ rate` tails stay aligned whether the session ran 3 seconds or 3 hours.

- **Prefill total** — Σ TTFT of every assistant request in this pi runtime.
- **Prefill w/o 1st** — the same minus the runtime's **first** request, both
  time and tokens. That request usually carries server-side model load and a
  cold prompt cache, so it says little about steady-state throughput.
- **Decode total** — Σ pure streaming time (same clock as the `tgs` slot).
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
- `/pps-tgs reset` clears the accumulators.

## Install

```bash
pi install git:github.com/kapojko/pi-pps-tps-mini
```

## Uninstall

```bash
pi remove git:github.com/kapojko/pi-pps-tps-mini
```
