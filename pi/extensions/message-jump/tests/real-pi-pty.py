"""Offline actual installed CLI + real fullscreen layout; temp config/session only."""
import fcntl
import json
import os
import pty
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time
from pathlib import Path

cli, extension, probe = sys.argv[1:]
for tool in ("fd", "rg"):
    assert shutil.which(tool), f"{tool} must be on PATH to avoid managed tool downloads"


def run(start_mode):
    with tempfile.TemporaryDirectory(prefix="message-jump-cli-") as temp:
        root = Path(temp)
        for directory in ("home", "agent", "cwd", "sessions"):
            (root / directory).mkdir()
        (root / "agent/settings.json").write_text(json.dumps({
            "quietStartup": True, "enableInstallTelemetry": False,
            "fullscreenExitOutput": "resume-hint", "fullscreenScrollbar": "always",
        }))
        session = root / "session.jsonl"
        lines = [{"type": "session", "version": 3, "id": "jump-test", "timestamp": "2026-01-01T00:00:00Z", "cwd": str(root / "cwd")}]
        for i in range(30):
            text = "restored duplicate" if i in (4, 12) else f"fixture {i} " + "wrap 世界 " * 30
            lines.append({"type": "message", "id": f"entry-{i:02}", "parentId": f"entry-{i-1:02}" if i else None,
                          "timestamp": "2026-01-01T00:00:00Z", "message": {"role": "user", "content": [{"type": "text", "text": text}], "timestamp": i}})
        session.write_text("\n".join(json.dumps(line) for line in lines) + "\n")
        report = root / "report.jsonl"
        env = {"PATH": os.environ["PATH"], "HOME": str(root / "home"), "TERM": "xterm-256color", "LANG": "en_US.UTF-8",
               "PI_CODING_AGENT_DIR": str(root / "agent"), "PI_OFFLINE": "1", "PI_SKIP_VERSION_CHECK": "1", "PI_TELEMETRY": "0",
               "MESSAGE_JUMP_REPORT": str(report)}
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 100, 0, 0))
        process = subprocess.Popen([cli, "--offline", "--session", str(session), "--session-dir", str(root / "sessions"),
                                    "--no-approve", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes",
                                    "--no-extensions", "--no-tools", "--tui-mode", start_mode, "-e", extension, "-e", probe],
                                   cwd=root / "cwd", env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        output = bytearray()
        deadline = time.monotonic() + 50

        def wait(predicate):
            while time.monotonic() < deadline:
                events = [json.loads(line) for line in report.read_text().splitlines()] if report.exists() else []
                failures = [event for event in events if event["event"] == "failure"]
                assert not failures, failures
                if predicate(events):
                    return
                assert process.poll() is None, f"CLI exited early {process.returncode}"
                readable, _, _ = select.select([master], [], [], 0.05)
                if readable:
                    try:
                        output.extend(os.read(master, 65536))
                    except OSError:
                        pass
            raise AssertionError("CLI smoke timed out")

        def event(name):
            wait(lambda events: any(e["event"] == name for e in events))

        def send(text):
            os.write(master, text.encode())

        try:
            event("ready")
            if start_mode == "regular":
                send("/jump-smoke unsupported\r")
                event("unsupported")
            else:
                for stage, key in (("cancel", "\x1b"), ("newer", "\r"), ("older", "\x1b[B\r"), ("live", "\r")):
                    send(f"/jump-smoke {stage}\r")
                    wait(lambda events: any(e["event"] == "opened" and e["stage"] == stage for e in events))
                    if stage == "older":
                        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 65, 0, 0))
                        os.killpg(process.pid, signal.SIGWINCH)
                        time.sleep(0.2)
                    send(key)
                    event(stage)
                send("/reload\r")
                event("reloaded")
                time.sleep(0.5)  # Reload status is outside the scrolled viewport; allow command handoff.
                send("/jump-smoke reload\r")
                wait(lambda events: any(e["event"] == "opened" and e["stage"] == "reload" for e in events))
                send("\r")
                event("reload")
                send("/jump-smoke compacted\r")
                wait(lambda events: any(e["event"] == "opened" and e["stage"] == "compacted" for e in events))
                send("\r")
                event("compacted")
                send("/new\r")
                event("switched")
                time.sleep(0.3)
                send("/jump-smoke empty\r")
                event("empty")
                send("/jump-smoke new\r")
                wait(lambda events: any(e["event"] == "opened" and e["stage"] == "new" for e in events))
                send("\r")
                event("new")
            send("/quit\r")
            wait(lambda _: process.poll() is not None)
            assert process.returncode == 0
            print(f"PASS installed CLI {start_mode}: " + ("truthful unsupported-mode feedback" if start_mode == "regular" else
                  "restored/live identity, duplicate stable IDs, real scrollTop, unchanged leaf/context/draft/focus, Escape, resize, reload, compaction, /new session replacement"))
        except Exception:
            print(output.decode(errors="replace")[-12000:], file=sys.stderr)
            if report.exists():
                print(report.read_text(), file=sys.stderr)
            raise
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)
            os.close(master)


for mode in ("fullscreen", "regular"):
    run(mode)
