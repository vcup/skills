# 文档闭环独立复核

> **历史审阅记录。** 本文保留当次工作树的发现、反例和建议；文档发现已通过[文档补齐与审阅处分](<DOC-CLOSURE-RESULT.md>)处理，不代表当前待办。正文中的“当前”“尚未”及行号均为当时定位，不代表现行产品状态或当前行号；链接指向正式维护文件。文档闭合不等于实现或运行验收；迁存的静态校验不补作历史产品验收。

范围：[用户旅程](<../USER-JOURNEYS.md>)，对照[命令](<../COMMANDS.md>)、[运行管理](<../OPERATIONS.md>)、[根说明](<../../../README.md>)、[skill](<../../../skills/ensemble/SKILL.md>)、[状态模板](<../../../skills/ensemble/STATE-TEMPLATE.md>)、[OMP指南](<../../../adapters/omp/README.md>)；补读[替代矩阵](<../REPLACEMENT-MAP.md>)、[演化模板](<../../../skills/ensemble/EVOLUTION-TEMPLATE.md>)。
方式：只读逐步演练；仅写本报告，未安装、运行实现或修改其它文件。不把待实现能力及未运行验收列作文档缺陷。

## 有实际后果的问题（3项）

1. **P2：把仅Lead可提交的适用声明交给泛称评估者。**
   - [旅程:15](<../USER-JOURNEYS.md>)让“评估者record_check，必要时applicability”，但[命令:53–54](<../COMMANDS.md>)仅允许L提交applicability。评估者为M/R时会被拒绝；有execution权限不等于有适用声明权限。
   - 最小修法：改为“评估者提交execution；需要复用旧观察时，由Lead引用prior_check/current_target及明确criterion_ids/scope提交applicability”。

2. **P2：proposed lesson落在下一任务的默认检索范围之外。**
   - [旅程:59–60](<../USER-JOURNEYS.md>)先保存proposed，再按任务/接口检索并应用；[命令:101](<../COMMANDS.md>)默认仅返回supported，而[命令:71](<../COMMANDS.md>)要求相关application及非作者check才能supported。照默认路径无法取回正待新例验证的lesson。
   - 最小修法：新例验证时显式查询`status: proposed`，或按已知lesson id/exact revision读取；标明这是待验证假说而非推荐。应用者记录application，非作者R核查，L再评估supported。

3. **P2：学习旅程省略非作者身份到实际review授权的交接。**
   - [旅程:58–60](<../USER-JOURNEYS.md>)直接从“非作者”进入审阅/lesson核查；[命令:28、62、71](<../COMMANDS.md>)要求被指派的R，而非任意非作者。仅按前段取得member-submit的成员不能据此进行授权审阅；缺权时这条学习路径会停住。
   - 最小修法：加一句“L在owner已有review委托内指派；未委托时请owner授权/assign_reviewer，缺权保持draft/proposed”。稿件审阅明确proposal版本，lesson check明确lesson版本。两条授权入口均已有[管理契约:23、38](<../OPERATIONS.md>)，不应把owner操作写成Lead的模型工具。

## 通过的具体路径

- **新项目→贡献→完成的主体链：** owner initialize→binding/grant与archive revision→有open权的Lead open→coverage/criterion id→plan_attempt＋原生创建事实→绑定成员→成员artifact/contribution→L对最终确切版本decide→candidate＋当前检查→各coverage的decision_refs/check_refs→complete收据。修订后需重新处分最终版本，不能沿用旧decision；这一点由所引用的[命令:37–39、86](<../COMMANDS.md>)明确，未另报摘要省略。授权不足、创建失败、检查缺口都有退路（[旅程:9–16](<../USER-JOURNEYS.md>)）。
- **旧目录→未知/变化文件迁移→导出：** owner原world清单→未知列/坏链/自由段落原字节与映射提案分存→批准例外→目录成员/digest变化则stale、重做预览→一次ref发布及complete/partial→用户对照原文、L另走领域动作→owner固定revision、授权目的地导出→manifest/digest与坏链报告；源保留、冲突默认不覆盖。此路径闭合（[旅程:42–49](<../USER-JOURNEYS.md>)、[管理:94–99](<../OPERATIONS.md>)）。
- **反思审阅与出版的版本链：** 在已有domain和合格R前提下，draft exact evidence→非作者review→作者修订→当前稿重新review且逐项解除阻断→L publish→稳定publication。旧review不授权新正文，出版不自动支持lesson；更正保留历史（[旅程:57–65](<../USER-JOURNEYS.md>)、[命令:61–73](<../COMMANDS.md>)）。
- **lesson新例应用的判定链：** 在显式取回待验证项及授权R后，实际应用者以新invocation/attempt提交application＋checks→R核查lesson exact revision→L以application_refs/review_ref评估；反例可先标contested，不能把原例修复当迁移证明。这一消费契约成立，旅程需补问题2、3的入口（[命令:71](<../COMMANDS.md>)）。
- **OMP／纯skill与成员／Lead边界：** OMP插件一次安装提供skill/agents/state工具，任务/通知由原生harness承担；Lead选记录位置并单写，成员仅执行任务、不另开ensemble。当前writer只接受工作区三位编号状态路径，外部记录仓用普通授权文件工具；均需显式历史管理，既有tracked记录不自动搬迁。托管DSH才由领域工具管理外部档案，未混称现有OMP能力（[根说明:15–33、48–61](<../../../README.md>)、[skill:13–15](<../../../skills/ensemble/SKILL.md>)、[状态模板:3–12](<../../../skills/ensemble/STATE-TEMPLATE.md>)、[OMP:19–35](<../../../adapters/omp/README.md>)）。

结论：迁移链与现行使用方式通过；新项目主体链和学习版本/判定规则可闭合，旅程补齐上述三处角色/入口说明即可，未发现需要增加新实现能力才能修复的文档问题。
