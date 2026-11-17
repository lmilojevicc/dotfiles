---
description: Find every failure the code hides, so an error looks like success
argument-hint: "[scope, e.g. src/api]"
---
Find every error this app swallows silently: an exception, rejected promise, or returned error that nothing observes, so a failure looks like success. Scope: ${@:-the whole repo}.

Look for:

- empty or log-and-continue `catch` blocks, `except: pass`, `try { } catch { }`
- `.catch(() => {})`, `.catch(console.log)`, `.on("error", ...)` that ignores the argument
- floating promises that are never awaited and have no handler
- ignored return values that carry a status or error (`_ = err`, `if err != nil { }`)
- optional error callbacks that no caller passes
- fallbacks that replace a failure with a default (`?? ""`, `|| []`, `0` on error), so "no data" and "failed" look identical
- retries that give up and return the last value anyway

Every finding needs evidence: the `file:line`, the failure that is lost, and the line that would have observed it if the code were correct. Then state what continues in a wrong state, and what a user or operator sees instead of the failure. Logging only does not make an error observed: if the process keeps running in a wrong state, name that state.

Drop any candidate where you cannot name the specific failure that disappears. Do not report missing validation or missing error handling in general; only places where handling exists and discards the failure.

Report a table of findings ranked by how long the failure stays invisible (silent state corruption first, then silent data loss, then a mislabeled or stale UI), with the fix in one line each. Then list the candidates you dropped and why. Read only: do not edit code.
