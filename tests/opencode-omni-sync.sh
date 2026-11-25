#!/usr/bin/env bash
# Run: bash tests/opencode-omni-sync.sh (Python 3.11+; no installs).
#
# Single-source guards for the harness-neutral agent instructions:
# 1. OpenCode's omni agent takes its system prompt from agents/orchestrator.md
#    through opencode.jsonc (`agents.omni.system` = {file:...}); no omni.md copy
#    exists, so the orchestrator policy has one source (also plain Pi's
#    APPEND_SYSTEM.md and the bb agent-instructions file).
# 2. agents/AGENTS.md stays host-neutral: no orchestrator-only blocks (every
#    agent receives it, workers and subagents included).
# 3. The subagent agent files must use V2 frontmatter (permissions list, no
#    deprecated `permission` map or `temperature`).
# 4. No OpenCode agent prompt (subagent files and orchestrator.md) may
#    reference mechanisms that do not exist inside OpenCode (intercom, herdr,
#    pi-subagents, workflowz, Pi paths or env vars, live supervisor contact).
#    The allowed "supervisor" mentions are the negations that tell the model no
#    such channel exists.
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


orchestrator = root / "agents/orchestrator.md"
agents_md = root / "agents/AGENTS.md"
jsonc = (root / "opencode/opencode.jsonc").read_text()

# 1. omni is defined in opencode.jsonc and reads orchestrator.md; no copy remains.
check(orchestrator.read_text().strip() != "", "agents/orchestrator.md is missing or blank")
check(not (root / "opencode/agents/omni.md").exists(),
      "opencode/agents/omni.md exists again — omni's prompt must come from "
      "agents/orchestrator.md via opencode.jsonc, not a copy")
omni = re.search(r'"omni"\s*:\s*\{(.*?)\n\s*\}', jsonc, re.S)
check(omni is not None, "opencode.jsonc: no agents.omni entry")
if omni:
    check('"system": "{file:~/dotfiles/agents/orchestrator.md}"' in omni.group(1),
          "opencode.jsonc: agents.omni.system must be {file:~/dotfiles/agents/orchestrator.md}")
    check('"mode": "primary"' in omni.group(1), "opencode.jsonc: agents.omni must be mode primary")
check(re.search(r'"default_agent"\s*:\s*"omni"', jsonc) is not None,
      "opencode.jsonc: default_agent is no longer omni — update this guard if intended")

# 2. The shared file stays free of orchestrator-only blocks. Pi's shared
#    precedence rule names the orchestrator's authorized brief, which applies to
#    subagents as well, so the check targets self-identification and
#    orchestrator-only sections, not the word "orchestrator".
shared = agents_md.read_text().lower()
for marker in ("you are the main orchestrator", "## release", "general workflow"):
    check(marker not in shared, f"agents/AGENTS.md mentions {marker!r} — "
          "orchestrator-only rules belong in agents/orchestrator.md, not the shared file")

# 3. Subagent files use V2 frontmatter.
for p in sorted((root / "opencode/agents").glob("*.md")):
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
for p in [*sorted((root / "opencode/agents").glob("*.md")), orchestrator]:
    body = p.read_text()
    low = body.lower()
    for token in FORBIDDEN:
        check(token not in low, f"{p.name}: references {token!r}, which does not exist "
              "inside OpenCode — rewrite the line for OpenCode's task-subagent world")

if failures:
    print("opencode-omni-sync: FAIL")
    for f in failures:
        print(f"  - {f}")
    sys.exit(1)
print("opencode-omni-sync: OK (omni reads agents/orchestrator.md, AGENTS.md host-neutral, subagents on V2)")
PY
