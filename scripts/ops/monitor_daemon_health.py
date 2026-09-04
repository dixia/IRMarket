#!/usr/bin/env python
"""Monitor IRMarket verifier bot health during a live run.

Polls the bot log file and reports:
  - Last log timestamp (liveness)
  - Recent errors / vetoes / quotes
  - Process alive status

Usage:
  python scripts/ops/monitor_daemon_health.py [--log irmarket_run.log] [--interval 30]
"""
import argparse
import platform
import subprocess
import time
from pathlib import Path

DEFAULT_LOG = "irmarket_run.log"
DEFAULT_INTERVAL = 30


def process_alive() -> bool:
    if platform.system() != "Linux":
        return True
    try:
        r = subprocess.run(
            ["pgrep", "-f", "bot/verifier.py"],
            capture_output=True, timeout=10,
        )
        return r.returncode == 0
    except Exception:
        return False


def tail(path: str, n: int = 20) -> list[str]:
    try:
        lines = Path(path).read_text(errors="ignore").splitlines()
        return [l for l in lines if l.strip()][-n:]
    except OSError:
        return []


def summarize(lines: list[str]) -> dict:
    veto = [l for l in lines if "veto" in l.lower()]
    quote = [l for l in lines if "quote" in l.lower()]
    error = [l for l in lines if "error" in l.lower() or "exception" in l.lower()]
    return {
        "vetoes": len(veto),
        "quotes": len(quote),
        "errors": len(error),
        "last_ts": lines[-1][:19] if lines else "n/a",
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--log", default=DEFAULT_LOG)
    parser.add_argument("--interval", type=int, default=DEFAULT_INTERVAL)
    args = parser.parse_args()

    print(f"[monitor] watching {args.log} every {args.interval}s")
    try:
        while True:
            alive = process_alive()
            lines = tail(args.log)
            s = summarize(lines)
            status = "ALIVE" if alive else "DEAD"
            print(f"[{time.strftime('%H:%M:%S')}] {status} | last={s['last_ts']} | "
                  f"vetoes={s['vetoes']} quotes={s['quotes']} errors={s['errors']}")
            time.sleep(args.interval)
    except KeyboardInterrupt:
        print("\n[monitor] stopped")


if __name__ == "__main__":
    main()
