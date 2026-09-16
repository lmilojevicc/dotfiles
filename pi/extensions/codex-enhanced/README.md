# Codex Enhanced

Pi extension for current-account Codex subscription quota, banked resets, Fast processing, and optional OpenAI Responses server compaction.

Use `/codex-enhanced` to open the Quota, Resets, Fast, and Compaction tabs. Manual account operations and the cached weekly footer remain available regardless of selected model, using current canonical `openai-codex` subscription authentication (`https://chatgpt.com/backend-api`).

## Automatic banked resets

In **Resets**, unarmed **Enter/Space** toggles automatic spending for **the current account only**. It defaults **off**. **Turning it on is permission to spend banked credits without further prompts; enabling itself does not ask for confirmation.** Switching accounts does not transfer this permission.

While a canonical subscription Codex model is selected in a running **TUI** session, checks run on enabling, after settled turns, at startup, and **every minute, including idle time**. There are no factory timers or automatic actions in RPC/JSON/print mode; shutdown stops monitoring. Disabling or changing account/model suppresses unsent automatic actions. Disabling after a POST cannot undo consumption.

- Only fresh, unrounded **main weekly usage >=100%**, with an exact recognized weekly duration and future reset timestamp, triggers automatic spending. Five-hour-only, review/additional/model-specific limits, rounded `0% left`, missing/invalid data, and the five-minute footer cache never trigger it.
- Only after confirming weekly exhaustion does automation fetch uncached credit details (unless the fresh usage summary already reports zero). It chooses the usable credit with the **soonest valid expiry**, deterministically breaking ties by ID; absent expiry sorts last. Expired, malformed known expiry, unusable status/type, or missing ID cannot be selected automatically. No usable detail means **no POST and no backend-selected fallback**. Read/eligibility misses can be checked again later.
- The **server decides eligibility** and which counters reset; `nothing_to_reset` is normal. Neither weekly recovery nor resetting all quota counters is guaranteed.
- **No automatic replay/retry of model or tool work**, and no automatic retry of an uncertain reset POST.

## Manual resets and paused states

The persistent **U use 1 reset** action opens **Use 1 banked reset?**; **Enter** spends one banked credit. **Ctrl+R twice** remains compatible, including mixed U/Ctrl+R/Enter confirmation. Repeating U never confirms. Manual spending is independent of the automatic toggle, selected model, and weekly exhaustion. Armed Enter never changes the auto preference. **Esc** cancels before closing; Tab, R, Space, and account/model/lifecycle/intent changes cancel the arm.

After a known outcome, the row shows **Manual reset · R refresh first**. A successful coordinated **R** refresh followed by confirmation permits a **new manual spend, even in the same weekly episode**; it does not clear the automatic guard. A saved pending/ambiguous/unknown intent instead offers **U retry previous reset**, then **Enter retry**: **the same credit and request ID**, even with zero current credits. Confirmation is checked against the exact journal identity after acquiring exclusion; another session's changed intent requires a new confirmation.

Busy/disabled manual actions remain visible, with a reason or R refresh action. A read-only refresh during contention cannot authorize a new spend. Local lock availability refreshes about once per second while the menu is open; this polling never resolves auth, fetches quota, writes a journal or spends.
After any POST outcome, including `no_credit` and `nothing_to_reset`, automation waits for a later fresh weekly read to observe **recovery below 100%**, followed by subsequent exhaustion. Post-success display refreshes and stale exhausted snapshots do not rearm it. Pending/ambiguous/unknown intents remain automatically paused even if usage recovers, until an exact manual retry resolves the outcome. The guard survives R, toggling, reload, and restart. Resets shows paused/status reasons without repeated notifications.

## Local spend safety and crash recovery

Manual and automatic callers share account-scoped exclusion and a durable logical intent written **before POST**, under `<agent-dir>/codex-enhanced-resets/`. Journals use atomic, fsynced, mode-0600 writes. Account directories use mode 0700; persistent regular `.lock` files use mode 0600. They contain account/credit/request IDs and guard state, **not tokens or auth headers**. Only cooperating updated extension processes sharing the **same agent directory on a local filesystem** are protected. Other directories/hosts, browsers, in-memory-only old versions, unrelated clients and manually replaced lock files are outside this guarantee.

**Upgrading from the old in-memory reset implementation:** finish manual requests and stop older extension instances before enabling automation. On `/reload`, a surviving original in-process record is classified using its phase, promise and exact producer outcome message. A known settled outcome becomes a normal guarded intent with the original credit/request IDs and `recovered=false`, without POST, credit selection or clearing the automatic recovery/exhaustion guard. `locked` alone is **not** proof of success: unknown responses also used that phase. Settled ambiguous/unknown records retain uncertainty and allow **Ctrl+R twice to retry only the original IDs**, never automatic retry. A still-running promise is left alone; wait for it to settle, then `/reload`. Separate older processes cannot be detected or coordinated.

An earlier upgrade may have saved a lossy `legacy_blocked` marker. `/reload` repairs it only if the surviving original record proves settlement and **both IDs match**; it never replaces a newer/mismatched intent. Otherwise R, restarting, quota recovery and an absent lock cannot establish the original outcome.

**Acknowledge a completed old reset:** first independently establish that the original reset succeeded (`reset` or `already_redeemed`) and stop all older/uncoordinated reset operations. In Resets, **A acknowledge completion** appears only for an eligible lossy marker. A opens an inline review without changing the journal. Choose **1 reset** or **2 already applied**, then **Enter** explicitly confirms that outcome and that no old request is running. **Esc** cancels without changing the journal. If unsure, cancel and keep spending paused.

Acknowledgement saves the **same original credit/request IDs**, original marker and explicit attestation locally, with **`recovered=false`**. It spends nothing and does not refresh quota, select a credit, retry a reset, enable automation or authorize another manual spend. The UI revalidates identity through Pi's public auth resolver (which may refresh credentials); the exported `offerLegacyAcknowledgement` / `acknowledgeLegacyReset` helpers themselves never resolve auth or call the network. Offers bind the exact record; account/model/view/preference changes, locks, conflicting/live old requests and storage failures cancel the action. Pending/ambiguous/unknown requests are not acknowledgeable: use their deliberate same-request manual retry instead.

**Operator note:** with all relevant Pi/old reset instances stopped and exclusive account access verified, an operator can obtain a read-only offer from `offerLegacyAcknowledgement(agentDir, accountKey, legacyIntent)` and separately apply `acknowledgeLegacyReset({ agentDir, offer, attestation: { outcome, noPriorOperationInFlight: true }, legacyIntent, checkCurrent })`. Derive the account and IDs from the owned journal, retain the exact offer, and provide a fresh legacy callback plus synchronous context guard. Never guess IDs, use a wildcard snapshot, delete the journal or remove a live lock. Automatic spending still requires a later valid weekly recovery followed by separate exhaustion; a new manual spend still requires R and two Ctrl+R presses.

### Runtime requirement

Reset locking requires **Python 3 with the standard-library `fcntl` module**, on **macOS or Linux**, and a supported **local filesystem**. Python is an external runtime dependency, not an npm dependency. On first use the extension selects and caches the first executable `python3` in an **absolute directory in Pi's PATH**, resolving its real absolute path. Empty/relative PATH entries are ignored; no shell discovery is used. Install Python 3 and ensure that PATH is correct before starting Pi. No helper starts from the extension factory. Unsupported platforms or missing/broken Python disable resets with a visible reason; quota display/refresh remains available.

Each bounded helper runs `-I -S -c` with an empty environment and `/` as cwd. It applies nonblocking `fcntl.flock` to **fd 3 inherited from Node**, never reopens the lock and never explicitly unlocks it. Node retains that shared descriptor throughout observation, intent persistence, POST and reconciliation. Independent opens/probes cannot unlock it. A small per-account, same-module priority gate lets authoritative acquisitions finish an already-running bounded display probe and defers new probes while local operations are pending/active. It never queues spend attempts behind one another, shares descriptors, retries a POST or replaces kernel flock; other module instances and processes still contend through the OS. Auth/lifecycle/consent and manual intent are revalidated after acquisition. A suspended owner remains exclusive. A killed Node owner releases exclusion when its last inherited helper descriptor closes, without changing file timestamps or deleting a lock. A two-second helper timeout kills only that helper and waits for it to exit before failing closed; it is not an ownership lease.

### Crash recovery and mixed versions

**Do not delete new regular `.lock` files.** Their stable inode is required for exclusion and intentionally fences old mkdir-based versions, which remain blocked even between updated operations. Update/stop all older implementations before rollout, especially in-memory-only versions that do not honor this protocol. No live migration is performed by the extension.

An existing **legacy `.lock` directory** displays **Old reset lock; see README** and remains blocked regardless of PID, age or timestamps. Separately verify that all relevant old/cooperating operations have stopped and exclusive account access is established before an operator migrates an orphan legacy directory. Preserve its matching journal and any uncertain request IDs; only a verified obsolete **directory**, never a new regular lock file, may be removed in that migration. A dead local process does not prove a server request settled.

Corrupt/unreadable journals, unexpected ownership/symlinks, or failed durability checks fail closed and preserve evidence. Under the acquired lock, the visible validated journal and its directory are re-fsynced before work. Atomic writes use unique private sibling temporary files, file fsync, rename, then directory fsync. A pending write must complete all steps before POST. Abandoned temporary files are not promoted or treated as outcomes. Failed persistence releases kernel ownership, not the spending guard: the next holder validates/re-fsyncs surviving state. A durable pending predecessor or complete terminal successor remains conservative, with `recovered=false`. Only a definitely-unsent first intent with no predecessor can roll back to absence. Never erase an uncertain journal to unblock spending.

**Guarantee boundary:** this client prevents competing fresh intents and repeated automatic credit selection during an uncertain/guarded episode. Deliberate retries preserve account/credit/request identity, but **server-side exactly-once behavior is not documented here**. A retry may overlap an earlier remote submission; the lock becoming free is not proof of remote settlement. Mock-server deduplication tests demonstrate identity preservation under the mock's explicit single-use contract, not production exactly-once. Durability assumes successful filesystem fsync/rename guarantees; deleted journals, disk rollback and lying hardware are outside it.

The adjacent **settings** lock (`codex-enhanced.json.lock`) still uses the separate mkdir protocol and is not repaired by this change. A settings-write crash requires separately verified recovery with all settings writers stopped, preserving the settings file.

## Other settings

Settings live at `~/.pi/agent/codex-enhanced.json` (or `$PI_CODING_AGENT_DIR/codex-enhanced.json`). Existing Fast-only files work, all features default off, and writes preserve unknown top-level/nested fields. Automatic preferences are strict booleans in `resets.autoByAccount["account:<id>"]`; per-account revisions invalidate in-flight checks when toggled. Cooperating settings writes use exclusive short-lived locks.

- **Fast mode** only adds `service_tier: "priority"` to eligible canonical Codex requests without an explicit tier.
- **Server compaction** only handles Pi compaction for eligible canonical OpenAI Codex Responses sessions. It requests Responses Compaction V2, persists the encrypted compaction item, and replays that opaque history on later requests. Remote errors/missing content fall back to normal local compaction. A portable local summary remains available for ineligible models.

Offline tests use synthetic accounts, temporary config/journals, mocked HTTP/keys, real Pi-TUI raw-key matching and ANSI/cell-width utilities, and subprocess coordination/crash fixtures; they do not start live Pi or contact accounts. The TUI peer package must be installed; for a nonstandard global Pi installation, set `PI_TEST_AGENT_PACKAGE` to its package directory:

```sh
npm test
```

The inherited-descriptor/crash suite was exercised on macOS arm64 with Node 26 and Python 3. Linux is implemented but has not been executed on this macOS host; run the full suite on Linux before claiming tested Linux support. No Windows or network-filesystem support is claimed.
