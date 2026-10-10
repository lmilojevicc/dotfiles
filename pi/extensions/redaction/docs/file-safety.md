# Filesystem limits and alias history

`src/file-tools.ts` supports regular UTF-8 text inside a pinned canonical workspace. Reads never change files. Redaction covers the **entire** file before rendered line slicing; `limit: 1` does not reduce scan coverage or permit editing hidden ranges. Restoration is limited to complete aliases observed in the same file and edited range. Whole-file writes require a current full observation. Stale content, identities, symlinks, protected policy paths, ambiguous matches and injected tokens are refused with value-free errors.

## Resource policy

| Resource | Limit | On exhaustion |
| --- | --- | --- |
| Raw file, write, restored content | 8 MiB UTF-8 | Refuse the operation before mutation |
| Rendered text / replacement input | 16 MiB UTF-8 | Refuse prospective operation |
| Spans per render | 32,768 | Refuse before copying spans |
| Retained snapshots plus reserved admissions | 32 files / 64 MiB accounted storage | Evict least-recently-used **snapshots only** |
| Remembered path spellings | 512 entries / 1 MiB accounted storage | Refuse novel entries; no eviction |
| Alias registry | 4,096 identities / 8 MiB accounted storage | Refuse new identities; no eviction or reuse |

The opened descriptor is checked before allocating file-content storage. Files above 8,388,608 bytes refuse even with a line limit. Reads fill exactly the verified size using positional chunks of at most 65,536 bytes and probe one additional byte for growth; at most 8,388,609 bytes are requested/consumed. Short reads are completed; shrink/growth or failed final identity checks refuse the whole operation, never an unscanned prefix.

An evicted snapshot grants no edit/write/restoration authority: read that file again. Existing scopes remain usable after prospective capacity refusal. Explicit session reset clears observations and registry budgets; novel path/alias exhaustion may require that reset. Aliases or paths discovered before a later phase refuses can remain reserved within their caps without granting restoration authority. Writes reserve snapshot capacity before creating a temporary file and pin scopes through commit. If capacity is pinned by pending commits, refuse rather than evict those scopes.

Accounting charges strings at two bytes per JS UTF-16 code unit:

- Snapshot: `1024 + 2*(file.length + raw.length + rendered.length)`; each span adds `160 + 2*(original.length + alias.length)`; each parent adds `512 + 2*parentPath.length`.
- Alias/path entry: `128 + 2*(key.length + value.length)`.

Retained alias keys/originals are detached copies so small identities do not retain evicted backing strings. These are **accounted retained-state limits, not process RSS/heap or global concurrency limits**. Native/bridge representations and simultaneous operations still use transient memory. Native has separate limits described in [native/README.md](../native/README.md).

## Historical token reservation

The Pi adapter reserves enabled generated-token IDs from the current retained branch **before any new allocation**, including session start/tree reset, initial input, tool results, context, forced system prompts and file operations. It sends only individual reserved-looking tokens to native, never raw history or a concatenated transcript. Stable session-manager identity memoizes branch traversal; reset or manager replacement invalidates that reservation. Disabled families do not activate or reserve.

With `userMessages: false`, intentional user text remains untouched. Generated tokens in that new text are nevertheless reserved before subsequent protected allocation. Historical `[EMAIL_1]` therefore cannot silently become the alias for a newly encountered different email after reset. Reservation does **not** reconstruct historical original identities or create restoration authority.

History traversal is bounded: 100,000 nodes/branch entries, depth 100, 8 Mi UTF-16 units per string, 64 Mi total text units, 10,000 distinct tokens, 64 characters per token. Invalid numeric IDs, missing/throwing history APIs, failed reset/reservation or exhausted traversal budgets latch protected-context/result censorship and empty instrumented provider requests until reload. Unlike ordinary file-capacity refusal, native/history sanitizer failure is sticky. See [Pi adapter coverage](pi-adapter.md).

## Remaining boundaries

This is not an OS sandbox or compare-and-swap against external writers. Final rename/ancestor race windows remain; atomic replacement does not preserve ownership, ACLs, xattrs, hard-link sharing or directory-fsync durability. Crashes/adversarial directory races may leave raw temporary files. Private snapshots/identities persist in memory until reset/drop and are not zeroized. In-flight mutations cannot be undone by cancellation/reset; re-read before retrying uncertain operations.

Filesystem policy protection is defense-in-depth, not same-user shell or hard-link isolation. Signed/opaque data, `/bug` summaries, transcript sharing/export, other runtimes/providers, direct networking and partial streaming/UI retain the documented alpha exclusions. No universal privacy or memory-isolation guarantee is claimed.
