# Roadmap 覆盖审查：完整设计到全部承诺的实现

> **历史审阅记录。** 本文保留当次工作树的发现、反例和建议；文档发现已通过[文档补齐与审阅处分](<DOC-CLOSURE-RESULT.md>)处理，不代表当前待办。正文中的“当前”“尚未”及行号均为当时定位，不代表现行产品状态或当前行号；链接指向正式维护文件。文档闭合不等于实现或运行验收；迁存的静态校验不补作历史产品验收。

methodology · 只读研究。Primary 为本仓库当时五份 ensemble 设计及六份核心技能文档；未联网、未运行产品或测试、未操作 Git。结论属于同一成员的接续审查，不包装成新的独立实验。

## 1. 阶段判断

**目前是“已有可审的领域、架构与表达覆盖草案，正在闭合完整设计图景”的实施前阶段。** 方法文本已有明确动作与术语；产品文档已经说明原生执行、协调、学习出版、外置存储及视图的职责，且列出主要正常路径、失败约束与验收向量。但命令、管理入口、全部状态转换、迁移/导出和规模行为尚未闭合，不能称设计已经完整，更没有可安装插件或运行通过的证据。

依据：[设计入口:3](<../README.md>) 明确尚无可安装插件；[实施计划:3、69–78、109–111](<../IMPLEMENTATION.md>) 明确未开始产品实现、A–F未运行。路径发现也未发现 `adapters/dsh/` 文件。现有 A–F 是**拟议实施切片**，不是进度或能力证明；其“已完成领域和全表达映射”应理解为已有草案与审阅，不替代逐项设计出口。

应分别报告：①方法文案已修订；②产品意图与大部分架构已描述；③全链行为契约仍需补全；④静态源码接入依据已有，但本轮未重验其运行可行性；⑤实现、真实组合、故障、迁移、规模与教学效果证据未建立。不要给“文档成熟度百分比”或用链接/字数换算完成度。

## 2. 不得在分期中消失的承诺清单

每行是覆盖组，不要求对应一个模块、角色或独立发布版本。依据给出实际承诺归属；末列把原 A–F 当作承接位置，缺项需由新路线图补入。

| ID | 明确承诺，含不能丢的部分 | Primary 依据 | 现有切片承接 |
|---|---|---|---|
| C01 | 可移植方法：完整结果、至少两个有意义的独立尝试、多维异构/冗余、观察取舍、单候选验证、Lead可亲自工作；不是固定角色流水线 | [SKILL:9–57](<../../../skills/ensemble/SKILL.md>)、[PATTERNS:3–11](<../../../skills/ensemble/PATTERNS.md>) | 正式方法与所有切片，F回归 |
| C02 | 教导前任务包和早期可审产物；中途诊断与纠偏；未见邻近例/不适用反例验证；指导修订不伪作独立首轮；Lead教案可被反驳 | [README:144–150](<../../../skills/ensemble/README.md>)、[DOMAIN:40–53](<../DOMAIN-MODEL.md>) | D，但依赖B的attempt/check |
| C03 | DSH用户触发技能、按需核心与指引、固定枚举参考读取、opaque资源提示、完整响应预算；不要求容器能读Host安装目录 | [IMPLEMENTATION:45–47](<../IMPLEMENTATION.md>) | A、F |
| C04 | 原生模型/effort/preset发现、授权、默认/省略语义、真实通信和续聊；请求/创建/实际请求证据分开；不造执行器/第二任务板 | [IMPLEMENTATION:35–43](<../IMPLEMENTATION.md>) | A依赖辨识、F真实smoke |
| C05 | 环境owner可配置本地角色偏好，推荐带当次可用性/授权诊断；偏好不扩权，经验读取不自动改部署；凭证不进入档案 | [DOMAIN:55–61](<../DOMAIN-MODEL.md>) | A/F；具体消费入口未定 |
| C06 | 用户首配/启用外置档案、可信项目绑定、grant、重绑/撤销/接管/分配审阅权限；新archive初始化有完整binding/grant版本；多项目隔离 | [ARCHIVE:7–19、48–60](<../ARCHIVE-DESIGN.md>) | C、E；管理正常路径需显式任务 |
| C07 | 所有协调数据在工作区外；无自动source文件、symlink、submodule、index/ref污染；不同execution world按可信身份核验；非Git项目可用digest | [ARCHIVE:7–19](<../ARCHIVE-DESIGN.md>) | A、C、E |
| C08 | 全部frame：标题/交付目标/subject/约束/覆盖/完成判据；范围变更留依据、覆盖稳定身份、用户范围不能被模型悄悄waive | [MAP:11–16](<../REPLACEMENT-MAP.md>) | B |
| C09 | attempt计划、成员绑定/替换、覆盖与写范围、差异/冗余、上下文来历、早期产物、所有进度；成员提交多个贡献与修订；提交不等于采纳 | [MAP:17–21](<../REPLACEMENT-MAP.md>)、[DOMAIN:29–32](<../DOMAIN-MODEL.md>) | B |
| C10 | finding/claim/贡献处分：accepted/rejected/revise/deferred/unresolved；authority、依据、后果、用户选择/风险、next、多blocker；原观察与处分分开 | [MAP:22–30](<../REPLACEMENT-MAP.md>) | B |
| C11 | candidate支持commit/patch/文件集/设计/artifact revision及dirty状态；检查的通过/失败/部分/未运行/不可用、critical后果、reported/采集证据分开；applicability复用不伪造重跑 | [MAP:24–27](<../REPLACEMENT-MAP.md>)、[DOMAIN:33–38](<../DOMAIN-MODEL.md>) | B、C |
| C12 | active/blocked/completed/abandoned；blocked恢复、completed重开、旧完成历史保留；交付后可追加artifact/反思/反证/更正，挑战不自动撤销交付；出版与交付独立 | [DOMAIN:34–36](<../DOMAIN-MODEL.md>)、[MAP:51–57](<../REPLACEMENT-MAP.md>) | B、D |
| C13 | 独立artifact完整正文、原始摘录、研究/设计/术语/未知字段、create/revise/retire/correct、旧版本、digest、版本diff；不能强制摘要化或先变成lesson | [ARCHIVE:44、64–68](<../ARCHIVE-DESIGN.md>)、[MAP:31、39–49](<../REPLACEMENT-MAP.md>) | B、E |
| C14 | 有界附件/二进制/长正文路径；接受内容无损读回，超限明确且有attachment/chunk或未覆盖结果；内部对象/版本/source/外部链接保留，行号绑定版本 | [MAP:40–49](<../REPLACEMENT-MAP.md>) | B、E；需补具体契约 |
| C15 | 完整旧目录迁移：source-world inventory/差异预览/授权、字节与结构/链接保留、未知内容、不支持项明示、结构化推断另列、重复/变化重导入、先保留原文件 | [ARCHIVE:110–114](<../ARCHIVE-DESIGN.md>)、[MAP:59–68](<../REPLACEMENT-MAP.md>) | E，不能只有预览 |
| C16 | 用户显式导出为普通文件、可恢复来源目录；导出不是自动镜像或协调真源，手工改导出不自动回流；删除旧source文件是另一次可审变更 | [ARCHIVE:9、114](<../ARCHIVE-DESIGN.md>)、[MAP:40](<../REPLACEMENT-MAP.md>) | A–F未单列，需补E/交付任务 |
| C17 | 工具与UI共享领域执法：action union、actor可信派生、project/角色授权、owner/Lead/member/reviewer分工、撤权与commit串行、只读source不妨碍获准archive记录 | [ARCHIVE:35–60](<../ARCHIVE-DESIGN.md>)、[IMPLEMENTATION:49–53](<../IMPLEMENTATION.md>) | A、B、C、E |
| C18 | bare Git单主ref唯一提交点，正文/状态/投影/历史一致；expected revision、幂等receipt、冲突、丢响应恢复、unknown结果、磁盘/权限/损坏/断电边界；不碰source Git | [ARCHIVE:70–100](<../ARCHIVE-DESIGN.md>) | C |
| C19 | 当前/历史查询、分页/内容选择/完整预算、旧revision与当时知识状态；committed草稿可读、published列表过滤；内部schema兼容、旧投影不被新renderer偷偷改写 | [ARCHIVE:46、64–68](<../ARCHIVE-DESIGN.md>) | B、C、D、E |
| C20 | reflection结构化章节与自由叙述、真实出处/回溯说明、非作者exact-revision review、阻断/修订失效、Lead出版、无review保持可读draft；有意义的因果阅读不等于流水 | [DOMAIN:74–82](<../DOMAIN-MODEL.md>)、[EVOLUTION:7–23](<../../../skills/ensemble/EVOLUTION-TEMPLATE.md>) | D |
| C21 | 发布顺序编号、无伪造时间线、保留有意义测量；更正/amendment/supersedes、旧身份/revision/失败经历可读、误导内容撤推荐；敏感清除另走owner维护 | [DOMAIN:80–82](<../DOMAIN-MODEL.md>) | D、E；清除界限需说明 |
| C22 | lesson单独提议/评价；trigger/action/证据/反例/适用/失效条件，proposed/supported/contested/retired；应用观察才支持；反证撤推荐/重评，检索不自动改prompt | [DOMAIN:90–92](<../DOMAIN-MODEL.md>)、[ARCHIVE:44](<../ARCHIVE-DESIGN.md>) | D |
| C23 | 规模分域：概览、面向读者的领域、collection split/迁移、稳定ID/顺序/跨域后果、单主叙事；按领域/任务/适用性可解释搜索、按需全文、限制不被截断 | [DOMAIN:84–92](<../DOMAIN-MODEL.md>)、[EVOLUTION:25–29](<../../../skills/ensemble/EVOLUTION-TEMPLATE.md>) | D、E；规模验收需补 |
| C24 | 授权只读看板：目标/贡献/取舍/candidate/check/next、原文/历史/分域阅读/更正、固定revision；不同项目/会话/撤权/慢结果不串；源证据和archive对象分路 | [IMPLEMENTATION:55–61](<../IMPLEMENTATION.md>) | E |
| C25 | CommonMark/GFM保守呈现、图片不自动载入、HTML/未知内容文本化、安全链接、typed locale、用户原文保留、未知/未审/过期/部分页/拒绝显示；HMR/卸载清理 | [IMPLEMENTATION:59–63、102](<../IMPLEMENTATION.md>) | E、F |
| C26 | 原生公开Host/Remote/resource/Loader组合、Host/Client分编译、仓外lazy-CJS/CSS、tarball完整闭包、真实可得依赖/兼容范围、Web/headless与OMP回归、无scratch运行依赖 | [IMPLEMENTATION:5–33、45–65、103](<../IMPLEMENTATION.md>) | A、F |
| C27 | 恢复/维护：ref重启、注册表可重建、停写重绑root、未知schema只读或拒写、卸载保留archive且不停止agents、重启不重放外部动作；备份/同步能力不伪称已有 | [ARCHIVE:17–19、86–116](<../ARCHIVE-DESIGN.md>)、[IMPLEMENTATION:53](<../IMPLEMENTATION.md>) | C、E、F |
| C28 | 分层验收：静态/纯领域/Git故障/真实Loader/实际pack/GUI/真实Adapter；R1–R18与MAP全表达往返；方法是否更有效须新例与反例，不能拿成功存储证明学习 | [IMPLEMENTATION:80–111](<../IMPLEMENTATION.md>)、[DOMAIN:94–98](<../DOMAIN-MODEL.md>) | 全阶段出口 |
| C29 | Teammate完整协作：Member与Attempt分离、原生Team/task/消息/等待、成员工具与archive grant、独立首轮/教学复用、交接/恢复/替换与迟到产物 | [GLOSSARY:9–15](<../../../skills/ensemble/GLOSSARY.md>)、[DOMAIN:21–36](<../DOMAIN-MODEL.md>)、[ARCHIVE:54–60](<../ARCHIVE-DESIGN.md>)、[IMPLEMENTATION:37–41](<../IMPLEMENTATION.md>) | A/F仅选型不够；应在P0单列契约、P3完整执行、最终真实协作验收 |

**本轮不得悄悄扩张，也不得抹去已承诺项。** 旧文明确不建立旧具名Team兼容、第二执行器/任务板、多Host共享目录多主写、全局prompt自动改写/权重训练/跨项目自动训练、向量数据库；首版也不承诺所有二进制内联预览。旧首版本地Git不自动push/pull/merge/GC，但外部备份/远端同步/环境仓版本化/跨机迁移另列“后续owner事项”，不能因此从全功能路线图消失。最新 [ROADMAP:33–35](<../../../ROADMAP.md>) 已将环境独立历史、本地备份/恢复/换机纳入阶段，远端同步另列待P0范围处分；这是当前范围安排，未定前不能将远端同步当已排除或已交付。原始依据见 [ARCHIVE:72、84、116](<../ARCHIVE-DESIGN.md>) 与 [IMPLEMENTATION:111](<../IMPLEMENTATION.md>)。

## 3. Phase 0 必须闭合的设计缺口

这些是明确承诺的行为尚未决定，不是要求实现前穷尽所有代码细节。每项应落到维护文档、负责者与可反驳的出口；可以沿已有Module补全，不必再建许多流程文件。

| 缺口 | 当前依据与具体反例 | Phase 0 必要决定/出口 |
|---|---|---|
| G01 全链用户路径和运行模式 | [入口:41](<../README.md>) 说“选择是否启用自动本地历史”，而 [ARCHIVE:72–80](<../ARCHIVE-DESIGN.md>) 规定Git唯一提交点。关闭“自动历史”后managed命令到底可否成功？ | 统一配置开关含义，写出首次安装→owner初始化/绑定/grant→模型发现合法入口→正常贡献/学习/阅读→跨会话恢复/接管的输入/返回；未启用、撤权、无模型路线和纯skill/OMP的可用路径不互相冒充 |
| G02 完整命令与角色契约 | [ARCHIVE:44、54–60](<../ARCHIVE-DESIGN.md>) 列出动作和角色原则，但不是逐动作contract。独立artifact的owner、Lead直接贡献、外部贡献、更正他人错误、教学/lesson评估各可由谁执行仍需表化 | 所有write/read/admin动作的actor、目标、必填内容/引用、当前状态、expected revision、结果/失败码与后续动作；不是用很多optional字段或任意JSON patch让实施者自己发明规则 |
| G03 所有协调状态与覆盖关闭判据 | [MAP:12、20、22–30、53–57](<../REPLACEMENT-MAP.md>) 已列名称和恢复方向；未定abandoned后能否重开、completed时frame/candidate改动是否先reopen、missing/superseded的后续合法动作、check更正与challenge入口 | 一张状态/动作矩阵覆盖invocation、attempt、contribution/decision、check/applicability/blocker。明确失败或缺失关键check怎样解除、deferred必要覆盖怎样阻断、applicability不能掩盖失败；保留历史且无自动语义等价 |
| G04 反思审阅与更正闭环 | [DOMAIN:78–82](<../DOMAIN-MODEL.md>) 给draft→reviewed→published和amendment，但未定reviewed后改稿回何态、多review冲突/阻断如何解除、出版更正是否重审、withdraw如何影响阅读 | 补proposal revision、review disposition与发布授权关系；更正/撤回正常路径及失败路径；至少一例“链接都真但因果过强”、一例“已审后修改正文”、一例“发布后反证”，不能留单人自动背书漏洞 |
| G05 经验/教导的完整可观察生命周期 | [DOMAIN:42–53、90–92](<../DOMAIN-MODEL.md>) 列教学步骤和lesson四态，未定proposed首次应用、contested后缩范围重评、retired恢复/替代及推荐过滤规则 | record_coaching与原例/新例/反例check、propose/assess/应用反馈的关联；各状态可推荐/显式读取规则；证据更新如何重核，未知≠已证伪；先验证声明范围，不虚设统一“学习分数” |
| G06 完整导入/显式导出入口缺位 | [ARCHIVE:44、54](<../ARCHIVE-DESIGN.md>) 的封闭命令及管理Remote没有明确import/export动作，章节却承诺预览/授权/重导入/普通文件导出 | 定义用户入口、模型可提出的范围、source-world读取授权、inventory版本/digest绑定、预览后source变化、部分成功/取消/重试、完整性结论、目的地与overwrite/链接/字节保真规则；无需模型管理路径编号；不得只交导入预览或只export摘要 |
| G07 长内容、附件和证据保真 | [MAP:39–49](<../REPLACEMENT-MAP.md>) 承诺无损/版本diff/附件或chunk；[ARCHIVE:66](<../ARCHIVE-DESIGN.md>) 只说有界输入/attachment handle | 定义接受类型、字节/响应预算、handle来源/权限/寿命、chunk归属与未完成状态、完整读回/分页/diff、不支持项的可读结果。明确内部引用指向何版本及源行号；无效引用不是丢弃原文的理由 |
| G08 大规模分域与检索一致性 | [DOMAIN:84–92](<../DOMAIN-MODEL.md>) 有概览、split、单主叙事与过滤原则，未定组织动作细节、改归属同时更正的语义及规模预算 | 定义域/概览正文的owner和版本、拆分/移动/跨域后果如何编辑与读取、旧引用与当前更正展示、固定revision的分页/搜索及授权过滤、当前默认推荐与历史知识状态。选代表资料规模与可用性阈值；无需向量库，但不能以“支持拆文件”代替可精读 |
| G09 Host与execution-world绑定的可落地前提 | [ARCHIVE:7、15、104–108](<../ARCHIVE-DESIGN.md>) 要可信拓扑/mount映射及Host-local confinement，实际提供者和支持平台待验 | 定义谁提供world身份/拓扑、能核验的部署组合、无法核验的返回与恢复、root变更停写/重绑迁移。把技术未知写成后续A探针与失败决策，不因未知削掉container/只读source等已承诺场景 |
| G10 存储schema、查询及维护边界 | [ARCHIVE:64–98](<../ARCHIVE-DESIGN.md>) 有强事务骨架，但缺可消费的记录版本/迁移支持范围、分页快照、取消/timeout最终收据和保留/修复操作契约 | 指定记录/投影/对象版本关系与稳定查询结果、读写失败后对账、升级/未知版本/损坏诊断、授权撤销读cache行为、最小Git/平台持久性验证计划。敏感清除/备份等owner维护说明诚实限定范围，不承诺append-only又抹除全部副本 |
| G11 UI与分发的完整使用规格及验收追踪 | [IMPLEMENTATION:55–76](<../IMPLEMENTATION.md>) 列读视图和构建约定；A–F未显式包含首配/重绑/接管、导出、域/lesson完整状态和规模测试 | 画出用户配置/管理入口与只读看板的关系，给正常/空/未知/部分/撤权/历史/更正视图；将C01–C29逐项映射到实现任务和可观察验收。明确tarball/依赖来源/Host、Client、headless、OMP、真实route试验需要什么环境，不能到最后才发现无法安装或验证 |

新增 G12（用户提醒 teammate 后）：C29的成员身份、原生Team/task、工具/grant、复用、替换、交接和恢复链须独立闭合，具体矩阵和四个验收场景见第6节，不再让它隐含在“原生执行”一行内。

补充原则：Phase 0 不必提前编写所有TypeScript schema或最终布局，但**每项被承诺的用户能力必须有合法入口、输入/输出、状态与失败处理、事实owner、实现依赖和验收目标**。不能仅把未决点改名为“实施细节”，也不能把正常功能换成只有拒绝错误的流程。

## 4. Phase 0 应交付的完整设计出口

1. **锁定完整范围与事实等级。** 把C01–C29逐项归属到维护设计和后续任务；范围外项、后续维护项单列。当前已知/待设计/待运行分开，不把A–F打勾，也不把日志/教学方法当已证明有效。
2. **通读一条完整新用户闭环与一条已有用户闭环。** 新用户：安装→配置/绑定/grant→调用技能→发现可选路线→提交独立artifact与贡献→反馈/修订/检查→关闭→反思审阅出版→lesson在新任务应用。已有用户：导入/再导入→跨会话恢复/接管→发现反证→挑战/重开→修订/更正→分域检索→显式导出。每步都能指出生产者、消费者、成功返回与未完成后果。
3. **状态、命令和权限表闭合。** 涵盖全部C08–C23，而不止open/submit/close。逐条从现有模板、未知内容和任意资料出发找到表达入口及读回目标；非作者review、完成后追加记录、blocked/reopen不因一个全局closed标记被挡死。
4. **学习出版与规模阅读成为一等设计。** 不是“有空再写经验”：reflection、lesson、domain、overview、应用反馈、反证/更正都有owner/版本/可见性/检索规则。大规模按域精读、稳定引用与有限预算有代表输入和预期结果；正文仍能完整理解条件，不能只是链接墙。
5. **存储/迁移/跨域契约可实施。** Git唯一提交点、grant与幂等/版本顺序、对象/投影/查询、长资料/附件、导入/export、取消/部分结果/恢复统一；先解决“自动历史是否可关闭”等矛盾。Host能力未知留下有负责人和反例的验证任务，不能宣称已经满足。
6. **非作者走查与全覆盖验收映射完成。** 对G01–G12至少各有正常例与能推翻过强保证的邻近例，补充现有R1–R18遗漏（导出、管理、lesson全态、出版更正再审、规模/分页）。每项实施任务有前置条件、可审中间产物、通过/失败后动作；不存在“实现者还需自行发明业务规则”的关键空白。

Phase 0 出口是**文档化的完整产品图景与可执行验证计划经过反例审查**，不是实现成功。可并行做只读依赖核验；需要原型/真实Loader/模型调用才能回答的技术问题进入下一阶段明确门槛，未验证时不升级事实等级。本轮不执行这些原型。

## 5. 新路线图怎样承接原A–F而不缩范围

| 顺序建议 | 必须保持的成果 | 与旧切片的关系及退出事实 |
|---|---|---|
| Phase 0：完整设计 | 第4节六项出口，关闭G01–G12的业务歧义，全部承诺有落点 | 新增并先完成，不能用已有五份文档的存在替代 |
| 后续：真实组合与平台可行性 | 实际pack/Loader、Host与source分域Git/sandbox、授权bootstrap、可用依赖；提早确认真实route/effort验收前提 | A + F的环境依赖前置；失败回修设计，不能宣称降级实现即完成 |
| 后续：全表达协调及可靠档案 | B的全部字段/资料/状态，与C的原子历史、grant、幂等、恢复一起形成可运行正常闭环 | B纯领域可并行，但仅open demo不是完整替代；C必须支撑真实调用 |
| 后续：教学、出版、经验与领域精读 | C02、C20–C23完整生命周期及查询；原例/新例/反例，反证与修订；实际数据规模可读 | D，不压成一个“生成Markdown”任务；发表、应用、效果各自留证据 |
| 后续：用户视图、迁移、导出与管理 | C06、C14–C16、C24–C25全部入口与正常/失败路径；完整旧目录往返与显式导出 | E扩足已有承诺，不新增随意功能；UI布局可早做但最终验证依赖真实Archive |
| 最后：完整产品验收和交付 | 全C组及R/补充向量闭合；真GUI/headless/pack、真实模型请求、OMP回归、卸载重启、文档与实际支持范围一致 | F不是把所有运行试验拖到最后；各切片先窄验收，最终只补集成和未闭合覆盖 |

不必固定采用以上阶段名称；重要的是依赖和出口完整。用户要求“第一阶段完善整个设计图景”应在根路线图中明文成为首个门槛，而不是在A前加一句“再研究”却仍让学习出版/迁移/规模设计拖到代码阶段。

## 6. 用户提醒 teammate 后的专项覆盖

这是对上述C04/C09/C17的显式补足，新增C29便于追踪。此前以“原生执行”统括太粗，可能让一个只创建两个代理的demo被当成完整协作。它不要求复活旧具名Team或另建成员roster。

| 协作环节 | P0必须明确及后续实测的正常/反例 | 事实归属 |
|---|---|---|
| 成员身份与尝试 | 一个持久Member可做多个Attempt；重用已读答案成员修复不计新的独立首轮，fresh prompt带答案也不独立 | 原生Session身份；archive只记录attempt关联与已知来历 |
| 原生Team/task | 检查root mode/实际工具；task归属、revision、依赖、接单和完成仍走原生；未启用不能假装已创建Team | 原生Team/task；archive不成为第二任务板 |
| 工具与授权 | 实际成员preset有必要的读/提交工具，并有相应project/attempt grant；有工具无grant拒绝，有grant但工具未装载应有明确诊断/受信登记路径 | 部署负责preset/工具；owner授grant；Lead仅在委托范围内分派 |
| 派发和等待 | 返回完整原生身份后绑定；消息受理不等于开始/完成，结果返回不等于采纳；原生通知/等待而非轮询 | 原生创建/通信/运行事实与协调判断分开 |
| 独立首轮与教学 | 中性事实先行，早期可审产物、纠偏、原作者续聊修复；非作者新例验证。重要新事实及时共享并标影响 | Lead负责任务与教学判断；工具不能证明未观察的信息绝没被读过 |
| handoff与接管 | 交接给出完整目标、候选、已决/未决、证据版本、已暴露信息与下一动作；新Lead经owner操作接管，不能凭名字获得权限 | archive保留可恢复判断；原生成员/task仍需查当前事实 |
| 替换与迟到结果 | 新旧成员绑定与版本可追溯；替换者能读必要事实；旧成员权限按策略收窄/撤销；迟到产物可留来历但不能覆盖新owner已接受状态 | 实际取消/停止走原生能力，archive撤权不是停止模型 |
| 中断与恢复 | 冷恢复核对binding/grant、candidate和原生task；不因inactive推成功、不因关闭invocation停止成员；消息/外部动作未知时先对账再决定 | 原生恢复执行，archive恢复协调；不自动重发已执行副作用 |

建议将这条链在根路线图单列设计项和能力项，并在后续P3/最终验收加入四个具体场景：

1. 两位真实成员各有可用工具与scope grant，独立提交artifact/贡献，Lead取舍并给一位续聊修复；修复不新增独立样本。
2. 原生Team未启用、工具不可用和archive grant缺失分别被识别，不能把三者混成“模型能力不足”或静默绕过授权。
3. 第一位成员被替换后迟到提交；保留来源与拒绝/旁存结果，新成员已接受贡献不被覆盖，旧成员也不能借旧身份处分别人结果。
4. Lead中断后由owner接管，恢复原生任务与archive当前候选，补做真正缺失部分；不重发已完成动作，不把旧消息accepted等同于任务完成。

最终只读复核 [ROADMAP](<../../../ROADMAP.md>)：D12、P3六行协作矩阵与C16已显式承接上述teammate链；成熟阶段、P0门槛、学习出版、导入/导出、管理和规模维护均有落点，未发现阻止路线图本身交付的重大漏项。此前遗漏建议已发Lead并被吸收，不等于P0或实现已经通过。环境独立历史、本地备份/恢复/换机已安排完整阶段，远端同步以C17留待P0明确处分；后续须同步维护设计，不能用旧“首版”措辞删项。研究中的旧A–F对应关系是输入基线，根路线图的新增P阶段不代表实现进度。

两项措辞建议已发送Lead：P3原生任务领取链注明Team启用条件，避免一面说Team可选、一面把它变成所有ensemble工作准入；P0允许留给P1的实验问题限定为运行才能回答的技术假设，业务状态、权限和内容落点不能整项延后。它们是路线图边界的收紧，不要求新增执行器或扩大本次研究。

## 自审与限制

已完整读取五份设计、技能核心正文及根路线图，并核对模式中的恢复、教导、出版、交付条款。引用是当时读到的工作树文本；后续修订会改变行号，应按章节和语义复核。本文无外部项目领域推论、无伪造时间线、无运行通过声明；区分旧文后续项与路线图本轮纳入项，没有以风险或未确定接口为由删去用户已要求的能力。
