---
description: Find every implicit state machine in the app, in parallel, then evaluate and report
argument-hint: "[model-by-provider pairs for the subagents]"
---
Find every implicit state machine in this app.

An implicit state machine is any place where a set of states and the legal transitions between them exist only implicitly, scattered across booleans, enums, nullable fields, flags, timestamps, and ad-hoc `if` chains instead of one explicit model. Typical shapes:

- loading / error / data flag combinations that can represent impossible states
- status or phase strings that only some code paths validate before transitioning
- multi-step wizards, onboarding, checkout, or upload flows with step guards spread across components
- retry counters, backoff, and circuit-breaker logic
- connection, session, or job lifecycles (open → ready → draining → closed) enforced by convention
- nested conditionals that really encode "you may only reach X from Y"
- reducers, stores, or DB rows whose fields imply a phase nobody names

Run the search with one subagent per candidate area, in parallel, so the areas do not overlap. If model-by-provider pairs are given below, assign one pair per subagent so different models search different areas: ${@:-no pairs given, so run every subagent on the default subagent model}.

Each subagent must report, per candidate:

1. Where it lives: file paths and the symbols that read or write the state.
2. The states it implies, and which transitions the code actually allows.
3. The current encoding: the exact fields, flags, and guards.
4. How it breaks: the reachable illegal states, races, or transitions that skip a step.
5. Confidence, and what evidence would confirm or refute it.

Then evaluate their findings yourself:

- Merge duplicates found in different layers of the same machine, and drop candidates that a closer read refutes. Say which you dropped and why.
- Rank what survives by blast radius: how much of the app depends on the machine and what breaks when it enters an illegal state.
- For each confirmed machine, state the states, the illegal transitions, and the smallest concrete fix. Do not propose a wholesale rewrite.

Report as a table of confirmed machines (location, rank, illegal transitions, fix) plus a short prose summary, then mention lower-confidence candidates you set aside. Read only: do not edit code.
