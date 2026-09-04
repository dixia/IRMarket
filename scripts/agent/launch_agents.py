"""Launch, monitor, continue, and safely kill opencode agents per audit cluster.

State schema v2 (per cluster):
    {status, pid, pid_starttime, session_id, launched_at, commit_sha, log}

Safety rules:
- Kill only PIDs recorded in this script's state file.
- Before killing, verify the live process start time matches the recorded
  value (guards against PID reuse killing an unrelated process).
- Never kill by process name.

Usage:
    py scripts/agent/launch_agents.py                       # launch pending clusters
    py scripts/agent/launch_agents.py --dry-run             # preview launches
    py scripts/agent/launch_agents.py --status              # fleet summary
    py scripts/agent/launch_agents.py --capture-sessions    # backfill missing ses ids
    py scripts/agent/launch_agents.py --kill C              # SAFE kill cluster C
    py scripts/agent/launch_agents.py --continue C --prompt-file fix_C.txt \
        [--model provider/model]                            # resume saved session
"""
import argparse
import json
import os
import platform
import re
import subprocess
import time
from datetime import datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
AUDIT_DIR = REPO_ROOT / "docs" / "audit"
SPEC_DIR = AUDIT_DIR / "specs"
LOG_DIR = AUDIT_DIR / "agent_logs"
STATE_FILE = AUDIT_DIR / "agent_state.json"

BASE_COMMIT_PREFIX = "28c8c76"

CLUSTERS = {
    "C": {"spec": "cluster-contracts.md", "worktree": "IRMarket_fx_C"},
    "B": {"spec": "cluster-bot.md", "worktree": "IRMarket_fx_B"},
    "W": {"spec": "cluster-web.md", "worktree": "IRMarket_fx_W"},
    "E": {"spec": "cluster-e2e.md", "worktree": "IRMarket_fx_E"},
    "I": {"spec": "cluster-infra.md", "worktree": "IRMarket_fx_I"},
    "D": {"spec": "cluster-docs.md", "worktree": "IRMarket_fx_D"},
    "A": {"spec": "cluster-audit.md", "worktree": "IRMarket_fx_A"},
}

PROMPT_TEMPLATE = (
    "You are working on IRMarket, an exotic option market on the Monad blockchain "
    "built on the Monoracle veto-arbitrage primitive. "
    "Read the attached spec file carefully. Implement ALL changes listed in the spec. "
    "Run the relevant tests after changes (Hardhat for contracts, pytest for bot, "
    "playwright for web). Commit with the exact message from the spec's Commit section. "
    "If you hit a STOP condition, write BLOCKED.md with the reason and stop. "
    "Do NOT ask questions — make reasonable decisions and proceed."
)

SESSION_RE = re.compile(r"ses_[A-Za-z0-9]{10,}")

OPENCODE_DB = Path.home() / ".local" / "share" / "opencode" / "opencode.db"


# ── state ─────────────────────────────────────────────────────────────────

def load_state() -> dict:
    if STATE_FILE.exists():
        data = json.loads(STATE_FILE.read_text())
        for entry in data.values():
            entry.setdefault("pid_starttime")
            entry.setdefault("session_id")
            entry.setdefault("commit_sha")
            entry.setdefault("log")
        return data
    return {}


def save_state(state: dict):
    STATE_FILE.write_text(json.dumps(state, indent=2))


def wt_path(cluster_id: str) -> Path:
    return REPO_ROOT.parent / CLUSTERS[cluster_id]["worktree"]


# ── session discovery (SQLite store) ───────────────────────────────────────

def find_sessions_db(worktree_name: str) -> list[dict]:
    """Query opencode's SQLite session store for sessions whose directory
    matches the worktree. Returns newest-first:
    [{id, title, created, updated, model}]. Read-only; safe while agents run.
    """
    if not OPENCODE_DB.exists():
        return []
    try:
        import sqlite3
        con = sqlite3.connect(
            f"file:{OPENCODE_DB.as_posix()}?mode=ro", uri=True, timeout=5)
        rows = con.execute(
            "SELECT id, title, time_created, time_updated, model "
            "FROM session WHERE directory LIKE ? "
            "ORDER BY time_created DESC",
            (f"%{worktree_name}",)).fetchall()
        con.close()
    except Exception as exc:
        print(f"[WARN ] DB lookup failed: {exc}")
        return []
    return [
        {"id": r[0], "title": r[1], "created": r[2], "updated": r[3],
         "model": r[4]}
        for r in rows
    ]


def discover_session_id(cluster_id: str, state: dict) -> str | None:
    """Resolve a cluster's session id: state file first, then the DB."""
    entry = state.get(cluster_id) or {}
    if entry.get("session_id"):
        return entry["session_id"]
    candidates = find_sessions_db(CLUSTERS[cluster_id]["worktree"])
    live = [c for c in candidates
            if c["title"] and c["title"] != "New session"
            and not c["title"].startswith(("Test ", "Testing "))]
    if len(live) == 1:
        sid = live[0]["id"]
        entry["session_id"] = sid
        state[cluster_id] = entry
        save_state(state)
        return sid
    if len(live) > 1:
        print(f"[AMBIG] {cluster_id}: multiple candidate sessions — pick one:")
        for c in live[:8]:
            print(f"         {c['id']}  title='{c['title'][:60]}'")
        return None
    return None


# ── process helpers (Windows) ──────────────────────────────────────────────

def _ps(command: str) -> str:
    """Run a PowerShell snippet, return stdout ('' on any failure)."""
    try:
        r = subprocess.run(
            ["powershell", "-NoProfile", "-Command", command],
            capture_output=True, text=True, timeout=15,
            encoding="utf-8", errors="replace",
        )
        return r.stdout.strip()
    except Exception:
        return ""


def proc_start_time(pid: int) -> str | None:
    """ISO start time of a PID, or None if the process does not exist."""
    out = _ps(
        f"(Get-Process -Id {pid} -ErrorAction SilentlyContinue)"
        f".StartTime.ToString('o')"
    )
    return out or None


def find_opencode_child(shell_pid: int) -> int | None:
    """Return the node/opencode child of a cmd.exe wrapper, if alive."""
    out = _ps(
        f"Get-CimInstance Win32_Process -Filter \"ParentProcessId={shell_pid}\" "
        "| Select-Object -ExpandProperty ProcessId"
    )
    for line in out.splitlines():
        line = line.strip()
        if not line.isdigit():
            continue
        cpid = int(line)
        name = _ps(f"(Get-Process -Id {cpid} -ErrorAction SilentlyContinue).ProcessName")
        if name.lower().lstrip() in ("opencode", "node"):
            return cpid
    if proc_start_time(shell_pid):
        return shell_pid
    return None


def pid_is_ours(entry: dict) -> tuple[bool, str]:
    """Validate a state entry before any kill. Returns (ok, reason)."""
    pid = entry.get("pid")
    recorded = entry.get("pid_starttime")
    if not pid:
        return False, "no PID recorded"
    now = proc_start_time(pid)
    if now is None:
        return False, f"PID {pid} is not running"
    if not recorded:
        return False, "no start time recorded; cannot guard against PID reuse"
    if now != recorded:
        return False, (
            f"start time mismatch (recorded {recorded}, live {now}); "
            "PID was reused by another process — refusing to kill"
        )
    return True, "verified"


# ── git helpers ────────────────────────────────────────────────────────────

def head_line(cluster_id: str) -> str:
    wt = wt_path(cluster_id)
    if not wt.exists():
        return "(worktree missing)"
    r = subprocess.run(
        ["git", "log", "-1", "--oneline"],
        capture_output=True, text=True, cwd=str(wt),
        encoding="utf-8", errors="replace",
    )
    return (r.stdout or "").strip()


def current_branch(cluster_id: str) -> str:
    wt = wt_path(cluster_id)
    if not wt.exists():
        return "(worktree missing)"
    r = subprocess.run(
        ["git", "rev-parse", "--abbrev-ref", "HEAD"],
        capture_output=True, text=True, cwd=str(wt),
        encoding="utf-8", errors="replace",
    )
    return (r.stdout or "").strip()


def is_cluster_done(cluster_id: str) -> bool:
    wt = wt_path(cluster_id)
    if not wt.exists():
        return False
    return not head_line(cluster_id).startswith(BASE_COMMIT_PREFIX)


# ── launch ────────────────────────────────────────────────────────────────

def capture_session_id(log_path: Path, timeout_s: float = 10.0) -> str | None:
    """Poll a log file for the first opencode session id."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            text = log_path.read_text(errors="ignore")
            m = SESSION_RE.search(text)
            if m:
                return m.group(0)
        except OSError:
            pass
        time.sleep(2)
    return None


def launch_agent(cluster_id: str, state: dict, model: str | None = None) -> bool:
    cluster = CLUSTERS[cluster_id]
    spec_path = SPEC_DIR / cluster["spec"]
    log_path = LOG_DIR / f"cluster_{cluster_id}.log"
    LOG_DIR.mkdir(parents=True, exist_ok=True)

    cmd = [
        "opencode", "run", "--auto",
        f"{PROMPT_TEMPLATE}\n\nTarget cluster: {cluster_id}",
        "--file", str(spec_path),
        "--title", f"ir-fix-{cluster_id}",
    ]
    if model:
        cmd += ["--model", model]

    with open(log_path, "w") as log_file:
        proc = subprocess.Popen(
            cmd, stdout=log_file, stderr=subprocess.STDOUT,
            cwd=str(wt_path(cluster_id)), shell=True,
        )

    real_pid = find_opencode_child(proc.pid)
    pid = real_pid or proc.pid
    entry = {
        "status": "running",
        "pid": pid,
        "pid_starttime": proc_start_time(pid),
        "session_id": capture_session_id(log_path),
        "launched_at": datetime.now().isoformat(),
        "commit_sha": None,
        "log": log_path.name,
    }
    state[cluster_id] = entry
    save_state(state)

    sid = entry["session_id"] or "NOT-CAPTURED-YET (run --capture-sessions)"
    print(f"[LAUNCH] Cluster {cluster_id}: PID={pid} "
          f"(wrapper {proc.pid}), session={sid}, log={log_path.name}")
    return True


def capture_missing_sessions(state: dict, timeout_s: float = 30.0):
    """Backfill missing session ids. Primary source: opencode SQLite store
    (matched by worktree directory). Fallback: poll the agent log file."""
    for cid in CLUSTERS:
        entry = state.get(cid)
        if not entry or entry.get("session_id"):
            continue
        sid = discover_session_id(cid, state)
        if sid:
            print(f"[OK   ] {cid}: session={sid} (from DB)")
            continue
        log_path = LOG_DIR / (entry.get("log") or f"cluster_{cid}.log")
        if not log_path.exists():
            print(f"[MISS ] {cid}: no DB match and no log file")
            continue
        sid = capture_session_id(log_path, timeout_s)
        if sid:
            entry["session_id"] = sid
            save_state(state)
            print(f"[OK   ] {cid}: session={sid} (from log)")
        else:
            print(f"[MISS ] {cid}: no session id found")


def safe_kill(cluster_id: str, state: dict):
    entry = state.get(cluster_id)
    if not entry:
        print(f"[REFUSE] {cluster_id}: not in state file — I never touch "
              "PIDs outside my own records.")
        return
    ok, reason = pid_is_ours(entry)
    if not ok:
        print(f"[REFUSE] {cluster_id}: {reason}")
        return
    pid = entry["pid"]
    if platform.system() == "Windows":
        r = subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                           capture_output=True, text=True)
    else:
        import signal
        try:
            os.kill(pid, signal.SIGTERM)
            r = subprocess.run(["ps", "-p", str(pid)],
                               capture_output=True, text=True)
            r.returncode = 1 if r.returncode == 0 else 0
        except ProcessLookupError:
            r.returncode = 1
        except Exception as exc:
            print(f"[ERROR] {cluster_id} PID {pid}: {exc}")
            return
    ok_kill = r.returncode == 0
    print(f"[{'KILL ' if ok_kill else 'ERROR'}] {cluster_id} "
          f"PID {pid}: {r.stdout.strip() or r.stderr.strip()}")
    if ok_kill:
        entry["status"] = "killed"
        save_state(state)


# ── continue ──────────────────────────────────────────────────────────────

def continue_session(cluster_id: str, prompt: str, model: str | None,
                     state: dict) -> None:
    entry = state.get(cluster_id)
    session_id = discover_session_id(cluster_id, state)
    if not session_id:
        print(f"[ABORT] {cluster_id}: no session_id in state and DB lookup "
              "found none. Set it manually in agent_state.json.")
        return

    log_name = (entry.get("log") or f"cluster_{cluster_id}.log").replace(
        ".log", "_fix.log")
    log_path = LOG_DIR / log_name
    LOG_DIR.mkdir(parents=True, exist_ok=True)

    cmd = [
        "opencode", "run", "--auto",
        "--session", session_id,
        prompt,
        "--title", f"ir-fix2-{cluster_id}",
    ]
    if model:
        cmd += ["--model", model]

    with open(log_path, "w") as log_file:
        proc = subprocess.Popen(
            cmd, stdout=log_file, stderr=subprocess.STDOUT,
            cwd=str(REPO_ROOT), shell=True,
        )
    real_pid = find_opencode_child(proc.pid)
    pid = real_pid or proc.pid
    state[cluster_id] = {
        **entry,
        "status": "running",
        "pid": pid,
        "pid_starttime": proc_start_time(pid),
        "launched_at": datetime.now().isoformat(),
        "log": log_name,
    }
    save_state(state)
    print(f"[LAUNCH] Continuation {cluster_id}: PID={pid}, "
          f"session={session_id}, log={log_name}")


# ── status ────────────────────────────────────────────────────────────────

def show_status(state: dict):
    print(f"{'CID':<5} {'Status':<9} {'Branch':<28} {'PID':<7} {'Alive':<6} "
          f"{'SessionID':<34} Head")
    print("-" * 120)
    for cid in CLUSTERS:
        entry = state.get(cid, {})
        done = is_cluster_done(cid)
        branch = current_branch(cid)
        pid = entry.get("pid")
        alive = "yes" if (pid and proc_start_time(pid)) else "-"
        sid = entry.get("session_id") or "-"
        status = entry.get("status", "pending")
        if done and status == "running":
            status = "done*"
        elif done:
            status = "committed"
        print(f"{cid:<5} {status:<9} {branch:<28} {str(pid or '-'):<7} "
              f"{alive:<6} {sid:<34} {head_line(cid)[:40]}")


# ── main ──────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--status", action="store_true")
    parser.add_argument("--capture-sessions", action="store_true",
                        help="backfill missing session ids from logs")
    parser.add_argument("--kill", metavar="CID",
                        help="SAFE kill of a recorded agent PID")
    parser.add_argument("--continue", dest="cont", metavar="CID",
                        help="resume a cluster's saved session")
    parser.add_argument("--prompt-file",
                        help="file containing the continuation prompt")
    parser.add_argument("--model", help="e.g. opencode-go/ox-alpha-free")
    args = parser.parse_args()

    state = load_state()

    if args.status:
        show_status(state)
        return
    if args.capture_sessions:
        capture_missing_sessions(state)
        return
    if args.kill:
        safe_kill(args.kill.upper(), state)
        return
    if args.cont:
        if not args.prompt_file:
            parser.error("--continue requires --prompt-file")
        prompt = Path(args.prompt_file).read_text(encoding="utf-8")
        continue_session(args.cont.upper(), prompt, args.model, state)
        return

    launched = 0
    for cid, info in CLUSTERS.items():
        if is_cluster_done(cid):
            print(f"[SKIP] Cluster {cid}: already committed ({head_line(cid)})")
            continue
        entry = state.get(cid, {})
        if entry.get("status") == "running":
            ok, _ = pid_is_ours(entry) if entry.get("pid") else (False, "")
            if ok:
                print(f"[SKIP] Cluster {cid}: running (verified PID "
                      f"{entry['pid']})")
                continue
        if args.dry_run:
            print(f"[DRY ] Would launch cluster {cid} in {info['worktree']}")
            continue
        launch_agent(cid, state, model=args.model)
        launched += 1
        time.sleep(2)

    print(f"\nLaunched {launched} agents")


if __name__ == "__main__":
    main()
