# Optimize Challenge Prompt

You are optimizing an automated browser agent against the provided challenge runner.

## Goal
Iteratively run the challenge command (example):

```bash
bun run agent:headed -- --verbose --step 7 --version 3
```

until performance and robustness are meaningfully improved.

## Success Criteria
- Latency: each challenge run should be < 20 seconds. If it is already < 20 seconds, continue optimizing if there is a clear path.
- Reliability: prefer solutions that remain stable across minor UI / copy / layout changes.
- Generality: optimize for general browser automation patterns, not one-off brittle fixes.

## Optimization Protocol (Required)
Treat this as a small experiment loop. Make one change at a time, measure, and keep what works.

1) Baseline
- Run the command once to establish a baseline time and failure mode.
- Record: runtime, number of steps, retries, and where time is spent.

2) Independent experiments
- Try options independently (one variable per iteration).
- Maintain a running changelog: what you changed, why, and measured impact.
- If a change regresses reliability or time, revert it.

3) Verify
- After each meaningful change, re-run the command and verify the improvement.
- If timings are noisy, run one more time to check if it was a blip.

4) Admit Defeat
- Don't loop forever, after 10-15 tries and you can't get meaningful improvements without hardcoding solutions. Summarize everything you tried and propose next steps or explain why this can't be optimized further. Then I will review. 

## Strategy Priorities
### 1) Tool-first automation
Any place the agent writes custom JavaScript is a signal that a more specific tool (or more direct tool usage) may be better.

Prefer:
- semantic targeting (roles, labels, accessible names)
- stable locators over brittle CSS/XPath
- fewer DOM round-trips

### 2) Better prompting for browser tasks
Optimize the plan the agent follows in-browser:
- reduce unnecessary verification steps
- avoid redundant navigation
- batch form filling where possible
- choose the most direct path to completion

### 3) Reduce work per step
Minimize:
- repeated page snapshots
- repeated element searches
- excessive logging in hot loops (keep enough for diagnosis)

## Observability (Encouraged)
Add lightweight logging that helps you understand bottlenecks.

Log:
- key decision points
- chosen locator strategy
- retries and backoff
- wait reasons (what you are waiting for)

On failures, capture:
- console errors
- failed network requests

Prefer structured logs where feasible so you can compare runs.

## Robustness Guardrails
- Do not hardcode exact text/copy unless required by the challenge.
- Prefer resilient patterns:
  - locate by role/label/placeholder
  - use stable URL/route hints when available
  - handle slow-loading UI with targeted waits rather than long sleeps

## Stop Conditions
Stop optimizing when:
- runs are consistently < 20s and further changes would materially reduce robustness, or
- you cannot find improvements after several independent experiments.

## Research Tools
- Use context7 to research libraries / APIs.
- Use exa web search when you need external references.

## Codebase-Specific Note (If Editing Tools)
If you modify any tool server handlers: tool return values must be JSON strings (for example `JSON.stringify({ result: "..." })`). Plain strings will be parsed and lost.
