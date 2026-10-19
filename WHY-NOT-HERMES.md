# 为什么不是 hermes：一份可复用的选型说明

中文 · [English](./WHY-NOT-HERMES.en.md)

对象：`pi-hermes-memory@0.9.10`（下称 hermes）与本仓库的 `scopedMemory`。

**结论**：`scopedMemory` 不是 hermes 的拓展、包装或适配器，而是同一"捕获 → 存储 → 注入"模式的另一个实现。零代码交集：不 import、不依赖、不共用存储，只借鉴了一个 `execute` 返回形状（`{ content, details }`）。hermes 是这个模式的富实现（sqlite 索引、语义检索、LLM 巩固、多 target 路由），本扩展是它的**作用域安全**实现（164 行、除 `typebox` 外只用 node 内置 `fs`/`path`、只认一个目录）。

---

## 一、先看选型：什么场景必须用它、不能用 hermes

判据只有一条主分叉：**一个进程里会不会出现两个身份。**

```
同一进程会服务 >1 个用户/租户吗？
├─ 是 → 不能用 hermes（除非每身份起一个进程 = 进程池，那是另一种成本）
│        └─ 还要按 (用户, 子作用域) 分区？→ scopedMemory，宿主自己算 dir
└─ 否（单用户 CLI / 一人一机一 agent 根）
         ├─ 记忆条目会涨到需要语义检索/巩固/分层？ → 用 hermes，别用这个
         └─ 只想要"记住我的偏好"、能接受 jsonl + 子串匹配 → 两者皆可，这个更轻
```

### 必须用 scopedMemory 的场景

| # | 场景 | 为什么 hermes 不行 |
|---|---|---|
| 1 | **嵌入式多用户服务**：一个 Node 进程按请求承载多个 `userId` 的会话 | 进程级常量 + 全局目录（下节 ①②），跨用户写入同一文件；这是隐私事故，不是"体验差一点" |
| 2 | **分区键只有宿主知道**：租户 id、备考资格、门店、团队、活动期 | hermes 只按 `cwd` 的 basename 分区（`src/project.ts:99-123`），没有 userId/tenant 概念；把身份塞进 cwd 会让租户键变成拼接文件名（含 `__` 时撞车）、且 cwd 会被 pi 打进系统提示 |
| 3 | **有按用户擦除 / 导出义务**（合规删除、账号注销、数据导出） | scopedMemory 的一个目录 `rm -rf` 就是整份清除，jsonl 可直接导出与 diff；hermes 的 user / memory / failure 类记忆落在进程共享的全局文件与 sqlite 里，按人擦除要么做不到，要么写脆弱脚本 |
| 4 | **不能带原生依赖或要求冷启动/镜像小** | hermes 需要 `better-sqlite3`（原生模块 / 预编译二进制），还要 spawn 子进程做巩固；纯 jsonl 扩展没有这两件事 |
| 5 | **记忆必须可审计、可随代码 review** | 存储是一个人读的 `entries.jsonl`，坏行跳过、temp+rename 重写；sqlite 索引做不到"看 diff 就知道模型被注入了什么" |
| 6 | **不想让模型自己决定记忆归属** | 见下节 ②：hermes 的路由指引把最有价值的偏好类记忆主动指向全局目录；本扩展没有 target 概念，模型无从选错 |

### 该用 hermes、别用这个的场景（诚实清单）

| 场景 | 原因 |
|---|---|
| 单人编码 agent（本机 CLI，有 git、有真实项目目录） | "项目"是天然作用域，hermes 的 cwd 发现正好对；语义检索 + 巩固 + 分层（user/memory/failure/project）是净收益 |
| 记忆条目量级到千/万，需要相关性召回 | 本扩展的 `recall` 是大小写无关子串匹配，注入是"最近 60 条全给"，量大必失效 |
| 需要自动去重 / 冲突消解 / 经验沉淀 | 本扩展只有计数滚动（默认 200 条，丢最旧），同一偏好记 N 次占 N 行 |
| 单租户但想要跨项目"教训"层 | 那层就在 hermes 的全局目录里，是它的设计意图，不是它的 bug |

一句反例提醒：**如果你的部署本来就是每用户一个进程**，hermes 的进程级常量不构成泄露，此时"为了多租户"这个理由消失，应该直接用 hermes 换它的检索与巩固质量。

### 那能不能两个都装上，各管一段？

不行。共存不是分层，是把泄露面请回来。两个 extension 各自 `registerTool`、各自往系统提示追加，pi 不拦；于是模型同时看到两套"记住"的工具和两份注入，而 hermes 那份的读写仍按它自己的 target 路由：身份/偏好/纠错照旧落进进程共享的全局目录（下节 ②）。租户边界于是从**"宿主传对 `dir`"退化成"模型今天选对 target"**——弃方案 A 改 B 就是因为不接受这个退化。

具体坏在三处：

1. **写入分裂**：同一句"回复用中文"可能进 hermes 的全局层，也可能进本扩展的 scope 目录，两边都不完整；按用户擦除时必然漏掉一份（上面表格第 3 行的义务静默失效）。
2. **注入自相矛盾**：两段引导语同时在系统提示里，hermes 的那段叫模型选 target，本扩展的那段假定无 target 可选；遵循哪段取决于采样，不是取决于宿主。
3. **依赖照旧回来**：`better-sqlite3` 和巩固子进程又都装上了，而"不想带这两样"正是上面第 4 行选本扩展的理由。

唯一站得住的"两个都用"形态是**每身份一个进程、各自跑一个 hermes**：那时同一进程里不存在第二个身份，也就没有共存问题——但那已经落到本节判据树的"否"分支（且带上了进程池的成本），不是"两个 extension 同时装载"。

---

## 二、为什么"写个窄插件包住 hermes = 多租户 hermes"不成立

泄露面是**结构性的，不在存储管道，包一层堵不住**。三条理由：

### ① 进程单例堵不掉

`AGENT_ROOT` 是 hermes `src/paths.ts:5` 在 **import 期求值**的模块级常量（取 env `PI_CODING_AGENT_DIR`，否则 `~/.pi/agent`）。Node 同进程内模块只初始化一次——宿主在 session 之间**没有任何时机**把它的根换掉。唯一的物理隔离是每用户起一个进程，那就回到我们否决掉的进程池方案。

### ② 泄露点恰好在最包不掉的地方：提示语义层

hermes `src/constants.ts:219-229` 给模型的路由指引是**主动教它选全局目录**："用户身份/偏好 → `target: user`"、"跨项目经验/纠错/失败教训 → `target: memory` / `failure`"；而 `src/memory-tool.ts:63-67` 的 `sqliteProjectFor` 对这三类**一律返回 null**（= 全局共享目录），只有 `project` 走按 cwd 分的目录。也就是说 hermes 设计里**最有价值的记忆类型，恰好全写在租户目录之外**，而且 config 里没有"把写面锁到 project"的开关。

窄插件能改写别的 extension 注册的工具参数或提示片段吗？**没有这个机制**。已核实 pi SDK：`replaceable: true` 只让具名 inline 扩展在名字冲突时被跳过，官方文档列出的可替换者是 CLI 内置的 codemode / tool search / MCP 扩展（`docs/sdk.md:112`）。它不是"覆盖别的扩展的提示内容"的能力。

### ③ 拦截式适配的结果是自我否定

pi 的 `tool_call` 确实能改写参数或阻止执行（`docs/extensions.md:106`："can mutate input or block execution"），所以"拦掉非 project 写入"技术上做得到。但把 `user` / `memory` / `failure` 全 block，等于砍掉 hermes 的大部分能力，剩下的就是"按目录存的要点 + 捕获注入循环"——**那正是本扩展**，还要额外背着 hermes 本体、它的依赖树（探针当时为它装过 `better-sqlite3@^13`，走预编译二进制），以及永远悬着的进程级常量（拦截规则一旦漏一条就又是泄露）。

### ④ fork 改造不划算

把作用域塞进 hermes 要动 ~60 个源文件（核心是把 `AGENT_ROOT` 从模块常量改成构造参数、把 target 路由改成宿主注入的分区键）。实测成本远超 164 行重写。

---

## 三、什么时候值得回头看 hermes

不是"加个适配器"，而是**换演进方向**。触发条件：

- 记忆条目多到子串 `recall` 不够用，或注入上限 60 条被真实命中率打脸。

届时两条路，按优先级：

1. **在本扩展的存储形状上加检索**（推荐）：对 `entries.jsonl` 加语义索引 / 巩固遍。文件形状与作用域契约不变，租户边界不破，宿主代码不动。
2. **真的要 hermes 的重型能力**：正确姿势是把它 fork 成 **per-scope 实例化**（`AGENT_ROOT` 变构造参数——即那 60 个文件的活），而不是在它外面再包一层。

## 四、引用与出处

hermes 侧行号来自对接前对 `pi-hermes-memory@0.9.10` 源码的探针，该依赖现已卸载，本机不可复验；当时的记录落在 `agent-chat` 仓库 `docs/软考助手 agent-chat：项目背景与开发交接文档.md` 的 S2-5 行与提交 `c40f503`。

pi 侧四条已在 `@earendil-works/pi-coding-agent@1.2.0` 本地复核：`replaceable` 作用域（`docs/sdk.md:112`）、`tool_call` 可改写/阻止（`docs/extensions.md:106`）、扩展须 `export default function (pi: ExtensionAPI)`（`docs/extensions.md:15`）、入口 `dist/index.d.ts` 不导出 `Type`（所以工具 schema 要自己 `import { Type } from "typebox"`，并按 `docs/packages.md:80-88` 把 typebox 声明为 `peerDependencies: "*"`，不要 bundle）。

对照：本仓库的引用链没有断，是因为所有 hermes 结论都同时落成了**文档 + 提交**；如果你要在 issue 里复现 hermes 的行为，得先 `npm i pi-hermes-memory@0.9.10`。

## 五、一句话

**hermes + 窄插件 ≠ 多租户 hermes**：泄露发生在进程常量与提示路由这两个适配器够不到的层面。`scopedMemory` 做的是把同一个模式重画在租户边界之内，而不是给 hermes 打补丁——代价是明确放弃它的检索与巩固质量，收益是它能在多用户进程里被安全装载，并且能作为一个不含业务知识的独立包发布。
