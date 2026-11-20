# DSH 插件实施准备与验收

本文件列明可领取切片和目前没有的运行证据。整体目标见[设计入口](README.md)；协调/学习行为见[领域模型](DOMAIN-MODEL.md)；数据与事务见[档案设计](ARCHIVE-DESIGN.md)；完整替代条件见[表达矩阵](REPLACEMENT-MAP.md)。仅面向 DSH `0.2.2-rc.4`（固定源码 `3f321d32bfe382212a8ed8785c1d47a5a300aa23`）。**当前已实现/已提交/未发布的探针状态、命令与未验边界只以 [P1 交付记录](P1-DELIVERY.md)为准，本文件不另述进度；产品代码实现、完整安装与 GUI 尚未验收。**

## 1. 交付形态

按[三路径隔离设计](DISTRIBUTION.md)从共同方法源构建纯skill、OMP、DSH三个独立安装产物。DSH有自己的包身份、Host/root与Client入口、技能正文及参考资源；OMP由自己的发布包继续交付。维护源码共用，安装根和使用说明分别闭合。

拟新增代码布局已部分在工作树实现（见 [P1 交付记录](P1-DELIVERY.md)），以下多数 DSH 领域/Archive 文件仍不存在：

```text
adapters/dsh/
  index.ts                   # Host function plugin, named exports
  config.ts                  # deployment-owned archive configuration
  skill.ts                   # user-invoked bundled skill, references
  domain/
    coordination.ts          # closed commands and business validation
    learning.ts              # coaching, publication, lessons, domains
    records.ts               # private persistence version and migration
    projection.ts            # generated Markdown from committed facts
  archive/
    service.ts               # one execution/auth/commit entry
    git.ts                   # fixed-argv isolated Host Git
    receipts.ts              # replay-safe operation results
    import.ts                # complete legacy inventory and mapping
  tools.ts                   # model-facing domain tools
  remote.ts                  # authorized project/document read Interface
  client/                    # archive view, source reading, locale/styles
  tests/                     # domain, Git faults, real composition, publication
  cordis.patch.yml
```

目录是 Locality 分工，不意味着每个文件都需公开 Interface。Domain 接收明确输入并返回变更；Archive 承担 IO；DSH Adapter 派生 actor/authority。未知事实留为未知，不能用无差别 default 值掩盖缺输入。

## 2. 原生执行选择保持原生

- 标准 Web spawn 开启 `modelSelection/modelDiscovery`，完整适配通过该入口提供逐代理获准的 provider/model/effort 选择。fork 的模型覆盖保持标准配置的关闭状态，避免跨模型继承损失思考和上下文；本次交付保持fork原effort，等级差异通过fresh实现。control 的 interrupt 和原生 Team 默认关闭，Team 需根 mode 启用；安装 ensemble 不替用户开启权限。
- 模型选择的 provider/model 必须成对；显式 effort 也要求同次显式 route。全省略保留受信默认/继承；显式 route 省略 effort 清继承 effort，采用该 route 默认值，即使 route 相同。
- 逐成员独立 preset 由 local spawn 支持、fork 拒绝；允许值由真实部署 allowlist 决定。Role偏好不应塞入受信 `agentOptions` 以绕过 model-authored selection policy。
- 允许路由属于原生 Session policy，新根采样、child继承，不回溯旧 Session。无 policy 不等于全模型开放。实际请求证据与创建声明分开；`list_agents` 不能代替 actual model request 证据。
- 原生 create 返回的完整 name 用于 `send_message({agent,message})`；同树原生代理可以互通，wait 等调用者 inbox，task 变化不自动唤醒。Team 在同一树上提供可选共享任务板，fresh/fork 成员可在启用且有工具时读/领取任务。创建/消息/完成/采纳分别判断，不创建 ensemble roster、LLM loop 或第二任务板。

[原生代理接入决定](NATIVE-AGENTS.md)说明 fresh/fork/续用与 workflow 的适用场景、通信及共享任务条件、模型选型配置，以及配置已有实例→独立命名原生实例→必要时作用域覆盖的优先级。同名覆盖技术上可行，但只加 schema 不会解除执行器校验；不把模型参数转写成受信配置以绕过授权。workflow 的 route/effort/授权路径另行核验，不假定与子代理工具相同。

源码：[标准组合][standard]、[原生工具][subagent]、[模型选择][selection]、[preset选择][preset]。这些是静态来源，真实 Adapter 请求仍需获准环境验收。正式仓库只记录字段与语义，不记录当前可用模型/provider清单。

rc.4 的选型参数和部分授权失败直接抛普通 `Error`，不能依赖开发分支的 `MODEL_SELECTION_DISABLED` / `MODEL_ROUTE_NOT_ALLOWED` 等细分码；workflow 结果有 `stopReason` / `error`，没有 `errorCode`。适配层按该发行真实返回保留失败与未完成状态，不靠错误文本猜测可重试类别。[选型执行][selection]、[workflow 结果][workflow-result]。DeepSeek `stop_reason: refusal` 对应 `CONTENT_REFUSED`，并先报告已消耗 usage；这不是成功贡献，也不是响应格式错误。[拒答迁移][refusal]。

## 3. Host、工具与权限接入

技能通过公开skill provider注册`ensemble`，遵守用户触发策略，加载构建好的DSH专用技能及包内参考。通用方法在构建时合入；运行时使用DSH领域工具，不加载纯skill或OMP的入口、模板说明及安装指南。实现按 rc.4 的已发布类型编译：skill 包不导出 `SkillError`；Cordis 根上下文使用 `ctx.root`，不照搬开发分支的 `ctx[Context.root]`。插件的领域 failure code 由自己定义，不假定原生失败均有对应码。[skill 出口][skill-api]、[设置实现][settings]。`ensemble_reference` 读取固定枚举的包内参考文档，含演进阅读指引，不接受路径，Host/container分离时仍可用；使用 opaque resourceBase。参考正文有完整输出预算，超限明确失败/分页，工具结果由原生日志记录。

Archive 使用公开 Cordis isolation group + local subprocess/sandbox，不继承 source execution world 的文件坐标。原生 `spawn` 不自动授权或 sandbox；执行器先验证 archive opt-in/绑定/角色，再构造 archive-root Host policy，调用 `confine → local spawn`。无法约束时失败，不启用 unconfined fallback。[本地进程][local]、[service isolation][isolation]、[sandbox][sandbox]。

Remote 使用公开 Typert Remote/resource声明，按全部受影响 project/document 授权；模型工具与 UI 仍进入同一领域执行器。`remoteAccess.allows` 在 Remote 外不是通用授权检查，不得用它为同进程工具放行。Read 同样需要 grant，列表和 stream 按条过滤，撤销/重连不得泄漏旧cache。[Remote权限][remote]、[scope限制][remote-allows]。

Settings 只对 `.volatile()` 字段自动提供 live 编辑；archiveRoot 改动需停写、重绑与显式迁移，不设为任意热切换。环境 route偏好可以单独配置，credentials维持原生owner；默认凭证位置不天然按项目隔离。原生 storage-domain只能做可重建小缓存；其 JSON backend无跨进程锁、domain可能持有旧snapshot，不能用它做另一套archive真源。[设置][settings]、[凭证][credentials]、[storage限制][storage]。

## 4. Client 变更与包构建

新看板按 archive document identity/revision 读取已授权的 Remote，展示目标、贡献、取舍、候选/检查和下一步，并提供原文、历史、分域阅读及更正。记录状态与 native runtime 状态用不同标签及证据来源。界面有 committed revision，不用收到一条通知就假设当前所有内容已加载；读取固定 revision，历史和当前不能拼接。

插件自有只读 resource provider/侧栏类型，编码 project、invocation、document、revision，不携带 Host path；这不是新增用户文件格式。它可沿原生 resources/useResource/slot 生命周期承载，不自己写轮询与全局cache。source file证据走原 file resource和Session权限；archive内部链接走档案对象身份。导出、迁移和环境设置属于用户动作，不能把点击一个文档当成同意写入。

沿用成熟 CommonMark/GFM解析，保守语义输出；HTML/未知内容原样文本，图片不自动加载。显式HTTP(S)点击与授权source证据分别处理；不激活未知scheme、不执行命令或脚本。generated文档是可读投影，不重新解析成命令。Typed locale承担产品文案，用户内容保持原文；未知/未审/过期/部分页/权限拒绝都有明确显示。

浏览器 half 由 bare-package Loader row 承载，不能挂在包subpath上。仓外 package需要按公开 lazy-CJS factory约定构建，不能从scratch源码导入仓内 `clientBundle`；CSS metadata与factory生命周期一起卸载。Host与Client独立编译，只有baseline共享身份external，第三方GFM依赖按browser产物打包；不 runtime-import另一feature的私有组件。[公开发布说明][client-build]

DSH tarball从独立staging root生成，只含Host/Client、声明、该路径的完整技能/参考、bundle配置及样式资产；README和manifest也来自DSH清单。纯skill的完整生成目录随Git提交，继续通过`npx skills@latest add vcup/skills`安装；OMP按[分发约定](DISTRIBUTION.md)迁移到独立包入口。两者在各自干净安装结果中验证；包内文件、依赖、autoload和参考链接均不得重新引入其它路径内容。`engines.dsh`/peers只声明经过实际验收的prerelease范围；首次切片锁定 `0.2.2-rc.4`，核对所有实际依赖的发布产物并验证可复现构建/安装，不以浮动 `next` 或开发分支源码替代。

## 5. 技术切片与交付门槛

A–F是技术切片，[ROADMAP](../../ROADMAP.md)统一P1–P7阶段与依赖。实施使用[命令约定](COMMANDS.md)、[运行管理](OPERATIONS.md)及[用户旅程](USER-JOURNEYS.md)作为共同输入；R1–R20保留原有覆盖，R21–R30细化完成判定、环境应用、完整内容、出版与数据寿命。

| 切片 | 可审中间产物 | 通过条件 |
|---|---|---|
| A：组合可行性 | 最小已打包Host+Client；同域Host archive Git探针 | 正式Loader启动，source在另一执行域仍不误读；没有任意Host读写；发布包不依赖scratch源码。当前工作树证据仅为 rc.4 公开 Loader 上的 Host-only 帮助探针（技能注册与固定参考读回），未覆盖完整 profile 启动、Client、Host 隔离或外部 Git，见 [P1 交付记录](P1-DELIVERY.md) |
| B：确定性协调替代 | open→artifact→attempt→decision→candidate/check→next/lifecycle 的typed commands、读回与checkpoint | [替代矩阵](REPLACEMENT-MAP.md)全部现有表达可实现；unknown原文/各状态/修订不丢 |
| C：原子版本与恢复 | Git事务、receipt、grant/binding、故障注入 | CAS、响应丢失、重启、撤销、磁盘错误、损坏版本均不误报；source Git不变化 |
| D：学习与出版 | coaching→新例check→reflection/review/publish→lesson→下一任务检索 | 学习/保存/出版/应用各有证据；未审/反例/适用性可见；领域拆分与更正保持引用 |
| E：真实UI与迁移 | 授权资源tab、概览/分域阅读/原文/历史、完整导入预览 | 两个项目/会话权限分离，旧目录全内容读回，失败不静默删；真实GUI完成操作 |
| F：执行与回归 | 两个获准route与effort smoke，OMP包消费，文档同步 | actual request证据可核对，scope/preset/默认语义正确；现有OMP不回归 |

B的纯领域代码和A的打包研究可分开推进，C依赖业务命令与Host能力；D复用C而不造第二存储；E并行布局可以早做，但产品完成依赖真实Archive Interface。关键缺口先收束，不通过堆更多文档或测试向量掩盖。

## 6. 代表输入与预期结果

全部为待运行向量，列正常例与能推翻错误保证的相邻反例：

| ID | 输入/情景 | 预期结果 |
|---|---|---|
| R1 | 含全部现有STATE字段及未知章节的导入；另有独立长研究文档 | 所有信息有读回目标；结构化映射与保留原文分报；无需强造lesson |
| R2 | 完成一次工作，仅用领域tools；检查source index/status/ref | source无`.ensemble`/symlink/自动提交；archive有一致记录和文档版本 |
| R3 | 成员提交自己的贡献；同成员尝试采纳别人贡献/关闭invocation | 前者成功，后者在执行器拒绝，不能只测schema隐藏 |
| R4 | 同一expected revision的两个进程并发 | 仅一个ref发布；另一个明确conflict，不last-write-wins |
| R5 | commit对象写好但ref未更新；ref更新后响应丢失 | 前者旧文档完整；后者receipt可读且重试不重复动作 |
| R6 | 相同operation_id同payload/不同payload/不同actor | 返回原收据/拒绝冲突/隔离身份，不重复编号不冒领 |
| R7 | archive grant撤销与排队写竞争；source read-only但archive明确opt-in | 撤销完成后的写拒绝；合法app-data记录可写但source仍不可写 |
| R8 | Host/container存在相同字符串路径；两个clone同remote | 不错域读写、不自动合并项目；必须显式binding与同域核验 |
| R9 | 修改checkpoint文字，不影响旧测试范围；修改真实候选代码 | 前者可显式applicability复用旧观察；后者不能自动继承通过；均不伪装重跑 |
| R10 | 教过的原例通过，未见相邻例失败 | 记录修复成功与迁移失败；不能把教学升级为supported普适lesson |
| R11 | reflection引用真实检查但因果解释过强，或review后修改draft | reviewer可阻断；draft revision变化使旧review不再授权publish |
| R12 | invocation completed后提交反思/反证；blocked解除后resume | 学习可继续；challenge可触发Lead reopen，既有完成历史保留 |
| R13 | collection拆分、跨域引用、published条目更正 | 稳定entry身份/旧版本保留、主叙事不重复、当前显著标更正 |
| R14 | key出现在原始环境/请求；纯工具元数据安全但自由正文含敏感信息 | 无自动原始采集；人工正文不承诺完美脱敏，发布前可审；默认私有/不push |
| R15 | 模型不获准route、fork preset、effort-only；显式同route省略effort | 原生拒绝非法组合；合法默认行为与源码一致，偏好不扩权 |
| R16 | future schema、损坏对象、磁盘满、timeout临近ref发布 | 不reset/覆盖历史；结果不明先对账；拒绝或unknown有明确依赖后果 |
| R17 | UI重连、撤权、旧revision慢结果、插件卸载/HMR | 不能串项目/版本或展示撤权内容；注册/资源/runner清理，重启从ref恢复 |
| R18 | 纯skill用`npx skills@latest add vcup/skills`及`--skill ensemble`分别验证发现/选择；OMP、DSH从独立包安装；离开母仓库加载全部参考；重复注册ensemble | 纯skill无需构建且生成内容与Git一致；每个安装根仅有common及本路径内容，README/链接/autoload/reference闭包正确；同名不合并，DSH与OMP原能力分别可用 |
| R19 | fresh/fork/续用的独立性与输入；同树通信；Team开/关、任务领取与变化 | 驱动选择有依据，fork当前轮要求明确传递；消息与任务能力分别验证，task变化不自动唤醒，成员身份不授予archive权限 |
| R20 | spawn显式route/effort及默认；fork模型覆盖请求；workflow模型选型；拒答与普通Error；采用包装时同名注册/卸载 | spawn保留原生授权及默认语义；fork保持原路由及effort、拒绝换模；workflow权限和失败子项单独验收，null或CONTENT_REFUSED不计完成；使用rc.4真实错误载体；包装不能仅改schema或绕过执行器 |

P0补齐的约定按以下成对场景验证；括号中的D项与[路线图](../../ROADMAP.md#31-设计决定归属与验收交接)对应。

| ID | 正常输入与反例 | 预期结果 / 负责阶段 |
|---|---|---|
| R21 | 原子新增必要coverage及判据；当前candidate完成；反例为新frame待核、局部applicability、旧passed后出现failed、open关键challenge | requirements整组校验；完成读取全部适用检查，关键失败经有依据的resolution解除，不能挑旧pass；改范围另核授权 / P3（D02–D04） |
| R22 | 在委托内绑定新成员；替换后旧成员迟到提交；无委托扩grant；reported“用户同意”缩范围 | 只有当前绑定和真实授权有效；旧产物由L外部登记，不能假冒新成员 / P3（D03/D12） |
| R23 | 保存desired后应用原生Settings；并发变化、响应丢失、恢复旧偏好 | 已保存/已应用分开；失败或unknown可reconcile，不恢复过期权限或凭证 / P3（D06） |
| R24 | 大文本分块中断/续传；异字节重叠块；源清单增加/删除文件；显式例外 | 完整digest核验后提交；冲突拒绝，源变化stale_inventory，例外导入标partial / P3、P5（D07） |
| R25 | 从独立备份恢复并换根；旧主未停、切换中断、旧备份缺较新receipt、未来format | 仅一个writer；同id恢复须含最后权威head，证据不足仅只读，有损恢复新id且列丢失范围；未知format拒写 / P6（D05/D11） |
| R26 | 非作者approve后发布；另一reviewer仍阻断；草稿改版；更正扩大主张 | 未解除的阻断拒发布，稿件改版/更正均需匹配新版review；只增其它artifact不使review失效 / P4（D08） |
| R27 | 显式检索proposed经验做新例验证；当前版本/旧版本/retired版本各收到contradiction | 当前未退役版标contested；旧/retired版只追加证据不复活；新例及非作者check支撑评估，默认检索仅supported / P4（D08/D09） |
| R28 | 固定snapshot多页读回；新head、撤权、超预算、cursor过期、晚到旧页 | 页不串版本/项目，撤权丢弃旧epoch；partial/empty/error明确；已接受字节可完整读回 / P5、P6（D07/D09/D10） |
| R29 | 停写备份后GC；敏感数据维护预览；存在未知外部副本 | 普通维护保留可达历史/收据；破坏性清除需owner批准并更换archive id，列出未确认副本 / P6（D11） |
| R30 | 显式push远端复制并隔离fetch恢复；断连、remote ref变化、不相关历史 | 不force/merge或改活动ref；unknown先对账，恢复要求旧主停写与新grant / P6（D01/D11） |

每个向量对应可观察结果。完成相关切片后运行窄测试，Host/Client至少各一条真实Loader组合；模型可见行为用keyless snapshot，跨模型运行用获准真实Adapter。

## 7. 设计证据与运行交接

已完成固定发行源码研究、方法修订、领域/全表达映射，以及命令、管理和三条旅程的文档约定。工作树已完成内容装配、OMP 独立包与 DSH Host-only Loader 探针（均已通过非作者独立复核），各自通过测试，命令与证据见 [P1 交付记录](P1-DELIVERY.md)；这些不是产品实现验收。P1优先验证[运行管理](OPERATIONS.md#1-范围决定与支持组合)选定的Linux Host、本地Git/fsync、Web/headless及容器source组合，再确定发布支持范围；P2–P6分别提供CAS、授权、内容、UI和数据维护证据。设计基线为 rc.4；当前支持集为 rc.4 与 rc.5（默认 rc.5），版本契约与升级流程见 [版本支持与升级](../UPGRADING.md)。精确字段、对象revision和失败规则直接转成实现schema及成对检查，变化回写对应设计。

初版只支持同Host本地Git单主存储，不做多Host共享文件系统写、自动远端同步、自动全局prompt优化或模型权重训练。不存在“完备”总布尔值：分别报告表达覆盖、领域流程、静态Interface可行性、真实组合、故障与运行证据。

## 固定源码依据

[standard]: https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/packages/bundle/web-app/presets/standard.patch.yml#L89-L116
[subagent]: https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/packages/subagent/tool-subagent/src/index.ts
[selection]: https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/packages/subagent/tool-subagent/src/model-selection.ts
[preset]: https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/packages/subagent/tool-subagent/src/preset-selection.ts
[local]: https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/packages/subprocess/subprocess-local/src/index.ts#L70-L160
[isolation]: https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/docs/user/develop/framework/service.md#L111-L139
[sandbox]: https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/packages/sandbox/sandbox/src/index.ts#L32-L89
[remote]: https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/packages/api/remote-access/src/index.ts#L145-L222
[remote-allows]: https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/packages/api/remote-access/src/index.ts#L224-L244
[settings]: https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/packages/settings/settings/src/index.ts#L298-L424
[credentials]: https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/packages/credentials/credentials/src/index.ts#L154-L250
[storage]: https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/packages/storage/storage-json/README.md#L135-L145
[client-build]: https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/docs/cookbook/adding-a-settings-card.md#L56-L70
[workflow-result]: https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/packages/workflow/workflow/src/types.ts#L60-L88
[refusal]: https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/docs/upgrade-guide/v0.2.2-rc.3/deepseek-refusal-code/guide.zh.md#L10-L17
[skill-api]: https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/packages/skill/skill/src/index.ts
