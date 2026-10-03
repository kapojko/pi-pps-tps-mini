# pi-pps-tps-mini

A minimal [Pi](https://pi.dev) extension that shows **prefill** and **generation**
speed in the status bar. Based on
[@qingwawangzi/pi-speedline](https://github.com/wangcheng666/pi-speedline),
stripped to the essentials — no live estimates, no calibration, no commands.

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
- Theme-neutral, distraction-free: everything renders in the footer's
  default color (plain text). The only exception is stale pps — the
  previous value kept after a short prompt — rendered **slightly darker**
  (~45%, the theme's text color scaled down; ANSI "faint" as fallback),
  so it reads as "last known value", not current.

## Install

```bash
pi install git:github.com/kapojko/pi-pps-tps-mini
```

## Uninstall

```bash
pi remove git:github.com/kapojko/pi-pps-tps-mini
```
