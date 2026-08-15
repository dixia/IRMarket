# IRMarket — Roadmap

> **Status:** Draft — milestones land with the product requirement analysis.

## M0 — Scaffold (done)

- [x] Repo scaffold mirroring Monoracle folder/doc structure
- [x] Mojo (Monad Blitz@北京V2, eventId=15) agent registration + claim

## M1 — Product Requirement Analysis

- [ ] Define exotic option market scope (underlyings: A-share, Labubu, any priced asset)
- [ ] Settlement design on the Monoracle veto-arbitrage primitive
- [ ] Collateral mechanics (bilateral / asymmetric)
- [ ] Fill `requirement.md`, `tech-spec.md`, `product/*`

## M2 — Contracts & tests

- [ ] Implement `contracts/IRMarket.sol` (+ settlement integration)
- [ ] Hardhat test suite

## M3 — Deploy & verify

- [ ] Deploy to Monad testnet (Sourcify verification)

## M4 — Bot & frontend

- [ ] Verification/settlement bot (`bot/verifier.py`)
- [ ] Next.js dapp

## M5 — Mojo submission

- [ ] Screenshots + `POST /api/agent/projects` (eventId=15)