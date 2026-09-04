#!/usr/bin/env python
"""Consolidated run-analysis for IRMarket verifier bot logs.

Subcommands:
    verdict <log>            fills/vetoes/quotes/errors + runtime summary
    errors <log>             full ERROR / exception lines
    check --env-file FILE    pre-run gate (wallet / contracts / RPC)

Usage:
    python scripts/ops/analyze_run.py verdict irmarket_run.log
    python scripts/ops/analyze_run.py errors   irmarket_run.log
    python scripts/ops/analyze_run.py check    --env-file bot/.env
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Dict, List


LOG = Path(__file__).resolve().parent.parent / "irmarket_run.log"
VETO_RE = re.compile(r"veto", re.IGNORECASE)
QUOTE_RE = re.compile(r"submitQuote|restockQuote|settleQuote", re.IGNORECASE)
ERROR_RE = re.compile(r"ERROR|Exception|Traceback|failed", re.IGNORECASE)
ITER_RE = re.compile(r"Iteration|loop|tick", re.IGNORECASE)
TS_RE = re.compile(r"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})")


def _read_lines(path: str) -> List[str]:
    try:
        return Path(path).read_text(errors="ignore").splitlines()
    except OSError:
        return []


def _first_ts(lines: List[str]) -> str | None:
    for line in lines:
        m = TS_RE.search(line)
        if m:
            return m.group(1)
    return None


def _last_ts(lines: List[str]) -> str | None:
    for line in reversed(lines):
        m = TS_RE.search(line)
        if m:
            return m.group(1)
    return None


def _duration_h(first: str | None, last: str | None) -> float:
    if not first or not last:
        return 0.0
    try:
        a = datetime.fromisoformat(first.replace("Z", "+00:00"))
        b = datetime.fromisoformat(last.replace("Z", "+00:00"))
        return max((b - a).total_seconds() / 3600.0, 1e-9)
    except Exception:
        return 0.0


def verdict(path: str, since: str = "", until: str = "") -> None:
    lines = _read_lines(path)
    if since:
        lines = [l for l in lines if _ts_after(l, since)]
    if until:
        lines = [l for l in lines if _ts_before(l, until)]

    vetoes = [l for l in lines if VETO_RE.search(l)]
    quotes = [l for l in lines if QUOTE_RE.search(l)]
    errors = [l for l in lines if ERROR_RE.search(l)]
    iters = [l for l in lines if ITER_RE.search(l)]

    first = _first_ts(lines)
    last = _last_ts(lines)
    dur = _duration_h(first, last)

    print(f"log:         {path}")
    print(f"lines:       {len(lines)}")
    print(f"duration_h:  {dur:.2f}")
    print(f"iterations:  {len(iters)}")
    print(f"quotes:      {len(quotes)}")
    print(f"vetoes:      {len(vetoes)}")
    print(f"errors:      {len(errors)}")
    if errors:
        print("\nERROR LINES:")
        for l in errors[-10:]:
            print(f"  {l[:200]}")


def errors(path: str, since: str = "", until: str = "") -> None:
    lines = _read_lines(path)
    if since:
        lines = [l for l in lines if _ts_after(l, since)]
    if until:
        lines = [l for l in lines if _ts_before(l, until)]

    err_lines = [l for l in lines if ERROR_RE.search(l)]
    print(f"ERRORS ({len(err_lines)} lines)")
    for l in err_lines:
        print(l[:300])


def check(env_file: str, min_mon: float = 0.1) -> int:
    try:
        import sys
        from pathlib import Path
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))
        from scripts.ops.check_health import load_env, check_rpc, check_wallet, check_contracts
    except ImportError:
        print("[check] cannot import check_health; run it directly")
        return 2

    env = load_env(env_file)
    rpc = env.get("RPC_HTTP_URL", "https://rpc-testnet.monadinfra.com")

    ok = True
    ok &= check_rpc(rpc)
    ok &= check_wallet(env)
    ok &= check_contracts(env)

    return 0 if ok else 1


def _ts_after(line: str, since: str) -> bool:
    m = TS_RE.search(line)
    return bool(m and m.group(1) >= since)


def _ts_before(line: str, until: str) -> bool:
    m = TS_RE.search(line)
    return bool(m and m.group(1) <= until)


def main():
    parser = argparse.ArgumentParser(description="IRMarket run analysis")
    parser.add_argument("cmd", choices=["verdict", "errors", "check"])
    parser.add_argument("path", nargs="?", default=str(LOG))
    parser.add_argument("--since", default="")
    parser.add_argument("--until", default="")
    parser.add_argument("--env-file", default="bot/.env")
    args = parser.parse_args()

    if args.cmd == "verdict":
        verdict(args.path, args.since, args.until)
    elif args.cmd == "errors":
        errors(args.path, args.since, args.until)
    elif args.cmd == "check":
        sys.exit(check(args.env_file))


if __name__ == "__main__":
    main()
