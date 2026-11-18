# Ensemble DSH 插件：第一版实施设计

状态：设计已收敛，尚未实现。目标仅为[固定新版 DSH 基线](<UPSTREAM-BASELINE.md>)，不承担旧具名 Team 兼容。方法与取舍由[综合设计](<DESIGN.md>)定义；本文件决定要写哪些代码、依赖哪些公开 Interface，以及怎样验收。

## 1. 交付单位与目录

继续使用当前 `@vcup/skills`，不把临时源码副本变成安装依赖。保留现有 [OMP 入口](<../../adapters/omp/index.ts>)与[包 manifest](<../../package.json>)的 OMP 消费声明；新增 bare-package DSH Host 入口和 `./client`。一个 bundle 插入一条自身的 bare-package row，供 Client module system 发现 browser half。

拟新增布局如下；名称为实施约定，不代表文件已存在：

```text
adapters/dsh/
  index.ts                    # Host function plugin
  config.ts                   # Host reference-output limit
  skill.ts                    # bundled skill provider
  references.ts               # enum -> packaged Markdown, bounded read-only tool
  ENSEMBLE-DSH.md              # native execution/context/settings guidance
  cordis.patch.yml            # insert own bare-package row only
  client/
    index.ts                  # client apply/inject, registration assembly
    document.ts               # GFM projection and source ranges
    evidence.ts               # conservative evidence classification/navigation
    snapshot.ts               # per-tab source and read-operation owner
    view.tsx                  # semantic dashboard and literal source view
    styles.module.css
    locale/                   # typed en/zh product copy
  tests/
    host/ client/ composition/ publication/
  README.md
scripts/build-dsh.ts          # independent Host / lazy-CJS Client artifacts
```

Host 与 Client 使用独立编译入口，根 tsconfig 可作 solution；Client 不依赖 Node fs、Host skill 或 OMP，Host 不导入浏览器实现。产物路径建议 `lib/dsh/index.js`、`lib/dsh/client.js` 与对应声明。公共入口仅暴露 Cordis 所需的 `name/inject/Config/apply`（依面需要）；私有解析器、组件、controller 不升级成公共服务或测试专用导出。

## 2. Host 技能入口

### Interface

- 原生用户调用 `/ensemble` 加载技能。候选名 `ensemble`，`invocation: { modelInvocable: false, userInvocable: true }`，维持[现行技能](<../../skills/ensemble/SKILL.md>)的用户触发意图。
- 使用 `ctx.skills.registerProvider`，source 为 bundled、rank 用公开 `BUNDLED_SKILL_RANK`；同名项目技能仍按原生 rank/scope 规则覆盖，不人为抢占。
- `list` 仅返回短元数据；`get` 按需返回**修订后的可移植核心 + DSH 指引 + 现有状态模板正文**。不把长参考文档、全局模型目录或整个 coordinator 历史默认塞进所有成员。
- `resourceBase` 使用 `opaque`，说明参考资料通过 `ensemble_reference` 读取；不输出一个容器未必能访问的 Host package 目录。

现有 `SkillResourceBase` 只是资源提示，没有通用的按路径读取方法。`skill({name})` 只读完整技能，并检查用户/模型调用策略；不能靠一个目录字符串完成 Host 到容器的挂载。这是需要下一节窄工具的具体原因，不新增虚拟 MCP server 或把每篇参考文档包装成独立技能。[公开技能类型](<../../.scratch/extra-src/deepseek-harness/packages/skill/skill/src/index.ts#L45-L110>)、[provider](<../../.scratch/extra-src/deepseek-harness/packages/skill/skill/src/index.ts#L249-L278>)、[资源提示](<../../.scratch/extra-src/deepseek-harness/packages/skill/skill/src/index.ts#L165-L215>)、[原生调用检查](<../../.scratch/extra-src/deepseek-harness/packages/skill/tool-skill/src/index.ts#L131-L160>)。

### Implementation 与失败行为

包内 canonical Markdown 仍是唯一方法来源；打包组合去除其既有 frontmatter，明确解析现有调用策略，不引入新的 invocation metadata。不要用运行时字符串替换去删除 OMP 规则：先按实施切片修订公共方法，把 harness 专属规则移回各自适配内容。短 DSH 指引使用新版工具名、Team/settings 启用条件和真实选型语义。

文件路径由包拥有、相对最终发布产物解析；读取使用 caller AbortSignal，缺文件/无效 metadata 明确报错。发布测试检查所需文档闭包；正文不作为全局 mutable cache。注册随插件 fiber 撤销，卸载后原生技能目录与用户菜单撤去本候选；不触碰原生成员。

核心与模板在同一次用户调用里可用，因而参考工具即使被某个受限 preset 隐藏，也不会留下“必须读 Host 文件才能开始”的断链。任务派发由协调者传递必要要求；fresh 不自动拥有父用户调用全文，fork 的继承则按实际信息判断。

## 3. 窄参考工具

新增且仅新增一个模型工具：

```text
ensemble_reference({ document: "rationale" | "patterns" | "glossary" | "state-template" })
  -> { document, title, source, content }
```

| document | 固定包内资料 |
|---|---|
| rationale | [方法说明](<../../skills/ensemble/README.md>) |
| patterns | [方法模式](<../../skills/ensemble/PATTERNS.md>) |
| glossary | [正式术语](<../../skills/ensemble/GLOSSARY.md>) |
| state-template | [普通 Markdown 模板](<../../skills/ensemble/STATE-TEMPLATE.md>) |

- `source` 是逻辑包/文档标识，不是 Host 绝对路径；内容作为普通参考资料返回，不伪装成新的用户调用或自动启动 ensemble。
- 只接受固定 enum，不接受 path、URL、任意包名、文件名拼接或写入选项。JSON 入口验证参数；内部映射用封闭类型。
- Host `Config.maxReferenceBytes` 明确限定一次**完整可见结果**的 UTF-8 字节数，包含 metadata 和渲染包装；默认 65536，可由原生配置调整。当前最大文档为 28712 字节，参考文档总计 44975 字节；该默认为单文档留有余量，仍须测试微小/恰好/超限值和多字节内容。
- 读取有界、支持取消；超限返回明确诊断，不把截断方法伪装成完整参考，不让模型自行扩权访问 Host。缺失资产是打包/安装错误，不能退回 workspace 同名文件。
- 工具注册走原生 tools registry，disposer 随 fiber 释放；原生工具事件负责持久记录模型所见内容，不另建日志。Host presenter 为纯函数，显示“读取 ensemble 参考资料”和文档标识；Web 沿普通只读工具卡，不增控制面。

Host 顶层注册在本基线 standard 可见，不需要修改 preset；自定义 scope allowlist 或同名 shadow 仍可能隐藏工具，不能承诺所有部署可用。应在说明与实际工具发现中如实体现，不绕过限制。[scope 与资源复核](<NEW-DSH-EXECUTION-RESEARCH.md#L88-L88>)

## 4. 执行适配不是另一个执行器

DSH 指引直接消费原生 `subagent/subagent_fork`、模型发现、Session 授权、preset、消息与任务。**不新增** spawn/router/provider/roster/stop 工具、共享模型槽位或恢复队列，也不提前抽取原生内部 selection helper。

bundle 默认不改 standard delegation、不自动开启全部 Team、不扩展路由允许列表。需要 fork 选型、interrupt、独立工具 preset 的部署，按[执行设计](<EXECUTION-ADAPTER-DESIGN.md>)给出的原生条件显式配置并测试；不覆盖用户整个 preset。安装技能不是授予模型访问权限。

## 5. Client：现有文件的一个资源视图

### 5.1 路由与公开依赖

注册外层 `sidebarRightTabs`，实现 id 对应本包、kind 为 ensemble 视图身份，priority 为 extension。pattern 覆盖 file resource，廉价同步 `canOpen` 用公开 `parseFileAddress` 只接受 Session 文件与 `.ensemble/<单个目录>/STATE.md` 布局。现有数字前缀仍是方法命名约定，读取器不增设新编号协议；不在 predicate 读文件，不接管任意 Markdown。

body/title 通过实际 slot 的 `slots.inject` 注册，并派生标准 props。服务只在 apply/inject 世界使用，组件不拿 ctx/整个 Remote。feature 包类型可 type-import；运行值只用静态公共 primitives/store、React/Cordis baseline、browser-safe workspace-path utility 和本包私有 GFM 依赖。`dsh.client.inject` 不是服务就绪保证，`dsh.client.external` 也不能用于深取另一 feature 的组件。

具体公共入口与约束见[接口表](<NEW-DSH-PLUGIN-RESEARCH.md#L13-L26>)；不导入 `TextPreview`、私有 `parseGfm` 或私有 link resolver。

### 5.2 `Snapshot`：源文件和读操作的唯一 owner

私有 Interface 只提供打开目标、处理 metadata 变化、刷新和取消。一个 tab 的 SourceRef 与读操作归该实例；声明 store 保存有限预览及视图状态，不镜像 Session/Team，不把正文写入布局或磁盘。

1. 解析原地址里的 file Session/path，初始 `useResource` 观察该地址；同时独立 `stat`，不能等 watch 健康才读。
2. 仅以该 stat 成功返回的 absolutePath 固定 SourceRef；通过同一个声明 action 发布，之后 metadata hook 改用 canonical `sessionFileAddress(fileSession, absolutePath)`。
3. 所有 read、post-stat、手动刷新和证据路径都用固定 absolute source。原相对地址仍是框架 tab identity，但其后 cwd 变化不能重定向内容；不接管框架自己持有的原始资源 pin。
4. **首版只读取一个原生有界页**：`workspaceFiles.read(scope, absolutePath, {}, signal)`，沿用 API 的可配置 maxLines/maxBytes，不自动拼接多页、后台轮询或另传 Client 预算配置。`eof:false` 只显示“未完整读取”和已加载原文；只有 EOF 才生成五区投影，不暗示部分页已覆盖完整候选验收。原生 too-large/not-text 错误明确展示。
5. 成功读后再次 stat：target/version 变化或 stat 失败都不发布为当前快照；可保留明确标为过期的旧快照并提供重试，权限拒绝则清除内容。不无限追赶；版本一致仍不是事务快照或作者已写完的保证。
6. 每次新操作取消前一操作，旧结果不得写回新目标；tab/body 生命周期和 AbortSignal 统一收敛到本次操作 controller。body 卸载取消在途读取，tab 存活可保留已固定 SourceRef；真正关闭/卸载清除所有本包资源。
7. `tab.actions.bindCommands({refresh})` 绑定按钮和框架刷新；手动刷新直接 stat/read，不等待订阅事件。明确拒绝访问时清除旧内容；普通短暂错误可保留标为过期的快照。

原生默认每页 5000 行/2 MiB 是**输入上限，不是性能已经验收**；解析与窄栏渲染必须覆盖极端单行、嵌套和大量节点测试。源文本行视图采用有限可见窗口，结构难以安全展示时保持可读源内容与诊断，不构造无界 DOM。若默认支持组合达不到响应/内存验收，先缩减呈现或明确调整已有 API 预算，不把无限分页或未经测试的全量 DOM 当成完成。首版无新的 browser config Remote、boot global、watcher 或文档缓存服务。

### 5.3 `Document` 与 `Evidence`

`Document.project(text)` 隐藏成熟 CommonMark/GFM AST，返回既有五区内容、原文范围与识别诊断；不查 agent/task、不计算费用、不替用户验收。重复字段全部保留，未知状态原样显示，表格列重排/转义/缺失不致整页消失。数据仅在内存中，不是新协议。

语义视图仅呈现文本、标题、强调、列表、代码与表格；HTML/未知节点保留为源文本。图片显示 alt/目标而不请求图像；代码不执行，不使用 innerHTML。使用同一解析结果，不复制完整通用 Markdown renderer。字面原文与看板在同一 tab 切换；API 是行文本读取，不能宣称字节级原件保真。

`Evidence` 把真正的 Markdown 链接分为本地路径、HTTP(S)、本源位置和不可激活项。相对路径以固定源文件目录为基准，绝对路径不拼接；公开 helper 负责 file URI 编码，Host 最终解析，不能失败后偷偷试 workspace root。仅支持明确的 `#L24` / `#L24-L30` 行指向，其他扩展可后续增加；编码 #/?/空格与 fragment 分开、解码一次。普通文本、inline code、命令和 commit 不猜成链接。

外链只允许显式合法 HTTP(S)，仅用户点击才打开并使用 `noopener noreferrer`；未知 scheme、protocol-relative、data/blob/file/javascript 等不激活。Markdown 不得伪造任意跨 Session resource 请求。不自动验证证据、预读链接或加载远端图片。[安全规则与权限](<NEW-DSH-PLUGIN-RESEARCH.md#L62-L80>)说明为何不能只包一层公共 `MarkdownText` 就声称有严格 allowlist。

UI 文案归 typed en/zh locale，用户 Markdown 不翻译；样式用 semantic token/CSS Modules，共享控件用公开 primitives。加载、过期、部分读取、空文档、权限失败、未知字段与可恢复动作必须可见。窄侧栏将宽表改为按贡献排列的卡片，借原生分栏/浮动能力扩展，不造新的全屏应用。

## 6. 发布与构建

拟议 manifest 关键部分（路径必须与实际产物一起验收）：

```json
{
  "name": "@vcup/skills",
  "type": "module",
  "exports": {
    ".": { "types": "./lib/dsh/types/index.d.ts", "default": "./lib/dsh/index.js" },
    "./client": { "types": "./lib/dsh/types/client/index.d.ts", "default": "./lib/dsh/client.js" }
  },
  "dsh": {
    "bundle": { "patch": "./adapters/dsh/cordis.patch.yml" },
    "client": { "platform": "web" }
  }
}
```

这是增量示意，不是覆盖现有 manifest；实施时保留 OMP 声明和所有既有消费路径，尤其不能因新增 `exports` 阻断原来合法的 deep imports。先列真实消费者并为需要的旧路径保留显式导出，pack 后做 OMP 回归。

- bundle row 必须是 bare `@vcup/skills`，不是 `@vcup/skills/dsh`；只有 bare row 承载 browser half。factory id、manifest name 和 row 对应。[官方说明](<../../.scratch/extra-src/deepseek-harness/docs/cookbook/adding-a-settings-card.md#L56-L70>)
- Client 产物按公开 lazy-CJS factory 约定构建：script evaluation 只注册 factory，materialization 才执行；首版单 chunk。仓内 `clientBundle` 不属于已发布 SDK，**不得从 scratch 相对路径 import 它**；本包维护薄构建适配并针对真实 module loader 测试。
- baseline React/Cordis/store/primitives 由模块表供给，不内联重复身份；GFM 和 browser-safe path helper 可按允许边界内联。CSS metadata 交原生 renderer 安装/卸载，不在脚本顶层留下永久 style。无自定义图片则不新增 assets 协议。
- Host value dependencies 按共享身份分类，DSH/Cordis 服务身份用 peer 并有匹配 dev 输入；浏览器/类型依赖作为构建输入。OMP-only 安装不应被迫安装整个 DSH，使用可选 DSH peers并验证实际 resolver；不能把 workspace:* 抄到仓外发布包。
- `files` 必须覆盖 Host/Client/声明、样式元数据、既有 OMP 代码、全部所需 skill 文档与本 bundle 配置；从真实 tarball、无源码 checkout 的消费环境测试闭包。
- `engines.dsh` 与 peers 只声明已真实验收的 prerelease 范围。当前目标为确切源码提交；开发可消费该基线构建产物，发布前确认其分发可获得性，不凭 `^0.2.2` 猜兼容性或声称 npm 已发布。

## 7. 实施切片与完成条件

| 顺序 | 写入范围 | 完成条件 |
|---|---|---|
| 1. 方法与发行骨架 | 公共 ensemble 文档、DSH 指引、包声明、双面构建 | 术语与用户策略一致；OMP 路径不回归；最小 Host/Client artifact 能被指定新版 Loader/module system 加载 |
| 2. Host 垂直切片 | provider、reference tool、Host tests | 用户调用加载核心/模板；模型直接调用被原生策略拒绝；Host/容器路径分离；有界参考资料、取消、错误与卸载可见 |
| 3. Client 垂直切片 | resource tab、snapshot、projection、evidence、view | 直接打开[已有检查点](<../001-portable-package/STATE.md>)，无需迁移；五区与原文可读，固定来源、刷新、错误和部分页状态正确 |
| 4. 真实分发与组合验收 | composition/publication fixtures、说明 | tarball 在目标新版 Web/headless 中加载；OMP 不回归；真实 GUI 打开/切换/证据/HMR 卸载通过 |
| 5. 原生执行资格验收 | 原生配置 fixture 与运行证据 | 授权/省略/preset/Team 矩阵通过；获准真实 Adapter 的跨模型与 effort 请求能核对；无凭证项明确未验证 |

先交付一条“用户调用 → 原生成员贡献 → 普通 Markdown → 专用视图”的真实切片，再扩容；不先建通用 HarnessAdapter 框架。看板与 Host 开发可在发行骨架后并行，但双面打包、共享文档组合及最终 diff 由同一集成 owner 合并验证。

## 8. 测试责任与非目标

- **纯单测**：文档投影、重复/缺字段、escaped pipes、代码假标题、未知状态；证据 URI 分类与编码；完整输出预算含包装/多字节；源目标与请求取消时序。
- **Host real composition + keyless snapshot**：通过测试 bundle/Loader/app 加载，记录用户 skill 注入、reference 工具结果、modelInvocable 拒绝与有意 scope 限制；不能只手造 ctx 调 apply。
- **Client real composition + browser**：普通 Markdown 不被接管；file Session 与 UI Session 不同；首次 relative stat 后 cwd 改变；eof false、too-large、删除/重建、watch 失效、重连、权限撤销、晚结果；无自动网络请求和脚本执行。
- **Disposal/HMR**：技能、工具、slot、tab type、locale、styles、请求和缓存撤销；再启用只有一份；body unmount 与真正 tab close 分开；不停止原生成员。
- **Artifact 与回归**：检查实际 pack 清单、lazy-CJS require 供应、CSS 生命周期、纯 Node Host、OMP 入口；目标源码构建先产出 artifacts 再做 build check。GUI 验收必须在实际装载此包的目标应用上，另起 Vite 不是完成证据。
- **模型运行**：复用[执行验收](<EXECUTION-ADAPTER-DESIGN.md#L80-L90>)，将真实请求与 mock/source evidence 区分；本轮未执行这些测试。

v1 不做执行器、任务/成员镜像、自动验收、看板编辑、跨 invocation 历史索引、成本统计、后台抓取证据、用户未授权的模型切换、旧 Team 兼容，以及新的 invocation 文件格式。未实施的风险是公开接口预稳定、未发布依赖分发、仓外构建与文件 backend 的实际组合；这些进入验收，不用另一套运行时绕开。
