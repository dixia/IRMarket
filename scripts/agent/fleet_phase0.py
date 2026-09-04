"""Phase-0 fleet launcher: launch opencode agents for IRMarket audit clusters.

Usage:
    py scripts/agent/fleet_phase0.py --mode work            # launch all pending
    py scripts/agent/fleet_phase0.py --mode work --cluster C
    py scripts/agent/fleet_phase0.py --status
    py scripts/agent/fleet_phase0.py --dry-run --mode work
"""
import argparse
import json
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
LOG_DIR = REPO_ROOT / "docs" / "audit" / "agent_logs"
STATE_FILE = REPO_ROOT / "docs" / "audit" / "phase0_state.json"
SPEC_DIR = REPO_ROOT / "docs" / "audit" / "specs"

MODEL = "opencode-go/ox-alpha-free"

CLUSTERS = {
    "C": {"wt": "IRMarket_fx_C", "spec": "cluster-contracts.md"},
    "B": {"wt": "IRMarket_fx_B", "spec": "cluster-bot.md"},
    "W": {"wt": "IRMarket_fx_W", "spec": "cluster-web.md"},
    "E": {"wt": "IRMarket_fx_E", "spec": "cluster-e2e.md"},
    "I": {"wt": "IRMarket_fx_I", "spec": "cluster-infra.md"},
    "D": {"wt": "IRMarket_fx_D", "spec": "cluster-docs.md"},
    "A": {"wt": "IRMarket_fx_A", "spec": "cluster-audit.md"},
}

WORK_PROMPT = """You are working on IRMarket, an exotic option market on the Monad blockchain
built on the Monoracle veto-arbitrage primitive.

Read the attached spec file carefully. Implement ALL changes listed in the spec.
After implementation:
  1. Run the relevant tests (Hardhat for contracts, pytest for bot, playwright for web).
  2. Commit with the exact message from the spec's Commit section.
  3. If you hit a STOP condition or blocker, write BLOCKED.md with the reason.

Hard rules:
- Stay inside this worktree.
- Do NOT modify files outside the scope of this cluster's spec.
- No questions — make reasonable decisions and proceed."""


def load_state():
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {}


def save_state(st):
    STATE_FILE.write_text(json.dumps(st, indent=2))


def wt_path(cluster_id: str) -> Path:
    return REPO_ROOT.parent / CLUSTERS[cluster_id]["wt"]


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


BASE_COMMIT_PREFIX = "28c8c76"


def is_cluster_done(cluster_id: str) -> bool:
    wt = wt_path(cluster_id)
    if not wt.exists():
        return False
    return not head_line(cluster_id).startswith(BASE_COMMIT_PREFIX)


def build_cmd(cid: str, mode: str, wt_path: Path):
    spec_path = SPEC_DIR / CLUSTERS[cid]["spec"]
    prompt_file = LOG_DIR / f"phase0_{cid}_{mode}_prompt.txt"
    prompt_file.parent.mkdir(parents=True, exist_ok=True)

    if mode == "work":
        body = WORK_PROMPT
    else:
        raise ValueError(f"unknown mode {mode!r}")

    prompt_file.write_text(body)
    cmd = [
        "opencode", "run", "--auto", "--model", MODEL,
        f"Execute the instructions in {prompt_file}",
        "--file", str(spec_path),
        "--title", f"ir-phase0-{cid}",
    ]
    return cmd


def launch(cid: str, mode: str):
    wt = wt_path(cid)
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_path = LOG_DIR / f"phase0_{cid}_{mode}.log"
    cmd = build_cmd(cid, mode, wt)
    with open(log_path, "w") as lf:
        proc = subprocess.Popen(
            cmd, stdout=lf, stderr=subprocess.STDOUT, cwd=str(wt), shell=True,
        )
    print(f"[LAUNCH] {cid}/{mode}: PID={proc.pid} log={log_path.name}")
    return proc.pid


def show_status():
    st = load_state()
    print(f"{'cid':<4} {'mode':<9} {'status':<10} {'launched':<20}")
    print("-" * 50)
    for k, v in sorted(st.items()):
        print(f"{k.split(':')[0]:<4} {k.split(':')[1]:<9} {v.get('status','?'):<10} {v.get('at','-'):<20}")
    if not st:
        print("(empty)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["work"], required=True)
    ap.add_argument("--cluster")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--status", action="store_true")
    args = ap.parse_args()

    if args.status:
        show_status()
        return

    targets = [args.cluster.upper()] if args.cluster else list(CLUSTERS)

    st = load_state()
    n = 0
    for cid in targets:
        if cid not in CLUSTERS:
            print(f"[SKIP] unknown cluster {cid}")
            continue
        if is_cluster_done(cid):
            print(f"[SKIP] {cid}: already committed ({head_line(cid)})")
            continue
        key = f"{cid}:{args.mode}"
        if st.get(key, {}).get("status") == "done":
            print(f"[SKIP] {key} marked done")
            continue
        if args.dry_run:
            print(f"[DRY] would launch {key}")
            continue
        pid = launch(cid, args.mode)
        st[key] = {"status": "running", "pid": pid, "at": datetime.now().isoformat(timespec="seconds")}
        save_state(st)
        n += 1
        time.sleep(3)
    print(f"launched={n}")


if __name__ == "__main__":
    main()
