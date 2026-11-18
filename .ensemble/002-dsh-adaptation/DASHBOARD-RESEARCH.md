# DSH ensemble 专用看板：既有 Markdown 的只读视图

本笔记只做设计调研。DSH 源码基线为 `39163dd30f703a79079e2d2446545cff3c453738`，已用 `git rev-parse HEAD` 核对；研究目录为 `/home/vcup/projects/deepseek-harness`。本轮没有实现、安装、构建、运行测试或验证浏览器集成。以下将“源码已有能力”与“建议实现行为”分开说明。

## 结论与最小范围

**首版推荐专用 right sidebar resource tab：用户从现有文件树或对话文件链接打开既有状态文件，直接看到 ensemble 看板。** 它消费普通 Markdown，沿用 DSH 的 `file` resource 和 `workspaceFiles` 只读接口。新增的 tab `kind` 只是插件内部的 UI 注册键，不是文件类型、文件协议或持久化数据格式。

不要首版同时建设主面板、invocation 索引和另一套控制台。当前需求是理解一次 ensemble 的产出与依据，右侧局部视图已经完整：总览 → 尝试及差异 → 决策与证据 → 候选与检查 → 下一步；宽表在窄栏展开为卡片。现有侧栏支持浮动、分栏与全屏，视图无需自己复制窗口系统。其动作接口见 [service.ts:155–195](</home/vcup/projects/deepseek-harness/packages/client/ui-sidebar-right/src/client/service.ts#L155-L195>)，全屏/浮动事实由 [slots.ts:184–208](</home/vcup/projects/deepseek-harness/packages/client/ui-sidebar-right/src/client/contract/slots.ts#L184-L208>)提供。

专用插件的价值在于把“哪些尝试带来不同信息、哪些结果改变交付物、哪个候选被什么检查支持”放到同一可扫描视图，并保留每项原文出处。它不需要成为执行器，也不需要把 Markdown 升级成数据库。

首版完整交付边界是：精确路由一个既有状态文件；普通读取；来源可追溯的五区展示；看板/原文切换；手动刷新与已有文件变化感知；明确的 unknown、缺失、读取失败和不完整内容状态；点击证据按原 Session 打开。任务分派、运行模型、修改状态、自动判定交付完成、跨 invocation 分析均不在这一最小范围内。

## 现有内容足以支撑什么

[STATE-TEMPLATE.md:3–5](</home/vcup/projects/vcup-skills/skills/ensemble/STATE-TEMPLATE.md#L3-L5>)规定每次调用独立目录，状态是紧凑恢复面而非工作流水账；[第 10–36 行](</home/vcup/projects/vcup-skills/skills/ensemble/STATE-TEMPLATE.md#L10-L36>)已经提供看板所需的主要分区。看板应直接解释这些普通标题、列表和表格。

| 看板区域 | 既有 Markdown 来源 | 展示规则与信息限度 |
|---|---|---|
| 总览 | 标题、Lifecycle、Requested deliverable、Subject and boundary、Required coverage、Completion evidence | 展示所记录的目标、边界和完成证据。Lifecycle 是文档声明，不是实时进程状态；缺项显示 unknown。 |
| 尝试 / 模型 / 差异 | Contributions 表的 Attempt、Assigned coverage、Material difference or redundancy、Status、Result / evidence pointer | 保持原文与原顺序。差异可来自模型、角色、方法、资料、观察角度或有意重复；不要求固定角色或代数。只有明确记录模型时才单独显示模型，否则显示“模型：unknown（未记录）”，原差异文字仍完整可见。 |
| 采纳与证据 | Decisions and findings 的普通条目 | 展示发现、决定、依据及影响。只有文中明确 accepted/rejected/unresolved 或清楚写明采纳/拒绝时才加对应标记；没有逐项关系时不把某次尝试连到某个决定。 |
| 候选与检查 | Candidate、Observed checks、Unavailable critical checks、Unresolved choices or risks | 将候选标识和已记录检查放在一起。没有检查与候选关系、时间或命令详情时显示 unknown；不把一句“passed”升级为当前候选已验证。 |
| 下一步 | Next action、Blockers | 保留单个下一步和阻塞原文。缺项不是“无阻塞”；明确写 none 才显示“文档记录无阻塞”。 |

实际样例 [001 的状态:1–36](</home/vcup/projects/vcup-skills/.ensemble/001-portable-package/STATE.md#L1-L36>)可直接呈现：completed 的声明、四条 returned contribution、五条决策/发现、候选 `95ebb1d`、测试和 smoke 的文字记录、delivered。**该样例没有模型身份、每次尝试的耗时/成本、逐项采纳关系、每项检查的时间戳，不能从 `upstream research`、`architecture audit` 等名称猜模型或角色。** 四条 returned 也不等于四条 accepted。

模型异构应“可观察而非强制编排”：直接突出已记录的 Material difference or redundancy，允许明确的模型名称并列；没有写模型就说明未记录，不给整次调用贴“异构成功/同构失败”标签。[ensemble 方法:21–35](</home/vcup/projects/vcup-skills/skills/ensemble/SKILL.md#L21-L35>)把模型列为多种差异之一，并强调用观察处理分歧、不能投票替代证据。看板不添加固定模型角色、轮次、树形谱系或多数票分数。

如果用户以后希望模型和采纳关系更容易扫描，只建议在**原有 Markdown** 的差异单元格补一句“模型为……，采用……方法”，或添加人可读的“模型”普通列；决策条目补“采纳 attempt A 的……，证据为……，影响为……”。这些都可选，不要求 machine tag、隐藏注释、frontmatter、JSON/YAML 边车、schema version 或另一个文件。普通自由文字始终是可展示的有效内容，缺少新增列不能使旧文档无效。

## 展示入口：需要区分两层预览接口

### 为什么不直接注册 document renderer

源码确实有 `ctx.documentPreviews.register(definition)`，并通过 `sidebar.right.tab.document` 派发正文。定义支持 `extensions`、`priority`、`loading: 'text-pages' | 'bytes-complete' | 'renderer'`，但**没有按目录或内容判断的 predicate**；匹配先取 basename 再按后缀排序。见 [registry.ts:6–53](</home/vcup/projects/deepseek-harness/packages/client/ui-sidebar-documentpreview/src/client/document/registry.ts#L6-L53>)。

因此，注册 `extensions: ['md']` 会成为所有 Markdown 的候选，且外部 extension 默认优先于 builtin；`extensions: ['state.md']` 实际查找 `*.state.md`，并不匹配文件名 `STATE.md`。依据是 [suffix.ts:20–35](</home/vcup/projects/deepseek-harness/packages/client/ui-sidebar-documentpreview/src/client/document/suffix.ts#L20-L35>) 的 `name.endsWith('.' + extension)`。不应为适配该 seam 改名、造后缀或接管全部 Markdown。

内置 Markdown 注册范例位于 [markdown/index.ts:16–30](</home/vcup/projects/deepseek-harness/packages/client/ui-sidebar-documentpreview/src/client/markdown/index.ts#L16-L30>)。它能复用分页加载，但这不意味着 ensemble 应深挂或替换它。若未来 DSH 为 document renderer 增加精确路径 predicate，才重新比较这个 seam。

### 推荐的外层 resource tab 已有精确筛选能力

`ctx.sidebarRightTabs.register` 的 `SidebarRightTabDefinition` 支持 resource-address `patterns` 和同步、便宜的 `canOpen(address)`，然后按优先级、模式长度、注册顺序选择；正文注册到 `sidebar.right.pane.tab`，key 为 definition 的 `id`，slot 为 session scope。见 [tab-registry.ts:94–138](</home/vcup/projects/deepseek-harness/packages/client/ui-sidebar-right/src/client/tab-registry.ts#L94-L138>)及 [slots.ts:52–78](</home/vcup/projects/deepseek-harness/packages/client/ui-sidebar-right/src/client/contract/slots.ts#L52-L78>)。

建议的精确路由：

1. `patterns` 只圈定既有 `dsh-resource://file/session/…` 地址。
2. `canOpen` 使用公开的 `parseFileAddress`，要求 `scope === 'session'`，在解码后的路径段中只接受以 `.ensemble/<数字前缀>-<slug>/STATE.md` 结束的既有布局；相对路径和同布局绝对路径均可。拒绝含歧义控制字符、无法解码或未规范化点段的候选，交还普通预览。不要对整个编码 URL 做一个随意的正则，也不要在 predicate 内读文件。
3. 目录形状只是识别当前已有文件的兼容约定，不是 ensemble 方法在其他 harness 上成立的前提。合法路由只表示“适合这种视图”，不是读取授权或可信内容证明。即使文件为空、老格式或内容不符，正文也显示原文和无法提取原因，保持用户可恢复。
4. 独立 id/kind，默认 extension 优先级只覆盖匹配文件；不覆盖内置 `text` kind。普通文件预览仍以 fallback 接受 session file 地址，现有范例见 [definition.ts:45–54](</home/vcup/projects/deepseek-harness/packages/client/ui-sidebar-documentpreview/src/client/definition.ts#L45-L54>)。

这是**同一个文件的另一个专用视图**，不是新资源 provider。已有 `file` provider 不可重复注册同一 protocol，资源契约见 [resources/contract.ts:70–100](</home/vcup/projects/deepseek-harness/packages/client/resources/src/client/contract.ts#L70-L100>)。不需要注册 `ensemble://`，也不需要新 Host endpoint。

首版入口就是已有文件树和普通文件链接；读其他 invocation 时继续选择其他状态文件，不自行扫描、生成索引或选“最新即当前”。侧栏文件浏览已有读目录、搜索和打开 resource 的实现范例：[ui-sidebar-files/index.ts:64–90](</home/vcup/projects/deepseek-harness/packages/client/ui-sidebar-files/src/client/index.ts#L64-L90>)、[FilesBody.tsx:44–53](</home/vcup/projects/deepseek-harness/packages/client/ui-sidebar-files/src/client/FilesBody.tsx#L44-L53>)。

### 不选主面板的具体理由

DSH 的所谓 workspace 看板应落在 `main` keyed slot 加 `sidebar.panellist`，并不存在这里可直接引用的通用 `workspace.panels` 注册接口。主面板 `main` 实际为 root scope，除了 conversation 之外没有 Session binding；见 [ui-layout/index.ts:71–75](</home/vcup/projects/deepseek-harness/packages/client/ui-layout/src/client/index.ts#L71-L75>)。注册范例可参考 [插件管理页:129–173](</home/vcup/projects/deepseek-harness/packages/client/ui-plugin-manager/src/client/index.ts#L129-L173>)。

主面板适合未来真实出现的跨 invocation 总览、比较或长驻工作区视图，但首版会额外承担 Session 选择、工作目录归属、无会话状态与文件导航。尤其全局面板在屏时右侧 `mounted` 为 undefined；不能直接假设 `ctx.sidebarRight.openResource()` 在主面板里可用，见 [service.ts:215–243](</home/vcup/projects/deepseek-harness/packages/client/ui-sidebar-right/src/client/service.ts#L215-L243>)。右侧 tab 已带文件身份和所在 Session，宽表可以变卡片，所以这里不值得加这一层。

右侧 tab 的代价也明确：**它不会自动继承内置 TextPreview 的分页与内容 store。** 专用插件需写自己的小型读取/刷新实现，复用公开 Remote 与 resource interfaces，而非导入私有 `textFace`。内置预览把文件 metadata 与内容读取分开的现成范例见 [rpc.ts:1–7](</home/vcup/projects/deepseek-harness/packages/client/ui-sidebar-documentpreview/src/client/rpc.ts#L1-L7>)。这一代价比首版建设主面板和导航系统更小。

## 可实现的最小结构与真实接口

建议一个专用插件包，Host 半部只承担标准装载身份，Client 半部注册 tab 并消费现成能力。已有纯 UI 插件的 Host `apply()` 可以为空，见 [ui-workspace/index.ts:1–9](</home/vcup/projects/deepseek-harness/packages/client/ui-workspace/src/index.ts#L1-L9>)。真实发布需要正常的 `dsh.client` 声明与 `exports['./client']`，现有包示例见 [package.json:16–48](</home/vcup/projects/deepseek-harness/packages/client/ui-workspace/package.json#L16-L48>)；Host 扫描这些声明的实际代码见 [modules/index.ts:891–917](</home/vcup/projects/deepseek-harness/packages/client/modules/src/index.ts#L891-L917>)。这些是插件打包元信息，不是为 ensemble 内容增加数据格式。

| 职责 | 已验证的 Interface / seam | 首版使用方式 |
|---|---|---|
| 装载与 slot | Client `apply(ctx)`、`inject`、`ctx.effect`、`ctx.slots.inject/register` | 声明所用服务，注册 tab 定义与 session-scoped body；插件卸载释放注册。参考 [预览插件:83–123](</home/vcup/projects/deepseek-harness/packages/client/ui-sidebar-documentpreview/src/client/index.ts#L83-L123>)。 |
| 文件身份 | `useTabInfo().tab.contentId`、`tab.signal`、`tab.visible`、`tab.navigation` | 以地址内的 Session/path 读取；不要把 slot 所在 Session 或浏览器 cwd 当源文件身份。来源规则见 [rpc.ts:56–71](</home/vcup/projects/deepseek-harness/packages/client/ui-sidebar-documentpreview/src/client/rpc.ts#L56-L71>)。 |
| 读取 | `ctx.remote.workspaceFiles.read(sessionId, path, { offset }, signal)`，返回 `RemoteResult<WorkspaceFileText>` | 从第 1 行读到 eof；同一版本再解析；检查 ok/failure，不能把失败当空文件。客户端契约及绑定见 [rpc.ts:15–46](</home/vcup/projects/deepseek-harness/packages/client/ui-sidebar-documentpreview/src/client/rpc.ts#L15-L46>)、[第 74–81 行](</home/vcup/projects/deepseek-harness/packages/client/ui-sidebar-documentpreview/src/client/rpc.ts#L74-L81>)。 |
| 文件变化 | 全局标准 `useResource<'file'>(address)` 返回 metadata 快照 | 订阅同地址版本变化，通知重新读或自动刷新；它不是文件文本，也不保证 watcher 当前健康。契约见 [resources/contract.ts:38–62](</home/vcup/projects/deepseek-harness/packages/client/resources/src/client/contract.ts#L38-L62>)。 |
| 手动刷新 | `tab.actions.bindCommands({ refresh })` | 顶部刷新按钮和侧栏已有刷新快捷键走同一个动作。接口见 [slots.ts:149–173](</home/vcup/projects/deepseek-harness/packages/client/ui-sidebar-right/src/client/contract/slots.ts#L149-L173>)。 |
| 证据跳转 | `tab.actions.openResource(sessionFileAddress(sourceSession, path), { params: { line } })` | 通过 tab 自身动作保持所在会话和 pane，不用全局当前会话猜目标；文件地址保留源 Session 作为读取授权上下文。 |
| 普通 Markdown | 公开 `MarkdownText`、`MarkdownDelegateProvider` | 展示普通条目及原文预览，绑定本视图的文件 opener。公开导出见 [ui-primitives/index.ts:121–128](</home/vcup/projects/deepseek-harness/packages/client/ui-primitives/src/index.ts#L121-L128>)。 |

实现时让一个“文件快照 → 看板”Module 对外只接收原文、来源身份与当前加载状态，产出带原文位置的展示值；读/订阅/取消放在 Client adapter 内。解析的 Interface 不需要变成公开持久化 schema；内存里的对象、行号与诊断只是渲染结果。独立纯解析与 UI adapter 的 seam 能让畸形输入、unknown 和候选绑定通过小接口验证，没必要暴露一组新的 ensemble RPC。

## 解析与展示：宽容读取，不偷偷建立第二协议

- 使用 GFM AST 解析普通 headings、list items、strong labels、tables，保留原始文本及 source position。不要按 `split('|')` 拆表，因为转义管道、行内格式和链接都可能存在。DSH 的 GFM 实现确实使用 `mdast-util-from-markdown` / `mdast-util-gfm`，见 [parse.ts:11–35](</home/vcup/projects/deepseek-harness/packages/client/ui-primitives/src/markdown/parse.ts#L11-L35>)；该解析函数不是上述公开导出的 Interface，插件可采用同类公开依赖，不能把私有源码深导入当稳定能力。
- 已知模板按普通分区标题和表头提取，忽略无语义的大小写、空白和强调差异；保持同一分区中自由段落。只有已观察到的别名才做有限兼容，不凭空宣称支持所有历史格式。本次只验证了当前模板与 001 样例，没有穷举历史修订。
- 没有模型列时，直接展示整段差异文字；明确的模型列可以作为便利展示，但不要求它存在，也不从模型名称模式猜 provider。决策没有显式 disposition 时显示“处置：unknown”，原文仍显示在决策区。
- 未识别的新节、旧版字段或附加列不丢弃，展示在原文/其他内容中；同名字段冲突时展示两段和冲突提示，不采用“最后一项胜出”的隐藏规则。占位符、空单元格和缺项不可转成成功或 none。
- 畸形 Markdown 常会退化成普通段落而不是抛异常；无法可靠提取的区域显示“结构未识别”，保留原文。整体解析失败也可显示带行号纯文本；不要求用户迁移文档才能打开。
- 五区中每个提取值都能定位到当前源文件的行；点击本文件出处时切换本 tab 的“原文”视图并滚动，不再走 resource 路由导致重新回到看板。这里的“原文”保留字面文本，另可复用 MarkdownText 做阅读预览。
- 不自动解析自然语言为执行计划，不自动执行 Result 中的命令，不以 attempt 数量生成完成百分比。状态计数至多是“文档记录的 returned 数”，不能代表充分覆盖或实际完成。

## 刷新、快照、一致性与异常

**首版呈现的是文档快照，不是 agents 的实时控制面。** 顶部显示源文件、源 Session、最后成功读取时间、刷新中/失败；文件中写 running 只能标为“文档记录 running”。浏览器读取时间不是最后修改时间，也不是检查执行时间。文件 `version` 是 opaque token，不能解析成时间，依据 [fs/types.ts:28–44](</home/vcup/projects/deepseek-harness/packages/fs/fs/src/types.ts#L28-L44>)。

已有刷新链是：文件系统 watch 或 `fs/observed` → `workspaceFiles.changes` 的 ready/change → Client file provider 重做 stat → `useResource` 版本变化 → 视图重读内容。Host 的实际 `changes` 使用 `ctx.fs.watch`，见 [changes.ts:39–107](</home/vcup/projects/deepseek-harness/packages/api/workspace-files/src/changes.ts#L39-L107>)；Client 先等待 watch ready 再 stat，并在已知版本变化时重读 metadata，见 [provider.ts:58–109](</home/vcup/projects/deepseek-harness/packages/api/workspace-files/src/client/provider.ts#L58-L109>)。

建议首版复用 `useResource`，收到新版本时合并短时间内的重复通知，再读取完整新快照；保留一个显式“刷新”动作作为可靠退路。暂时不要为“live”徽章再开一套重复 watcher：

- `ResourceSnapshot.status === 'live'` 只表示最近的 ok frame；资源流结束仍保留上次状态，见 [resources/contract.ts:70–84](</home/vcup/projects/deepseek-harness/packages/client/resources/src/client/contract.ts#L70-L84>)。
- watch 初始化失败时，file provider 可以 stat 一次后结束；watch 后续终止时，ChangeFeed 安静结束并留下最后 metadata，见 [provider.ts:69–74](</home/vcup/projects/deepseek-harness/packages/api/workspace-files/src/client/provider.ts#L69-L74>)、[change-feed.ts:153–191](</home/vcup/projects/deepseek-harness/packages/api/workspace-files/src/client/change-feed.ts#L153-L191>)。Host 明确以 `workspace-file/watch-unsupported` 报告监听不可用，但当前 file provider 不把订阅健康度完整传给 useResource；这种情况下必须仍允许手动读取。因此首版只写“文件快照；自动检测尽力而为”，不写“实时连接正常”。手动刷新直接读文件，不依赖 metadata token 必须变化。
- 已有 stream supervisor 在重连后的 ready 会触发 refresh，见 [change-feed.ts:158–165](</home/vcup/projects/deepseek-harness/packages/api/workspace-files/src/client/change-feed.ts#L158-L165>)。如果以后产品要求显示订阅健康度，可直接消费公开 `workspaceFiles.changes` + `remote.$stream` 并显式处理终止；已有绑定范例见 [files/face.ts:44–79](</home/vcup/projects/deepseek-harness/packages/client/ui-sidebar-files/src/client/face.ts#L44-L79>)。这不是首版必需能力。
- 本地 backend 监听文件父目录来感知替换，目录观察只覆盖 direct entries，见 [fs-local/index.ts:76–95](</home/vcup/projects/deepseek-harness/packages/fs/fs-local/src/index.ts#L76-L95>)。基础 FileSystem 默认不支持 watch，见 [fs/index.ts:109–122](</home/vcup/projects/deepseek-harness/packages/fs/fs/src/index.ts#L109-L122>)；当前 [SSH backend](</home/vcup/projects/deepseek-harness/packages/ssh/fs-ssh/src/index.ts#L16-L124>)没有覆盖 watch，不能承诺 SSH 实时更新。容器部署的具体 backend 与映射未在本笔记验证。

内容一致性的建议实现规则：

1. 读取期间保留上一份成功快照并标明“更新中”，不逐行替换五个分区；完成到 eof 后一次发布。请求有 generation/取消机制，旧响应不能覆盖新选择、刷新或关闭后的视图。`tab.signal` 只在记录消失或插件卸载时 abort，不在隐藏/切会话时 abort；需额外处理 body 卸载、可见性与更新请求的生命周期，见 [slots.ts:196–207](</home/vcup/projects/deepseek-harness/packages/client/ui-sidebar-right/src/client/contract/slots.ts#L196-L207>)。
2. 各分页必须具有相同 version，不一致就丢掉整次读取并从首行有限重试。内置预览已有相同原则，见 [face.ts:146–165](</home/vcup/projects/deepseek-harness/packages/client/ui-sidebar-documentpreview/src/client/face.ts#L146-L165>)。首版状态文件通常很小，但仍需有限总字节/页数预算；达到预算显示“不完整”，不能当完整看板。
3. `read` 返回的是读取前 stat 的版本，不是事务快照，见 [workspace-files/index.ts:238–259](</home/vcup/projects/deepseek-harness/packages/api/workspace-files/src/index.ts#L238-L259>)。建议读完再 stat 比较；变化时有限重试，避免混合版本。它只能缩小竞态，不能证明自然语言作者已经写完。
4. 普通编辑器/脚本可以截断或分段写入。短暂空文件、半行表格、未闭合语法先标“可能更新中/结构未识别”，短暂合并通知后重试；仍存在则如实显示当前不完整内容和 unknown。上一份成功快照若保留，必须明确是旧快照，不能无限冻结它冒充最新。仅靠 debounce 或两次相同 stat 无法区分“稳定但还没写完”与“作者本来就省略字段”。
5. 区分 not-found、权限拒绝、非 UTF-8/二进制、非普通文件、超上限、网络失败和未识别结构；错误均有恢复入口。Host 默认单页 2 MiB / 5000 行、完整 bytes 32 MiB，是部署默认而非插件应假定的常量；见 [workspace-files/index.ts:192–203](</home/vcup/projects/deepseek-harness/packages/api/workspace-files/src/index.ts#L192-L203>)及 [types.ts:206–229](</home/vcup/projects/deepseek-harness/packages/api/workspace-files/src/types.ts#L206-L229>)。

## 文件世界、权限与链接

**Host 插件运行位置、浏览器资源地址、文件系统执行世界是三个不同概念。** `ctx.fs.processPath(target)` 返回 backend 执行世界里的绝对路径；`processPathFromHostPath` 默认没有映射。见 [fs/index.ts:151–181](</home/vcup/projects/deepseek-harness/packages/fs/fs/src/index.ts#L151-L181>)。不要用 Node `fs` 直接读猜测路径，不要把 `FsTarget.targetKey` 当宿主机路径，不要用浏览器 `file://` 打开执行世界文件。opaque target 的定义见 [fs/types.ts:11–16](</home/vcup/projects/deepseek-harness/packages/fs/fs/src/types.ts#L11-L16>)。

`workspaceFiles` 使用现有 `ctx.fs`，文件 scope 从 Session header 的 cwd 取得，冷 Session 可查持久 header，不必激活 Agent；没有 cwd 时使用 sandboxPolicy.workspaceRoot 作为相对基准。见 [workspace-files/index.ts:215–234](</home/vcup/projects/deepseek-harness/packages/api/workspace-files/src/index.ts#L215-L234>)，相关源码测试见 [scope.spec.ts:50–69](</home/vcup/projects/deepseek-harness/packages/api/workspace-files/tests/scope.spec.ts#L50-L69>)，本轮没有执行该测试。Session id 提供路径基准与 Remote resource 身份，不等于凭一个 id 就会自动切到任意容器文件系统。

权限也不能混淆：lookup 声明 `resource: 'session'`；Gateway 对非 owner 先用 action + resource 做访问判定，再 resolve lookup，拒绝返回 `remote-access/denied`，见 [gateway/index.ts:760–806](</home/vcup/projects/deepseek-harness/packages/api/gateway/src/index.ts#L760-L806>)。这是普通 browser viewer 的 Remote 授权，不是 agent tool 的 Session sandbox 策略：此处 `read` / `locateFile` 直接调用现有 `ctx.fs`，没有经过 `tool-fs` 的工具调用与 Session 策略解析。路径匹配和前端按钮不是授权判断，插件必须沿原 Remote 链读取；不能用新 Host 直读去绕过被拒绝的调用。若 UI 检查能力，需检查**地址内源 Session**的 read/stat/changes，不能只查 slot 的 Session。

也不要误写“所有读都限在 workspace 内”：实际 regular-file read/stat 跟随 backend 的读权限，可读 workspace 外文件；list/search 保持 workspace scope，文件 watch 可跟随读权限，目录 watch 保持 workspace scope。分别见 [workspace-files/index.ts:1–12](</home/vcup/projects/deepseek-harness/packages/api/workspace-files/src/index.ts#L1-L12>)、[第 390–412 行](</home/vcup/projects/deepseek-harness/packages/api/workspace-files/src/index.ts#L390-L412>)。源码开头关于 change observations 的概括不如后面的实现精确，应以后者为准。本地 fs-sandbox 只约束 mutation，读透传，见 [fs-sandbox/index.ts:1–24](</home/vcup/projects/deepseek-harness/packages/fs/fs-sandbox/src/index.ts#L1-L24>)。

读取会先 lstat 拒绝 final-component symlink，再 resolve/stat 检查 regular file，见 [workspace-files/index.ts:441–492](</home/vcup/projects/deepseek-harness/packages/api/workspace-files/src/index.ts#L441-L492>)。这不是“拒绝所有祖先 symlink/解决全部 TOCTOU”的保证。推荐视图只自动读被选中的状态文件，不跟随文档内容递归抓证据；若将来要求一个比现有 backend 更窄的严格 read-containment 策略，须单独设计 Host 约束，不能拿 canOpen 冒充安全措施。

证据链接的首版规则：

- 标准相对 Markdown 链接按**源文档所在目录**解析，绝对路径保留执行世界含义；不会因为第一次解析失败就悄悄改按 repo root 重试。现有样例用行内代码写 `adapters/omp/index.test.ts`，本来没有链接和基准声明，应原样显示，不猜文件。确有需要时作者可在原 Markdown 增加普通链接。
- 用 `sessionFileAddress(sourceSession, resolvedPath)` 保留身份并逐段编码空格、`#`、`?`，不要拼 URI 字符串；构造/解析实现见 [file-address.ts:59–110](</home/vcup/projects/deepseek-harness/packages/util/workspace-path/src/file-address.ts#L59-L110>)。它本身不 resolve `.`/`..`；路径解析应遵循源文件执行世界的 POSIX/Windows 语义，最终读取仍交 Host。引用其他 Session 的内嵌 resource URI不自动当作当前文件链接。
- 普通本地链接通过 `MarkdownDelegateProvider.openFile` 打开，支持 `#L24`、`:24` 等 first-line 导航；不存在 opener 时本地链接保留为文本。公开契约见 [MarkdownDelegate.tsx:48–55](</home/vcup/projects/deepseek-harness/packages/client/ui-primitives/src/markdown/MarkdownDelegate.tsx#L48-L55>)，行号和控制字符处理实现见 [file-link.ts:12–44](</home/vcup/projects/deepseek-harness/packages/client/ui-primitives/src/markdown/file-link.ts#L12-L44>)。
- MarkdownText 不把 raw HTML 执行为 markup，已有协议过滤，见 [MarkdownText.tsx:157–187](</home/vcup/projects/deepseek-harness/packages/client/ui-primitives/src/markdown/MarkdownText.tsx#L157-L187>)。其默认 URL 规则是禁用 `javascript:`、`vbscript:`、`data:`、`blob:` 等，并非所有未知 scheme 的 allowlist，见 [render.tsx:55–71](</home/vcup/projects/deepseek-harness/packages/client/ui-primitives/src/markdown/render.tsx#L55-L71>)。看板自身的证据 opener 只支持普通文件与 HTTP(S)，其余按文本呈现；不执行 shell、命令链接、HTML iframe 或 code fence。这是插件需实现的展示规则，不能只安装 openExternalLink callback 就宣称已限制所有 scheme：该 callback 仅接收 HTTP(S)。在本地渲染投影中将其他 URL 节点降为文本、图片改为可点击引用，可避免默认远程图片加载；不改源 Markdown。原文模式直接显示字面文本。

## 与 DSH 任务板表达不同

DSH 已有 TeamBoard：从 root Session 的 `agentTeam` projection 读 tasks，展示 pending/in_progress/completed、owner、subject、description，并统计任务状态；见 [TeamBoard.tsx:19–37](</home/vcup/projects/deepseek-harness/packages/client/ui-agent-team/src/client/TeamBoard.tsx#L19-L37>)、[第 81–110 行](</home/vcup/projects/deepseek-harness/packages/client/ui-agent-team/src/client/TeamBoard.tsx#L81-L110>)。入口在 subagent 菜单 footer，见 [mount.ts:71–73](</home/vcup/projects/deepseek-harness/packages/client/ui-agent-team/src/client/mount.ts#L71-L73>)。

任务板回答“谁负责哪项工作、任务推进到哪里”。ensemble 看板回答“不同尝试给出了什么、哪些观察影响决定、一个候选得到了什么验证”。任务 completed 不自动意味着贡献 accepted，代理 idle/running 不自动意味着文档 Lifecycle 已改变。首版不把 task id、agent 名称和 attempt 名称作隐式关联，不从实时 projection 回填历史模型；将来有明确普通文字指针时，可做带来源标记的可选跳转，但不改变 Markdown 快照的含义。

## 验证边界与后续实现验收

**已由源码验证**：Host/Client 双半插件与装载声明；slot 注册；right sidebar 的路径 predicate、session body、文件地址和生命周期；现有 `file` provider；普通 read/stat/list/search/changes；watch 降级；Remote 的 Session 授权顺序；公开 Markdown 展示与链接 delegate；现有状态模板足够产生基本看板。

**尚未验证集成**：新插件能否在目标 DSH 已安装版本正确打包装载；实际 GUI 文件树/对话 opener 对所选地址的端到端路由；关闭/恢复 tab 后不同插件 kind 的恢复行为；相对路径在 Windows、容器/SSH 与当前部署的具体映射；目标部署的 watch 可用性及权限撤回后的 UI 更新；GFM 提取在完整历史样本上的兼容性。源码提供 seam，不等于这些组合已经运行通过。

未来获准实现后，应以既有模板和 001 样例作为固定输入，再验证有意义的失败面：空/截断文件、转义管道和链接、旧标题/附加列/冲突字段、缺模型/缺采纳关系、分页 version 变化、晚到响应、watch 不支持、断线/权限拒绝、final symlink、带空格和编码字符的证据路径、跨 Session 同路径、关闭与隐藏 tab。每条都应证明“保留原文和不确定性、没有误读取或误报完成”，而不只是镜像实现细节。本轮只记录这些验收条件，未创建或运行测试。

最终首版决策：**一个专用右侧 resource tab，读取一个已有 Markdown，呈现有出处的 ensemble 看板；不新增持久化格式，不引入独立执行状态，也不同时建设主面板。**
