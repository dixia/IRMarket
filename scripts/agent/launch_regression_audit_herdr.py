#!/usr/bin/env python3
"""Herdr-coordinated regression audit fleet.

Requires: herdr CLI + HERDR_ENV=1 environment.

Replaces the subprocess/PID model in `scripts/agent/launch_regression_audit.py`
with herdr workspaces / tabs / panes / named agents.

Workflow
--------
1. Create a dedicated workspace with a unique label.
2. Create one tab inside it.
3. Build a readable grid of panes:
   - 1 agent  -> 1x1
   - 2 agents -> 1x2
   - 3-4     -> 2x2
   - 5-6     -> 3x2
   - 7-9     -> 3x3
   - etc.
4. Start one OpenCode agent per spec file in its own pane.
5. Push the spec into the agent and wait for completion.
6. Allow live reads, targeted prompts, and pane-level cleanup.

Usage
-----
    py scripts/agent/launch_regression_audit_herdr.py --dry-run
    py scripts/agent/launch_regression_audit_herdr.py
    py scripts/agent/launch_regression_audit_herdr.py --status
    py scripts/agent/launch_regression_audit_herdr.py --watch R1
    py scripts/agent/launch_regression_audit_herdr.py --kill R1
    py scripts/agent/launch_regression_audit_herdr.py --model step-plan/step-router-v1
"""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Sequence

# ---------------------------------------------------------------------------
# Environment guard
# ---------------------------------------------------------------------------
if os.environ.get("HERDR_ENV") != "1":
    sys.exit("This script requires HERDR_ENV=1. Run it from inside a herdr session.")

# ---------------------------------------------------------------------------
# Constants / defaults
# ---------------------------------------------------------------------------
DEFAULT_MODEL = "step-plan/step-router-v1"
DEFAULT_SPECS_DIR = "docs/audit/regression_2026-09-01/specs"
DEFAULT_REPORT_DIR = "docs/audit/regression_2026-09-01/reports"
DEFAULT_LABEL = "regression-audit"


# ---------------------------------------------------------------------------
# Herdr JSON helpers
# ---------------------------------------------------------------------------

def _jq(expr: str, json_text: str) -> str | None:
    try:
        out = subprocess.run(
            ["jq", "-r", expr],
            input=json_text,
            text=True,
            capture_output=True,
            check=True,
            timeout=10,
        )
        val = out.stdout.strip()
        return val or None
    except Exception as exc:
        raise RuntimeError(f"jq query failed: {expr!r} -> {exc}") from exc


def _require(cmd: Sequence[str]) -> None:
    if not shutil.which(cmd[0]):
        sys.exit(f"required binary not found: {cmd[0]}")


# ---------------------------------------------------------------------------
# Herdr surface wrappers
# ---------------------------------------------------------------------------

def herdr_workspace_create(label: str) -> str:
    out = subprocess.run(
        ["herdr", "workspace", "create", "--label", label],
        capture_output=True,
        text=True,
        check=True,
        timeout=30,
    )
    return _jq(".result.workspace.workspace_id", out.stdout)


def herdr_tab_create(workspace_id: str, label: str) -> str:
    out = subprocess.run(
        ["herdr", "tab", "create", "--workspace", workspace_id, "--label", label],
        capture_output=True,
        text=True,
        check=True,
        timeout=30,
    )
    return _jq(".result.tab.tab_id", out.stdout)


def herdr_pane_list(workspace_id: str) -> list[dict]:
    out = subprocess.run(
        ["herdr", "pane", "list", "--workspace", workspace_id],
        capture_output=True,
        text=True,
        check=True,
        timeout=30,
    )
    data = json.loads(out.stdout)
    return data.get("result", {}).get("panes", [])


def herdr_pane_split(pane_id: str, direction: str, cwd: str) -> str:
    if direction not in {"right", "down"}:
        raise ValueError("direction must be right or down")
    out = subprocess.run(
        [
            "herdr", "pane", "split",
            "--pane", pane_id,
            "--direction", direction,
            "--cwd", cwd,
            "--no-focus",
        ],
        capture_output=True,
        text=True,
        check=True,
        timeout=30,
    )
    return _jq(".result.pane.pane_id", out.stdout)


def herdr_agent_start(name: str, pane_id: str, model: str) -> None:
    subprocess.run(
        [
            "herdr", "agent", "start",
            name,
            "--kind", "opencode",
            "--pane", pane_id,
            "--timeout", "30000",
            "--",
            "--model", model,
        ],
        capture_output=True,
        text=True,
        check=True,
        timeout=60,
    )


def herdr_agent_wait(name: str, timeout_ms: int = 120_000) -> str:
    out = subprocess.run(
        ["herdr", "agent", "wait", name, "--timeout", str(timeout_ms)],
        capture_output=True,
        text=True,
        timeout=timeout_ms / 1000.0 + 10,
    )
    # wait returns state on stdout when it settles
    return out.stdout.strip()


def herdr_agent_prompt(name: str, text: str, timeout_ms: int = 120_000) -> None:
    subprocess.run(
        ["herdr", "agent", "prompt", name, text, "--wait", "--timeout", str(timeout_ms)],
        capture_output=True,
        text=True,
        timeout=timeout_ms / 1000.0 + 10,
    )


def herdr_agent_read(name: str, lines: int = 120) -> str:
    out = subprocess.run(
        ["herdr", "agent", "read", name, "--source", "recent-unwrapped", "--lines", str(lines)],
        capture_output=True,
        text=True,
        check=True,
        timeout=30,
    )
    return out.stdout


def herdr_agent_get(name: str) -> dict:
    out = subprocess.run(
        ["herdr", "agent", "get", name],
        capture_output=True,
        text=True,
        check=True,
        timeout=30,
    )
    data = json.loads(out.stdout)
    return data.get("result", {})


def herdr_agent_list(workspace_id: str) -> list[dict]:
    out = subprocess.run(
        ["herdr", "agent", "list"],
        capture_output=True,
        text=True,
        check=True,
        timeout=30,
    )
    data = json.loads(out.stdout)
    return [
        a for a in data.get("result", {}).get("agents", [])
        if a.get("workspace_id") == workspace_id
    ]


def herdr_pane_close(pane_id: str) -> None:
    subprocess.run(
        ["herdr", "pane", "close", pane_id],
        capture_output=True,
        text=True,
        timeout=30,
    )


# ---------------------------------------------------------------------------
# Layout
# ---------------------------------------------------------------------------

def _grid_layout(n: int) -> tuple[int, int]:
    if n <= 1:
        return 1, 1
    cols = math.ceil(math.sqrt(n))
    rows = math.ceil(n / cols)
    return rows, cols


def create_audit_layout(workspace_id: str, tab_id: str, n_agents: int, cwd: str) -> list[str]:
    panes = herdr_pane_list(workspace_id)
    root = next(p["pane_id"] for p in panes if p["tab_id"] == tab_id)
    rows, cols = _grid_layout(n_agents)
    grid: list[list[str]] = []
    current = root
    # first row: root + right splits
    first_row = [current]
    for _ in range(1, cols):
        current = herdr_pane_split(current, "right", cwd)
        first_row.append(current)
    grid.append(first_row)
    # subsequent rows: for each column, split the pane above it down
    for _ in range(1, rows):
        row: list[str] = []
        for parent in grid[-1]:
            child = herdr_pane_split(parent, "down", cwd)
            row.append(child)
            if len(grid) * cols + len(row) >= n_agents:
                break
        grid.append(row)
    # flatten first n_agents panes
    flat: list[str] = []
    for row in grid:
        for pid in row:
            flat.append(pid)
            if len(flat) == n_agents:
                break
        if len(flat) == n_agents:
            break
    return flat


# ---------------------------------------------------------------------------
# Spec handling
# ---------------------------------------------------------------------------

def discover_specs(paths: Sequence[str]) -> list[tuple[str, Path, str]]:
    """Return list of (cid, spec_path, title_hint) tuples."""
    results: list[tuple[str, Path, str]] = []
    for raw in paths:
        p = Path(raw)
        if p.is_dir():
            for child in sorted(p.iterdir()):
                if child.is_file() and child.suffix.lower() in {".md", ".txt"}:
                    cid = child.stem
                    results.append((cid, child, child.stem))
        elif p.is_file():
            cid = p.stem
            results.append((cid, p, p.stem))
        else:
            print(f"[WARN] missing spec path: {raw}")
    return results


def read_spec(path: Path) -> str:
    return path.read_text()


# ---------------------------------------------------------------------------
# Launch / monitor
# ---------------------------------------------------------------------------

def launch_fleet(
    specs: list[tuple[str, Path, str]],
    model: str,
    cwd: str,
    dry_run: bool = False,
) -> tuple[str, str, dict[str, str]]:
    label = f"{DEFAULT_LABEL}-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
    print(f"[WORKSPACE] {label}")
    workspace_id = herdr_workspace_create(label)
    tab_id = herdr_tab_create(workspace_id, label)
    pane_ids = create_audit_layout(workspace_id, tab_id, len(specs), cwd)
    mapping: dict[str, str] = {}
    for (cid, path, _), pane_id in zip(specs, pane_ids):
        agent_name = f"audit-{cid}"
        print(f"[START] {agent_name} -> {pane_id}")
        if dry_run:
            mapping[cid] = pane_id
            continue
        herdr_agent_start(agent_name, pane_id, model)
        mapping[cid] = pane_id
    return workspace_id, tab_id, mapping


def wait_fleet(
    specs: list[tuple[str, Path, str]],
    mapping: dict[str, str],
    timeout_ms: int = 120_000,
) -> None:
    for cid, _, _ in specs:
        agent_name = f"audit-{cid}"
        print(f"[WAIT] {agent_name}")
        state = herdr_agent_wait(agent_name, timeout_ms=timeout_ms)
        print(f"[DONE] {agent_name} -> {state}")


def prompt_fleet(
    specs: list[tuple[str, Path, str]],
    mapping: dict[str, str],
    timeout_ms: int = 120_000,
) -> None:
    for cid, path, _ in specs:
        agent_name = f"audit-{cid}"
        text = (
            f"Read the regression audit spec `{path}` and write the report.\n"
            "Constraints:\n"
            "- Do NOT change code.\n"
            "- Do NOT modify files outside your report.\n"
            "- Verify any tool calls succeeded before writing.\n"
            "- Report only real regressions, true bugs, or material config drift.\n"
        )
        print(f"[PROMPT] {agent_name}")
        herdr_agent_prompt(agent_name, text, timeout_ms=timeout_ms)


def watch_agent(cid: str, mapping: dict[str, str], lines: int = 120) -> None:
    agent_name = f"audit-{cid}"
    if agent_name not in mapping:
        sys.exit(f"unknown agent: {agent_name}")
    print(f"[READ] {agent_name}")
    print(herdr_agent_read(agent_name, lines=lines))


def status_fleet(workspace_id: str, mapping: dict[str, str]) -> None:
    agents = {a["agent"]: a for a in herdr_agent_list(workspace_id)}
    print(f"{'CID':<10} {'Agent':<18} {'Status':<12} {'Pane':<12}")
    print("-" * 60)
    for cid, pane_id in mapping.items():
        agent_name = f"audit-{cid}"
        info = agents.get(agent_name, {})
        print(f"{cid:<10} {agent_name:<18} {info.get('agent_status','?'):<12} {pane_id:<12}")


def kill_agent(cid: str, mapping: dict[str, str]) -> None:
    agent_name = f"audit-{cid}"
    if agent_name not in mapping:
        sys.exit(f"unknown agent: {agent_name}")
    info = herdr_agent_get(agent_name)
    print(f"[KILL] {agent_name} state={info.get('agent_status')}")
    herdr_agent_wait(agent_name, timeout_ms=5000)
    herdr_pane_close(mapping[cid])
    print(f"[CLOSED] pane {mapping[cid]}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Herdr-coordinated regression audit fleet")
    parser.add_argument(
        "specs",
        nargs="*",
        default=[DEFAULT_SPECS_DIR],
        help="spec files or directories containing specs",
    )
    parser.add_argument(
        "--model",
        default=DEFAULT_MODEL,
        help=f"OpenCode model pattern (default: {DEFAULT_MODEL})",
    )
    parser.add_argument(
        "--report-dir",
        default=DEFAULT_REPORT_DIR,
        help="where reports should be written",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="show workspace/tab/pane plan without starting agents",
    )
    parser.add_argument(
        "--status",
        action="store_true",
        help="show fleet status",
    )
    parser.add_argument(
        "--watch",
        metavar="CID",
        help="read live output for one audit agent",
    )
    parser.add_argument(
        "--kill",
        metavar="CID",
        help="stop one audit agent and close its pane",
    )
    args = parser.parse_args()

    _require(["herdr", "jq"])

    cwd = os.getcwd()
    specs = discover_specs(args.specs)
    if not specs:
        sys.exit("no specs discovered")

    print(f"[INFO] {len(specs)} audit cluster(s) discovered")

    workspace_id = os.environ.get("HERDR_WORKSPACE_ID", "")
    tab_id = os.environ.get("HERDR_TAB_ID", "")
    mapping: dict[str, str] = {}

    if args.status or args.watch or args.kill:
        if not workspace_id:
            sys.exit("HERDR_WORKSPACE_ID is required for --status/--watch/--kill")
        # rebuild mapping from specs for status display
        for cid, path, _ in specs:
            mapping[cid] = f"<pane-for-{cid}>"

    if args.status:
        status_fleet(workspace_id, mapping)
        return

    if args.watch:
        watch_agent(args.watch, mapping)
        return

    if args.kill:
        kill_agent(args.kill, mapping)
        return

    workspace_id, tab_id, mapping = launch_fleet(specs, args.model, cwd, dry_run=args.dry_run)
    if args.dry_run:
        print(f"[DRY] workspace={workspace_id} tab={tab_id} agents={len(mapping)}")
        return

    try:
        prompt_fleet(specs, mapping)
        wait_fleet(specs, mapping)
    except KeyboardInterrupt:
        print("\n[INTERRUPT] leaving agents running; use --kill <CID> to stop individually")

    print("\n[POST-RUN] live audit panes:")
    status_fleet(workspace_id, mapping)


if __name__ == "__main__":
    main()
