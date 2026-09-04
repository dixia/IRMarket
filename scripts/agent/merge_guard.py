"""Merge-guard: marker presence + artifact conflict advisory for the
IRMarket multi-cluster merge pipeline.

Modes:
    markers                 print the marker table
    check C1 [C2 ...]       grep working tree for every marker of the listed
                            clusters; exit 1 listing absent ones
    conflicts C1 [C2 ...]   read change-<X>.yml artifacts present in the tree
                            for the listed clusters; report functions touched
                            by >= 2 clusters (high-risk hunks)

Run from repo root after each merge round:
    py scripts/agent/merge_guard.py check C B W
"""
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent

MARKERS = {
    "C": [
        "openLong(uint256 marketId, uint256 quoteId)",
        "openShort(uint256 marketId, uint256 quoteId)",
        "vetoUnderpriced(quoteId)",
        "vetoOverpriced(quoteId)",
        "MAX_FEE_BPS",
    ],
    "B": [
        "submit_quote",
        "settle",
        "_rescan_own_quotes",
        "RPC_HTTP_URL",
    ],
    "W": [
        "useTrade",
        "usePositions",
        "formatPrice",
        "NEXT_PUBLIC_MARKET_ADDRESS",
    ],
    "E": [
        "test.describe",
        "page.goto",
        "playwright",
    ],
    "I": [
        "hardhat",
        "forge",
        "deploy.js",
        "deployment.json",
    ],
    "D": [
        "sc-tech-spec",
        "prd.md",
        "ui_copy.md",
    ],
    "A": [
        "gas",
        "immutable",
        "selfdestruct",
        "delegatecall",
    ],
}

MERGE_ORDER = ["A", "I", "D", "E", "W", "B", "C"]


def artifact_path(cid: str) -> Path:
    return REPO_ROOT / "docs" / "audit" / "artifacts" / f"change-{cid}.yml"


def cmd_markers() -> int:
    print(f"merge order: {' -> '.join(MERGE_ORDER)}")
    for cid in MERGE_ORDER:
        print(f"\n[{cid}]")
        for m in MARKERS[cid]:
            print(f"  - {m}")
    return 0


def cmd_check(cids: list[str], root: Path) -> int:
    missing_total = []
    for cid in cids:
        if cid not in MARKERS:
            print(f"[?] unknown cluster id {cid!r}; known: {MERGE_ORDER}")
            continue
        missing = []
        for m in MARKERS[cid]:
            hits = _grep(m, root)
            status = "OK" if hits else "ABSENT"
            if not hits:
                missing.append(m)
                missing_total.append((cid, m))
            print(f"[{cid}] {status:<7} {m}")
        if not missing:
            print(f"[{cid}] all markers green")
        else:
            print(f"[{cid}] !!! {len(missing)} marker(s) ABSENT — possible merge overwrite")
    if missing_total:
        print(f"\nFAIL: {len(missing_total)} marker(s) missing: {missing_total}")
        return 1
    print("\nPASS: all requested markers present")
    return 0


def cmd_conflicts(cids: list[str]) -> int:
    """Report functions touched by >= 2 of the listed clusters (from artifacts)."""
    fn_map: dict[str, set[str]] = {}
    loaded, skipped = [], []
    for cid in cids:
        p = artifact_path(cid)
        if not p.exists():
            skipped.append(cid)
            continue
        loaded.append(cid)
        cur_file = None
        for raw in p.read_text(encoding="utf-8", errors="replace").splitlines():
            line = raw.strip()
            if line.startswith("- path:"):
                cur_file = line.split(":", 1)[1].strip()
            elif line.startswith("- ") and cur_file and (
                "(" in line or line[2:].replace("_", "").isidentifier()
            ):
                name = line[2:].strip().rstrip(",")
                if name and not name.startswith(("change_type", "impact_level", "functions")):
                    fn_map.setdefault(name, set()).add(cid)
    if skipped:
        print(f"[!] artifacts not found (not merged yet?): {skipped}")
    risky = {k: v for k, v in fn_map.items() if len(v) >= 2}
    if not risky:
        print("no function-level overlap detected among provided clusters")
        return 0
    print("functions touched by multiple merged clusters — HIGH-RISK hunks:")
    for fn, who in sorted(risky.items(), key=lambda kv: -len(kv[1])):
        print(f"  {fn}: {sorted(who)}")
    return 0


def _grep(needle: str, root: Path) -> bool:
    """Cheap recursive text search over contracts/ bot/ web/ scripts/ docs/."""
    for sub in ("contracts", "bot", "web", "scripts", "docs"):
        base = root / sub
        if not base.exists():
            continue
        for p in base.rglob("*"):
            if p == Path(__file__).resolve():
                continue
            if p.suffix not in (".py", ".md", ".ini", ".sh", ".sol", ".ts", ".tsx", ".json") or not p.is_file():
                continue
            try:
                if needle in p.read_text(encoding="utf-8", errors="ignore"):
                    return True
            except OSError:
                continue
    return False


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2
    root = REPO_ROOT
    rest = argv[1:]
    if rest and rest[0] == "--root":
        root = Path(rest[1]).resolve()
        rest = rest[2:]
    mode = rest[0] if rest else ""
    args = rest[1:]
    if mode == "markers":
        return cmd_markers()
    if mode == "check":
        if not args:
            print("usage: merge_guard.py [--root PATH] check <cid> [cid...]"); return 2
        return cmd_check([a.upper() for a in args], root)
    if mode == "conflicts":
        if not args:
            print("usage: merge_guard.py conflicts <cid> [cid...]"); return 2
        return cmd_conflicts([a.upper() for a in args])
    print(f"unknown mode {mode!r}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
