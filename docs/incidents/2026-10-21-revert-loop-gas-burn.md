# Incident: revert-retry loop burned ~270 MON (2026-10-21 → 2026-10-22)

**Status:** fixed (`perf(bot): guard sends against revert loops and an empty wallet`, PR #44
+ the circuit breaker / budget follow-up).
**Severity:** funds (testnet) + market-making outage.
**Trigger:** an operator-funded top-up being consumed by paid no-op transactions.

---

## 1. Summary

Between 2026-10-21 15:12 UTC and 2026-10-22 08:22 UTC the bot wallet
`0x5ceF21c2977470Fa4fBa3C6b87203268003Ef498` went from **404.22 MON to 134.42 MON**
(−269.8 MON, ~15.9 MON/h). The bot was submitting `withdrawProviderFunds` against the
**pre-lazy** Monoracle (`0x807321100748d75a618e508de214123CB77C9f4D`) on every loop, and
every one of those transactions **reverted** (`status = 0`) while still being charged the
full gas limit (129,367 gas ≈ **0.0132 MON**). Monad bills the **gas limit**, so a mined
revert is a paid no-op — the loop produced nothing and cost everything.

## 2. Timeline (UTC)

| when | event |
|---|---|
| 2026-10-19 | production wrapper `0x3B08bd1C…` deployed; bot running against the pre-lazy oracle |
| 2026-10-21 15:12 | **+400 MON** deposit into the bot wallet (tx `0x4e3419f3…` from `0x075Bbc05…`), balance 4.21 → 404.22 |
| 2026-10-21 15:12 → 10-22 08:22 | the loop runs: balance 404.22 → 134.42 (−269.8 MON in 17.1 h ≈ 15.9 MON/h) |
| 2026-10-22 08:22 → 10-24 23:33 | steady-state burn resumes: ~2 MON/h (normal quoting), 134.42 → 4.67 |
| 2026-10-25 06:47 | balance exhausted; log becomes `Signer had insufficient balance` on all 7 pairs |
| 2026-10-25 12:16 | balance 0.000135 MON — market-making fully down |
| 2026-10-26 04:17 | temporary 1.8 MON top-up; bot resumes |
| 2026-10-26 04:17 → 05:36 | normal burn ~1.4 MON/h consumes the top-up (unrelated to this incident) |

Down time from funding exhaustion to the top-up: **≈ 21.5 h**. During it the site served
expired markets (no quotes, no round rolls).

## 3. Evidence

Balance curve (sampled `eth_getBalance` at historical blocks):

```
2026-10-21 15:12   404.22   ← +400 MON deposit
2026-10-21 19:47   390.95
2026-10-22 08:22   134.42   ← the loop (269.8 MON in 17 h)
2026-10-22 20:59   102.51
2026-10-23 09:34    79.39
2026-10-23 22:09    56.92
2026-10-24 10:50    29.60
2026-10-24 23:33     4.67
2026-10-25 12:16     0.000135
```

Sampled transactions from the loop window (dense scan, e.g. blocks 73,099,000–73,099,500):

```
to 0x8073211007…  sel 0x245d254f (withdrawProviderFunds(uint256))
gasLimit 129,367  status 0 (reverted)  gasUsed 129,367  gasPrice 102 gwei  = 0.0132 MON
```

All sampled bot transactions in that window were the same call to the same (pre-lazy)
oracle, all reverting. A block-sampled extrapolation puts the loop at tens of thousands of
transactions; the census is **partial** (RPC sampling, not a full index) — the balance curve
is the authoritative figure.

## 4. Root cause

1. **Pre-lazy withdraw semantics.** On the old oracle a quote had to be settled before it
   could be withdrawn; the bot attempted the withdraw anyway and the oracle reverted.
2. **Retry on every loop.** Any exception from a send was logged as
   `step failed (will retry)` and retried on the next iteration (~5 s), with no memory of
   the previous failure.
3. **Monad bills the gas limit.** A mined revert costs the full limit, so a "failed" send
   is indistinguishable from a successful one on the balance curve — the loop was *paid*.
4. **No spend accounting or alerting.** The only signal was a generic WARNING line, mixed
   in with genuine transient RPC noise. Nothing measured MON/h, nothing stopped the loop.

## 5. Fix

`bot/verifier.py` `_send` now has layered guards (see the gas section of
`docs/sc-tech-spec.md` §7 and `bot/.env.example`):

| layer | env | effect |
|---|---|---|
| pre-flight simulation | `PREFLIGHT_SIMULATE`, `PREFLIGHT_WARN_EVERY_S` | `eth_call` the exact tx first: a permanent failure costs one free RPC, not a paid revert (skipped in the near-expiry band) |
| revert backoff | `REVERT_BACKOFF_*` | same label skipped for 5 s → 300 s after 2 reverts; the MON already spent on the label is logged |
| circuit breaker | `MAX_CONSECUTIVE_REVERTS`, `POISON_COOLDOWN_S` | label parked after 5 reverts (ERROR), so a capped backoff cannot leak one attempt per window forever |
| spend budget | `MAX_MON_PER_HOUR`, `MAX_MON_PER_DAY` | rolling ledger (`gas × gasPrice`); nothing is sent once a cap is hit |
| balance floor | `MIN_BALANCE_TX_MULT` | send skipped + warning naming the wallet to fund, instead of failing at the RPC |
| durable state | `GUARD_STATE_FILE` | breaker + ledger persist, so a systemd restart cannot reset a tripped stop |
| meter | `SPEND_LOG_EVERY_S` | `MON/h`, `MON/day`, balance, runway in the log |

Unrelated but adjacent: the lazy-settlement cutover (#33) removed the settle checkpoint for
trading quotes (#43), which cut the per-round bill by ~7 × 72,956 gas.

## 6. Residual risk

- A revert that is *only* fixed by operator action is now parked, not retried; the
  collateral behind that quote stays stranded until someone withdraws it manually.
- The spend budget is per process; a restart resets the hour/day window (the persisted
  ledger mitigates this, but the window math is time-based).
- No push alerting: everything is in `run.err.log`. A webhook is a follow-up if the bot
  runs unattended for longer stretches.

## 7. Prevention checklist for future deploys

1. Fund the bot wallet with a **documented budget** (MON/day) and keep `MAX_MON_PER_*`
   below what the balance can sustain for ≥ 2 days.
2. Watch the `spend:` meter line; a jump from ~1 MON/h to > 3 MON/h means a loop.
3. Grep the log for `CIRCUIT BREAKER`, `BUDGET EXCEEDED`, `backing off` after any deploy.
4. Never deploy against an oracle whose semantics the bot has not been reconciled with —
   the pre-lazy → lazy cutover is the class of change that produced this incident.
