# 文档补齐与审阅处分

> **历史审阅处分记录。** 本文汇总各轮文档发现及其处理，保留原审阅结论与后续纠正的先后关系。正文状态、统计和行号属于当时的审阅，不是当前待办或本次迁存的运行结果；文档闭合不等于实现或运行验收。

当轮按用户要求盘点 ensemble 文档，应用 codebase-design、domain-modeling、lossless 与 research 技能。设计选择以当时需求、rc.4 源码研究、实际 OMP writer 及独立审阅为依据；当轮产品变更全部为 Markdown。

## 起始审查

- [路线图覆盖审查](<ROADMAP-COVERAGE.md>)保留 C01–C29 承诺、G01–G12 设计缺口、阶段依赖和原生成员协作反例；[交付依赖复核](<ROADMAP-DELIVERY.md>)补充真实包、环境配置、协作、维护与发布门槛。它们是闭合前的输入，不是当前实现进度或未解决项清单。
- [领域审查](<DOC-CLOSURE-DOMAIN.md>)指出完成谓词、权限替换、Finding/Challenge 生产入口、版本引用、审阅更正、环境应用、内容与运行管理缺口。
- [指南审查](<DOC-CLOSURE-GUIDES.md>)核对现有 OMP writer 及精确 17.2.15 技能/任务加载源码，指出 managed 入口误用、成员加载完整 Lead 契约、记录位置/编号和纯 skill 跨包链接问题。
- 各报告针对当次工作树，行号只保留当时定位。以下记录文档处分；报告中的运行门槛不因文档闭合而自动通过。

## 设计落点

| 缺口 | 当轮形成的约定 |
|---|---|
| 命令、状态、权限、完成判据、反证 | [COMMANDS](<../COMMANDS.md>)：封闭字段、可信 actor、精确对象版本、all-checks 完成判断及 resolution |
| 管理、数据寿命、环境配置与远端范围 | [OPERATIONS](<../OPERATIONS.md>)：始终版本化、owner 入口、单主 Git、desired/apply/reconcile、完整导入、备份与单主远端复制 |
| 三条完整路径、UI、异常下一步 | [USER-JOURNEYS](<../USER-JOURNEYS.md>)：新项目、旧资料迁移、下一任务经验应用，生产者至消费者明确 |
| 逐项表达与阶段责任 | [替代矩阵](<../REPLACEMENT-MAP.md>)增具体输入/读回案例；[路线图](<../../../ROADMAP.md>) D01–D12 逐项决定与 owner；[实施矩阵](<../IMPLEMENTATION.md>)扩至 R1–R30 |
| 当时可用能力的说明 | [技能](<../../../skills/ensemble/SKILL.md>)区分 Lead/成员；[OMP 指南](<../../../adapters/omp/README.md>)与[模板](<../../../skills/ensemble/STATE-TEMPLATE.md>)给实际调用、两种记录位置、单写者及三位编号限制 |

当轮范围决定：远端纳入 P6 的显式单主复制与隔离恢复；fork 保持原 route 和 effort，差异通过 fresh；首个实验组合为 Linux Host/本地盘/rc.4/Web 及 headless/本地及容器 source。默认预算是实验输入，发布值由容量验证决定。

## 第二轮反例及处分

[契约复核](<DOC-CLOSURE-CONTRACT-REVIEW.md>)给出五项阻断：

1. Learning 字段缺 invocation 归属：所有 learn payload 统一必带 invocation_id，organize 另验 project 级 organize grant。
2. 新 required coverage 与 criterion 互相卡住：requirements 组原子提交两者；请求内 key 与已有稳定 id 采用显式引用变体。
3. 旧 pass 掩盖新 fail：完成读取全部适用检查；冲突需要有证据的 resolution，不能按时间静默覆盖。candidate/frame 变化后重核决定及检查。
4. retired lesson 因反证复活：只有当前未退役版自动 contested；旧/退役版本仅追加证据，恢复需新版本。
5. 旧备份复用 archive id 丢失较新 receipt：同 id 激活需证明包含最后权威 head；否则只读，或由 owner 接受有损恢复并生成新 id 和丢失说明。

[旅程复核](<DOC-CLOSURE-JOURNEY-REVIEW.md>)给出三项：applicability 改为 Lead 动作；试用经验显式读 proposed/确切版本；review 与 lesson 核查先取得对应授权。三项均已同步旅程。迁移原文/映射分离、源变化拒绝、固定 revision 导出和 OMP 角色路径在该轮通过。

## 验证记录与最后一项纠正

原审阅轮次记录的静态检查结果为：39 份文档、651 处本地文件/标题/行号引用（含 120 处固定源码 SHA 引用）、JSON 示例语法、D01–D12/C01–C17/R1–R30 唯一编号覆盖，全部通过；当轮 `git diff --check` 也通过。迁存后的正式[文档检查器](<../../../scripts/check-docs.py>)承接此类检查；上述计数与通过结论属于旧轮次，不是该正式脚本或本次迁存的运行结果。检查器不对 HTTP 在线可用性或主张语义作保证。

[最终定向复核](<DOC-CLOSURE-FINAL-REVIEW.md>)八项中七项通过，剩余一项为 challenge 处分绕过检查冲突 resolution。Lead 按审阅者的最小修法删除该旁路，并重新走读：已有 passed 及 failed 时，即使 challenge 被处分，failed 仍须有合法 resolution，且有效 passed 条件保留。审阅原文保留这一发现，本记录明确记下其后续闭合。

路线图当时将 P0 文档阶段标完成，P1–P7 继续按各自运行交付门槛推进；这不是 P1–P7 的运行通过声明。

## 后续路径隔离决定

[最小设计比较](<PATH-ISOLATION-DESIGN.md>)保留三份手写、共用方法加静态产物、运行时过滤的取舍及三类安装/阅读闭包反例；[OMP 源码核验](<PATH-ISOLATION-OMP.md>)保留 Lead 对 provider 误用的纠正、实际 OMP 发现依据与未运行限制。这两份后续建议的最终处分以[三路径分发约定](<../DISTRIBUTION.md>)为准：纯 skill 保留原 Git 安装源 `vcup/skills`，OMP/DSH 独立构建和分发；不能再将旧“同包加 DSH exports”或新 OMP 包名提案当作当前承诺。
