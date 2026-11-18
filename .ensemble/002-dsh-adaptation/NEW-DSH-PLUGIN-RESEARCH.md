# 新版 DSH：专用 ensemble 看板交付研究

## 结论与证据边界

目标是指定的未发布新版 DSH，专用插件已经确定；本文只给出 Client 看板、文件读取与发布闭包的落地设计，不增加旧 Team 兼容层，不重新讨论是否做插件。Host skill/provider/reference tool 及总包组织由 Lead 决定。

本次研究重新读取 `.scratch/extra-src/deepseek-harness` 新副本。`git rev-parse HEAD origin/master` 均为 `39163dd30f703a79079e2d2446545cff3c453738`，相对此前已知同一 SHA 的 `git diff --stat` 为空，工作树干净。因此这是对指定新目标的独立复核，**不是发现了源码接口变化**。本轮未运行安装、构建、测试、服务器或浏览器，也未修改该源码副本。以下“应/建议”是待实现设计，“源码”是已核对的行为；测试矩阵不是通过记录。

最小完整产品：在现有 `file` 资源上注册专用右侧资源标签页，只识别 ensemble 调用状态路径；从现有 Markdown 生成五部分只读看板；支持同标签页原文、证据导航、元数据触发刷新及始终可用的手动刷新；正确处理缺字段、半写入、权限/读取失败及卸载。没有额外状态数据库、JSON/YAML sidecar、Markdown schema/version、运行代理控制面或新资源协议。

Lead 当前包方向是 `@vcup/skills` 的 bare root Host entry 加 `./client`，由 bundle 插入 bare root row；Client factory 的 `id` 必须是 `@vcup/skills`，不能是 `@vcup/skills/dsh` 或 `@vcup/skills/client`。OMP 入口不参与本看板设计。

## 1. 已验证的公开接口与限制

| 事实 | 新副本依据 | 对实现的约束 |
|---|---|---|
| `SidebarRightTabDefinition` 有 `patterns`、同步 `canOpen`、`priority`、实现 `id` 与 UI `kind`；`contentId` 是原资源地址 | [标签页定义:94–153](</home/vcup/projects/vcup-skills/.scratch/extra-src/deepseek-harness/packages/client/ui-sidebar-right/src/client/tab-registry.ts#L94-L153>) | 独立标签页可按路径识别，不必接管全部 Markdown；`kind` 不是磁盘格式 |
| 标签页公开入口导出类型；body/title 是 session-scoped slots | [公开入口:61–80](</home/vcup/projects/vcup-skills/.scratch/extra-src/deepseek-harness/packages/client/ui-sidebar-right/src/client/index.ts#L61-L80>)、[动作与生命周期:149–208](</home/vcup/projects/vcup-skills/.scratch/extra-src/deepseek-harness/packages/client/ui-sidebar-right/src/client/contract/slots.ts#L149-L208>) | 类型只作 type import；`tab.actions.openResource` 保留标签页所属 UI Session；文件地址中的 Session 才决定 Remote 读取作用域 |
| 普通文档预览是 `fallback`；内部 `documentPreviews` 只认后缀，没有路径 predicate | [文件 fallback:45–54](</home/vcup/projects/vcup-skills/.scratch/extra-src/deepseek-harness/packages/client/ui-sidebar-documentpreview/src/client/definition.ts#L45-L54>)、[后缀注册:9–32](</home/vcup/projects/vcup-skills/.scratch/extra-src/deepseek-harness/packages/client/ui-sidebar-documentpreview/src/client/document/registry.ts#L9-L32>) | 不注册 `extensions: ['md']` 劫持所有 Markdown；`state.md` 后缀也不是独占文件名 `STATE.md` 的机制 |
| `workspaceFiles.read` 是分页 UTF-8 文本；每页附 `absolutePath`、不透明 `version`、`offset/lines/eof` | [读取实现:192–259](</home/vcup/projects/vcup-skills/.scratch/extra-src/deepseek-harness/packages/api/workspace-files/src/index.ts#L192-L259>)、[返回字段:24–64](</home/vcup/projects/vcup-skills/.scratch/extra-src/deepseek-harness/packages/api/workspace-files/src/types.ts#L24-L64>) | 首版只读原生默认有界页；`eof: false` 不做完整投影；`version` 来自读前 stat，不是事务快照 |
| `useResource<'file'>` 提供元数据，不提供正文；终止流保留最后状态 | [资源状态:38–84](</home/vcup/projects/vcup-skills/.scratch/extra-src/deepseek-harness/packages/client/resources/src/client/contract.ts#L38-L84>)、[文件 provider:52–109](</home/vcup/projects/vcup-skills/.scratch/extra-src/deepseek-harness/packages/api/workspace-files/src/client/provider.ts#L52-L109>) | 复用现有资源缓存/订阅，再以 Remote 读取正文；`live` 不表示 watch 健康 |
| watch 起不来时可退为一次 stat；运行中终止也可能只留下旧元数据 | [首次 watch 失败:69–74](</home/vcup/projects/vcup-skills/.scratch/extra-src/deepseek-harness/packages/api/workspace-files/src/client/provider.ts#L69-L74>)、[流终止:153–191](</home/vcup/projects/vcup-skills/.scratch/extra-src/deepseek-harness/packages/api/workspace-files/src/client/change-feed.ts#L153-L191>) | 不能给“实时连接正常”绿灯；刷新按钮必须直接重读，不能等待下一条 watch |
| `parseFileAddress`、`sessionFileAddress`、`pathPartsOf` 是 browser-safe 公共函数 | [编码/解码:59–110](</home/vcup/projects/vcup-skills/.scratch/extra-src/deepseek-harness/packages/util/workspace-path/src/file-address.ts#L59-L110>)、[路径帮助函数:64–80](</home/vcup/projects/vcup-skills/.scratch/extra-src/deepseek-harness/packages/util/workspace-path/src/index.ts#L64-L80>) | 不手拼 resource URI，不从文件预览包深导入私有 path/link helper |
| `MarkdownText`、`MarkdownDelegateProvider` 是静态 ui-primitives 的公开导出 | [公共导出:116–128](</home/vcup/projects/vcup-skills/.scratch/extra-src/deepseek-harness/packages/client/ui-primitives/src/index.ts#L116-L128>) | 可以合法复用，但它们并非“所有内容严格无外部副作用”的现成包装 |
| 默认 Markdown 不执行 HTML，却允许 HTTP(S) 图片；URL sanitizer 是危险 scheme 黑名单 | [渲染说明:157–199](</home/vcup/projects/vcup-skills/.scratch/extra-src/deepseek-harness/packages/client/ui-primitives/src/markdown/MarkdownText.tsx#L157-L199>)、[URL 策略:55–81](</home/vcup/projects/vcup-skills/.scratch/extra-src/deepseek-harness/packages/client/ui-primitives/src/markdown/render.tsx#L55-L81>) | `openExternalLink` 只处理 HTTP(S)，不是全部 scheme 的安全过滤器 |
| 外部插件的 browser artifact 是 lazy-CJS factory，不是任意 ESM | [仓外插件说明:56–70](</home/vcup/projects/vcup-skills/.scratch/extra-src/deepseek-harness/docs/cookbook/adding-a-settings-card.md#L56-L70>)、[factory 包装:1134–1154](</home/vcup/projects/vcup-skills/.scratch/extra-src/deepseek-harness/packages/client/tsdown.client.ts#L1134-L1154>) | `clientBundle` 预设在上游源码树内，并未作为构建 SDK 发布；本包需自己的薄构建适配 |

## 2. Module 设计：三个私有模块，不新增公共 service

三个模块按变化原因划分，而不是每个页面区块建立一层 adapter。它们通过包内函数/回调组合；现有 DSH 已提供资源与 Remote capability seam，没有第二个消费者的看板 helper 不应升级成公共 Service Definition/Provider。

### 2.1 `EnsembleDocument`：Markdown 到保守展示投影

小接口为 `project(text)`，返回五区内容、原始文本/行范围、表格/字段识别诊断及仅用于展示的链接描述。该结果只在内存中存在，不是落盘 DTO，不提供序列化协议。模块隐藏 Markdown AST、标题/字段识别、重复项和缺项处理；不读文件、不碰 Cordis/React、不查 agent/model/task，不替用户判断证据是否有效。

使用维护中的 CommonMark/GFM 解析依赖，例如 `mdast-util-from-markdown`、`micromark-extension-gfm`、`mdast-util-gfm`；从第三方依赖直接打包，不借用 DSH 私有 `parseGfm` 或 `render`。上游也使用这些依赖，但其 [解析实现:11–35](</home/vcup/projects/vcup-skills/.scratch/extra-src/deepseek-harness/packages/client/ui-primitives/src/markdown/parse.ts#L11-L35>) 不在公共 Markdown 导出中。只需标准 GFM，不承诺复制其 CJK/math/Windows-link 私有扩展；无法解释的语法保留源文本，不静默丢失。

### 2.2 `EnsembleSnapshot`：一次文档读取的生命周期

小接口为“打开/观察元数据/刷新/取消本次读取”，由注入的 `read`、`stat`、时钟与声明 store actions 组合；外部不接触请求 generations、AbortController 或重试细节。源码入口通过 `ctx.remote.workspaceFiles` 创建窄回调；组件不接收 `ctx`、Remote service 或 `resources` service。

实例属于插件/标签页，不使用 module-global cache。以 UI Session 与 tab identity 分桶，同时明确记录资源地址携带的 **file Session**。声明 store 仅保存这个预览的瞬时读取结果和视图状态，不复制 Session/Team 业务状态，不持久化正文到布局或会话。可保留最后成功的预览以应对短暂重读错误，但必须区分当前读取状态与旧快照。

来源固定顺序：① `parseFileAddress` 得到 file Session 与作者路径，组件暂以原地址调用 `useResource`；② 独立调用 `remote.workspaceFiles.stat` 解析原路径，不等待 watch 成功；③ 仅该 stat 成功结果的 `absolutePath` 固定该 tab 的 `SourceRef = { fileSessionId, absolutePath }`，通过声明 store action 发布；④ `useResource` 转到 `sessionFileAddress(fileSessionId, absolutePath)`，本次唯一的 read page、post-stat、手动 refresh 和证据基准从此全用固定绝对目标。失败时保持未解析态，允许重试，不从当前 UI cwd 猜源文件。原始相对地址仍是 sidebar 内容身份，其后续元数据不得把已固定目标改到另一 cwd。不要关闭 sidebar 自己拥有的原始资源 pin，也不要声称相对/绝对地址必定被框架合并为一个底层 watcher。

首版按 Lead 的最小交付取舍，每次只调用一次 `read(fileSessionId, fixedAbsolutePath, {}, signal)`，继承原生 `maxLines/maxBytes`，不传自选 page size、不自动拼页。只有 `eof: true` 才生成完整五区投影；`eof: false` 显示“仅加载部分内容”及已加载的字面原文，不暗示已看到全体贡献/全部验证结果。读取后对同一绝对目标 stat；版本不同或 stat 失败时保留明确的过期/无法确认当前性提示，由用户手动刷新，不自动重试。每次刷新退休前一 generation，晚到结果不能覆盖新快照。读前/读后版本一致也仅缩小竞态，不能证明作者已完成一次逻辑更新。

源码的 [cutPage:112–165](</home/vcup/projects/vcup-skills/.scratch/extra-src/deepseek-harness/packages/api/workspace-files/src/index.ts#L112-L165>) 在页字节超过 `maxBytes` 时立即报 `workspace-file/too-large`，超过行窗口返回 `eof: false`。当前默认每页 2 MiB/5000 行，足够现有很小的状态记录；首版不是通用全文 reader。沿用已有 Host Config owner，不新增 Client `maxStateBytes`、配置 Remote、boot global 或私有配置对象。实现仍要测试默认页上限和部署扩大该上限时的解析/渲染性能；原生输入限额不自动证明主线程/UI 性能，超限错误也不得伪造部分成功内容。

`tab.signal` 只在 record 消失/插件卸载时 abort，不在隐藏或 Session 切换时 abort。首次版本保留默认 `keepMounted: false`；body 卸载可以取消其在途读取 generation，但 tab 存活时保留已解析 SourceRef/有限预览缓存，重新显示时再检查最新内容。真正 tab 结束或插件卸载要取消全部请求并清掉桶。不能依靠一个 React unmount 推断 Session 已结束。

刷新通过 `tab.actions.bindCommands({ refresh })` 同时绑定页面按钮与框架刷新动作；释放绑定时不得删掉新 body 的注册。元数据仅通过标准 `useResource` hook 输入；无自建轮询器、change stream、resource provider 或组件手工 subscribe。

### 2.3 `EnsembleTab`：注册、交互与安全输出

注册层用公开类型声明 `id: '@vcup/skills'`（包内如需多个独立类型，再明确唯一实现 id）与专用 `kind`，`priority: 'extension'`。使用覆盖 file address 的 pattern，然后由同步 `canOpen` 调用 `parseFileAddress`，只接纳 session scope 和 `.ensemble/<one-directory>/STATE.md` 布局；不在 `canOpen` 做 I/O，也不要求目录名满足新编号协议。具体 path spelling 只用于识别，读取时保留原始大小写与编码语义。非 ensemble Markdown 继续走内置 fallback。

body/title 通过 `ctx.slots.inject('sidebar.right.pane.tab', ...)` 与对应 title slot 注册，注册 disposer 归 effect。服务 `inject` 包含真正使用的 `slots`、`locale`、`sidebarRightTabs`、`remote`、`remote.workspaceFiles` 等；只为类型/框架 hook 合并声明引入的包不伪装成 runtime value dependency。组件 props 从标准 shares 派生，数据从 `useTabInfo`、`useResource`、声明的 `useStore` 等读，动作只用注入的普通回调和 tab actions。

视图使用共享 primitives、语义 token CSS Modules 和 typed locale 文案；不导入其他 feature 的组件/constants/stores。原始文档内容保持原样，不翻译或重写用户数据。标题、内容标签、未知/失败提示、按钮和无障碍名称是插件 locale-owned copy。

## 3. DOM 输出与证据链接：首版做可审计的保守视图

不把“React 自动转义”等同于链接安全。React 能让文本节点不执行 HTML，但不能替产品决定任意 URL scheme、远程图片及本地文件的激活策略。上游 `openExternalLink` 只覆盖 [HTTP(S) activation](</home/vcup/projects/vcup-skills/.scratch/extra-src/deepseek-harness/packages/client/ui-primitives/src/markdown/MarkdownDelegate.tsx#L34-L63>)；默认 sanitizer 对未列入黑名单的绝对 scheme 可放行。缺少 `fileImages` 或 `pathImages` 也不会禁用直接 HTTP(S) 图片。

首版明确采用同一个 GFM AST 的受限语义 React 输出：文本、标题、强调、列表、代码、表格；HTML 和不支持节点按源文本呈现。图片显示 alt/目标引用而不生成 `img`、网络请求或隐式 file media 请求；代码块只有文本，不执行、iframe、预览脚本或加载外部 renderer。链接先变成私有的“本地文件/HTTP(S)/同文档位置/不可激活”判别值，再交给按钮或安全 anchor。不得使用 `innerHTML`、`dangerouslySetInnerHTML`、未审计 HTML sanitizer 或 regex 改写 Markdown 来建立这条安全链。

这是刻意比通用 Markdown 更窄的输出，不是复制完整 Markdown renderer。公共 `MarkdownText` 仍可用于已明确定义安全要求的其他展示，但不能仅套一个 delegate 就宣称本看板拥有严格 URL allowlist；本版本不为“完整富文档预览”另造插件/包装层。始终可切换同 tab 的字面源文本行视图；`read` 返回按行组合且不保留末尾终止符，该视图不是字节级原件或取证副本。

链接规则：

- 只将实际 Markdown link/reference-link 当作可激活证据；inline code、普通路径文本、命令与 commit 字符串不猜成链接。现有 [调用状态:13–16](</home/vcup/projects/vcup-skills/.ensemble/001-portable-package/STATE.md#L13-L16>) 的证据多是 inline code/普通文本，不应靠猜测跳转。
- 本地相对目标基于固定 SourceRef 的文件目录。用公共 `pathPartsOf` 获得目录，对明确相对目标进行路径连接，允许正常 `../`；把该绝对形式交回 Host 解析，客户端不把它改基于当前 UI Session cwd。没有“失败再试 workspace root”的隐藏 fallback。
- 明确绝对路径不拼 source 目录；UI 读取仍使用 source 的 file Session。窗口当前 Session 与 file Session 不同，也不得换成当前 Session 读取。`sessionFileAddress(fileSessionId, targetPath)` 负责资源编码；`tab.actions.openResource(address, { params: { line } })` 负责从原标签页导航。传入的 line 类型取公共 `WorkspaceFileParams`，不深导入内置预览内部类型。
- 首版支持标准 Markdown URL 转义与 `#L24` / `#L24-L30`；`:24`/`:24-30`/`:24:5` 等扩展留待后续，不属于本版验收。链接分类由本模块拥有并测试，不导入未公开的 `parseFileLink`。行范围首先跳到起始行。带编码 `#`、`?`、空格的真实文件名必须与 fragment/query 区分，解码恰好一次；Windows drive-absolute 与 URI scheme 需先分类，含歧义的 drive-relative 等形式保留文本。
- `#L…` 指向本源文件时切到本地源行视图；普通 fragment 可导航本地已生成 heading，无法定位就保留文本/提示，不导航到整个 DSH GUI 的 hash。源文档“查看原文”也只切本地视图，不能再次 open 同一资源而被专用路由重新接管。
- 外部链接仅允许显式、合法 HTTP(S)，激活来自用户手势，新窗口需要 `noopener noreferrer`。`javascript:`、`vbscript:`、`data:`、`blob:`、`file:`、未知 scheme、protocol-relative、控制字符及 malformed escapes 不变成浏览器可执行目标。作者不能通过 Markdown 构造任意 `dsh-resource` 跨 Session 调用。
- 不预读证据、不自动检查链接、不加载图像，不因“完成证据”字段而发送网络请求。真实导航后的 not-found/access-denied 由文件查看流程明确展示，不能改写路径或掩盖失败。

文件链接不是 agent sandbox 授权：Session lookup 取 header cwd（没有时用 sandbox workspace root），Gateway 对非 owner 先判断 action/resource 再 lookup；`workspaceFiles` 最终调用组合的 `ctx.fs`，没有经过 tool-fs 的 Session sandbox 路径。普通文件 read/stat 可读取 backend 允许的 workspace 外路径，目录操作另有限制；最终 symlink 因非普通文件而拒绝，不等于拒绝所有祖先 symlink。依据：[Session scope:215–234](</home/vcup/projects/vcup-skills/.scratch/extra-src/deepseek-harness/packages/api/workspace-files/src/index.ts#L215-L234>)、[Gateway:770–795](</home/vcup/projects/vcup-skills/.scratch/extra-src/deepseek-harness/packages/api/gateway/src/index.ts#L770-L795>)、[文件检查:441–492](</home/vcup/projects/vcup-skills/.scratch/extra-src/deepseek-harness/packages/api/workspace-files/src/index.ts#L441-L492>)。看板不新增读取服务绕过此路径，也不能据 Session id 推断部署必定路由到某个 container；需实际部署测试。

## 4. 容忍既有 Markdown，不要求作者写新协议

当前 [状态模板](</home/vcup/projects/vcup-skills/skills/ensemble/STATE-TEMPLATE.md#L8-L36>) 是恢复面，不是完整审计账本。投影只识别已经存在的标题/加粗标签/Contributions table，同时保持源顺序、扩展字段和未识别内容可读。标题顺序变化、CRLF、缺段、重复标签、表格列重排/增加、空单元格、转义 pipe、代码块中的假标题都不能令整个看板失效。

| 展示区 | 从现有记录读什么 | 不推断什么 |
|---|---|---|
| 概览 | 标题、Lifecycle、Requested deliverable、Subject and boundary、Required coverage、Completion evidence | 生命周期文字不等于实时运行状态；`completed` 不等于插件已验证候选 |
| 贡献 | Attempt、Assigned coverage、Material difference or redundancy、Status、Result/evidence | 缺 model/provider/effort/角色等字段就是未记录；不能从 attempt 名称猜模型，不能把角色差异算成模型多样性 |
| 决策与发现 | 接受/拒绝/未决文字、依据及交付影响 | 自由文本没有明确关联时，不制造 attempt→accepted/candidate 的关系 |
| 候选与验证 | Candidate、Observed checks、Unavailable critical checks、Unresolved choices or risks | “记录的检查”不是看板执行的检查；没有时间戳、版本绑定或结果就不补出 verified 图标 |
| 下一步与阻塞 | Next action、Blockers | 空白不等于 none；未知不等于无阻塞 |

对缺失字段显示“未记录/无法识别”并保留剩余内容；重复或冲突字段都展示，不静默取最后一个；部分表格可正常显示的行继续显示，不能识别的片段可定位原文。任意未知状态保留作者原文，而不是强塞进 running/completed。对半写入造成的暂时不完整给可恢复诊断，不要求作者补 YAML frontmatter、隐藏注释或固定列。

已读的 [现有完整调用状态](</home/vcup/projects/vcup-skills/.ensemble/001-portable-package/STATE.md#L1-L36>) 有四条 returned 贡献与候选/检查文字，没有 model/provider/effort、耗时、费用、逐贡献采纳关系或检查时间。这个真实 fixture 应直接得到有用看板，而不是要求迁移。`returned ≠ accepted`；任务完成数量不能替代候选验证状态。需要更丰富信息时，可读普通额外字段/列，但它们永远不是安装或方法运行的前提。

## 5. 发布闭包与最小完整交付

### 5.1 Public imports 与两种依赖图

- 其他 feature 的 `/client` 只用于 `import type`（包含必要 declaration merging）；`@deepseek-ai/dsh-api-workspace-files/types` 提供 wire types，`/remote` 提供生成的 Remote augmentation，`/client` 提供 file resource/params 类型。包导出依据：[workspace-files manifest:16–39](</home/vcup/projects/vcup-skills/.scratch/extra-src/deepseek-harness/packages/api/workspace-files/package.json#L16-L39>)。类型需要不是 runtime import 的理由。
- Runtime values 只从静态共享 `@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-primitives`、React/Cordis baseline 及 browser-safe path utility 等获取；path utility 是上游 [inline-safe 层:94–111](</home/vcup/projects/vcup-skills/.scratch/extra-src/deepseek-harness/packages/client/tsdown.client.ts#L94-L111>)，可以随本包内联。GFM 依赖亦私有打包，不要求模块表提供它们。
- `dsh.client.inject` 是包名关系/显示元数据，不保证 apply 顺序，也不会替产品安装或激活全部服务。运行时服务等待靠 Cordis `inject`；对 slot 的等待靠 `slots.inject`。feature 不得通过 `dsh.client.external` 请求另一 feature 的私有值。
- baseline 是 [platform 清单:7–15](</home/vcup/projects/vcup-skills/.scratch/extra-src/deepseek-harness/packages/client/web/src/platform.ts#L7-L15>)，构建要 externalize，但 manifest 的 `dsh.client.external` 不重复 baseline。无非 baseline runtime 请求时可省略 external。缺失的 `require` 供应商会在 factory materialization 当场失败，不受服务注入等待保护。
- `/client` 公共值只导出 `apply`、`inject`、必要 `Config`/type-used store factory；解析器、link resolver、组件、常量和 store handle 留包内。Host 构建不导入 Client，Client 不带 Node fs/path、Host skill/provider 或 OMP 代码。

### 5.2 本仓库的构建要求

上游 [cookbook:58–60](</home/vcup/projects/vcup-skills/.scratch/extra-src/deepseek-harness/docs/cookbook/adding-a-settings-card.md#L58-L60>) 明说仓外包自行复现 lazy-CJS 构建；不能写一个相对路径指向临时源码副本的 `clientBundle` import，也不能把普通 ESM 的 `./client` 当成已完成发布。

最小 browser artifact：一次 script evaluation 只调用 `window.__ModuleLoader__.load({ id: '@vcup/skills', factory(require) { ... return module.exports }, meta? })` 注册，不立即 apply；factory 内才执行 bundle。第三方依赖内联，baseline require 留给模块表。CSS Modules 类名与样式通过 DSH stylesheet metadata 归 renderer 生命周期安装/卸载，不能在顶层插入全局 style 然后泄漏。无自定义图片时无需添加 assets 接口。首版可保持单个 Client chunk，避免无价值的 chunk 路由与打包复杂度；若 split，遵循 `require.async('./client.<name>.js')`，所有 sibling chunks/maps/assets 必须进入 publish `files`。

保留/补齐 Host root 与 `./client` 导出、类型声明、实际构建输出、许可证和所需资源。Client factory id、manifest name 与 bare Loader row 一致；`@vcup/skills/dsh` 子路径行不能承载 browser half。client-modules 按 [bare package 元数据:891–917](</home/vcup/projects/vcup-skills/.scratch/extra-src/deepseek-harness/packages/client/modules/src/index.ts#L891-L917>) 取得 `./client`。Host 启动读取已构建文件，不替外部插件编译 TSX。对 package root 的 HMR/disable 生命周期必须验证：已打开 tab、locale、slot、styles、读请求及缓存均能撤销，再启用只出现一份。

npm 关系与 browser 外部性独立：browser-only/type dependencies 为开发输入，构建后没有漏到运行时的裸 import；Host runtime dependencies 由 Lead 按其真正引用分类。上游 workspace 版本不能直接抄进发布给用户的外部包；这次只支持指定未发布目标，精确 prerelease/source 构建依赖及发布可获得性由实现环境锁定，不以兼容旧版或猜一个 semver 范围来掩盖。

### 5.3 交付清单

1. 新版目标的包 root/Client 构建、manifest/exports/files 和实际可安装产物；在干净消费环境中不是依赖本仓库临时源码或 node_modules 才能加载。
2. 窄路由专用 tab、公开 API 注入、五区只读看板、同 tab 原文行视图、locale/style、明确 file Session/absolute source 显示。
3. 原生有界单页读取、EOF 判断与不完整原文退路、原资源元数据复用、手动刷新、失效与取消、错误/旧快照状态；不宣称 watch 健康或事务一致。
4. 严格的 DOM/link 行为与既有 Markdown 容错。原文也不能执行 HTML/脚本或自动取证据。
5. 下述 source/unit、real composition、built publication 和 GUI acceptance 记录；README 说明状态快照、未知字段、数据与权限边界，以及实际支持的源码基线。

## 6. 验收矩阵（待实现，不是本轮已通过测试）

| 层 | 必测场景 | 通过标准 |
|---|---|---|
| 路由/注册 | 有效 ensemble 相对/绝对地址；普通 README/任意 STATE；编码空格/#/?；非 session/畸形地址；slot 晚出现、消失、重建 | 只接管目标路径；无 I/O predicate；fallback 不变；无 apply-order 偶然性或重复 registration |
| 模板/真实文档 | 当前模板与已有四贡献 fixture；缺字段/段、乱序/重复字段、多/少/重排列、CRLF、escaped pipes、代码内假标题、未知状态、半张表、长单行 | 不需迁移；内容不静默丢失；未知不显示为 none/success；returned 不变 accepted |
| 有界读取 | 空文件/空行、原生页边界与 EOF、超 maxBytes 单行、read target 不符、读前/读后版本改变、post-stat 失败、持续写入、旧请求晚回 | 一次刷新只取一页；不自动拼页/重试；非 EOF 仅部分原文；变更明确过期；旧 generation 不覆盖新值；不宣称事务快照 |
| source context | Session A tab 打开带 Session B 的文件；相对源在首次解析后 cwd 改变；source 父目录含空格/编码字符/Windows drive；`../` 证据与错误路径 | content/stat/resource hook/link base 始终同一个固定绝对 source + file Session；不漂移到当前 cwd；不隐式 root fallback |
| 刷新/失效 | watch 不支持、首次 stat 成功但 stream 结束、重连、删除后重建、权限撤销、普通 read 失败；手动/快捷键刷新 | 无假“实时”绿灯；manual read 一直可用；旧快照标为旧；明确拒绝后清除可见旧内容/不沿用权限；恢复可重读 |
| 生命周期 | 隐藏、换 Session、重新挂载、移动 pane、关闭 tab、disable/re-enable、HMR 替换；在途 read 晚完成 | 隐藏不等于 tab 销毁；真正结束后无写回、请求、订阅、style、locale 泄漏；重载仅一份贡献 |
| DOM/链接 | script/HTML/event handler、嵌套 HTML、混合大小写/实体/控制字符 scheme、data/blob/file/未知 scheme、remote/local/reference image、malformed escape、protocol-relative、相同源行链接 | 无 HTML 执行、自动网络/image 请求、隐式 file fetch；只显式 HTTP(S)/本地文件动作；同源行/查看原文不递归路由 |
| UI | 初始加载、重读、空文档、未识别文档、部分字段、旧快照+错误、长字段、窄右栏、深浅主题、键盘/焦点与语言切换 | 状态与恢复动作可见，文字可读；五区同源、无裁切隐藏关键未知；显示“记录的检查”而非自行验证 |
| composition | 用真实 Loader/测试 composition 加载包，供应标准 services/slots/resources，只有外部不确定性可 mock | 从 openResource 到用户可见看板/原文/证据路径走通；仅直接调用 apply 的 recorder unit test 不算完成 |
| 发布 | inspect pack 清单；从实际 tarball/安装产物启动指定新版；检查 factory id、模块表 requires、声明、CSS 生命周期；CLI/headless 无 DOM | 无源码路径依赖、漏文件/隐式 require、Node 浏览器泄漏；Host 与 browser 各自可加载；OMP 不回归 |

可参考 [内置预览注册测试](</home/vcup/projects/vcup-skills/.scratch/extra-src/deepseek-harness/packages/client/ui-sidebar-documentpreview/tests/apply.client.spec.ts#L1-L78>) 的 disposer 验证，但它本身明确是 registry+recorder 测试，不能代替真实 Loader composition。静态类型检查和 unit tests 也不能证明发布 factory/CSS/GUI 的组合能运行。最终 GUI 验收必须在安装了指定新版且实际加载此包的应用上进行；本次没有启动或替换当前 GUI，也没有观察到任何已工作的看板。

## 7. 剩余验证，而非架构待选项

方案已经收敛。实现还必须验证：未发布目标依赖的可复现获取；本仓库 lazy-CJS/CSS metadata 薄构建适配；实际包 root 与 bundle 的加载闭包；实际 deployment 的 file backend 与权限；看板在原生页限额内的解析/DOM 性能；真实 GUI 的来源固定、link activation、disposal/HMR 行为。上述项应进入实现验收，不用旧 Team fallback、额外状态协议或另起独立页面来绕开。
