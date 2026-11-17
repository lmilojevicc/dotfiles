---
description: Find the rules the app assumes but nothing enforces
argument-hint: "[scope, e.g. src/billing]"
---
Find every invariant this app relies on that nothing enforces. Scope: ${@:-the whole repo}.

An invariant is a sentence that must be true for the code to be correct, but that no type, constraint, or single place guarantees. Look for:

- uniqueness assumed but not enforced by a DB constraint (one active subscription, one open cart per user, one primary address)
- ownership or tenant checks present in one entry point but missing in its siblings (API route, job, admin command)
- totals, counts, and balances that must match the rows they summarise
- required pairs: both fields set or neither, a child never older than its parent
- "only one X at a time": running job, active session, pending order
- status columns implying facts elsewhere (a `paid` order with no payment row)
- ordering rules assumed by readers: created before updated, parent written before child

For each, give:

1. The invariant as one sentence.
2. Where the code assumes it, with `file:line`.
3. How it can be violated today: the write path that skips the check, or the constraint that does not exist. Name the schema check if you looked and found none.
4. What breaks when it is violated, and whether anything detects it afterwards.

Only report invariants you can see assumed in code and show a path that breaks them. Drop anything that is enforced somewhere, and say where. Do not report generic "add validation" advice.

Report a table ranked by blast radius, then list dropped candidates with the enforcement that made you drop them. Read only: do not edit code.
