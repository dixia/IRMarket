#!/usr/bin/env python
"""Pre-flight health gate for IRMarket testnet live runs.

Checks:
  - Monad RPC reachable
  - Bot wallet has MON balance
  - Contract addresses are deployed (have code)
  - No stale verifier process running

Usage:
  python scripts/ops/check_health.py --env-file bot/.env
"""
import argparse
import os
import sys
from pathlib import Path

try:
    from dotenv import load_dotenv
except ImportError:
    load_dotenv = None

try:
    from web3 import Web3
except ImportError:
    Web3 = None


DEFAULT_ENV_FILE = "bot/.env"
DEFAULT_RPC_URL = "https://rpc-testnet.monadinfra.com"
DEFAULT_MARKET_ADDRESS = "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512"
DEFAULT_ORACLE_ADDRESS = "0x5fbdb2315678afecb367f032d93f642f64180aa3"
MIN_MON_BALANCE = 0.1  # MON


def load_env(env_file: str):
    if load_dotenv is None:
        print("[WARN] python-dotenv not installed; reading env file manually")
        vals = {}
        for line in Path(env_file).read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                k, v = line.split("=", 1)
                vals[k.strip()] = v.strip().strip('"').strip("'")
        return vals
    load_dotenv(env_file, override=True)
    return {k: v for k, v in os.environ.items()}


def check_rpc(rpc_url: str) -> bool:
    if Web3 is None:
        print("[skip] web3.py not installed; cannot verify RPC")
        return True
    try:
        w3 = Web3(Web3.HTTPProvider(rpc_url, request_timeout=10))
        chain_id = w3.eth.chain_id
        print(f"[rpc] chain_id={chain_id} provider={rpc_url}")
        return chain_id == 10143
    except Exception as exc:
        print(f"[rpc] FAIL: {exc}")
        return False


def check_wallet(env: dict) -> bool:
    pk = env.get("PRIVATE_KEY", "")
    if not pk or "your_private_key" in pk:
        print("[wallet] PRIVATE_KEY not set or placeholder")
        return False
    if Web3 is None:
        print("[skip] web3.py not installed; cannot verify wallet")
        return True
    try:
        w3 = Web3(Web3.HTTPProvider(env.get("RPC_HTTP_URL", DEFAULT_RPC_URL)))
        acct = w3.eth.account.from_key(pk)
        bal = w3.from_wei(w3.eth.get_balance(acct.address), "ether")
        print(f"[wallet] address={acct.address} balance={bal:.4f} MON")
        return float(bal) >= MIN_MON_BALANCE
    except Exception as exc:
        print(f"[wallet] FAIL: {exc}")
        return False


def check_contracts(env: dict) -> bool:
    market = env.get("MARKET_ADDRESS", DEFAULT_MARKET_ADDRESS)
    oracle = env.get("ORACLE_ADDRESS", DEFAULT_ORACLE_ADDRESS)
    if Web3 is None:
        print("[skip] web3.py not installed; cannot verify contracts")
        return True
    try:
        w3 = Web3(Web3.HTTPProvider(env.get("RPC_HTTP_URL", DEFAULT_RPC_URL)))
        ok = True
        for name, addr in [("MARKET", market), ("ORACLE", oracle)]:
            code = w3.eth.get_code(Web3.to_checksum_address(addr))
            if len(code) == 0:
                print(f"[contract] FAIL: {name} {addr} has no code")
                ok = False
            else:
                print(f"[contract] OK: {name} {addr} ({len(code)} bytes)")
        return ok
    except Exception as exc:
        print(f"[contract] FAIL: {exc}")
        return False


def check_process() -> bool:
    import platform
    import subprocess
    if platform.system() != "Linux":
        return True
    try:
        r = subprocess.run(
            ["pgrep", "-f", "bot/verifier.py"],
            capture_output=True, timeout=10,
        )
        if r.returncode == 0:
            print("[process] WARN: verifier bot already running")
            return False
        print("[process] OK: no stale verifier process")
        return True
    except Exception as exc:
        print(f"[process] skip: {exc}")
        return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--env-file", default=DEFAULT_ENV_FILE)
    args = parser.parse_args()

    print("=" * 60)
    print("IRMarket TESTNET HEALTH CHECK")
    print("=" * 60)

    env = load_env(args.env_file)
    rpc = env.get("RPC_HTTP_URL", DEFAULT_RPC_URL)

    ok = True
    ok &= check_rpc(rpc)
    ok &= check_wallet(env)
    ok &= check_contracts(env)
    ok &= check_process()

    print("-" * 60)
    if ok:
        print("STATUS: HEALTHY")
        return 0
    print("STATUS: FAILED — fix issues above before running live")
    return 1


if __name__ == "__main__":
    sys.exit(main())
