# 用户旅程与界面交接

以下是DSH托管模式的设计走读，动作与字段以[命令约定](COMMANDS.md)及[运行管理](OPERATIONS.md)为准。已可使用的OMP入口见[OMP指南](../../adapters/omp/README.md)。owner管理在Web配置页和认证headless控制端提供同一组操作；模型命令负责工作和学习内容。

## 1. 新项目：从绑定到交付

| 步骤 | 生产者 → 输入 → 动作 | 保存点 / 返回 → 消费者 | 失败后的下一步 |
|---|---|---|---|
| 1 | owner选择档案根、source世界与权限，经 `manage` 的 `initialize` 建立档案（`initial_grants` 必须写明 owner 的 `ownerId`/`hostAuthorityId` 或 session 的 `sessionId`/`rootSessionId`） | 初始binding/grant提交、archive id与revision → Lead | 根重叠或世界映射不明，返回具体冲突，修正绑定 |
| 2 | 用户调用ensemble；Lead读取checkpoint/偏好并open | active invocation、coverage与criterion id → 计划 | 无open权限交owner处理；open冲突先读head |
| 3 | Lead按任务与上下文匹配plan_attempt，调用原生subagent | planned attempt与独立原生创建返回 → Lead绑定member | 创建失败记录missing；计划与返回身份分别保留 |
| 4 | 成员读任务包/共享任务与必要证据，领取可用任务 | 原生task revision；已有archive提交grant → 成员工作 | task被占用重新协调；缺grant由L在委托内分配或请owner |
| 5 | 成员put_artifact、submit_contribution | 原文digest与submitted贡献 → Lead/审阅者 | 大正文走upload；冲突重读，不覆盖他人更新 |
| 6 | Lead核查差异、decide并record_coaching；成员修订 | 指导与新版本 → 非作者检查 | 修复仍失败记录gap或安排新attempt |
| 7 | Lead选candidate并复核采纳决定；评估者record_check execution，必要时由Lead提交applicability | 对应版本的观察及明确复用范围 → Lead判断coverage | 关键检查缺失维持active或blocked，保留明确next |
| 8 | Lead给各coverage关联当前结果和checks，complete | 完成收据、checkpoint、候选引用 → 用户 | 指出未满足的coverage/criterion，补证据或获准改范围 |

一个示例：用户要检查并修订缓存失效方案。Lead让熟悉现有调用链的成员继续追踪，再创建未见预设根因的fresh成员检查原始日志。两者共享需求和baseline，独立首轮前不互传根因结论。新成员领取共享任务并不继承旧对话；它完整读取任务、依赖和原始证据后开始。产物比较后再互相审阅，已有成员可继续修复。

示意输入使用工具返回的符号值，实际调用应替换成真实id/revision：

```json
{
  "action": "record_finding",
  "expected_revision": "<read_revision>",
  "operation_id": "finding-cache-1",
  "payload": {
    "invocation_id": "<invocation_id>",
    "kind": "risk",
    "statement": "并发失效后，第二个读取者可能继续使用旧值。",
    "impact": "缓存一致性要求需要额外检查。",
    "evidence_refs": [{"kind": "object", "object_id": "<log_artifact_id>", "object_revision": 1}],
    "coverage_ids": ["<consistency_coverage_id>"]
  }
}
```

保存返回风险身份与committed revision；后续`decide`引用这个finding的确切版本。报告风险不会自动改写candidate或把一个假说变成已复现缺陷。

## 2. 旧目录：清单、原文和解释分别处理

1. owner选定原execution world中的旧资料根，运行inventory_import。预览列出每个文件的类型、字节数、digest、可读性、原始链接和拟映射对象。
2. Lead核对[完整替代矩阵](REPLACEMENT-MAP.md)中的字段与目录材料。未知列、坏链接、自由段落保留为原始artifact；解析结果单列为待确认提案。模型不借迁移把旧“已通过”变成新的运行结果。
3. owner批准inventory及明确例外，commit_import重新核对源清单。源在读取期间变化则拒绝混合快照，生成新的inventory再预览；上传中断可查询已收块继续。
4. 全部字节与映射在一次ref发布，返回导入revision、manifest、缺口与完整性状态。例外必须列出，partial不能显示成完整导入。
5. 用户打开原文和生成检查点逐项比较；每条映射可回到原始字节与逻辑路径。Lead选择采纳的结构化提案，再通过领域动作创建当前工作记录。
6. 导出固定revision到用户选定位置，核对manifest/digest及坏链接报告。源目录保留；是否清理旧文件作为独立source修改处理。

反例：两份同名文件不能合并身份；导入期间新增文件不能悄悄漏掉；已读成功的文本不代表同批超限附件已保存；未知字段不能只留在被裁剪的日志中。

## 3. 下一任务：教学、精读和经验应用

审阅前，Lead在owner已委托的review范围内指派非作者并绑定具体提案；没有这项委托时，由owner通过assign_reviewer授权。lesson的新例核查也要求对应的读取和检查权限；缺权时保留draft/proposed，不能以普通成员身份替代授权。owner管理动作不属于Lead模型命令。

| 交接 | 例子 | 当前可见结果 |
|---|---|---|
| 具体问题→教学 | 成员把“消息受理”写成“对方完成”；Lead示范区分两个事件 | coaching引用错误产物、指导内容和暴露答案 |
| 教学→新例检查 | 成员检查另一条异步任务链，非作者验证其是否等到了真实完成事件 | 原例修复与新例结果分别记录；新例失败仍保留 |
| 观察→反思 | 提案说明原假设、改变判断的事件证据、受理/执行的差别和剩余未知 | 可读draft，关联exact artifact/check版本 |
| 反思→出版 | 非作者审阅发现因果概括过强，作者缩小范围后重新review | 新版approve后由L发布，原review不授权修改后的稿件 |
| 出版→经验 | 提议“异步工具先区分受理与业务完成”，标适用接口与反例 | proposed lesson，不因文章出版自动supported |
| 经验→下一任务 | 新invocation显式按status: proposed检索，或读取已知lesson exact版本；成员先读限制，把它作为待验证假说应用到另一工具 | application记录动作、结果和非作者checks；证据支持后由L评估为supported，进入默认推荐 |
| 反例→更正 | 新工具明确同步返回最终结果，不适用原异步建议 | 标contested，保留双方证据，修订范围或retire |

精读条目示例：**“把消息受理与任务完成分开”**。起点是以消息返回代替完成证据；对照inbox receipt与目标产物后，改为等待原生完成通知并核对产物版本。代价是需要保留两类引用，收益是避免提前集成。该经验不适用于明确同步完成的工具；下一检验是取消发生在受理之后时，检查点能否仍准确显示未完成。

概览只保留主题、关键转折和跨域后果。条目同时影响“协作”和“验证”时，以一个主domain保存正文，另一domain引用其稳定publication身份。领域split后旧链接仍能定位原条目，历史发布顺序不改。

## 4. 中断、接管与长期使用

- **Lead中断：** 新调用先读checkpoint、receipt与原生agent/task事实；同一身份可续做。不同Session接管由owner执行takeover，重新核对旧成员写权和原生task owner，防止迟到结果覆盖新绑定。
- **停用与再启用：** owner pause后仍能读历史和诊断；resume先验证存储及grant。插件卸载保留档案；再启用从已提交ref读回，不重发历史工具动作。
- **更换位置：** owner选新位置并预览映射，停写、备份、验证、切换、重授权，旧位置只读保留。任何一步中断都显示当前权威位置，不能猜测哪份副本更新。
- **环境偏好恢复：** 查看历史差异→保存新的desired revision→预览原生目标→apply→reconcile。界面分别显示已保存和已应用；旧Session需要新root采样权限时明确提示。
- **敏感材料：** owner先收紧访问，再预览涉及的历史和副本，按维护流程决定撤回或清除。普通阅读页面不提供隐式删除历史入口。

## 5. 信息结构与交互

侧栏有一个 `sidebar.panellist` 图标（`order: 30`，标题 “Ensemble”），点开是主面板，标签顺序与随包界面一致：

```text
Ensemble
├─ 当前工作 → 目标/覆盖 → 尝试与贡献 → 候选/检查 → 下一步
├─ 资料 → 摘要列表 → 原文/附件 → 版本与来源
├─ 阅读 → 概览 → 领域 → 条目 → 审阅/更正与证据
├─ 经验 → 适用性过滤 → 建议与限制 → 应用/反例
├─ 历史 → 固定快照的对象历史与提交引用
├─ 项目与授权（owner） → 根/世界映射、授权、接管、诊断
└─ 管理维护（owner） → 环境偏好、导入预览、导出、备份/恢复、复制
```

**还没有任何项目时**，`项目与授权` 直接给出初始化表单（`expected_revision: absent`），这就是第一个 owner 动作的入口；其余标签提示尚未选择项目。**环境偏好位于 `管理维护` 之内**，不是独立标签。

当前工作、资料、阅读、经验与历史是固定快照的只读查询（分页）；创建或修改通过模型命令或明确的 owner 管理操作。owner 写入面是 `项目与授权` 与 `管理维护`，两者都是 表单 → 预览 → 提交 的 revision 绑定流程。按钮展示具体目标、revision和影响范围；绑定、授权、导入及恢复在提交前给差异预览。headless返回同样的预览记录与operation id，再提交明确动作，无需浏览器会话也能完成管理。

每个文档页固定project、对象版本和archive read_revision，面包屑可返回其invocation/domain。贡献旁分开显示“已返回/已采纳/检查结果”；原生运行状态附观察时点。证据点击走对应授权资源，归档内链接不用任意Host路径。草稿默认有可见标识，更正/争议展示在当前正文顶部，历史页显示当时状态并提供当前更正入口。

| 视图状态 | 展示和操作 |
|---|---|
| 未绑定 / 无权限 | 展示绑定或申请权限入口，不列未授权对象名称 |
| 加载 / 空结果 | 保留当前查询条件；空结果不等于库中不存在相关事实 |
| 部分页 / 超预算 | 显示覆盖范围、原因与继续读取入口，限制条件与建议一起展示 |
| 新revision到达 | 提示可刷新；未刷新页面仍按原snapshot读，不能拼接新旧页 |
| 冲突 | 显示原输入和最新摘要，要求重新判断后提交新操作 |
| 权限撤销 / 断连 | 撤权立即清理对应缓存；断连标过期且禁止管理提交；重连先重验权限 |
| 迟到响应 / 卸载 | 按project、revision、授权epoch和挂载世代丢弃失效响应，释放订阅与临时URL |
| 无法显示的附件 | 可授权下载原字节并给digest，不自动加载外部图片或执行HTML |

## 6. 走读检查点

三条旅程均需核对：输入来自谁、谁有权操作、引用哪个版本、何处持久化、谁消费结果、失败如何继续。设计审阅用这些步骤检查遗漏；实现验收对应[实施向量](IMPLEMENTATION.md#6-代表输入与预期结果)。owner能管理、成员能表达完整资料、后来者能读回并反驳经验，三者各有独立入口。
