# AGENTS.md — yinian-plugin-hk-ipo

[安时](https://github.com/VangelisHaha/nikou-agenda)的港股新股**日历**同步插件。
数据源是华盛证券的公开页面，没有凭据。

## 必须遵守

- 中文回复，中文写注释与文档。
- 契约的 source of truth 是安时仓库的 `docs/11-plugin-architecture.md` **§5.1.1（Event 资源）**，不是本仓库的 SDK。两者不一致时以文档为准。
- 改完必须 `npm run verify`（build + doctor + 测试）全绿。
- `src/sdk/` 是从 [yinian-plugin-template](https://github.com/VangelisHaha/yinian-plugin-template) 同步来的，**不要在这里改**——改了下次同步会被覆盖。有问题去模板仓库改。
- 不引任何运行时依赖。只用 Node 标准库 + 内置 `fetch`。

## 这是一个 event 插件，不是 task 插件

`contributes.sync.resources` 是 `["event"]`，`actions` 只有 `list`。

Event 同步是 **pull-only、远端权威**：宿主不会调 `sync.push`，外部日历落成只读日历。
所以本仓库**没有** `sync.push` handler，也不该加——加了永远不会被调用。

## 四条不能动的实现约束

1. **解析必须「按 `<h3>` 分段取表 + 按 `<thead>` 定位列」**。
   页面的可認購 / 待上市两段表结构相同但**第 8 列语义不同**（认购截止 vs 暗盘时间），
   而且「可認購」为空时渲染成 `<!---->`（连 `tbody` 都没有）。用「`可認購` 之后第一个
   `tbody`」的正则会串到「待上市」表，把暗盘时间当成认购截止——`nikou-screen` 修过
   这个 bug，`tests/parse.test.mjs` 里有回归，别退回去。

2. **不要开 `eventsComplete`**。这个源是「可认购 + 待上市」的**滚动窗口，不是全量集合**。
   新股上市后从页面消失是「已经发生」，不是「被撤回」。开了它，每只票一上市宿主就
   把它的四个事件全置成 `canceled`，用户回头看历史全是「已取消」。

3. **撤回判定靠 `host.setState` 记账**：记 `代码 → 上市日`，只有「上次见过、这次没有、
   **且上市日还在未来**」才算撤回并上报 `deletedExternalIds`。上市日已过的直接从记账里
   移除，不报删除。

4. **`externalId` 是 `<代码>:<时点后缀>`**，后缀在 `events.mts` 生成、在 `sync.mts` 的
   `suffixOf()` 拼删除 id，两处必须一致。测试里有一条专门断言它们相等——拼错的话
   宿主永远找不到要标记的事件。

## 暗盘时间：推导值必须标出来

页面的「暗盤時間」列大多数时候是 `--`，所以缺失时按「上市日前一个非周末日」推导。

- **不内置港股公众假期表**。那需要农历库算农历节日，与零运行时依赖冲突。
  用户可以在实例设置的 `holidays` 里补日期。
- **推导值必须在标题上带「（推导）」并在来源字段说明「请以券商公告为准」**。
  一个推导错的暗盘时间比没有更糟——用户会照着它去挂单。

## 事件语义

- **忙闲一律 `free`**。这些是信息提示，不是占用时间的会议。标成 busy 会把整周的
  忙闲视图涂满。
- **一只票产四个事件，不做成一条跨天块**。它们是四件要分别做的事，压成一条横条
  就看不出哪天该干什么。
- **全天事件的 `endDate` 右开**：只占 8/20 要写 `2026-08-21`。写成同一天宿主会判成
  空区间并跳过。
- **定时与全天互斥**：混着给（既有 `startAt` 又有 `startDate`）会被宿主跳过并计入
  `invalid`。

## 时区

港股时间固定 `+08:00`，在 `events.mts` 里显式拼进 RFC3339。
不要依赖本机时区——插件跑在用户机器上，时区什么都可能是。

## 不要做的事

- 不要 spawn `curl`。用内置 `fetch`；声明 `spawn` 权限会让安装时的权限清单多一条
  「执行外部命令」，而用户没法判断那意味着什么。
- 不要把「抓到空列表」当失败。没有新股是正常业务结果。抓到的页面里**没有**
  「可認購」字样才是失败（说明拿到了登录页或页面改版）。
- 不要给 `remoteUpdatedAt`。页面没有更新时间，编一个内容指纹塞进去是滥用语义；
  宿主本来就会比对字段，没变化时不写库。

## 发布

1. `yinian-plugin.json` 与 `package.json` 的 `version` 同步改。
2. `npm run pack:zip`。
3. Git tag **必须与 manifest 的 `version` 完全一致**，GitHub Release 挂那一个 zip。
4. 索引仓库 [yinian-plugins](https://github.com/VangelisHaha/yinian-plugins) 里加一条，
   `contributes` 写 `["sync:event"]`。
