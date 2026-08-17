# IRMarket 产品需求与UI设计全文档（V0.8.1 Veto-Market 架构版）

> 本文档合并产品需求规格（PRD）与UI交互流程（UI Flow），用于整体逻辑评审、链路校验与落地对齐。
>
> **V0.8 变更说明**：按用户对 Monoracle 机制的深度澄清，**推翻了 V0.6/V0.7 的"IRMarket 自有资金池 + 线性合约"模型**，重构为 **Veto-Market 架构**：交易层 = Monoracle 报价否决流本身（"看多/看跌 = price verification 套利"），IRMarket 退化为薄层（市场工厂 / 持仓索引 / 费用包裹，demo 可省）。
>
> **V0.8.1 变更说明**：否决窗口对齐期权到期日（D-13）——引入自部署的 **MonoracleWindowed 分叉合约**（`contracts/MonoracleWindowed.sol`，派生自 `github.com/dixia/monoracle`，用户批准的唯一破例）；市场去重取消（D-14）、wrapper 不限制报价来源（D-15）、手续费统一按 HKD 计（D-16）。

## 阅读约定

| 标记 | 含义 |
|------|------|
| ⚠️ | **认知修正**：原文与 Monoracle 实际机制不符，已按合约源码纠正 |
| 🔁 | **复用 Monoracle**：该能力 Monoracle 已实现，IRMarket 直接调用，无需自研 |
| ✅ | **已确认决策**：由用户拍板（见 §八 决策记录） |
| 🚧 | **卡点**：当前方案存在设计缺口，需要落地前解决 |
| ❓ | **待确认**：需求表述有歧义，需与用户确认后才可进入开发 |
| 〔v0.7〕〔v0.8〕 | 标注修改版本，可追溯至修订记录表 |

## 修订记录

### V0.7 → V0.8（Veto-Market 架构重构）

| # | 位置 | 修改 | 原因 |
|---|------|------|------|
| R9 | §〇/§二 | 核心架构重构：**交易 = 对 bot 报价的否决套利**；看多 = `vetoUnderpriced`（付 HKD 得 LLM），看跌 = `vetoOverpriced`（付 LLM 得 HKD） | 用户澄清："看多 看空直接是一个 price verification 过程（套利）"；原"方向≠veto"的修正本身是错的 |
| R10 | §二/§八 | **删除 IRMarket 自有资金池模型**（D-03 原案）：PNL 在 veto 交易内完成资产转换，零和、由 bot 双边抵押全额承接；"池不足"问题不存在 | 用户："结算的价格并不需要实际要进行资产的转换，转换过程中只对某种价格报价arb过程中已经完成了"；"这是一个不存在的问题" |
| R11 | §三/§五 | **删除"结算/领取"链路**：到期 = bot 最终报价定标（D-06），UI 只做估值展示；用户资产已在钱包，无领取动作 | 用户 Q4："No need" |
| R12 | §〇/§六 | 市场定义：**每个 Monoracle 报价对（base, quote）= 一个市场**；createMarket = 新建报价对并启动 bot 报价 | 用户 Q6："每个 oracle 可报价价格，其实是不同的市场"；须以 Monoracle 合约结构规划 |
| R13 | §一 | 标的：改用**真实 ticker 06658.HK（HKG:6658）**，bot 接真实行情源；"溜溜梅/LLM"仅作 demo 叙事（公开资料 06658 对应锅圈食品，如需换叙事另议） | 用户 Q5 选 B 真实 ticker |
| R14 | §二 | 手续费：Q3 选 A（显式扣费）与"钱包直接操作 Monoracle"存在张力——Monoracle 内无扣费位；改为**IRMarket 包裹层入口扣 1%**（demo 或选无手续费），待 Q7 拍板 | 费用无法嵌入报价价差（会被套利者否决吃掉） |
| R15 | §四 | IRMarket 合约角色重定位：Monoracle 全责交易与结算；IRMarket 仅工厂/持仓索引/费用包裹（demo 可省） | 用户："这些钱包在直接操作 monoracle 的合约，是同一个智能合约" |

### V0.6 → V0.7（Deep Review）

| # | 位置 | 修改 | 原因 |
|---|------|------|------|
| R1 | §〇 | "预言家"→预言机；新增能力归属表 | 语音转写术语错误；明确不重复造轮子边界 |
| R2 | §〇 | Monoracle 抵押品托管在 Monoracle 内，IRMarket 无法动用（注：V0.8 架构下该问题消失，交易直接在 Monoracle 内完成） | 修正资金池模型误解 |
| R3 | §二/§八 | 平仓对手方改述（V0.7 版；V0.8 已按 veto 流重写） | 原文技术上不可行 |
| R4 | §二 | 手续费两种模型矛盾标出（V0.8 收敛为包裹扣费，Q7） | 同一笔费不可能既是隐式又是显式 |
| R5 | §五 | 到期 UI 对齐自动结算（V0.8 进一步删除领取） | 与 D-04 矛盾 |
| R6 | §三/§四 | 池注入/余额校验（V0.8 已删除——无池） | 资金来源缺失 |
| R7 | §二 | "做多/做空"为线性合约语义简称 | 术语歧义 |
| R8 | §一 | 标的真实性核实 | 事实性风险 |

### V0.8 → V0.8.1（窗口对齐到期 + 分叉）

| # | 位置 | 修改 | 原因 |
|---|------|------|------|
| R16 | 全文 | 否决窗口：2-slot 固定窗口 → **quote 级 `expiryBlock` = 期权到期日**；引入自部署分叉合约 `contracts/MonoracleWindowed.sol` | 用户 B8："放大否决窗口。窗口对齐期权到期日（本质上是一样的）"；人工签名延迟问题消失 |
| R17 | §四/§八 | 市场注册取消去重：同标的多市场并存（不同到期/费率） | 用户 B9："一个资产可以有不同的期权，到期了再上新的，标的是一样的" |
| R18 | §四 | wrapper 不限制报价来源（任何 provider 的报价可 veto，费用仍归注册 MM） | 用户 B10 选 b |
| R19 | §二/§四 | 手续费统一按 HKD（quote）计：`feeBps × quoteAmount / 10000`；看涨加在付入端、看跌从收付出扣 | 用户 B11："按 quote 收取更好理解" |

---

## 〇、Monoracle 机制速览（认知基线）

> 以下为 Monoracle 合约源码（`github.com/dixia/monoracle` → `contracts/Monoracle.sol`）+ tech-spec 中的真实行为。PRD 中涉及 Monoracle 的一切表述都以此为准。
> 〔v0.8.1 R16〕IRMarket 实际交易场所是**自部署的分叉合约 `MonoracleWindowed`**（唯一改动：每笔报价带 `expiryBlock`，否决窗口 = 期权到期日，D-13）。除窗口外，机制与上游完全一致。

Monoracle 是一个"**报价 + 免许可否决仲裁**"的链上价格市场，**没有链下数据源、没有多节点共识**：

1. **报价（quote）**：provider 调用 `submitQuote(base, quote, baseAmount, quoteAmount, expiryBlock)`，同时质押**两种** ERC20（标的 base + 计价 quote），确定对价：
   `price = quoteAmount × 1e18 / baseAmount`（即 1 单位标的 = 多少 quote，如 1 LLM = 若干 HKD）。
   报价 = 以价格 P **双向承诺对手交易**：provider 等于同时挂了"按 P 卖 base"与"按 P 买 base"两个盘。
2. **验证窗口 = 期权到期日**（✅ D-13，〔v0.8.1 R16〕）：报价在 `expiryBlock` 前（含）始终 `ACTIVE` 可被否决；到期后才可 settle。上游固定 2-slot（≈600ms）窗口已由分叉替换——否决挑战期与期权期限是同一回事。
3. **否决仲裁（veto）——这就是交易本身**：
   - `vetoUnderpriced(quoteId)`：否决者**支付 quoteAmount，收走 baseAmount**。语义 = 认为标的被报低了 → **按 P 买入标的（做多）**。
   - `vetoOverpriced(quoteId)`：否决者**支付 baseAmount，收走 quoteAmount**。语义 = 认为标的被报高了 → **按 P 卖出标的（做空）**。
   - 被否决的报价作废（`VETOED_*`），不进价格源；否决者收到的资产**当场到账**，无需二次结算。
4. **provider 后果（零和）**：被否决后 provider 取回**另一侧 2 倍**——
   - 被 underpriced 否决：provider 失去 base、留 2×quote（等于以 P 把 base 卖给了否决者）；
   - 被 overpriced 否决：provider 失去 quote、留 2×base（等于以 P 从否决者手里买了 base）。
   - 按真实价 T 计价：**否决者盈利 = provider 亏损 = |T − P| × baseAmount**。系统永远全额偿付（`Q2 不存在资不抵债`）。
5. **结算（settle）**：到期前无人否决，任何人（免许可）在 `expiryBlock` 后调 `settleValidQuote`，报价成为该资产对的 **canonical 有效价格**（`latestValidQuoteId`）。**结算顺序**：旧报价先结算、**bot 最终报价最后结算**（保证 canonical = 终价，B12）。
6. **提取（withdraw）**：provider 事后 `withdrawProviderFunds` 回收（有效报价原额；被否决按第 4 条取回）。
7. **读取**：`getLatestPrice(base, quote)` → `(price, settledSlot, exists)`；永久审计读 `quotes(quoteId)`。

### 能力归属（🔁）

| 能力 | 由谁提供 | 说明 |
|------|----------|------|
| 报价提交 / 账本 / 事件 | 🔁 MonoracleWindowed（IRMarket 自部署分叉，D-13） | `submitQuote(..., expiryBlock)` + `quotes` + 5 个 indexed 事件 |
| **多空交易撮合** | 🔁 MonoracleWindowed | veto 流 = 用户以报价价格与 provider 换手 |
| **盈亏资产交割** | 🔁 MonoracleWindowed | veto 交易内当场换手，无后续结算动作 |
| 验证窗口 / 仲裁 | 🔁 MonoracleWindowed | **窗口 = 期权到期日**（quote 级 `expiryBlock`）；免许可 |
| 有效价结算 / 读取 | 🔁 MonoracleWindowed | `settleValidQuote` / `getLatestPrice` |
| 市场注册 / 工厂 | IRMarket 薄层 | createMarket 工厂；**同标的多市场并存，不去重**（D-14） |
| 持仓索引 / UI 估值 | IRMarket 薄层 + 前端 | 监听 veto 事件 → 持仓记录；轮中按 ACTIVE 报价、到期按 `getLatestPrice` 估值（B12） |
| 手续费（1%，HKD） | IRMarket 包裹层 | Monoracle 内无扣费位（见 R14/D-16） |

> ⚠️〔v0.7 R1〕"预言机"原文误作"预言家"。
> ⚠️〔v0.8 R9〕**修正 V0.6/V0.7 的"方向≠veto"结论**：IRMarket 的交易方向**正是** veto 的两个方向。此前将其判定为"机制误解"是错误结论，已在 V0.8 整体翻转。

---

## 一、产品概述

### 1.1 产品定位

IRMarket 是部署在 Monad 区块链上的**奇异标的链上多空市场**：任何有公开价格的资产（A 股/港股现货、Labubu 等）都可以成为交易标的。底层直接复用 **Monoracle 否决-套利原语**——bot 持续对标的报价，用户以「看涨/看跌」直接参与价格验证（否决套利），盈亏在套利换手中当场实现。全程无链下预言机、无中心化结算节点、无资金池。

产品UI对标轻量化预测市场：用户只需对标的价格方向做判断，界面把 `vetoUnderpriced` / `vetoOverpriced` 包装成「看涨开仓」「看跌开仓」按钮。

### 1.2 示例标的定义（Demo 阶段）

| 项目 | 详情 |
|------|------|
| 标的代码 | **06658.HK（HKG:6658，真实港股代码**〔v0.8 R13〕） |
| 交易简称 | 溜溜梅（LLM）——**已最终确认，不再变更**（✅ D-12） |
| 行情源 | bot 拉取 06658.HK 真实市场行情（如第三方行情 API），据此报价 |
| 选用价值 | 验证"任意有公开价格的资产（含非加密资产）均可上链做多空"，降低用户认知门槛 |

### 1.3 核心特性

1. **去信任结算**：价格可信度由 Monoracle 双边抵押 + 免许可否决仲裁保证；盈亏在否决套利交易内当场完成资产换手（🔁 原生机制）
2. **零和全抵押**：用户盈利 = provider 抵押品亏损（`|T−P|×size`），系统内不存在资不抵债（✅ D-10）
3. **有限风险**：用户最大亏损 = 单次 veto 投入的本金（+手续费），无爆仓、无追缴
4. **随时平仓**：反向 veto 即平仓（bot 持续报价提供双向流动性）
5. **高性能底层**：Monad 300ms 出块；否决窗口 = 期权到期日（✅ D-13，无秒级交易竞争）
6. **极简交互**：卡片式 UI，"看涨/看跌"两个按钮背后即两个 veto 方向

### 1.4 项目当前状态

- 脚手架完成；`contracts/MonoracleWindowed.sol` 分叉合约已就位（唯一改动：quote 级 `expiryBlock` 窗口，D-13）+ 6 个窗口测试通过；`abi/Monoracle.abi.json` 已由分叉构建重新生成
- V0.8.1 架构已由用户确认（D-07~D-16）
- Demo 进入开发准备阶段

---

## 二、核心业务规则

### 2.1 产品基础属性

- **产品类型**：Monoracle 否决-套利多空市场（线性差价 PNL：`PNL = (终价 − 开仓价) × 份数`，方向相关）。〔v0.7 R7〕"看涨（做多）/ 看跌（做空）"是 veto 方向的用户化别名，非标准期权术语
- **交易方向**（✅ D-08，〔v0.8 R9〕）：
  - **看涨开仓 = `vetoUnderpriced`**：用户付 HKD，收 LLM → 做多 LLM
  - **看跌开仓 = `vetoOverpriced`**：用户付 LLM，收 HKD → 做空 LLM
  - 用户钱包**直接调用 MonoracleWindowed 合约**（与报价/结算同一个合约，〔v0.8 R15〕；或经 IRMarket 包裹层扣费，D-11）
- **期限**：Demo 默认 **3 分钟**（✅ D-01，≈600 blocks）；UI 保留多期限选择。**期限即报价的 `expiryBlock`**（✅ D-13）：否决挑战期 = 期权期限，到期定标（bot 最终报价）+ UI 倒计时
- **结算资产**：测试币 `HKD`（计价）/ `LLM`（标的），MockERC20 自铸（Monad 测试网无官方币）；报价对 = `(base=LLM, quote=HKD)`，价格 = HKD/LLM
- **风险机制**：无爆仓、无追缴、无强平；最大亏损 = 投入本金。⚠️ 期权/杠杆术语已弃用，即"以 P 价格换手后承担标的涨跌"的现货式敞口
- **价格基准**：全部盈亏以 `getLatestPrice` 为准（开仓价 = 被否决报价的 price；终价 = 到期 bot 最终报价，✅ D-06）
- **开市权**：任何人为任意资产对建市（✅ D-07：报价对 = 市场；与 Polymarket 平台审理制不同，Monoracle 天然支持任意配对）

### 2.2 报价与手续费规则

> 🔁 **bot（provider）= 做市商**：抓取 06658.HK 真实行情 → 以公平价 P 持续 `submitQuote`（双边质押）。bot 的报价 = 市场的双向流动性，用户任何时刻对任意 ACTIVE 报价 veto 即成交。

1. **定价锚点**：bot 报价严格锚定真实市场价 P（否则被套利者否决、损失 `|T−P|×size`——这是 Monoracle 原生约束，bot 无需自研风控）
2. **手续费（✅ D-11/D-16，已拍板：方案 1 包裹扣费，统一 HKD）**：〔v0.8 R14〕交易经 **IRMarket 包裹层入口**，进 veto 前按名义额**显式扣除 1%** 至做市商地址（`feeBps × quoteAmount / 10000`，HKD 计）：看涨加在付入端、看跌从收付出扣。费用**不**嵌入报价价差（任何系统性偏离公平价都会被否决套利瞬间吃掉）
3. **收益归属**：1% 手续费归 bot/做市商；bot 的对赌盈亏 = 用户盈亏的镜像
4. **用户感知**：UI 明确展示"将以报价 P 与做市商换手 + 手续费 1%"（显式展示，不做隐性价差）

### 2.3 交易与平仓规则

- **开仓 = veto**：用户选方向 → 前端默认选定**最新 ACTIVE 报价**（成交规模 = 该报价全额，veto 无部分填充，B4；〔v0.9 同步〕）→ 用户签名 veto 交易（`vetoUnderpriced`/`vetoOverpriced`）→ 资产当场换手（付一侧、收一侧）→ 生成持仓（= 收到的资产）
  - 前置：用户需持有并授权（approve Monoracle）对应资产（看涨需 HKD；看跌需 LLM）；Demo 由 faucet/铸币脚本发放
- **平仓 = 反向 veto**（✅ D-08）：
  - 看涨持仓（持有 LLM）→ 对后续 bot 报价执行 `vetoOverpriced` → 付 LLM 收回 HKD
  - 看跌持仓（持有 HKD）→ 执行 `vetoUnderpriced` → 付 HKD 收回 LLM
  - bot 持续报价即持续提供双向平仓流动性
- **报价可用性**：报价在 `expiryBlock` 前**全程可 veto**（✅ D-13，无 600ms 窗口竞争）；bot 报价被否决后**立即补报**（restocking），保持市场始终有可交易报价；bot 停报/抵押耗尽 = 市场自然停牌（✅ D-10，非资不抵债）。前端需展示"可交易报价/无可用报价"状态（🚧 B4 降级）
- **成交价锚定**：用户对**具体 quoteId** 的报价价 P 成交，无滑点（所见即所成交）；但报价会随 bot 新报更新（B4 备注）

### 2.4 结算规则（✅ D-09，〔v0.8 R11〕）

- **触发**：到期时 bot 提交**最终报价**（真实终价）；到期后按序结算——**旧报价先结算、最终报价最后结算**（✅ D-06/B12）→ `getLatestPrice` 即到期定标价
- **盈亏**（线性差价，✅ D-02 公式保留）：
  - 看涨：`PNL = (终价 − 开仓价) × 份数`；看跌：`PNL = (开仓价 − 终价) × 份数`
  - 份数 = veto 收到的标的数量（看涨收 LLM 即份数；看跌按名义额折算）
- **兑付**：**无链上结算/领取动作**（❓ Q4 答案 "No need"）——用户的盈亏已体现在其钱包资产中（持有 LLM/HKD 的价值随终价变化）。"到期结算"在 UI 上仅是**估值展示**：显示"持仓市值 @ 终价 vs 开仓成本 = 盈亏"。用户可继续持有或随时反向 veto 变现

---

## 三、完整业务全流程

### 3.1 前置流程：bot 建市（Demo 阶段）

1. （脚本）铸币：`LLM`、`HKD` 测试币 → 分发给 bot 与用户（faucet）
2. （脚本）bot 授权 MonoracleWindowed 动用 LLM/HKD（approve）
3. （bot）拉取 06658.HK 真实行情 → 按公平价 P 提交首笔报价 `submitQuote(..., expiryBlock)`（🔁 双边质押；`expiryBlock` = 本轮到期块，D-13）
4. （bot）报价被否决 → `withdrawProviderFunds` 回收后**立即补报**（restocking）；未否决报价到期后按序 `settleValidQuote` 回收（✅ D-05 间隔可配）
5. IRMarket `createMarket(base, quote, expiryBlock, feeBps, marketMaker)` 注册市场（✅ D-14：同标的多市场并存，不去重）
6. 市场生效：用户可对任意 ACTIVE 报价 veto

### 3.2 用户开仓流程（以看跌/做空为例）

1. 连接钱包（Monad 10143）；从 faucet 领取 LLM/HKD
2. 市场列表选标的 → 详情页显示"当前 bot 报价 P（到期倒计时）"
3. 切「看跌」Tab（成交规模 = 所选报价全额：付 `baseAmount` LLM / 收 `quoteAmount−fee` HKD，B4）
4. 前端预览：将执行 `vetoOverpriced(quoteId#N)`，付 LLM、收 HKD，成交价 P
5. 用户签名 → Monoracle 执行 veto → 资产当场换手到账
6. 前端监听 `QuoteVetoedOverpriced` 事件 → 生成持仓记录（空头 = 收到的 HKD）

### 3.3 持仓与反向平仓流程

1. 持仓页：显示持仓资产余额（如"持有 HKD 8,000 / 空头 06658.HK"）+ 浮盈（轮中按最新 ACTIVE 报价估值、到期按 `getLatestPrice`，B12）
2. 点「反向平仓」→ 前端选定当前 ACTIVE 报价 → 预览反向 veto（付 HKD、收回 LLM 本金+浮盈）
3. 签名 → Monoracle 执行反向 veto → 资产换回，仓位关闭

### 3.4 到期流程

1. 3 分钟到期：bot 提交最终报价并 settle（✅ D-06）→ `getLatestPrice` 定标
2. UI 估值展示：每个持仓显示"终价、开仓价、最终盈亏"（〔v0.8 R11〕无链上结算动作、无领取按钮——资产已在用户钱包）
3. 用户可选：继续持有资产（下期市场继续用）或反向 veto 变现

---

## 四、分模块功能需求

### 4.1 智能合约层

#### 4.1.1 MonoracleWindowed（🔁 交易与结算全责，IRMarket 自部署分叉）

- 报价、否决（多空换手）、结算、提取、价格读取**全部由 MonoracleWindowed 承担**，IRMarket **不复制任何结算逻辑**（〔v0.8 R15〕："是同一个智能合约"）
- 分叉来源：上游 `github.com/dixia/monoracle`（`contracts/Monoracle.sol`）；唯一改动 = quote 级 `expiryBlock` 窗口（✅ D-13，用户批准的唯一破例）
- **已废弃标记（CWV-01）**：上游已将 quote 级 `expiryBlock` 并入主合约；分叉仅在使用中的 Monad 测试网部署服役到上游部署落地为止（见 TODO.md / GH issue #2）
- 完整错误集（供前端/bot 解析）：`ZeroBaseAmount`、`QuoteAmountTooSmall`、`IdenticalTokens`、`ExpiryMustBeFuture`、`VerificationWindowActive`、`VerificationWindowExpired`、`QuoteDoesNotExist`、`QuoteNotActive`、`NotQuoteProvider`、`NotWithdrawable`
- `abi/Monoracle.abi.json` 由分叉构建生成

#### 4.1.2 IRMarket 薄层（✅ D-11/D-14：费用包裹 + 工厂）

- `createMarket(base, quote, expiryBlock, feeBps, marketMaker)` 工厂注册——**不去重**（D-14）：同一标的可并存多个市场（不同到期/费率），每轮 = 新 marketId；创建时对 oracle `forceApprove` 两种代币（gas 上限 ≈2M）
- **费用包裹（D-11/D-16）**：入口函数按 HKD 名义额扣 1%（看涨加付入端、看跌从收付出扣）→ 代用户执行 veto（看涨/看跌两个入口函数）
- `openLong`/`openShort`/`createMarket` 入口 + `markets`/`nextMarketId` 读取 + `version()`（返回 `"0.9.0-vetomarket"` 标注构建）
- **事件索引**：`MarketCreated` 索引 `marketId`/`baseToken`/`quoteToken`（`marketMaker`/`expiryBlock`/`feeBps` 在 data）；`VetoWrapped` 索引 `quoteId`/`marketId`/`trader`（`side`/金额/`fee` 在 data）——与 `web/src/lib/abis/market.ts` 一致
- 部署：`script/deploy.js` 一键完成 oracle→market→铸币→createMarket 并写 `deployment.json`；后轮用 `script/create-market.js` 或 bot `AUTO_CREATE_MARKET` 滚动
- 持仓索引：可选，监听 veto 事件落库；前端亦可纯事件驱动，不需要链上账本

#### 4.1.3 定价与费用模块

- 价格读取：`getLatestPrice`（🔁）；"价格有效性"由否决仲裁机制原生保证，无需额外校验
- 费用：✅ D-11/D-16 包裹层显式扣 1%（HKD 计，详见 §二 2.2）

### 4.2 做市商报价 bot（Demo 版）

- 核心：拉取 06658.HK 真实行情 → 循环 `submitQuote(..., expiryBlock=本轮到期块)`（双边质押）→ 被否决即 withdraw + 补报 → 到期按序 settle（旧先新后）→ withdraw（✅ D-05 间隔可配 `QUOTE_INTERVAL_SECONDS/BLOCKS`）
- **轮次作用域（FR-BOT 硬性要求）**：一切 quote/settle/restock 以 `quote.expiryBlock == market.expiryBlock` 归属本轮，**禁止只按交易对匹配**；过期 `marketId` 启动时结算旧轮并 roll 到新轮，不得触碰活跃轮报价（曾因只按 pair 匹配致结算崩溃，详见 sc-tech-spec §5.1）
- 到期：提交最终报价并**最后结算**（✅ D-06/B12，`SETTLEMENT_QUOTE_LEAD_BLOCKS` 提前量）
- 风控：bot 自身报价即对手方敞口；被否决 = 正常赔付（零和），bot 无需额外对冲逻辑；未否决报价抵押锁定至到期（B12 资本预算）
- 参考实现：monoracle `bot/verifier.py`（否决侧）与 `script/demo.js`（报价侧）改造而来

### 4.3 前端功能模块

- 钱包连接/网络校验（10143）+ 测试币 faucet 领取
- 市场列表（报价对 + 到期倒计时）
- 交易面板：当前 ACTIVE 报价展示（价格 + 到期倒计时）+ 看涨/看跌按钮（映射两个 veto）
- 持仓管理：资产余额、浮盈（轮中按 ACTIVE 报价、到期按 `getLatestPrice` 估值，B12）、反向平仓
- 到期估值展示（无结算/领取按钮）

---

## 五、UI界面设计与交互流程（UI Flow）

### 5.1 整体设计规范
- 卡片式布局；主色明黄；绿=看涨/盈利，红=看跌/亏损；深灰底
- 核心按钮：黄色主按钮「确认看涨开仓」「确认看跌开仓」；平仓按钮黄色描边

### 5.2 全局核心链路总览
```
产品入口 → 市场列表 → 标的详情页（当前报价 + 看涨/看跌 veto）
                          ↓
                    持仓管理页 → 反向平仓 / 到期估值
```

### 5.3 分页面UI与交互

- **导航 + 钱包**：同 V0.7（连接钱包、链 ID 10143 校验、余额 + faucet 入口）
- **市场列表**：标的「溜溜梅 LLM」+ 标签「港股 06658.HK」+ 到期倒计时；当前报价（`getLatestPrice`，黄色大字体）；「看涨」（绿）/「看跌」（红）快捷按钮
- **标的详情页（核心交易页）**：
  - 左卡：标的信息、当前链上报价（Monoracle 源）、到期信息
  - 右卡（交易面板）：
    - 顶部：当前可 veto 报价卡片：`报价 P`、`到期倒计时（本轮到期块）`、`无可用报价` 降级态（🚧 B4）
    - Tab：看涨（做多）/ 看跌（做空），选中黄色填充
    - 成交规模展示（= 所选最新 ACTIVE 报价全额，B4）+ 可用余额（看涨显示 HKD 余额，看跌显示 LLM 余额）
    - 预览：`将按 P 价格与做市商换手：付 X HKD / 收 Y LLM（或反之）` + `手续费 1%（D-11 显式展示）` + 最大亏损提示（= 投入本金）
    - 主按钮：「确认看涨开仓」（绿）/「确认看跌开仓」（红）；签名 → 加载态 → 成功卡（显示收到资产 + tx 链接）
  - 文案：**"多空市场 · 默认 3 分钟到期 · 随时反向平仓 · 无爆仓风险"**
- **持仓管理页**：
  - 持仓卡：方向标签（看涨=持有 LLM / 看跌=持有 HKD）；开仓价、当前报价、持仓市值、浮动盈亏（盈绿亏红）、到期倒计时
  - 未到期：黄色描边「反向平仓」；到期后：卡片显示「最终盈亏（@ 终价）」，**无结算/领取按钮**（〔v0.8 R11〕），仅提示"资产已在钱包，可反向平仓变现或持有"
- **通用交易状态反馈**：加载/成功/失败三态复用

### 5.4 核心场景走查
- 场景1 看跌开仓：列表→看跌→详情→成交规模展示（整笔）→预览（vetoOverpriced @ P）→签名→收到 HKD→持仓页显示空头浮盈
- 场景2 反向平仓：持仓→反向平仓→预览（vetoUnderpriced @ P'）→签名→收回 LLM，仓位关闭
- 场景3 到期：3min 到期→bot 终报→持仓卡显示最终盈亏（无操作）→可反向 veto 变现

---

## 六、Demo 版本范围界定

| 模块 | Demo 包含 | 暂不实现 |
|------|-----------|----------|
| 标的 | 溜溜梅（06658.HK / HKG:6658，✅ D-12 已确认），bot 接真实行情 | 多标的、用户自定义标的 |
| 交易 | 看涨/看跌 veto 开仓、反向 veto 平仓、到期 UI 估值（✅ D-08/D-09） | 限价单、止盈止损、杠杆/保证金 |
| 做市商 | bot 持续报价（✅ D-05 可配间隔）+ 到期终报（✅ D-06） | 多做市商、分级基金（Stage 2） |
| 价格 | MonoracleWindowed 报价 + 否决仲裁（🔁 自部署分叉，窗口=到期 D-13） | 多报价聚合 |
| 费用 | ✅ D-11/D-16：IRMarket 包裹层显式扣 1%（HKD 计） | 动态费率、嵌入报价价差（不可行） |
| 资产 | HKD/LLM 测试币（MockERC20）+ faucet | 多币种、稳定币、真实法币通道 |
| 前端 | 市场列表、交易面板（报价+到期倒计时）、持仓/浮盈、到期估值 | 高级K线、深度图 |
| 合约 | MonoracleWindowed（自部署分叉）+ IRMarket 薄层（工厂+费用包裹） | IRMarket 全功能市场合约 |

---

## 七、评审校验清单

1. ✅〔v0.8〕架构：交易 = Monoracle veto 流；看多/看跌 = 两个否决方向（D-07/D-08）
2. ✅ 对手方：bot 双边抵押零和承接，无资不抵债（D-10；原 B1/B2 卡点关闭）
3. ✅ 结算：到期 bot 终报定标 + UI 估值，无链上结算/领取（D-09；Q4 答案）
4. ✅ 手续费：IRMarket 包裹层显式扣 1%（D-11），HKD 计（D-16）
5. ✅ 报价节奏：可配间隔，3min 内完成全链路（D-05）；否决窗口 = 到期（D-13）
6. ✅ UI 链路：faucet→开仓(veto)→持仓→反向平仓→到期估值，无断点
7. ✅ 设计风格：卡片式、黄色主色
8. ⚠️ 标的：溜溜梅 06658.HK 已确认（D-12）；真实行情源的接入方式待开发时确认（bot 拉数源）
9. ✅〔v0.8.1〕窗口/分叉：MonoracleWindowed 已编译 + 6 窗口测试通过；市场不去重（D-14）、不限报价来源（D-15）
10. ❓ 其他遗漏场景（请在下方反馈）

---

## 八、决策记录

### 既有决策（D-01 ~ D-06）

- **D-01 期限**：Demo 默认 3 分钟（≈600 blocks）；UI 保留多期限选择
- **D-02 盈亏模型**：线性差价 PNL；份数 = veto 收到的标的数量；核心 = 算 PNL（在 V0.8 架构下 = 持仓市值 − 开仓成本，全部可前端计算）
- **D-03（V0.8 重写）**：平仓对手方 = bot 的 Monoracle 双边抵押（veto 流内换手，✓ 技术可行——不再需要 IRMarket 自有池）
- **D-04（V0.8 重写）**：到期无强制结算/领取；bot 终报定标（D-06）+ UI 估值展示
- **D-05 报价频率**：bot 持续报价，间隔可配（`bot/.env`），适配 3min Demo 周期
- **D-06 最终报价结算**：到期 bot 再报一笔；到期后按序 settle——旧报价先、最终报价最后（B12），`getLatestPrice` 即终价（〔v0.8.1〕原文"2-slot ≈600ms 后成 canonical"已随 D-13 更新为"expiryBlock 后"）

### V0.8 新增决策（D-07 ~ D-12，用户确认）

- **D-07 市场 = 报价对**：每个 Monoracle 报价对（base, quote）= 一个市场；createMarket = 注册配对 + bot 报价配置（工厂模式）；用户钱包直接操作 Monoracle 合约（同一合约承载报价与交易）
- **D-08 方向 = veto 方向**：看涨 = `vetoUnderpriced`（付 HKD 收 LLM）；看跌 = `vetoOverpriced`（付 LLM 收 HKD）；反向平仓 = 反向 veto
- **D-09 结算 = 资产已在钱包**：盈亏在 veto 换手中已实现；到期仅为 UI 估值点（bot 终报）；无领取
- **D-10 零和全抵押**：用户盈利 = bot 抵押亏损；bot 抵押耗尽 = 停报停牌，系统不存在"池不足/缩水/欠账"问题
- **D-11 手续费**：IRMarket 包裹层入口显式扣 1% 给做市商，再代用户执行 veto（Q7 方案 1；费用不嵌入报价价差）
- **D-12 标的**：溜溜梅（06658.HK / HKG:6658），已最终确认，不再变更

### V0.8.1 新增决策（D-13 ~ D-16，用户确认）

- **D-13 窗口 = 期权到期日**：否决窗口由上游固定 2-slot 放大为 **quote 级 `expiryBlock` = 本轮到期块**（否决挑战期与期权期限是同一回事）；实现 = 自部署分叉 `contracts/MonoracleWindowed.sol`（派生上游，唯一改动，用户批准的唯一破例）
- **D-14 市场不去重**：同一标的多市场并存（不同到期/费率），到期后再上新轮次；createMarket 永远新建 marketId
- **D-15 不限报价来源**：wrapper 允许 veto 任何 provider 的报价；1% 费用归注册 MM
- **D-16 手续费 HKD 计**：`feeBps × quoteAmount / 10000`（HKD）；看涨加在付入端、看跌从收付出扣

---

## 九、卡点清单（V0.8.1）

> 严重程度：高 = 阻塞开发；中 = 阻塞对应模块；低 = 文案/事实性。

| # | 卡点 | 严重度 | 状态 |
|---|------|:---:|------|
| B1 | ~~PNL 偿付资金来源~~ | ~~高~~ | ✅ 关闭：V0.8 veto 流内换手，零和全抵押（D-10） |
| B2 | ~~池余额不足~~ | ~~高~~ | ✅ 关闭：不存在的问题（D-10） |
| B3 | ~~手续费无处扣~~ | ~~中~~ | ✅ 关闭：D-11/D-16 包裹层显式扣 1%（HKD 计） |
| B4 | **报价可用性**：bot 停报/抵押耗尽时无交易机会（自然停牌）；两轮报价间价格可能变动（用户按具体 quoteId 成交，无滑点但需 UI 展示待成交报价） | **中** | 前端"无可用报价"降级态 + 到期倒计时（已列入 §五）；bot restocking 间隔调优 |
| B5 | **标的行情源**：06658.HK 真实行情接入（bot 拉数源） | **低** | 开发时确认 |
| B6 | 术语已统一（预言机、多空=veto 别名、provider=bot/做市商） | 低 | ✅ 完成 |
| B7 | bot 抵押循环：被否决报价需 withdraw 回收后补报 | 低 | ✅ bot PRD FR-BOT-001 覆盖 |
| B8 | ~~否决窗口 vs 人工签名延迟~~ | ~~高~~ | ✅ 关闭：D-13 窗口=期权到期日（quote 级 expiryBlock） |
| B9 | ~~市场重开/去重~~ | ~~中~~ | ✅ 关闭：D-14 不去重，同标的多市场并存 |
| B10 | ~~wrapper 报价来源~~ | ~~低~~ | ✅ 关闭：D-15 不限 provider |
| B11 | ~~做空费币种~~ | ~~低~~ | ✅ 关闭：D-16 统一 HKD |
| B12 | **bot 资本与估值**：未否决报价抵押锁定至到期（bot 资本 = 轮内报价数 × 单笔规模）；轮中 `getLatestPrice` 无新 settle → 浮盈改读 ACTIVE 报价事件；到期按序 settle（旧先、终报最后）保 canonical=终价 | **低** | 已写入 bot 设计 + §5.4/sc-tech-spec §5；demo 铸币充足 |

---

## 十、歧义确认清单（V0.8.1）

### 已回答（Q1 ~ Q6）

- **Q1（对手方/资金池）→ 答案**：不做资金池。盈亏在 veto 套利换手中完成；用户钱包直接操作 Monoracle（同一合约）；价格与 PNL 由 UI 计算
- **Q2（池不足）→ 答案**：不存在的问题（零和全抵押，D-10）
- **Q3（手续费模型）→ 答案 A 显式扣费**：见 Q7 落地张力
- **Q4（领取机制）→ 答案**：No need（D-09）
- **Q5（标的）→ 答案 B**：真实 ticker 06658.HK（HKG:6658）
- **Q6（市场创建）→ 答案**：工厂 OK；市场 = 报价对，需按 Monoracle 合约结构规划（D-07）

### ❓ Q7（中）→ ✅ 已拍板（D-11/D-16）
- 选 **方案 1**：交易经 IRMarket 包裹层入口，进 veto 前按名义额显式扣 1% 给做市商（HKD 计）

### ❓ Q8（低）→ ✅ 已拍板（D-12）
- 标的就用 **溜溜梅（06658.HK）**，已确认，不再变更

### V0.8.1 评审已拍板（B8 ~ B11 对应）

- **B8（窗口 vs 人工延迟）→ 答案**："放大否决窗口，窗口对齐期权到期日（本质上是一样的）"→ **D-13**：quote 级 `expiryBlock` = 本轮到期块；自部署分叉 `MonoracleWindowed`
- **B9（市场重开/去重）→ 答案**："一个资产可以有不同的期权，到期了再上新的，标的是一样的"→ **D-14**：不去重，多市场并存
- **B10（报价来源）→ 答案 b**：不限制 → **D-15**
- **B11（做空费币种）→ 答案**："按 quote 收取更好理解"→ **D-16**：统一 HKD
- **分叉位置 → 答案 a**：分叉到 IRMarket repo（`contracts/MonoracleWindowed.sol`，用户批准的唯一破例）
