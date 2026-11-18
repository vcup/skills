# `.ensemble/` 的完整表达替代

这张矩阵是替代成立的必要验收范围，而非可选功能清单。原始依据为[当前状态模板](../../skills/ensemble/STATE-TEMPLATE.md)及现有目录中的状态、研究、设计、术语与证据文档。程序接管维护，不削减模型能表达的内容：模型仍可写研究正文、解释和判断，经工具提交；程序决定存储、路径、编号、历史和视图。

工具分层见[档案设计](ARCHIVE-DESIGN.md)，字段与封闭分支以[命令约定](COMMANDS.md)为准。此处动作栏是语义速记，省略共同envelope与change包装；第5节提供逐项输入/读回样例。实现typed schema须覆盖每一行；所有持久路径、编号和生成视图由程序管理。

## 1. 状态模板逐项对应

| 既有表达 | 工具动作与内容 | 程序生成/检查 |
|---|---|---|
| Invocation 标题和目录身份 | `open(title, goal, subject, constraints, required_coverage, completion_evidence)` | 生成 project/invocation id，唯一身份；标题可变，路径不作为身份 |
| Lifecycle: active/blocked/completed | `set_lifecycle(state, reason, evidence_refs)` | blocked/resume、completed/reopen、abandoned 均明确；reopen保留上次完成声明，不删除历史 |
| Requested deliverable | `amend_frame(deliverable, rationale, authority_ref)` | 保留旧目标与变更依据；删减用户范围要求可核对的用户指令 |
| Subject and boundary | `amend_frame(subject, constraints, rationale)` | 范围含不变要求与排除项，不把实现缺口当新的排除项 |
| Required coverage | `amend_frame(coverage_items, change_reason)` | 每项稳定 id；退役有理由与用户授权依据，不用从表格删除隐藏遗漏 |
| Completion evidence | `amend_frame(completion_criteria)` | 预期判据与实际 check 分开；改变判据会提示相关判断需重核 |
| Contributions.Attempt | `plan_attempt(question, baseline_ref, member_ref?, early_slice, expected_output)` | 尚未派发与真实绑定分开；可分配/替换成员，保留旧绑定 |
| Assigned coverage | plan/update 的 `coverage_refs, write_scope_claims` | 引用已知覆盖；范围只是声明，不被当作实际锁 |
| Material difference or redundancy | `difference_or_redundancy`, `context_lineage`, `requested_selection?` | 普通说明不局限枚举；实际 selection evidence 单独记录，未知不补全 |
| planned/running/returned/missing/superseded | `update_attempt(progress, reason, replacement_ref?)` | 表达全部原状态；running 为协调进度声明，不冒充原生 agent 真值；missing 保留缺口 |
| Result / evidence pointer | `submit_contribution(attempt, summary, artifact_refs, evidence_refs, limitations)` | 支持多产物/观察/缺失后果；作者与版本由系统追踪 |
| accepted/rejected/unresolved finding | `decide(contribution_or_finding, disposition, reason, evidence_refs, consequence)` | unresolved/deferred 均可表达；影响可指交付或未来工作；不能只留一票赞成 |
| Decisions 的来源/授权 | decide/amend 的 `authority_refs` | 用户要求、规范、静态源、运行检查分别分类；记录引用不证明其内容 |
| Candidate | `set_candidate(source_ref, digest_or_revision, description)` | 允许 commit、patch、文件集、设计/artifact revision；dirty source 明确标记 |
| Observed checks | `record_check(target, kind, action, result, evidence_refs, limits)` | 记录通过/失败/部分/未运行，不伪造执行日志；reported 与采集证据分开 |
| 已有检查仍适用 | `record_check(kind: applicability, prior_check, current_target, scope, rationale)` | 原检查不变；显式影响核对把适用部分关联新候选，不称为重新执行 |
| Unavailable critical checks | record_check 的 unavailable + consequence，或覆盖项 gap | 关键与非关键、原因、对交付的后果均可记录；不得用缺结果当通过 |
| Unresolved choices or risks | `decide(disposition: unresolved/deferred, options?, impact, owner?)` | 仍需用户决定的事项可在 current view 中保留；不强迫二元采纳 |
| Next action | `set_next(action, intended_result, owner_ref?)` | 具体下一动作，允许 delivered；不因自动历史提交而捏造业务下一步 |
| Blockers | set_next/set_lifecycle 的 `blockers[], clearing_evidence?` | 多阻塞项可恢复；移除 blocker 留依据，不暗示 native 任务被启动 |
| 自由文字、未知段落/字段 | `put_artifact(kind: note, title, content, context_refs)` | 作为关联补充可读，原始片段保留；可另作结构化解释但不能覆盖原文 |

`set_next` 同时处理 next 与 blocker 列表，`amend_frame`完整替换指定字段组；coverage与criteria属于同一requirements组，原子校验并保留理由；不能因 schema 仅列常见项而丢掉语义。每次 mutation 由 expected revision 与 actor 校验约束。

## 2. 目录中不止状态文件

| 既有材料/行为 | 替代方式 | 完整性标准 |
|---|---|---|
| 长研究、设计、术语、原始摘录 | `put_artifact(kind, title, content, supersedes?, references?)` | 无须先成为 reflection/lesson；正文可为普通 Markdown/text，完整读回与版本 diff 可得 |
| 多个文件、嵌套目录、文件名 | artifact id、显示名称、导入时的 logical source path | 来源目录可重建供导出；新内容不要求模型管理文件树；引用靠身份而非重命名失效 |
| 图片、二进制证据、已有原生附件 | 受限原生 attachment handle 导入，或带digest/类型的引用 | 支持类型/大小明确；不支持者保留外部引用+缺失声明，未覆盖不得称完整迁移 |
| 对 workspace 代码/日志的链接 | source-world 引用，含实际基线和选择范围 | 不把 Host path 当 source path；引用可失效，不能保证永久可重放 |
| 文档互相引用、行号、外链 | internal object/revision 引用与原链接保留 | 不静默重写到另一个同名文件；行号仅针对对应版本 |
| 同一文件修订/替换/废弃 | put_artifact 新 revision 或 superseded/retired 标记 | 旧正文与旧引用可读；废弃不删原记录 |
| 状态回溯、交接与中断恢复 | read invocation/checkpoint/history/receipt | 恢复读取当前已提交 revision；native运行事实另查，不自动重启已完成动作 |
| 对历史错误的更正 | 追加 correction/amendment，链接目标和依据 | 不重写旧提交，也不让原误导性结论继续无标识推荐 |
| 某次研究有多领域内容 | artifact 可关联多领域；reflection只有一个主叙事归属 | 未拆分原稿不丢，分域阅读不要求复制全部正文 |

内容预算是明确失败/分页条件，不是允许无声截断的理由。完整替代表示已接受的内容可无损读回；超限应给可用的 attachment/chunk 导入或明确未覆盖结果，不能让模型拆成多份互相失去关系的“成功”记录。首版不承诺所有二进制格式可内联预览。

## 3. 关闭、恢复与学习不共用一个状态机

Invocation completed 关闭的是当前交付工作；仍允许新增反思、外部反证、artifact和已发布内容的更正。反证可能使旧完成声明受到质疑：程序标记关联 check/decision 的 challenge，Lead 再选择 reopen，不能由程序静默取消真实发生过的交付，也不能把旧完成当不许纠错。

Blocked → active 需要解释哪些阻碍已解除；completed → active 产生 reopening 记录与新候选/范围关系。成员继续说话不自动 reopen，archive shutdown 不停止原生 agents。反思 draft/review/published 的进度独立于 invocation lifecycle，因此可在交付后整理经验；未审稿不应迫使代码交付永不完成。

纠错非一律全量重验。新贡献/候选使相关决定与检查进入待核适用状态；Lead 可明确哪些判断因何仍适用、哪些必须重做。程序不推断语义等价，也不让复用旧观察被冒充为新的执行结果。

## 4. 替代的端到端验收

1. 用包含所有模板字段的 invocation 完成 open、计划、提交、取舍、候选、检查、缺口、风险、next、blocked/resume、complete/reopen；逐项比较当前可读投影，没有无处表达的字段。
2. 创建无 contribution/lesson 的长研究 artifact，读取、修订、引用旧版本，再撤回推荐；其正文不被强行概括成反思。
3. 导入现有 `.ensemble/` 全部文件，展示 inventory、原始摘要/digest、映射结果和未识别内容。导入前后字节内容可核对；生成结构化字段的推断另列，不伪作原作者声明。
4. 故意加入重复标题、未知列、额外段落、坏链接与不支持二进制；显示保留/缺口，禁止静默省略并报告迁移成功。
5. 模型不提供任何持久文件路径或 Git 命令，仅经工具完成上述行为；正常使用期间工作区没有新增/改动 `.ensemble/`、索引、symlink 或 Git 提交。
6. 自动版本、模型可见结果和 UI 展示引用同一 committed revision；丢失响应的重试不重复编号，不因旧 expected revision 覆盖另一人的更新。

这些是实现验收向量。下面先用具体值走读每个表达的输入与消费者；完整JSON示例见[用户旅程](USER-JOURNEYS.md#1-新项目从绑定到交付)。

## 5. 逐项输入与读回样例

共用背景：交付“缓存一致性方案”，覆盖项K1为并发读取正确，判据Q1为并发反例检查；A1/A2为两个attempt，C1/C2为候选，P1/P2为artifact版本。它们是工具真实返回id的占位符，不是模型分配的身份。每行写操作均带当前archive revision和独立operation_id；读取固定提交，具体payload使用[封闭字段](COMMANDS.md)。

| 第1节对应表达 | 示例输入或动作 | 必须读回的结果 |
|---|---|---|
| 标题和身份 | open，title为“缓存一致性方案”，coverage key为K1、criterion key为Q1 | invocation id和K1/Q1稳定id映射；同标题另开不会覆写 |
| Lifecycle | block，reason为“缺少并发日志”；取得日志后resume | 两次转换及解除证据；当前active |
| Requested deliverable | amend_frame将“补丁”改为“设计评审”，附真实用户批准 | 新deliverable与原要求、授权依据都可追溯 |
| Subject and boundary | subject为“进程内缓存”；constraint为“保留原接口” | 当前范围和不变条件各自可见 |
| Required coverage | coverage新增“取消后的读取”，保留K1身份 | 新项稳定id；退役K1若无授权被拒绝 |
| Completion evidence | Q1由“单读者”改为“双读者交错” | 新判据；旧单读者check不能默认为满足 |
| Contributions.Attempt | plan A1研究失效顺序，随后绑定原生成员 | planned与真实member绑定的分别记录 |
| Assigned coverage | A1关联K1，write_scope_claims为“设计正文” | 任务包中有覆盖与范围；未显示为文件锁 |
| Material difference/redundancy | A2 fresh只读原始日志，与A1按状态机推导对照 | context来源、差异、已知答案暴露及requested selection |
| Attempt状态 | A1 returned，A2 missing，后建替代attempt | 各状态及原因，缺失不转成功，旧attempt保留 |
| Result / evidence | A1引用P1和日志，提交“可能有失效竞态” | submitted摘要、原文链接和limits |
| Decisions/finding | L针对该贡献exact版decide accepted | 采纳依据与后果；贡献作者、采纳者区分 |
| 来源/授权 | user指令与源码摘录分别作为引用 | 授权凭据和普通reported证据类型不同 |
| Candidate | set_candidate引用C1的patch digest，dirty=true | 可定位的dirty候选，不虚构commit |
| Observed checks | Q1执行结果failed，引用交错日志 | 失败、操作、局限和reported/observed来源 |
| 旧检查适用 | C2只改标题，L对Q1登记applicability到C2 | 原检查版本与复用范围；failed仍是failed |
| 不可用关键检查 | Q1 unavailable，说明缺少原生事件 | 完成被阻断，显示需要补充的证据 |
| 未决选择/风险 | record_finding登记“容量上限未知”，decide deferred | 独立风险与影响；没有贡献也能表达 |
| Next action | set_next为“获取双读者交错日志”及目标结果 | 下一动作、负责者和清除条件 |
| Blockers | blocker引用K1，新增日志后移除并给解除refs | 当前列表与历史解除理由 |
| 自由文字/未知字段 | put_artifact保存“观察窗口：可能漏报”原段落 | 完整原文，不被强塞成lesson |

按第2节逐类走读材料：

| 材料 | 示例输入或动作 | 必须读回的结果 |
|---|---|---|
| 长研究与原始摘录 | 保存超过inline预算的设计，通过upload收齐 | 字节数、digest、完整分页正文；可独立于contribution存在 |
| 文件名与嵌套路径 | 导入`notes/a.md`和`drafts/a.md` | 两个artifact id、原逻辑路径和导出映射 |
| 二进制/附件 | 导入一张图与未知类型二进制 | 原字节可下载；不支持预览单独标记 |
| workspace链接 | 绑定容器source_handle及C1基线 | 原世界的授权引用，不按Host同名路径打开 |
| 行号/外链 | 保存P1第10行引用及失效外链 | 行号始终对应P1；坏链显示不可读，原链接保留 |
| 修订/废弃 | revise P1为P2，再retire | 当前状态与旧字节可读，旧引用不改指P2 |
| 中断恢复 | 提交响应丢失后按operation_id读receipt | 原committed_revision，不新增一份贡献 |
| 更正 | correct指出P1误读日志，给正确证据 | 原主张、更正、影响和理由相连 |
| 多领域研究 | 同一artifact关联协作与验证领域 | 原稿一份；各阅读引用同一内容版本 |

补充生命周期样例：K1有效accepted结果及Q1在C2上passed后complete；随后收到反证，record_challenge指向该check，当前页显示争议但保留原完成记录；L确认影响后reopen。Learning在关闭后可独立继续，publication更正需要新提案及非作者review。完整的跨动作旅程见[使用路径](USER-JOURNEYS.md)。
