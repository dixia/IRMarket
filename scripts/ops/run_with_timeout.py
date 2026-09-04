"""Run IRMarket verifier bot with hard timeout and save logs for analysis.

Usage:
    python scripts/ops/run_with_timeout.py [--timeout SECONDS] [--log-level LEVEL] [--once]

Example:
    python scripts/ops/run_with_timeout.py --timeout 30
    python scripts/ops/run_with_timeout.py --timeout 60 --log-level DEBUG
    python scripts/ops/run_with_timeout.py --timeout 0        # no timeout: block until the
                                                           # bot exits (external signal)
    python scripts/ops/run_with_timeout.py --once            # single pass, then exit
"""

import argparse
import shutil
import subprocess
import sys
import time
import platform
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent.parent


def is_server() -> bool:
    """Check if running on a remote server via SSH."""
    try:
        result = subprocess.run(
            ["hostname"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        return "server" in result.stdout.lower()
    except Exception:
        pass
    return False


def check_process_running() -> bool:
    """Check if verifier bot process is still running."""
    if platform.system() == "Linux" or is_server():
        try:
            result = subprocess.run(
                ["pgrep", "-f", "verifier.py"],
                capture_output=True,
                timeout=10,
            )
            return result.returncode == 0
        except Exception:
            pass
    else:
        try:
            result = subprocess.run(
                ["powershell", "-Command",
                 "Get-Process python* -ErrorAction SilentlyContinue | Where-Object {$_.CommandLine -like '*verifier.py*'}"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            return "python" in result.stdout.lower()
        except Exception:
            pass
    return False


def main() -> None:
    parser = argparse.ArgumentParser(description="Run IRMarket verifier bot with timeout")
    parser.add_argument("--timeout", type=int, default=30,
                        help="Max runtime in seconds (0 = no timeout, run until the bot exits)")
    parser.add_argument("--log-level", type=str, default="INFO", help="Log level")
    parser.add_argument("--once", action="store_true", help="Run single pass (--once flag to bot)")
    args = parser.parse_args()

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    saved_log = ROOT / f"irmarket_{timestamp}.log"
    run_log = ROOT / "irmarket_run.log"

    if run_log.exists():
        try:
            run_log.unlink()
        except PermissionError:
            pass

    if args.timeout > 0:
        print(f"[{datetime.now().strftime('%H:%M:%S')}] Starting verifier bot, timeout={args.timeout}s")
    else:
        print(f"[{datetime.now().strftime('%H:%M:%S')}] Starting verifier bot, NO TIMEOUT (run until stopped)")
    cmd = [sys.executable, "bot/verifier.py", "--log-level", args.log_level, "--log-file", str(run_log)]
    if args.once:
        cmd.append("--once")
        print(f"  Mode: single pass (--once)")
    proc = subprocess.Popen(
        cmd,
        cwd=str(ROOT),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    try:
        if args.timeout <= 0:
            proc.wait()
            print(f"[{datetime.now().strftime('%H:%M:%S')}] Bot exited (no timeout was set)")
        else:
            proc.wait(timeout=args.timeout)
    except subprocess.TimeoutExpired:
        print(f"[{datetime.now().strftime('%H:%M:%S')}] Timeout reached, stopping...")
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            print(f"[{datetime.now().strftime('%H:%M:%S')}] Process did not stop, killing...")
            proc.kill()
            proc.wait()

    print(f"[{datetime.now().strftime('%H:%M:%S')}] Process finished")

    # Save log for analysis
    if run_log.exists():
        try:
            size = run_log.stat().st_size
            shutil.copy2(run_log, saved_log)
            print(f"Log saved: {saved_log} ({size:,} bytes)")
        except PermissionError:
            print("Log in use, cannot save")
    else:
        print("No log file found")

    # Verify process is stopped (wait a bit for cleanup)
    print(f"[{datetime.now().strftime('%H:%M:%S')}] Verifying process stopped...")
    time.sleep(2)
    if check_process_running():
        print("WARNING: Process may still be running! Manual cleanup may be needed.")
    else:
        print("Process stopped successfully")


if __name__ == "__main__":
    main()
