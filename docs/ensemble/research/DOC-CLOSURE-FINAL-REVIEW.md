# 定向契约修复复核

> **历史审阅记录。** 本文保留当次工作树的发现、反例和建议；文档发现已通过[文档补齐与审阅处分](<DOC-CLOSURE-RESULT.md>)处理，不代表当前待办。正文中的“当前”“尚未”及行号均为当时定位，不代表现行产品状态或当前行号；链接指向正式维护文件。文档闭合不等于实现或运行验收；迁存的静态校验不补作历史产品验收。

范围：仅[命令契约](<../COMMANDS.md>)、[运行管理](<../OPERATIONS.md>)、[用户旅程](<../USER-JOURNEYS.md>)三份指定文档；仅静态契约走读，未运行功能、检查全仓链接或修改产品文件。
结论：8项中7项通过、1项未通过；完成判定仍存在冲突处分路径歧义，需最小修订后闭环。

| 项目 | 判定 | 简短依据 |
|---|---|---|
| 1 Learning公共invocation_id与organize权限 | 通过 | [COMMANDS:59–70](<../COMMANDS.md>)统一要求invocation_id；organize同时要求Lead和owner授予的project级权限，create亦有鉴权上下文；[OPERATIONS:21](<../OPERATIONS.md>)提供授权入口。 |
| 2 required coverage、criterion与原子requirements修订 | 通过 | [COMMANDS:24–33](<../COMMANDS.md>)要求至少一项required及关联criterion；request_key限定同请求、existing_id限定修改后集合，返回稳定id；requirements完整替换并原子校验。 |
| 3 candidate/frame重核、失败冲突及解除依据 | 未通过 | [COMMANDS:89–91](<../COMMANDS.md>)已要求重decide、重执行或applicability、读取全部适用检查；resolution须有独立依据/后续执行且不造passed。但末句允许“或challenge处分解除”，其解除证据门槛未与resolution对齐。 |
| 4 retired/旧lesson的contradicts不复活 | 通过 | [COMMANDS:74、86](<../COMMANDS.md>)旧版/retired只追加反证，不改变当前版或退役状态；恢复须作者新版本重新proposed。 |
| 5 旧备份缺最终head/receipt的恢复 | 通过 | [OPERATIONS:100–102](<../OPERATIONS.md>)同id可写须证明最终head及全部收据；否则只读，接受有损恢复须新id、记录缺失区间、重建授权/重试空间，禁止跨id自动重放。 |
| J1 applicability仅Lead | 通过 | [USER-JOURNEYS:15](<../USER-JOURNEYS.md>)区分评估者execution与Lead applicability，与[COMMANDS:41、54](<../COMMANDS.md>)一致。 |
| J2 试用proposed显式检索 | 通过 | [USER-JOURNEYS:62](<../USER-JOURNEYS.md>)明确status: proposed或读取已知exact版本，不依赖默认supported检索；[COMMANDS:106](<../COMMANDS.md>)提供status过滤。 |
| J3 review权限先指派 | 通过 | [USER-JOURNEYS:53](<../USER-JOURNEYS.md>)审阅前先在owner委托内指派并绑定提案，否则owner assign_reviewer；缺权保留draft/proposed，与[OPERATIONS:23、38](<../OPERATIONS.md>)一致。 |

## 唯一阻断与最小修法

- 复核序列：同candidate/criterion已有passed和failed → 对failed记录challenge → Lead以dismissed/superseded处分 → 完成谓词可能按“或challenge处分解除”沿用旧passed。
- [COMMANDS:3、24、43](<../COMMANDS.md>)未给resolve_challenge.evidence_refs最低项数或独立解除依据；文本reason不等于独立证据。因此第91行“须用resolution”与末句可选challenge路径不能得到唯一安全解释。
- 最小修法：第91行将“合法resolution或challenge处分解除”改为“合法resolution解除；challenge处分本身不能解除执行检查冲突”。challenge自身仍按第89行另行处分，不影响正常争议处理。
- 保留第55行resolution不产生passed、以及第91行仍须有效passed的约束；无需扩大改动范围。
