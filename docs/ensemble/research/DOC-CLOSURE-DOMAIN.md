# Ensemble 文档闭合独立审查

> **历史审阅记录。** 本文保留当次工作树的发现、反例和建议；文档发现已通过[文档补齐与审阅处分](<DOC-CLOSURE-RESULT.md>)处理，不代表当前待办。正文中的“当前”“尚未”及行号均为当时定位，不代表现行产品状态或当前行号；链接指向正式维护文件。文档闭合不等于实现或运行验收；迁存的静态校验不补作历史产品验收。

已完整阅读 [ROADMAP](<../../../ROADMAP.md>)、[领域模型](<../DOMAIN-MODEL.md>)、[档案设计](<../ARCHIVE-DESIGN.md>)、[替代矩阵](<../REPLACEMENT-MAP.md>)、[实施准备](<../IMPLEMENTATION.md>)，并核对关联总览与方法定义；未改产品文档、未查 DSH 全源码、未安装或运行测试。
结论：P0 尚未闭合。现有设计已明确外置档案、CAS、身份不由模型自报、保存/采纳/验证/出版分离；以下指出仍会使实施者作出不同解释的契约空白，不把未实现或未运行本身列为文档缺陷。1–12 按对语义一致性与交付安全的影响排序，均可先靠文档决定补齐；V1–V4 才是必须运行回答的门槛。

1. **完成门槛没有闭合到“哪些版本、哪些状态算满足”〔文档决定；D03/D04〕**。定位：[领域模型:32–38](<../DOMAIN-MODEL.md>)、[替代矩阵:25–28](<../REPLACEMENT-MAP.md>)、[待核规则:57](<../REPLACEMENT-MAP.md>)。
   正常例：C1 的必要覆盖均有采纳版本和对应通过检查，允许 completed。反例：改为 C2，只对局部填写 applicability，其余决定仍待核；“必要项已处分”可被误读为允许关闭。已有关键失败/缺失拒绝规则，但 partial、待核、受 challenge 的旧 pass 如何参与关闭判定仍未明确。
   最小补充：一张覆盖项满足表，绑定 frame revision、贡献/决定 revision、candidate、检查及复用范围；明确待核/受挑战/部分覆盖何时阻断、谁能处分，以及关键性变更的授权。列 active/blocked/completed/abandoned 的合法转换和各态允许动作，保留旧完成声明而不把它当当前有效证明。

2. **授权的委托单位、成员替换和范围变更凭据尚未闭合〔文档决定；D03/D12〕**。定位：[权限:54–60](<../ARCHIVE-DESIGN.md>)、[范围与绑定:13–20](<../REPLACEMENT-MAP.md>)、[迟到结果要求](<../../../ROADMAP.md>)。
   正常例：A 被绑定 attempt 后在获准范围提交；owner 确认缩减范围后 Lead amend_frame。反例：换成 B 后 A 凭历史绑定迟到提交；Lead 将自行写入 artifact 的“用户同意”作为 authority_ref。当前原则禁止越权，却未定义执行器凭什么区分这些输入。
   最小补充：actor×action×对象/生命周期的授权表，明确 plan/update 是否及如何派生受限 grant、绑定代际/有效期、替换后旧提交拒绝或隔离的规则；scope amendment 只接受可核对的受信用户指令引用或 owner 确认凭据，普通 reported 引用不能授予权限。原生 task owner 与 archive grant 分别记录。

3. **命令闭集缺少必要事实的生产入口〔文档决定；D03/D04〕**。定位：[命令枚举:44](<../ARCHIVE-DESIGN.md>)、[claim/未决问题:22–28](<../REPLACEMENT-MAP.md>)、[challenge:53](<../REPLACEMENT-MAP.md>)。
   正常例：已有 contribution 可被 decide。反例：尚无 contribution 的范围风险要登记；交付完成后成员提供反证，希望把具体 check/decision 标为 challenged。claim 没有身份/创建规则，challenge 既无明确动作也无解除流程；保存一篇 artifact 不等于完成这些状态变化。
   最小补充：选择 claim 是独立对象还是具名内嵌主张，给创建/修订/引用规则；明确无贡献风险的 decide 分支，以及 challenge 的提交、目标 revision、处置、解除和读回入口。可收进现有 action 的封闭分支，不必扩展通用 CRUD。

4. **“revision”与引用尚不足以作为共同契约〔文档决定；D05/D07/D09〕**。定位：[查询/收据:46–50](<../ARCHIVE-DESIGN.md>)、[引用分类:64](<../ARCHIVE-DESIGN.md>)、[exact draft review:78](<../DOMAIN-MODEL.md>)。
   正常例：审阅 draft r1 后发布 r1；修改正文成为 r2 后重审。反例：别人只新增 artifact，archive commit 已变、draft 未变，某实现使 review 失效，另一实现继续有效；两者均能把文中的 revision 解释通。
   最小补充：分别定义 archive revision、对象 revision、native/source revision；给内部对象、原生证据、source-world、外链/用户报告的判别 union 和一个实际引用例。规定 exact 与 latest 何时解析、跨项目授权、坏链/未知状态；receipt 的 committed_revision 必须定位原提交，不能随包含该收据的后续 commit 漂移。

5. **审阅阻断与出版更正未共用明确门槛〔文档决定；D03/D08〕**。定位：[审阅/更正:78–82](<../DOMAIN-MODEL.md>)、[学习命令:44](<../ARCHIVE-DESIGN.md>)。
   正常例：非作者对精确稿件无阻断，Lead 发布。反例：reviewer A 阻断而 B 批准；或者作者先出版弱主张，再直接 amend_publication 加入更强因果结论。现有 draft 规则不能确定阻断如何解除，也未说明 amendment 是否同样受审。
   最小补充：规定有效 review 集、blocking issue 的解除/撤回权限和发布前判定；语义更正绑定待审 revision 后再出版，拼写/链接修正若走轻流程需明确允许字段。另定撤回入口，以及被引用证据受挑战时当前阅读如何显著标记、是否需要复审；不自动抹掉历史。

6. **教学观察与 lesson 状态之间还缺可审交接〔文档决定；D08〕**。定位：[教学验证:51–53](<../DOMAIN-MODEL.md>)、[lesson:90](<../DOMAIN-MODEL.md>)、[assess 输入:44](<../ARCHIVE-DESIGN.md>)。
   正常例：原例修复后，在未暴露的新例上观察到适用改善，由有权限者作限定支持判断。反例：将同一已教答案的再次通过填入“应用观察”，或反例出现后不同实现分别保留推荐/置 contested；四种状态未给足转换与权限。
   最小补充：应用观察绑定 lesson revision、attempt/案例、coaching 与暴露记录、结果/局限；指定 assessor、supported/contested/retired 的进入和退出规则、反例处理与默认推荐过滤。程序验证关系和必填依据，语义上的可比性/支持程度仍由具名审阅者判断，不把一条 check 自动升格为学习有效。

7. **概览编辑、分域顺序及分页快照不能由读取端各自猜测〔文档决定；D04/D08/D09〕**。定位：[分域/检索:86–92](<../DOMAIN-MODEL.md>)、[查询:46](<../ARCHIVE-DESIGN.md>)、[UI 固定 revision:61](<../IMPLEMENTATION.md>)。
   正常例：拆域后 entry id 和引用不变，概览指向新归属；搜索翻页仍读同一版本。反例：概览正文没有明确生产动作；“发布顺序”与“collection 文章顺序”可能冲突；翻页期间条目迁移/被撤回导致重复、漏项或当前/历史混读。
   最小补充：给 organize_domain 的创建/改概览/拆分/迁移/排序分支及编辑权限，区分全局发布序号与集合阅读顺序；query 固定 archive revision、过滤条件和 cursor，标 complete/partial/next，撤权时重新授权。正文/限制段超预算要分页或拒绝，不能只返回建议而省略适用条件。

8. **导入批准对象与接受的字节未绑定〔文档决定；D04/D07〕**。定位：[导入:112–114](<../ARCHIVE-DESIGN.md>)、[内容完整性:39–49](<../REPLACEMENT-MAP.md>)。
   正常例：预览清单的字节/digest 与导入一致，未知段落及原链接原样可读。反例：授权预览后源文件改变、同名附件 handle 换内容，或 chunk 最后一段丢失；目前不能确定导入原快照、重读新字节还是报失败。
   最小补充：固定 inventory 的 source-world、逻辑路径、大小/digest、例外集合及授权引用；接受前核验，变化则 stale_inventory 并重新预览。定义 attachment/chunk 的接收上限、会话身份、finish 校验、取消/重试和完整发布点；去重按接受的内容而非可变 handle。坏链接保留原串并报告，导出给清单、版本和冲突策略，不隐式覆盖源。

9. **可关闭历史与唯一提交点直接冲突，失败契约还缺最后一段〔文档决定；D05/D11〕**。定位：[总览:43](<../README.md>)、[唯一提交点:72–80](<../ARCHIVE-DESIGN.md>)、[失败:88–98](<../ARCHIVE-DESIGN.md>)。
   正常例：managed 保存一次事实即产生可恢复 commit。反例：用户关闭自动历史后 open/put 成功应保存在哪；取消时刻跨过 ref 发布后，调用方怎样区分取消成功与结果未知；重试键过期后是否重做原动作。
   最小补充：建议 managed 历史必开，把无档案模式明确留给纯 skill/OMP，不发明第二保存路径；补初始化/重绑/撤销的锁序、收据保留期限与查找方式、payload 规范化及已提交/未提交/unknown 的取消和重试表。领域错误需稳定 code+下一动作，原生普通 Error 仍原样保留为未知类别，不能靠字符串猜重试。

10. **环境历史“保存成功”与原生设置“应用成功”没有可恢复流程〔文档决定；D06〕**。定位：[可选环境仓:11](<../ARCHIVE-DESIGN.md>)、[期望/实际证据:57–61](<../DOMAIN-MODEL.md>)、[D06 明确要求](<../../../ROADMAP.md>)。
    正常例：owner 保存偏好，应用后获取实际配置证据。反例：环境 commit 成功而 Settings 应用失败；恢复旧偏好却仍运行旧 Session policy；没有 actual request 时拿创建描述当实际值。
    最小补充：确定环境身份/独立版本及 owner 命令，给 desired revision、applied/failed/unknown、受信 observation 的对账与重试状态；恢复是新授权操作，不复活过期权限。P0 明确 fork 同路由 effort 纳入与否及未知基线行为；actual request 的受信来源/不可取得状态须先定，再运行核验。

11. **owner/headless 和长期维护旅程仍只有承诺，缺可执行交接〔文档决定；D02/D04/D09/D11〕**。定位：[管理动作:54](<../ARCHIVE-DESIGN.md>)、[长期演进:116](<../ARCHIVE-DESIGN.md>)、[P5/P6 要求](<../../../ROADMAP.md>)。
    正常例：新项目 owner 初始化→Lead 读 revision→成员获准提交；干净机器从备份恢复。反例：无 GUI 时如何证明 owner；archiveRoot 换到一半失败；恢复时只有档案、没有旧注册表/凭证，却误复制旧 grant 或启动两个 writer。
    最小补充：用新项目、旧目录、下一任务学习三条旅程串明入口、可信身份、输入/成功点/失败下一步；管理闭集加入预览/导入/导出、诊断、停写/换根、备份/恢复和版本迁移，明确恢复重新绑定授权及单 writer 交接。指定可重建索引与必须备份事实；敏感清除与普通撤回分开。

12. **剩余范围与资源支持必须作有界决定，不能留给首版实现〔文档决定；D01/D10〕**。定位：[远端同步范围](<../../../ROADMAP.md>)、[D10](<../../../ROADMAP.md>)、[首版本地范围](<../IMPLEMENTATION.md>)。
    正常例：本地闭环按确定平台/预算推进；远端能力有明确未纳入决定。反例：实现者将“首版不自动同步”当成永久删除 C17，或每个入口自行决定正文大小/并发上限，使接受的内容无法完整读回。
    最小补充：记录 C17 纳入/排除及依据和 owner；给首个支持平台/执行世界、内容/附件/响应/并发/检索预算表及超限返回。数值可作为待测目标，但必须附通过/失败后修改的承诺位置；同步待定默认不阻塞本地 P1–P5，不冒称全范围完成。

以下是运行门槛，不是以上业务决定的替代品；本次均未执行。

- **V1〔必须运行；D10〕：真实 Loader/包与 Host 隔离。** [接入约束:104–108](<../ARCHIVE-DESIGN.md>)、[R18](<../IMPLEMENTATION.md>)。正常例：无源码 checkout 安装，source 在另一执行世界仍只写获准 archive；反例：同字符串路径/缺 sandbox/卸载重载。失败须修支持范围或接入设计，不能以裸 Host 执行、source fallback 补洞。
- **V2〔必须运行；D05/D11〕：CAS、撤权与崩溃恢复。** [R4–R8](<../IMPLEMENTATION.md>)、[R16](<../IMPLEMENTATION.md>)。正常例：ref 前失败旧视图不变，ref 后丢响应可读原收据；反例：跨进程撤销/重绑竞争、磁盘满、超时、重启及备份在干净环境恢复。失败不能声称原子/持久，返回对应事务或维护契约重定。
- **V3〔必须运行；D06/D12〕：真实代理与配置证据。** [R19–R20](<../IMPLEMENTATION.md>)、[原生限制](<../NATIVE-AGENTS.md>)。正常例：获准 spawn route/effort 对上 actual request、消息续做和 Team 开/关各自可用；反例：拒绝 route、fork 覆盖、workflow 子项失败、替换后迟到提交。无受信证据只能 reported/unverified；失败缩回明确能力或修 Adapter，不能用创建成功/脚本结束冒领。
- **V4〔必须运行；D07–D10〕：真实内容、UI、负载及学习效果。** [R1](<../IMPLEMENTATION.md>)、[R10–R13](<../IMPLEMENTATION.md>)、[R17](<../IMPLEMENTATION.md>)、[容量门槛](<../../../ROADMAP.md>)。正常例：全字节往返、授权快照分页、读者答出证据/取舍、下一任务新例改善；反例：源变化/坏链接/超限、撤权后慢结果、教过例通过而新例失败。分别收窄覆盖/容量/学习主张，不把文章发布或 UI 可打开当验收。

建议先由 Coordination/Archive/Learning 的负责者共同裁定 1–5，再固化命令/引用样例；其余 D 项补上具体 owner 与完成依据。只有 V 类未知才按 [P0 出口](<../../../ROADMAP.md>)移交有界 P1 实验，不能把状态、权限或必要内容落点留给实施者猜测。
