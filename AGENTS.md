# AGENTS.md — yinian-plugin-hk-ipo

[安时](https://github.com/VangelisHaha/nikou-agenda)港股新股**日历**同步插件，数据源是华盛证券公开页面，无凭据。

- 中文回复，中文注释与文档。改完必须 `npm run verify` 全绿。**零运行时依赖**，不 spawn `curl`，用内置 `fetch`。
- 契约以安时主仓库《插件架构》文档 §5.1.1（Event 资源）为准；`src/sdk/` 是模板副本，**不要在这里改**。
- 这是 **event 插件**，pull-only、远端权威：**没有也不该加 `sync.push`**。
- 解析必须「按 `<h3>` 分段取表 + 按 `<thead>` 定位列」，不要用「`可認購` 之后第一个 `tbody`」的正则（会串表，`tests/parse.test.mjs` 有回归）。
- **不要开 `eventsComplete`**：这是滚动窗口不是全量集合，开了每只票一上市就被全置成 `canceled`。
- 撤回判定靠 `host.setState` 记账（代码 → 上市日），只有「见过、这次没有、且上市日还在未来」才报 `deletedExternalIds`。
- `externalId` 是 `<代码>:<时点后缀>`，`events.mts` 与 `sync.mts` 的 `suffixOf()` 必须一致（有测试断言）。
- 暗盘时间缺失时推导，**推导值标题必须带「（推导）」**；忙闲一律 `free`；全天事件 `endDate` 右开；港股时间固定 `+08:00`。
- 发布：`version` 同步 → `npm run pack:zip` → tag 与 manifest 一致 → 索引加 `["sync:event"]`。
