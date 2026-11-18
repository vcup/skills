# Ensemble: 面向新版 DSH 的方法与插件设计

- **Lifecycle:** completed
- **Requested deliverable:** 固定拉取后的可写源码基线，交付仅面向新版 DSH 的 ensemble 方法适配和已确认插件的具体实现设计。
- **Subject and boundary:** 原生 subagent 树与可选 Team 任务协作；本轮设计，不实现、安装插件或更换 GUI 构建；保留 OMP 消费者和用户暂存改动。
- **Required coverage:** 方法独立性与多维异构、原生模型/effort/preset 选择、用户技能与 Host 参考资料、既有 Markdown 看板、仓外打包及真实组合验收。
- **Completion evidence:** 主设计、执行设计、插件实现设计、两份新版复核与上游基线已整合；8 份文档的 133 个文件/行号引用及格式检查通过，成员复核未发现重大接口问题。

## Contributions

| Attempt | Assigned coverage | Material difference or redundancy | Status | Result / evidence pointer |
|---|---|---|---|---|
| lead / task-11 | 源码复制/拉取、Host 技能与包交付、综合取舍 | 本地 Git 观察、公共技能接口和发布机制；不计为新的盲评 | returned | [源码基线](<UPSTREAM-BASELINE.md>)、[执行设计](<EXECUTION-ADAPTER-DESIGN.md>) |
| execution / task-12 | 新版创建、选型、Team、上下文和恢复 | 原生执行与授权链追踪；同模型；接续既有研究，不重复计作独立首轮 | returned | [新版执行复核](<NEW-DSH-EXECUTION-RESEARCH.md>)；已复核最终主/执行设计 |
| dashboard / task-13 | 新版 Client、文件与分发接口 | UI/文件时序与公开构建接口追踪；同模型；接续既有研究 | returned | [新版看板复核](<NEW-DSH-PLUGIN-RESEARCH.md>)；已复核最终 Client/发布设计 |

## Decisions and findings

- 采用官方 master 的 `39163dd30f703a79079e2d2446545cff3c453738`；pull 成功但新增提交为零，变化是支持目标收敛，不是源码升级。
- 不再实现旧 Team bridge；不另写 spawn、模型路由器、成员 roster、任务镜像或恢复数据库。
- 同模型的方向、方法、工具和真实 effort 差异可以有价值；异构性、冗余和独立性分别判断。
- 确认需要 Host 用户技能、窄包内参考读取和 Client 只读看板；执行选择复用原生工具/设置。
- 继续使用既有普通 Markdown，不增加 invocation 文件类型、frontmatter 或状态协议。
- 看板来源固定后读原生有界单页；非 EOF 仅展示已读原文及不完整提示，post-stat 失败不宣称当前。仓外浏览器产物采用公开 lazy-CJS/CSS metadata 机制。

## Candidate and verification

- **Candidate:** [综合设计](<DESIGN.md>)、[执行适配](<EXECUTION-ADAPTER-DESIGN.md>)和[插件实现设计](<PLUGIN-IMPLEMENTATION-DESIGN.md>)的 2026-11-17 新版专用修订。
- **Observed checks:** 独立 Git clone、官方 pull、SHA/默认分支/零差异与副本可写核验通过；副本工作树干净。具名成员完成各自研究与最终交叉审阅；133 个文件/行号引用（含映射至精确副本的 32 个固定上游引用）、引用定义、尾随空格和结尾换行检查通过；初检发现的一个越界行号已修正并重验通过。工作区与暂存区 diff whitespace 检查通过，用户暂存变更保留。
- **Unavailable critical checks:** 未实现产品，故尚无插件 Loader/Web 运行、真实多模型/effort 请求、打包安装和 OMP 回归证据；这些是实施验收项，不伪称已通过。
- **Unresolved choices or risks:** DSH API 预稳定；仓外浏览器产物须实测；文件变化订阅不保证实时快照；跨模型需要用户配置可用且获准的 routes。

## Next

- **Next action:** 设计已交付；实施按插件设计中的方法/发行骨架、Host、Client、真实组合和原生执行资格验收切片推进。
- **Blockers:** 无设计阻碍；实施测试仍待实际开发环境和获准模型配置。
