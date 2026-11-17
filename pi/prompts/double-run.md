---
description: Find async work that can run twice and the write that corrupts on the second run
argument-hint: "[scope, e.g. src/payments]"
---
Find every async action in this app that can run twice or interleave with itself, and what that does. Scope: ${@:-the whole repo}.

Look for:

- submit, purchase, or "create" handlers with no in-flight guard (double click, double keypress, client retry)
- retries on non-idempotent requests: network middleware, job queues, queue redelivery, "at least once" consumers
- effects without cleanup, missing `AbortController`, a response applied after the component moved on
- check-then-act across an `await` (read a row, await, write it back)
- shared mutable state written between two awaits
- `setInterval`/pollers whose next tick starts before the last one finished
- get-or-create "ensure X exists" paths, and upserts without a unique key
- optimistic updates with no reconciliation when the server disagrees

For each finding, the evidence is the pair of executions: name the two events that start them (two clicks, a timeout and a manual retry, a queue redelivery), the interleaving, the write that lands twice, and the `file:line` of both the operation and the missing or insufficient guard. Then say what a user loses: a duplicate charge, a doubled row, a lost update, a stale screen.

If you cannot name the exact second execution and the write it repeats, drop the candidate. Note where an existing guard is sufficient.

Report a table ranked by damage on a second run, with the operation, the trigger, the bad write, and the fix. Then list dropped candidates and why. Read only: do not edit code.
