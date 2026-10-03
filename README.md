# Anticipation of Uncertainty · 不确定性前瞻

> 不是算命机，是**带认识论标注的预测引擎**。
> Ask about the future, get a falsifiable claim — not a comfortable sentence.

**在线站点**：https://world-model-54082.app.workbuddy.host/

## 这是什么

对任意「未来会怎样」的问题，它先抓取**此刻的真实世界状态**，再按四元组建模：

| 层 | 含义 |
|---|---|
| **S** 状态空间 | 此刻哪些事实与该问题相关 |
| **T** 演化算子 | 什么机制把现状推向未来 |
| **O** 观测算子 | 哪些可观察信号能验证 / 推翻判断 |
| **P** 不确定性来源 | 哪些因素在系统之外，无法建模 |

最后交出一条**到期能被判定的结论**，强制附带：

- 置信度（概率化，可用于 Brier 校准）
- 可预测时域（诚实声明"这个问题最多能看多远"）
- **推翻条件**（满足任一条，即说明这条预测错了）
- 反身性警示（这条预测被读到并据此行动时，会如何改变自己的结果）
- 依据数据（本次推理实际用了哪几路数据源）

每条预测到期后回站内复盘，长期积累出**硬命中率、Brier 分数、可靠性分桶、过度自信指数** —— 让"准不准"变成可统计的事实，而不是印象。

## 特性

- **18 路实时数据源**：天气 / 空气质量 / 外汇 / 地震 / 空间天气 / ISS / 比特币链上 / 技术热榜 / 日照 / 航天 / 宏观 CPI / 金融市场 / 国际期货 / 政策要闻 / 实时热点 / 公司公告 / 社交热榜（微博·百度·抖音）等，按问题关键词自动路由，单点失败不中断推理
- **预测复盘闭环**：判定与证据分离、Brier / 可靠性分桶 / 过度自信指数，时域换算单源真源
- **长期记忆参与推理**：个人背景与偏好进入上下文，判断贴合使用者处境
- **模型看门狗**：首 token 超时监测 + 逐候选自动降级（详见 `js/engine.js` 与下方"踩坑记录"）
- **每日额度保护**：按账号当日提问数精确计数，防单人刷爆共享额度
- **数据自主**：预测档案与记忆可导出 JSON / CSV，随时带走
- **零依赖后端**：`server.js` 单文件、零 npm 依赖，静态托管 + 社交热榜代理 + 白名单防 SSRF

## 快速开始

```bash
git clone https://github.com/losedead/anticipation-of-uncertainty.git
cd anticipation-of-uncertainty
node server.js          # 零依赖，无需 npm install
# → http://localhost:3000
```

要跑通**云功能**（登录、记忆、预测档案、LLM 推理），需要一个 WorkBuddy 云服务应用：

1. 在 WorkBuddy 中新建云服务应用（含数据库 + 认证 + LLM）
2. 执行 `tools/schema.sql` 建三张表并启用 RLS（每张表 4 条策略，全部绑定 `owner_id = auth.uid()`）
3. 把应用给的三个值填进 `js/config.js` 的 `PUBLIC_CONFIG`（`resourceId` / `endpoint` / `publishableKey`）
4. `node server.js`，完事

回归测试（需要 `server.js` 跑在 8787 端口）：

```bash
node tools/selftest.mjs        # 数据源自检 29 项
node tools/metrics-test.mjs    # 复盘度量 62 项
```

## 项目结构

```
server.js      零依赖 Node 服务：静态托管 + /api/social 代理 + /api/health
index.html     单页外壳
css/style.css  蓝白主题（设计 token + 网格背景 + 登录双栏 + 介绍页）
js/config.js   品牌常量 + 云配置（唯一需要修改的文件）
js/brand.js    品牌图形 LOGOMARK（「不确定性锥」内联 SVG）
js/cloud.js    云 SDK 封装
js/store.js    持久化（记忆 / 档案 / 设定 / 当日额度计数）
js/auth.js     邮箱认证（密码 + 验证码）+ 双栏介绍式登录页
js/datasources.js  18 个数据源适配器 + 关键词路由
js/engine.js   预测内核（S/T/O/P prompt + 结构化解析 + 模型看门狗与降级）
js/metrics.js  复盘度量（Brier / 可靠性分桶 / 过度自信指数）+ 时域换算（纯函数）
js/app.js      六视图路由（预测台/档案/记忆/介绍/我的）+ 预测流程
tools/schema.sql      建表 + RLS 全套 SQL
tools/selftest.mjs    数据源自检（29 项）
tools/metrics-test.mjs 复盘度量单测（62 项）
```

## 踩坑记录（重要，改代码前先读）

这些都是真实踩过的坑，详细分析见各模块注释：

1. **有"挂死型"模型**：某些 LLM 在长 prompt 下 HTTP 200 建立后 SSE 零字节、不报错不断开。
   `engine.js` 的三层防护（偏好白名单 / 25s 首 token 看门狗 / 逐候选降级）**一层都不要拆**。
2. **东财接口有 Referer 防盗链**：curl 全绿但浏览器 CORS 失败。所有前端 fetch 必须带
   `referrerPolicy: 'no-referrer'`。
3. **腾讯行情是 GBK 编码**：必须 `arrayBuffer()` + `TextDecoder('gbk')`，直接 `.text()` 会乱码。
4. **微博/百度/抖音热搜无 CORS 且校验 UA/Referer**：前端不可能直连，必须走 `server.js` 的
   `/api/social` 服务端代理（含白名单防 SSRF）。
5. **RLS 三件套**：启用 RLS 后必须同时 `GRANT` 操作权限并 `CREATE POLICY`，缺一步就是"查不到数据"。
6. **切视图回页首只能用 `window.scrollTo({top:0})`**：顶栏是 `position: sticky`，
   `scrollIntoView` 会把页面标题顶到顶栏底下。
7. **路由兜底判据用 keywordHits 而非命中总数**：核心源固定 4 路，按总数判断永远不触发兜底。
8. **时域换算只有一份真源**：`js/metrics.js`，别在别处重复实现。

## 安全模型

- 终端用户用邮箱注册，数据按账号隔离（PostgreSQL RLS，12 条策略全部绑定 `owner_id = auth.uid()`）
- `publishableKey` 设计上公开（随前端下发给每个访客），不构成凭据泄露；服务端强校验 Origin
- 后端代理仅允许白名单域名，防 SSRF

## License

**非商业许可 / Noncommercial License** —— 详见 [LICENSE](LICENSE)。

- ✅ 个人学习、研究、教学、学术竞赛、自建自用部署：**免费**
- ❌ 任何商业用途（出售、SaaS/托管/付费服务、企业内部业务、盈利性展示）：**禁止**，需联系作者获取书面商业授权

This project is licensed for **noncommercial use only**. Commercial use (selling, paid services, SaaS, internal business use) requires prior written permission — see [LICENSE](LICENSE).
