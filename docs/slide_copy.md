# slide_copy.md — IRMarket Pitch Deck (中文版 5 页)

---

## PAGE 1 — 封面

**Irrational Market**

任何有价格的资产都能交易期权。可以做空 H/A 股、做空 Labubu、做空任何有价格的东西。

团队：Who Killed Jeffrey

---

## PAGE 2 — 为什么需要做空

**不能做空的市场，只会奖励不理性。**

- 一个只能做多的市场，本质上是在惩罚理性
- You have to be irrationally rational
- 做空是价格发现的核心——它让理性的人有机会做对的事
- 举个例子：A 股没有便捷的做空渠道，泡沫来了，看空的人只能看着，没法用行动表达判断

---

## PAGE 3 — 我们做了什么

**Irrational Market - Monad 上的免许可低门槛期权市场。**

- 任何资产都能开市场 —— A 股、Labubu，只要有价格，任何人都能发
- 看涨/看跌 —— 投入 USD 立刻拿到仓位，最大亏损就是本金，不会爆仓、不会追缴
- 可以做空任何东西 —— 包括 A 股这种在别处根本没法空的
- 低门槛 —— 默认 3 分钟到期，期限灵活

结算价全部在链上完成，不需要链下预言机，也不需要信任任何节点。

---

## PAGE 4 — Demo

**Demo**

已上线 Monad，任何有价格的资产都能交易期权

线上地址：irmarket.xyz

---

## PAGE 5 — Misprice Flow

**Misprice Flow**

Monoracle 错误定价套利机制流程图：
- Price Provider 报价 LLM/USD=1/100，抵押 2 LLM & 200 USD
- Verifier 验证发现价格过高（实际应为 1/80）
- 套利者在二级市场用 160 USD 买入 2 LLM
- 与智能合约交互：用 2 LLM 换回 200 USD，净利润 40 USD
- Price Provider 被惩罚，只能取回 4 LLM & 0 USD
