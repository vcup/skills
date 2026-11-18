# 路线图交付依赖与原生成员接入复核

> **历史审阅记录。** 本文保留当次工作树的发现、反例和建议；文档发现已通过[文档补齐与审阅处分](<DOC-CLOSURE-RESULT.md>)处理，不代表当前待办。正文中的“当前”“尚未”及行号均为当时定位，不代表现行产品状态或当前行号；链接指向正式维护文件。文档闭合不等于实现或运行验收；迁存的静态校验不补作历史产品验收。

execution · 只读核查当时正式设计、实际包配置与 OMP 代码。不实现、不安装、不运行测试或 Git；没有新探针结果。DSH 公共能力仍沿既有固定 `39163dd30f703a79079e2d2446545cff3c453738` 研究，不重新展开全源码调查。

## 1. 成熟度：总体方案成立，详细契约与真实产品组合尚未完成

| 事实 | 原始依据 | 路线图含义 |
|---|---|---|
| 当前包是 `@vcup/skills` 0.2.0，只声明 OMP extension；脚本仅 Bun test/typecheck，无 DSH exports/build/engine/依赖声明 | [package.json](<../../../package.json>) | 不能把 DSH 实施描述当已交付；增加 Host/Client 是包消费模型的扩展 |
| OMP 工具接受路径与完整 Markdown，写入源工作区限定位置；临时文件 rename，不含领域规则、expected revision、Git历史或恢复收据 | [OMP writer](<../../../adapters/omp/index.ts>) | 有可保留的原生 Adapter，不是托管 Archive 的前一版本；OMP 不应被悄悄改口成已迁移 |
| 当前 OMP 测试只有有效路径写入、形状拒绝、两类 symlink 拒绝；本轮未运行 | [OMP tests](<../../../adapters/omp/index.test.ts>) | 不能拿这些测试通过支持 DSH CAS、全表达、授权、UI 或发布证明 |
| TypeScript 配置是 noEmit，include adapters TS，没有独立 Host/Client 编译配置 | [tsconfig](<../../../tsconfig.json>) | 需解决打包产物、类型声明、浏览器 external 身份与 OMP 源入口兼容 |
| 包没有 files 白名单；根忽略仅 node_modules 与外部源码副本 | [package.json](<../../../package.json>)、[忽略规则](<../../../.gitignore>) | 实际 tarball 须既验必需文件存在，也验私有研究/环境/历史不在包内；未 pack，不能声称已泄漏或已安全 |
| 正式文档已给正常交付、学习流程、唯一 Git commit point、全表达矩阵与 R1–R18 | [设计入口](<../README.md>)、[实施向量](<../IMPLEMENTATION.md>) | 具备详细设计输入，不具备产品运行资格；A–F 均未运行，P0 仍须闭合 |

成熟度不能用“研究完整，所以进入全部代码并行”概括。当前可开始的是有界设计补全、契约审阅与最小真实组合实验。领域状态/权限/记录版本尚有共同未决点，贸然按 tools、Remote、UI 分工会让每个实现者各造一套语义。

## 2. 第一阶段必须补齐的完整设计图景

不是再扩写理念：每项需一份生产者→可信输入/版本→动作→保存点→返回→消费者→失败/恢复的明确契约、正反例及负责者。以下都对应当前文字承诺。

| 待闭合项 | 现有承诺/缺口 | 必需设计结果 |
|---|---|---|
| 领域动作闭集 | [命令表](<../ARCHIVE-DESIGN.md>)已补 propose_lesson 与 artifact create/revise/retire/correct；[学习规则](<../DOMAIN-MODEL.md>)仍以自然语言说明 draft 修订、撤回、lesson状态、collection拆分 | 明确 reflection draft 的 revise/withdraw 分支、lesson 内容修订与 assessment 状态变化、领域概览/顺序维护；可用现有命令的封闭 mode，不必增通用CRUD |
| claim / challenge / evidence | [替代矩阵](<../REPLACEMENT-MAP.md>)允许对 claim 决定；[生命周期](<../REPLACEMENT-MAP.md>)要求 challenge 与 reopen | 定义可引用身份、声明者、修订/更正、授权写入、相关决定失效/待核；反证来自哪个命令、当前视图如何标记，不能仅靠全篇文本扫描 |
| 用户改变交付范围 | [关闭条件](<../DOMAIN-MODEL.md>)要求可追溯 scope amendment；[字段映射](<../REPLACEMENT-MAP.md>)要求用户授权依据 | `authority_ref` 需区别可信用户指令指针、引用文字和模型解释；不能因模型填了任意字符串就解锁 completion 判据 |
| 查询/返回/错误 | [查询与收据](<../ARCHIVE-DESIGN.md>)已有 revision/pagination/receipt 语义 | 定输入输出schema、可重试错误、分页游标绑定 revision 与权限、完整预算、正文diff查询、history/receipt定位；不存在先“成功”后静默裁掉限制段 |
| 原文与附件 | [完整替代](<../REPLACEMENT-MAP.md>)承诺字节往返、大小缺口、attachment/chunk | 定支持类型/字节上限、handle归属、读取授权、chunk会话完整性/digest/取消/回收；导入源在预览后变化必须重验。二进制不内联预览≠可以丢原字节 |
| 管理闭集 | [owner管理](<../ARCHIVE-DESIGN.md>)有 enable/bind/rebind/revoke/takeover/assign-reviewer | owner 首次身份、Web/headless进入方式、授权范围/委托、初始化失败、revocation线性化；import/export/rebuild/maintenance由哪个用户入口承担；不能只留模型工具 |
| 持久格式与恢复 | [记录/事务](<../ARCHIVE-DESIGN.md>)有原则而无完整格式 | 明确 record/object revision 与 archive commit、snapshot/event关系、renderer版本、receipt保留/定位与迁移、初始archive占位与崩溃清理；不在tree中写自己的commit hash |
| 环境配置历史 | [存储归属](<../ARCHIVE-DESIGN.md>)及[环境交接](<../DOMAIN-MODEL.md>)承诺独立环境、偏好及可用性/授权诊断 | 定非秘密字段/环境身份、读取推荐、修改/比较/恢复与历史入口。环境 Git 保存的期望配置与原生 Settings 实际应用不是同一提交：明确失败/待应用/生效证据和对账；恢复须重新授权而非恢复旧grant |
| managed模式开关 | [正常路径](<../README.md>)写“选择是否启用自动本地历史”，而[Git方案](<../ARCHIVE-DESIGN.md>)把Git定为唯一提交点 | 明确可关闭的是整个托管模式还是别的行为；不能实现未定义的“保存记录但不产生archive历史”第二真源 |
| 长期维护 | [长期演进](<../ARCHIVE-DESIGN.md>)、[敏感内容](<../DOMAIN-MODEL.md>)已有维护承诺 | schema升级、备份恢复、换根/换机、登记重建、锁恢复、容量/不可引用对象维护、敏感材料处置均给可操作路径与限制。append-only正常写与owner清除历史是不同操作集 |

## 3. teammate 必须是一条可验收的原生协作链

[方法](<../../../skills/ensemble/SKILL.md>)和[实施原生选择](<../IMPLEMENTATION.md>)明确复用原生 agents/tasks/messages；当前文档的较细篇幅集中于 archive，不能因此把成员协作缩成“两条route smoke”。建议独立设计项与覆盖项，保持原生运行事实的 owner。

| 交接 | 必须明确的事实 | 不可略过验证 |
|---|---|---|
| plan → native create → binding | attempt 可先存在；spawn/fork真实返回稳定身份后绑定，名称是当时通信名；失败保留planned/gap，不伪造已启动 | 创建失败、返回后响应丢失、同名替换；不以archive重放重复spawn |
| grant → member工具使用 | 工具可见性、原生policy与archive project/attempt grant是不同权限；从可信agent上下文解析actor | parent/child/sibling、fork/恢复/不同preset下可见而未授权时拒绝；成员只提交自己attempt，不能冒充Lead或reviewer |
| native task → contribution | task创建/领取/依赖/完成由原生拥有；archive只保存对应引用与协调判断 | native completed但贡献缺失、检查失败、贡献未采纳时不能completed invocation；不维护第二任务表 |
| message/wait → progress | 原生通信身份与inbox/wait语义照原生，known exposure由协调记录；不另造收件箱 | inactive不等于成功；无其他运行成员时wait不当作推进；取消/中断/失败消息不产生虚假采纳 |
| reuse / replacement | 同agent续做是修订而非新独立样本；换成员有新身份/旧绑定历史/权限变化 | 旧成员迟到提交按绑定与当前grant处理；已暴露siblings结论不能标独立首轮；native preset/route实际证据区别创建意图 |
| cold resume / handoff | 先读archive，再查原生Session当前存在性/状态；owner接管改变协调角色，不自行复活执行 | session缺失/恢复后名字变化、旧Lead迟到、撤销排队写；不因archive重建重复spawn/send/execute |

正常端到端：用户启用能力与绑定→Lead open/plan→原生创建→绑定真实成员→原生任务与消息→早期产物→工具提交→非作者检查→Lead采纳/返工→候选与验证→完成/恢复。至少两项有意义尝试，不必为了测试机械制造更多角色；角色声明不证明独立性、模型异质性或学习效果。

## 4. “首版不做”不能吞掉其它段落的承诺

| 项目 | 当前来源 | 路线图处理 |
|---|---|---|
| 环境独立历史 | [归属](<../ARCHIVE-DESIGN.md>)与[后续项](<../ARCHIVE-DESIGN.md>)；原A–F没有完整交付切片 | 纳入完整目标；可在P3，不因只读Settings可用就结项 |
| 本地备份/恢复、换机/换根 | [后续项](<../ARCHIVE-DESIGN.md>)、[损坏拒绝](<../ARCHIVE-DESIGN.md>) | P6有独立恢复演练，核心本地闭环可先交；“仅本地Git”不等于用户只能自救 |
| 远端同步 | [长期演进](<../ARCHIVE-DESIGN.md>)称后续；[实施限制](<../IMPLEMENTATION.md>)仅排除初版自动同步 | P0范围登记必须处分：是全目标中的后继阶段、手动受控操作还是明确不承诺；不能因初版排除直接从全部承诺表删掉 |
| 任意二进制内联预览 | [替代约束](<../REPLACEMENT-MAP.md>)明确不承诺全部格式 | 可保持非目标；但支持范围、原字节保留或明确缺口、完整导入判断仍是承诺 |
| 多Host共享目录多主、模型权重训练、全局自动prompt改写、向量DB | [实施限制](<../IMPLEMENTATION.md>)、[检索边界](<../DOMAIN-MODEL.md>) | 无现有需求依据，不扩造。可用的单主跨机器迁移、文本检索与教学验证不能依赖它们 |
| OMP自动外置Archive | [包现状](<../../../package.json>)、[能力声明](<../IMPLEMENTATION.md>) | 当前只承诺保留OMP消费/原工具，不承诺自动获得DSH托管能力；发布宣传需区分 |

## 5. 合理里程碑与不可绕过的门槛

顺序与 Lead 当前路线图 P0–P7 一致；原 A–F 是技术切片，不能直接等同完整用户目标。纯领域设计可并行，但共享身份/权限/版本先定；环境与原生协作不可作为 UI 完成后的附录。

| 阶段 | 依赖与可交产物 | 门槛 |
|---|---|---|
| P0 完整设计图景 | 闭合上述领域/管理/环境/原生成员/维护契约，逐项追踪承诺与范围；完整新项目、迁移、后续经验应用旅程 | 每个必要动作有生产者/消费者与正反例；未知只保留有界实验问题及失败后果；不把写完路线图当P0通过 |
| P1 真实组合与分发 | P0相关契约；最小Host工具、Client、用户调用技能/参考正文、外置Git探针、原生选择探针 | 无checkout实际pack安装Web/headless与OMP；公開依赖可获得；Host/source不同world；sandbox不支持则失败；实际request证据；包内必需资产与私有内容排除双向验收 |
| P2 最小可靠事务 | P1真实Host能力；owner init/bind/grant→open/artifact/read/receipt→重启 | 真实两进程CAS；ref前后崩溃/响应丢失/unknown；撤销竞争；source无改动；cache丢失可重建；初始grant不半发布 |
| P3 全协调+原生协作+环境历史 | P2；全部替代字段、附件内容、成员交接与交付恢复、环境偏好独立版本 | 模型不写状态文件完成全部模板/正文；原生task不冒领采纳；冷恢复不重复外部动作；环境保存/实际应用/恢复各有结果，不复制credential或旧授权 |
| P4 学习出版与复用 | P3产物与证据；coaching→新例→draft/review/publish→lesson→下一任务→反证 | exact review失效、非作者审阅、可读draft、撤回/更正、跨域稳定引用；未知/失败保留，不用文章数量证明迁移改善 |
| P5 Client、完整导入/导出 | P3/P4契约；管理+只读资源面、源world inventory/preview、导入和显式导出 | 两项目/会话grant隔离、撤权与旧响应、固定revision；源变化/重复/部分导入不误报；字节往返、未知文本/坏链/超限可见；真实GUI，不替代server |
| P6 运维与持久寿命 | 从P2准备，依赖P3–P5完整数据；升级、备份、换根换机、性能和敏感处置 | 干净环境从独立备份恢复；不搬旧机器grant当授权；schema未来版本拒写；锁/磁盘/退出故障；容量、长历史、检索预算；敏感清除披露副本限制 |
| P7 集成发布资格 | P1–P6，唯一实际候选包 | R1–R18+全表达+新增成员/环境/维护向量，三条完整真实旅程；OMP/纯skill回归，支持版本与平台说明；正式发布依届时授权，验证实际分发物 |

P1 和 P7 的发布物验收须同时检查：Host named exports/root entry、Client lazy-CJS factory与CSS/metadata、types与全部方法正文、原OMP入口、bare-package Loader消费；不能通过从本checkout或scratch私有源码解析依赖“通过”。要列实际tarball内容并限制发布白名单，不仅验证入口import成功。相关既有约定见[构建与R18](<../IMPLEMENTATION.md>)。

## 6. 对路线图草稿的快审

已读 [ROADMAP](<../../../ROADMAP.md>) 初稿并复核修订后的182行版本。成熟度判断、P0先行、P1真实组合、P2故障前置、P3环境历史、P6运维与“各阶段未验收”的措辞合适。最终复核确认本轮关键建议均有落点，未发现阻碍路线图交付的重大遗漏：

1. [D12与P3协作矩阵](<../../../ROADMAP.md>)、[C16](<../../../ROADMAP.md>)独立承接成员创建/复用、身份绑定、原生任务/消息/等待、权限、迟到结果及冷恢复，不重造roster。
2. [D06](<../../../ROADMAP.md>)与[P3环境交付](<../../../ROADMAP.md>)区分环境期望值历史和原生实际应用；[P1](<../../../ROADMAP.md>)及[C15](<../../../ROADMAP.md>)要求tarball白名单及私有记录排除。
3. [范围处分](<../../../ROADMAP.md>)、[C17](<../../../ROADMAP.md>)保留远端同步待P0决定；若纳入则P6/P7等待其独立验收，未被“首版”措辞无声删除。

本报告本身只证明阅读与推理，不证明任何未来里程碑运行通过。Host外目录先前写入受限、实际插件未实现，都不能以路线图或静态公共能力研究补作成功证据。
