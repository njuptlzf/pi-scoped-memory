# pi-scoped-memory

中文 · [English README](./README.en.md) · [为什么不用 hermes（中文）](./WHY-NOT-HERMES.md) / [Why not hermes (English)](./WHY-NOT-HERMES.en.md)

一个 [pi](https://github.com/earendil-works/pi)（`@earendil-works/pi-coding-agent`）的极简长期记忆扩展：`remember` / `recall` 两个模型自主调用的工具 + 会话启动时把已存要点注入系统提示。

单文件。运行时 import 只有三个：`node:fs`、`node:path`、`typebox`。没有数据库、没有原生模块、没有子进程。**对租户/身份/项目一无所知**。

> **一句话定位**：它不是"给某个记忆插件加了多租户"，而是**把作用域决定权从插件里拿出来交还宿主**的极简实现。隔离来自"宿主为每个会话传一个已经算好的目录"这个契约，插件本身不管理租户。

## 为什么这一点值得说

大多数 pi 记忆类扩展（含 `pi-hermes-memory`）把"这条记忆该写到哪"编码进了插件内部：读 `cwd`、读 git、按 target（user / memory / failure / project）路由。在**单用户 CLI** 里这是贴心的自动化；在**嵌入式多用户服务**里，它变成结构性的跨用户泄露——插件里没有"这个人是谁"的信息，也不可能有。

本扩展反过来：只认一个 `dir`。宿主按自己的身份模型计算 `<base>/memory/<userId>/<scope>/` 并传入，插件写文件、读文件、注入，不做任何发现（discovery）。代价是它没有语义检索、没有 LLM 巩固；收益是它可以在多用户进程里安全装载，并且能作为一个无业务知识的独立包发布。

## 什么时候用它，什么时候该用 hermes-memory

主判据只有一条：**同一个进程里会不会出现两个身份。**

| 用 `pi-scoped-memory` | 用 `pi-hermes-memory` |
|---|---|
| 一个服务进程按请求承载多个 `userId`（嵌入式多租户后端） | 单人编码 agent：本机 CLI、一人一机一个 agent 根 |
| 分区键只有宿主知道（租户 id / 资格 / 门店 / 团队） | "项目"确实是天然作用域（有 git、有真实 cwd 语义） |
| 有按用户擦除、导出、审计义务（注销即 `rm -rf` 一个目录） | 条目量到千/万，需要语义召回与相关性注入 |
| 不能带原生依赖（`better-sqlite3`）或巩固子进程 | 需要自动去重 / 冲突消解 / 经验巩固 |
| 不想让模型自己选记忆归属（路由指引会把偏好类写进全局目录） | 单租户但想要跨项目"教训"分层 |

**反过来说**：如果部署本来就是每用户一个进程，"为了多租户"这个理由就消失了——直接用 hermes 换它的检索与巩固质量，别用这个。

**也别指望两个都装上互补**：共存会让租户边界从"宿主传对 `dir`"退化成"模型选对 target"，详见 [WHY-NOT-HERMES.md](./WHY-NOT-HERMES.md) 第一节末尾。

完整论证（含为什么不写一个包住 hermes 的适配器、以及什么时候值得回头看它）见 [WHY-NOT-HERMES.md](./WHY-NOT-HERMES.md)。

## 它做什么

- `remember`（工具，模型调用）：记一条不超过 500 字符的要点，可选 `kind` 标签（枚举：`preference` / `correction` / `failure` / `fact`）。同一要点重复写入不会重复计数——读取时按文本（大小写无关）去重，后写覆盖先写。
- `recall`（工具，模型调用）：按关键词过滤并按命中打分排序（命中次数 > kind 命中 > 更靠前的命中，时间只做平局裁决），返回前若干条（默认 10，上限 50）。
- `before_agent_start`（事件）：把**快照**追加进 `event.systemPromptOptions.appendSystemPrompt`，包在 `<user-memory>` 里；快照为空则不注入。

存储是 `<dir>/entries.jsonl`：坏行跳过、**每条一次 O_APPEND 追加**（跨进程并发写不丢条目）、按条数滚动（默认 200；磁盘最多涨到 1.5× 后压缩一次，可见条数始终按上限截断）。注入上限最近 60 条、总额 4000 字符（按新到旧装，装不下的那条截断而非整条丢）。提示缓存友好——快照按文件指纹（mtime+size）懒刷新，内容没变就不改注入文本。

工具描述明确要求模型：只在用户表达了值得跨会话遵循的偏好、纠错或结论时记录，不记录一次性问题内容与题目原文。没有"醒来保存"这类显式触发流程。

## 用法

### A. 作为 SDK 宿主的一部分（多用户服务的正确姿势）

工厂函数每会话 new 一次，作用域在宿主侧算：

```ts
import * as path from "node:path";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { scopedMemory } from "pi-scoped-memory"; // 本仓库内开发时：从 ./src/index.ts 引

const loader = new DefaultResourceLoader({
  // ...
  extensionFactories: [
    scopedMemory({ dir: path.join(dataDir, "memory", userId, qualification || "default") }),
  ],
});
```

要点：**每个会话一个工厂实例**。同一个实例被两个用户共用，等于共用一个目录——隔离责任在宿主，库不会替你校验。真实宿主接线见 agent-chat monorepo 的 `packages/server/src/session.ts:420-426`（`dir = <dataDir>/memory/<userId>/<qual||"default">`），另有两例集成测试守着它（见「发布」）。

### B. 单用户 CLI（试水）

pi 的文件发现要求扩展 `export default function (pi: ExtensionAPI)`，而本包导出的是**返回** factory 的工厂（多租户宿主必须每会话 new 一次），所以 CLI 用法靠 [`extensions/scoped-memory.ts`](./extensions/scoped-memory.ts) 这层薄包装固定 `dir`：取 `PI_SCOPED_MEMORY_DIR`（空串/纯空白算未设置），回落到 `~/.pi/agent/memory`。

```bash
pi install npm:pi-scoped-memory                                     # 从 npm 装（pi gallery 能搜到）
pi --extension ./extensions/scoped-memory.ts                        # 在本仓库根目录下直接加载
```

多用户宿主**不要**走 B：薄包装在一个进程里只解析一次 `dir`，所有会话会共用同一个目录。

## API

| 导出 | 说明 |
|---|---|
| `scopedMemory(options: ScopedMemoryOptions)` | 返回 pi extension factory；`options.dir` 必填（首次写入时创建），`options.maxEntries` 默认 200 |
| `MemoryEntry` | `{ at: number; kind: string; text: string }` |
| `cleanEntryText(text)` | 信任边界清洗：压空白、截 500 字符、剥掉 `<user-memory>` 标签（上下文围栏） |
| `hasSecret(text)` | 写入前的密钥/口令粗筛（reject，不落盘） |
| `loadEntries(file)` / `appendEntry(file, entry, max)` / `recallEntries(entries, q, limit)` / `renderMemorySection(entries)` | 纯函数，可单独测 |

`dir` 的绝对路径**永不进提示**；注入文本里只有日期和条目正文。注意：所有面向模型的文案目前是中文（`src/index.ts:105`、`:123-129`、`:142-147`），英文宿主需要自行改这几处字符串。

## 边界与安全

- pi 官方文档写明扩展"运行在 Pi 进程内，拥有同样的操作系统权限……只加载你信任的来源"（`docs/extensions.md`）。本库不提供沙箱，`dir` 之外它什么都不碰。
- 存进去的文本会被注入系统提示 = 一次间接 prompt injection 面。已有的缓解：单条 ≤500 字符、`</user-memory>` 剥离、注入上限 60 条。没有的：投毒检测、写入需人工确认（疑似密钥会在写入时被拒）。
- 多用户宿主必须保证**同一进程内不同会话传不同 `dir`**；本库不读环境变量、不猜身份，因此也无法阻止你传错。

## 已知的天花板（有意为之）

- `recall` 是大小写无关的**子串匹配**，不是语义检索。
- 滚动是**计数**淘汰，不是 LLM 巩固（重复要点在读取时去重，不会占多行，但文件里的历史行要等 compaction 才消失）。
- 压缩（把日志重写成上限条数）是尽力而为：与写者竞争时可能吞掉这一轮压缩，日志稍后再缩；坏行只在压缩时清掉。
- 注入仍是"最近 N 条 + 字符预算"，不按相关度挑（`recall` 才打分）。

若记忆质量成为瓶颈，升级路径是在 `entries.jsonl` 之上加一趟巩固 / 语义索引，**存储形状不变、作用域契约不变**，宿主代码不动。这条路径写进源码注释（`ponytail:`）。

## 发布

已发布：npm [`pi-scoped-memory`](https://www.npmjs.com/package/pi-scoped-memory) `0.1.0` + GitHub [`njuptlzf/pi-scoped-memory`](https://github.com/njuptlzf/pi-scoped-memory)，MIT（`Copyright (c) 2026 njuptlzf`）。

包里有什么：`package.json`（`pi.extensions` + `keywords: ["pi-package"]`；宿主自带的 `@earendil-works/pi-coding-agent` 与 `typebox` 声明为 `peerDependencies: "*"`，**不放 dependencies**，理由见 pi 的 `docs/packages.md`）、`src/index.ts`（**237 行**；发布的是 TS 源码，由 pi 的扩展装载器加载，不是编译产物）、CLI 薄包装 `extensions/scoped-memory.ts`、四份文档。`test/` 和 `tsconfig.json` 只进仓库、不进 tarball（由 `files` 决定）——在仓库里跑测试：`npm install && npm test`（11 例：清洗 / 坏行+滚动 / **跨进程并发追加不丢** / 子串 recall（含打分排序、**重复要点只算一条**）/ 密钥拒写（含样例）/ 注入行数上限与字符预算、无路径泄露 / fake-pi 结构 / **两个 dir 互不可见的隔离契约** / **同 dir 两会话互相可见** / 薄包装 dir 解析）。

它在母项目 agent-chat（monorepo）里的位置：这个仓库是**唯一真相源**，宿主 `packages/server/src/session.ts` 直接引本仓库的 `src/index.ts`（原来那份 `packages/server/src/extensions/scoped-memory.ts` 已 `git mv` 搬走，不留第二份拷贝）。宿主侧的两例集成测试（断言落盘目录归 `(userId, scope)` 管、`agent.memory: false` 时无工具）留在 `packages/server/test/memory.test.ts`——那是宿主契约，不属于这个包。原始实现提交 `c40f503`；决策记录见 agent-chat 仓库 `docs/` 下的《软考助手 agent-chat：项目背景与开发交接文档》S2-5 行（[docs 目录](https://github.com/njuptlzf/agent-chat/tree/main/docs)）。

