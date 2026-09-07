# Codex Enhanced

Pi extension for current-account Codex subscription quota, banked resets, Fast processing, and optional OpenAI Responses server compaction.

Use `/codex-enhanced` to open the Quota, Resets, Fast, and Compaction tabs. Manual account operations and the cached weekly footer remain available regardless of selected model, using current canonical `openai-codex` subscription authentication (`https://chatgpt.com/backend-api`).

## Automatic banked resets

In **Resets**, **Enter/Space** toggles automatic spending for **the current account only**. It defaults **off**. **Turning it on is permission to spend banked credits without further prompts; enabling itself does not ask for confirmation.** Switching accounts does not transfer this permission.

While a canonical subscription Codex model is selected in a running **TUI** session, checks run on enabling, after settled turns, at startup, and **every minute, including idle time**. There are no factory timers or automatic actions in RPC/JSON/print mode; shutdown stops monitoring. Disabling or changing account/model suppresses unsent automatic actions. Disabling after a POST cannot undo consumption.

- Only fresh, unrounded **main weekly usage >=100%**, with an exact recognized weekly duration and future reset timestamp, triggers automatic spending. Five-hour-only, review/additional/model-specific limits, rounded `0% left`, missing/invalid data, and the five-minute footer cache never trigger it.
- Only after confirming weekly exhaustion does automation fetch uncached credit details (unless the fresh usage summary already reports zero). It chooses the usable credit with the **soonest valid expiry**, deterministically breaking ties by ID; absent expiry sorts last. Expired, malformed known expiry, unusable status/type, or missing ID cannot be selected automatically. No usable detail means **no POST and no backend-selected fallback**. Read/eligibility misses can be checked again later.
- The **server decides eligibility** and which counters reset; `nothing_to_reset` is normal. Neither weekly recovery nor resetting all quota counters is guaranteed.
- **No automatic replay/retry of model or tool work**, and no automatic retry of an uncertain reset POST.

## Manual resets and paused states

**Ctrl+R twice** still confirms a manual spend independently of the automatic toggle or weekly exhaustion. **Esc** cancels an armed reset before closing; Tab and R also cancel the arm. After a known server outcome, an explicit successful **R** refresh followed by Ctrl+R twice permits a **new manual spend, even in the same weekly episode**. That refresh does **not** clear the automatic guard. An uncertain saved intent (pending, transport failure, or unknown outcome) allows only manual retry of the **same credit ID and request ID**, never a new intent.

After any POST outcome, including `no_credit` and `nothing_to_reset`, automation waits for a later fresh weekly read to observe **recovery below 100%**, followed by subsequent exhaustion. Post-success display refreshes and stale exhausted snapshots do not rearm it. Pending/ambiguous/unknown intents remain automatically paused even if usage recovers, until an exact manual retry resolves the outcome. The guard survives R, toggling, reload, and restart. Resets shows paused/status reasons without repeated notifications.

## Local spend safety and crash recovery

Manual and automatic callers share account-scoped exclusion and a durable logical intent written **before POST**, under `<agent-dir>/codex-enhanced-resets/`. Journals use atomic, fsynced, mode-0600 writes; directories/locks use mode 0700. They contain account/credit/request IDs and guard state, **not tokens or auth headers**. Only cooperating updated extension processes sharing the **same agent directory on a local filesystem** are protected. Other directories/hosts, browsers, old extension versions, or other clients are not coordinated.

**Upgrading from the old in-memory reset implementation:** finish manual requests and stop older extension instances before enabling automation. On `/reload`, a surviving original in-process record is classified using its phase, promise and exact producer outcome message. A known settled outcome becomes a normal guarded intent with the original credit/request IDs and `recovered=false`, without POST, credit selection or clearing the automatic recovery/exhaustion guard. `locked` alone is **not** proof of success: unknown responses also used that phase. Settled ambiguous/unknown records retain uncertainty and allow **Ctrl+R twice to retry only the original IDs**, never automatic retry. A still-running promise is left alone; wait for it to settle, then `/reload`. Separate older processes cannot be detected or coordinated.

An earlier upgrade may have saved a lossy `legacy_blocked` marker. `/reload` repairs it only if the surviving original record proves settlement and **both IDs match**; it never replaces a newer/mismatched intent. Otherwise R, restarting, quota recovery and an absent lock cannot establish the original outcome.

**Acknowledge a completed old reset:** first independently establish that the original reset succeeded (`reset` or `already_redeemed`) and stop all older/uncoordinated reset operations. In Resets, **A acknowledge completion** appears only for an eligible lossy marker. A opens an inline review without changing the journal. Choose **1 reset** or **2 already applied**, then **Enter** explicitly confirms that outcome and that no old request is running. **Esc** cancels without changing the journal. If unsure, cancel and keep spending paused.

Acknowledgement saves the **same original credit/request IDs**, original marker and explicit attestation locally, with **`recovered=false`**. It spends nothing and does not refresh quota, select a credit, retry a reset, enable automation or authorize another manual spend. The UI revalidates identity through Pi's public auth resolver (which may refresh credentials); the exported `offerLegacyAcknowledgement` / `acknowledgeLegacyReset` helpers themselves never resolve auth or call the network. Offers bind the exact record; account/model/view/preference changes, locks, conflicting/live old requests and storage failures cancel the action. Pending/ambiguous/unknown requests are not acknowledgeable: use their deliberate same-request manual retry instead.

**Operator note:** with all relevant Pi/old reset instances stopped and exclusive account access verified, an operator can obtain a read-only offer from `offerLegacyAcknowledgement(agentDir, accountKey, legacyIntent)` and separately apply `acknowledgeLegacyReset({ agentDir, offer, attestation: { outcome, noPriorOperationInFlight: true }, legacyIntent, checkCurrent })`. Derive the account and IDs from the owned journal, retain the exact offer, and provide a fresh legacy callback plus synchronous context guard. Never guess IDs, use a wildcard snapshot, delete the journal or remove a live lock. Automatic spending still requires a later valid weekly recovery followed by separate exhaustion; a new manual spend still requires R and two Ctrl+R presses.

Corrupt journals, uncertain ownership, and failed durability checks fail closed. Normal completion/errors/shutdown release only the owned lock after recording the outcome. A hard crash may leave an orphan `<account-hash>.lock` directory and pause spending indefinitely; locks are **never automatically reclaimed** by age, lease expiry, or PID checks.

To recover, first verify **no cooperating process is operating** (stop all relevant Pi instances if necessary). Identify the affected lock alongside its matching `<account-hash>.json` journal; lock `owner.json` contains diagnostic PID/nonce metadata, not authority to reclaim it. **Only after verifying exclusive access, remove only the orphan lock directory. Never delete/edit the journal to unpause spending.** Resume and use Ctrl+R twice to retry the saved pending/ambiguous/unknown intent exactly. If the journal is corrupt or ownership cannot be established, keep spending paused and investigate; do not erase unknown attempts. A settings-write crash can similarly leave `codex-enhanced.json.lock`; recover that lock only with all settings writers stopped, preserving the settings file.

## Other settings

Settings live at `~/.pi/agent/codex-enhanced.json` (or `$PI_CODING_AGENT_DIR/codex-enhanced.json`). Existing Fast-only files work, all features default off, and writes preserve unknown top-level/nested fields. Automatic preferences are strict booleans in `resets.autoByAccount["account:<id>"]`; per-account revisions invalidate in-flight checks when toggled. Cooperating settings writes use exclusive short-lived locks.

- **Fast mode** only adds `service_tier: "priority"` to eligible canonical Codex requests without an explicit tier.
- **Server compaction** only handles Pi compaction for eligible canonical OpenAI Codex Responses sessions. It requests Responses Compaction V2, persists the encrypted compaction item, and replays that opaque history on later requests. Remote errors/missing content fall back to normal local compaction. A portable local summary remains available for ineligible models.

Offline tests use synthetic accounts, temporary config/journals, mocked HTTP/keys, real Pi-TUI ANSI/cell-width utilities, and subprocess coordination/crash fixtures; they do not start live Pi or contact accounts. The TUI peer package must be installed; for a nonstandard global Pi installation, set `PI_TEST_AGENT_PACKAGE` to its package directory:

```sh
npm test
```
