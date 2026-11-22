#!/usr/bin/env bash
# Run: bash tests/opencode-omni-sync.sh (Python 3.11+; no installs).
#
# Single-source guards for the OpenCode orchestrator split:
# 1. The body of opencode/agents/omni.md must be byte-identical to
#    pi/APPEND_SYSTEM.md (omni's body replaces OpenCode's base prompt, so the
#    orchestrator policy must be edited in APPEND_SYSTEM.md and re-synced).
# 2. opencode/AGENTS.md must stay host-neutral: no orchestrator-only blocks
#    (every OpenCode agent receives it, including subagents).
# 3. The subagent agent files must use V2 frontmatter (permissions list, no
#    deprecated `permission` map or `temperature`).
# 4. No agent body may reference mechanisms that do not exist inside OpenCode
#    (intercom, herdr, pi-subagents, workflowz, Pi paths or env vars, live
#    supervisor contact). The allowed "supervisor" mentions are the negations
#    that tell the model no such channel exists.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PYTHON="$(command -v python3)"
[[ -n "$PYTHON" ]] || {
  echo "python3 required"
  exit 1
}

"$PYTHON" - "$ROOT" <<'PY'
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1])
failures = []


def check(ok, message):
    if not ok:
        failures.append(message)


omni = root / "opencode/agents/omni.md"
canonical = root / "pi/APPEND_SYSTEM.md"
agents_md = root / "opencode/AGENTS.md"

# 1. omni body == APPEND_SYSTEM.md, byte for byte. The formatter's single blank
#    line between frontmatter and body is normalized away, so only content drift
#    fails here.
text = omni.read_text()
m = re.match(r"^---\n.*?\n---\n", text, re.S)
check(m is not None, "omni.md: no frontmatter block found")
if m:
    check(
        text[m.end():].lstrip("\n") == canonical.read_text().lstrip("\n"),
        "omni.md body differs from pi/APPEND_SYSTEM.md — re-sync it "
        "(edit APPEND_SYSTEM.md, then regenerate the omni body) or the "
        "OpenCode orchestrator drifts from the Pi one",
    )

# 2. AGENTS.md stays free of orchestrator-only blocks: it now mirrors
#    pi/AGENTS.md byte for byte (one source, guarded below), so the leak check
#    targets self-identification and orchestrator-only sections, not the
#    word "orchestrator" (Pi's shared precedence rule names the orchestrator's
#    authorized brief, which applies to subagents as well).
shared = agents_md.read_text().lower()
for marker in ("you are the main orchestrator", "## release", "general workflow"):
    check(marker not in shared, f"opencode/AGENTS.md mentions {marker!r} — "
          "orchestrator-only rules belong in omni.md's body, not the shared file")
check(
    agents_md.read_text() == (root / "pi/AGENTS.md").read_text(),
    "opencode/AGENTS.md differs from pi/AGENTS.md — the shared rules are "
    "single-sourced; edit pi/AGENTS.md and copy it over",
)

# 3. Subagent files use V2 frontmatter.
for p in sorted((root / "opencode/agents").glob("*.md")):
    if p.name == "omni.md":
        continue
    t = p.read_text()
    fm = re.match(r"^---\n(.*?)\n---\n", t, re.S)
    check(fm is not None, f"{p.name}: no frontmatter block found")
    if not fm:
        continue
    body = fm.group(1)
    check("permissions:" in body, f"{p.name}: missing V2 `permissions:` list")
    check("permission:" not in body, f"{p.name}: deprecated V1 `permission:` map present")
    check("temperature:" not in body, f"{p.name}: deprecated V1 `temperature:` present (V2 "
          "per-agent request overlays are not sent by the runner)")

FORBIDDEN = [
    "intercom",
    "herdr",
    "pi-subagents",
    "~/.pi",
    "PI_SUBAGENT",
    "PI_AGENT",
    "workflowz",
    "fork-workflows",
    "codemode",
    "prompt_cache",
    "agent-policy",
    "wake me",
    "signal me",
    "contact the supervisor",
    "message the supervisor",
    "ask the supervisor",
    "notify the supervisor",
    "wait for the supervisor",
]

# 4. Agent bodies stay inside OpenCode's world.
for p in sorted((root / "opencode/agents").glob("*.md")):
    body = p.read_text()
    if p.name == "omni.md":
        m = re.match(r"^---\n.*?\n---\n", body, re.S)
        body = body[m.end():] if m else body
    low = body.lower()
    for token in FORBIDDEN:
        check(token not in low, f"{p.name}: references {token!r}, which does not exist "
              "inside OpenCode — rewrite the line for OpenCode's task-subagent world")

if failures:
    print("opencode-omni-sync: FAIL")
    for f in failures:
        print(f"  - {f}")
    sys.exit(1)
print("opencode-omni-sync: OK (omni body in sync, AGENTS.md host-neutral, subagents on V2)")
PY
