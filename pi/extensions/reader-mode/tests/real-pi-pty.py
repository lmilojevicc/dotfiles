"""Bounded offline CLI smoke; Python stdlib PTY, no terminal emulator dependency."""
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

pi, reader, probe = sys.argv[1:]
for tool in ("fd", "rg"):
    assert shutil.which(tool), f"{tool} must be on PATH so Pi does not download managed tools"


def run(start_mode):
    with tempfile.TemporaryDirectory(prefix="reader-mode-cli-") as temp:
        root = Path(temp)
        for name in ("home", "agent", "cwd", "sessions"):
            (root / name).mkdir()
        (root / "agent/settings.json").write_text(json.dumps({
            "quietStartup": True, "enableInstallTelemetry": False,
            "fullscreenExitOutput": "resume-hint", "fullscreenScrollbar": "always",
        }))
        report = root / "report.jsonl"
        # Deliberately do not inherit API keys, Pi config, NODE_OPTIONS or terminal hooks.
        env = {
            "PATH": os.environ["PATH"], "HOME": str(root / "home"),
            "TERM": "xterm-256color", "LANG": "en_US.UTF-8",
            "PI_CODING_AGENT_DIR": str(root / "agent"),
            "PI_OFFLINE": "1", "PI_SKIP_VERSION_CHECK": "1", "PI_TELEMETRY": "0",
            "READER_SMOKE_REPORT": str(report),
        }
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 140, 0, 0))
        process = subprocess.Popen([
            pi, "--offline", "--no-session", "--session-dir", str(root / "sessions"),
            "--no-approve", "--no-context-files", "--no-skills", "--no-prompt-templates",
            "--no-themes", "--no-extensions", "--no-tools", "--tui-mode", start_mode,
            "-e", reader, "-e", probe,
        ], cwd=root / "cwd", env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        output = bytearray()
        deadline = time.monotonic() + 35

        def wait(predicate):
            while time.monotonic() < deadline:
                events = [json.loads(line) for line in report.read_text().splitlines()] if report.exists() else []
                failures = [event for event in events if event["event"] == "failure"]
                assert not failures, failures
                if predicate(events):
                    return
                assert process.poll() is None, f"CLI exited early: {process.returncode}"
                readable, _, _ = select.select([master], [], [], 0.05)
                if readable:
                    try:
                        output.extend(os.read(master, 65536))
                    except OSError:
                        pass
            raise AssertionError("CLI smoke timed out")

        def event(name):
            wait(lambda events: any(item["event"] == name for item in events))

        def send(text):
            os.write(master, text.encode())

        try:
            event("ready")
            send("/reader on\r")
            wait(lambda _: b"Reader mode on (110 columns)" in output)
            send("/reader-smoke baseline\r")
            event("baseline")
            assert b"               READER_SMOKE_CONTENT" in output, "centered content reached the actual PTY"
            output.clear()
            send("/settings\r")
            wait(lambda _: b"Type to search" in output)
            output.clear()
            send("TUI mode")
            wait(lambda _: b"TUI mode" in output)
            output.clear()
            send("\r")
            target = "fullscreen" if start_mode == "regular" else "regular"
            wait(lambda _: f"TUI mode: {target}".encode() in output)
            output.clear()
            send("\x03")
            # The main Editor's empty cursor differs from the settings search Input.
            wait(lambda _: b"\x1b[7m \x1b[0m" in output)
            send("/reader-smoke switched\r")
            event("switched")
            send("/reload\r")
            event("reloaded")
            wait(lambda _: b"Reloaded keybindings" in output)
            send("/reader-smoke reload\r")
            event("reload")
            output.clear()
            send("/reader off\r")
            wait(lambda _: b"Reader mode off (110 columns retained)" in output)
            send("/reader-smoke off\r")
            event("off")
            send("/quit\r")
            wait(lambda _: process.poll() is not None)
            assert process.returncode == 0, process.returncode
            print(f"PASS bundled CLI {start_mode} startup → {target} /settings → /reload → off/quit; live class, seven roots, editor/footer, both working indicators, PTY rendering")
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


for mode in ("regular", "fullscreen"):
    run(mode)
