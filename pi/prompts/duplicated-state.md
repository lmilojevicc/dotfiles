---
description: Find one piece of truth stored twice, and the sequence that makes the copies disagree
argument-hint: "[scope, e.g. src/features/cart]"
---
Find every place where one piece of truth is stored twice, so the copies can drift apart. Scope: ${@:-the whole repo}.

Count any second copy: a cached field, a denormalized column, an index table, props passed down and mirrored into local state, a value duplicated into the URL, localStorage, or a query cache, a counter next to the rows it counts, a precomputed total, or the same constant declared in two places.

For each, give the evidence:

1. The two (or more) locations that hold the same fact, with `file:line` for each write.
2. Which code writes each copy, and which copy each reader trusts.
3. The exact sequence that desynchronizes them: what has to happen, in what order, for the copies to disagree.
4. What the user or a downstream system sees once they disagree, and whether anything heals it.

Rules that keep this honest:

- A value computed at read time from a single source cannot drift; skip it.
- A memoized or cached value keyed on the source, invalidated everywhere the source changes, is a weak candidate; report it only if you can show a write path that skips invalidation, and say which.
- If you cannot name the sequence that makes the copies disagree, drop the candidate.

Report a table ranked by how quiet the drift is (silent, healed by nothing, first) with the pair of locations, the trigger, and the fix. Then list the dropped candidates and why. Read only: do not edit code.
