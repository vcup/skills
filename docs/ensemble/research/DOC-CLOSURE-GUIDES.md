# Ensemble 文档与现有 OMP 能力独立审查

> **历史审阅记录。** 本文保留当次工作树的发现、反例和建议；文档发现已通过[文档补齐与审阅处分](<DOC-CLOSURE-RESULT.md>)处理，不代表当前待办。正文中的“当前”“尚未”及行号均为当时定位，不代表现行产品状态或当前行号；链接指向正式维护文件。文档闭合不等于实现或运行验收；迁存的静态校验不补作历史产品验收。

范围：只读审查产品文件；未安装、未运行测试、未修改产品代码。以下是源码与文档观察，不能作为安装或运行验收。
已读：[总入口](<../../../README.md>)、[技能](<../../../skills/ensemble/SKILL.md>)、[术语](<../../../skills/ensemble/GLOSSARY.md>)、[方法说明](<../../../skills/ensemble/README.md>)、[模式](<../../../skills/ensemble/PATTERNS.md>)、[状态模板](<../../../skills/ensemble/STATE-TEMPLATE.md>)、[演进模板](<../../../skills/ensemble/EVOLUTION-TEMPLATE.md>)。
对照：[scout](<../../../agents/ensemble-scout.md>)、[reviewer](<../../../agents/ensemble-reviewer.md>)、[worker](<../../../agents/ensemble-worker.md>)、[OMP说明](<../../../adapters/omp/README.md>)、[writer](<../../../adapters/omp/index.ts>)、[writer测试，仅阅读](<../../../adapters/omp/index.test.ts>)、[包清单](<../../../package.json>)。
设计边界：[DSH总览](<../README.md>)、[原生接入](<../NATIVE-AGENTS.md>)、[实施准备](<../IMPLEMENTATION.md>)、[路线图](<../../../ROADMAP.md>)均明确 rc.4 目标与未实现/未验收。

## 1. 优先修复：首派入口须按实际能力分支

事实：[技能:13](<../../../skills/ensemble/SKILL.md>)先无条件要求经 adapter tools 打开 invocation，之后才区分 managed 与无 managed；[现有注册:45–68](<../../../adapters/omp/index.ts>)只提供 `ensemble_state(path, content)`，没有 open、领域动作或归档工具。
影响：安装现有 OMP 插件的 Lead 无法照第一句操作；“plugin”也不能等同于“managed adapter”。[方法说明:176–182](<../../../skills/ensemble/README.md>)已经正确说明 OMP 缺外置历史，但后文又无条件说插件管理出版，入口读者仍需自行拼出边界。
最小改法：将首句直接限定为 managed 支持；紧接明确“当前 OMP/纯 skill 由 Lead 维护人工 checkpoint，只有已提供的工具才能使用”。[模式:293–295](<../../../skills/ensemble/PATTERNS.md>)也把 managed 动作与人工保存分支放在同一可执行描述内。
保留未完成：DSH open/领域命令、生成视图、外置档案和自动版本化；不要为修文档而虚构工具名或把 OMP writer 升格成 managed 接口。

## 2. 优先修复：区分用户启动、成员加载与 Lead 职责

事实：[技能 frontmatter:4](<../../../skills/ensemble/SKILL.md>)设置 `disable-model-invocation: true`；三个角色均配置 `autoloadSkills: [ensemble]`。OMP 17.2.15 的 [skills 实现][omp-skills]把该标记映射为 `hide`，保留用户 `/skill:<name>` 入口；[executor:3284–3298][omp-executor]在首轮前以 autoload 方式注入技能正文。这两项本身并不矛盾。
缺口：[总入口:5–29](<../../../README.md>)与[OMP说明:3–9](<../../../adapters/omp/README.md>)只有安装，没有用户调用示例；成员加载的完整技能仍包含 open、至少两次尝试、全局关闭等指令（[13/23/53–59](<../../../skills/ensemble/SKILL.md>)）。角色正文虽限定分派范围，Lead-only 动作的适用对象仍不够直接。
最小改法：补 OMP `/skill:ensemble <交付物、约束和验收>` 示例（原生技能命令启用时）；在技能顶部明确“受派成员仅执行 assignment，返回证据；Lead 负责 invocation、组合和关闭，成员不因 autoload 另开整个 ensemble”。保留两种加载机制。
保留未完成：真实 OMP 包安装、用户入口和三角色加载 smoke；这些静态来源不证明当前用户环境已经加载、授权或运行成功。DSH 用户触发入口仍是设计目标。

## 3. 优先修复：人工隔离方案必须与旧 writer 的坐标吻合

事实：[状态模板:5](<../../../skills/ensemble/STATE-TEMPLATE.md>)要求隔离记录区、最大编号加一，并提到 OMP 路径限制；[writer:5–38,61](<../../../adapters/omp/index.ts>)只接受三位数字和限定 slug 的 `.ensemble/.../STATE.md`，基于实际 `ctx.cwd`，拒绝 `.ensemble` 和 invocation 目录 symlink，临时文件后 rename 完整替换。
实际边界：没有调用身份/序号分配、Markdown 语义校验、revision/CAS、历史提交、外置根、研究正文或 evolution 写入接口；成功只证明本次文件替换。原子替换不是并发防覆盖或断电持久性证明。已有[替换测试:20–27](<../../../adapters/omp/index.test.ts>)也明确同一路径可以被再次覆盖，本轮未运行它。
最小改法：在 OMP 说明给出真实人工分支：沿用允许的工作区路径时，由使用方建立另仓/本地排除与单一写入责任；选仓外记录区时用获准的普通文件工具，不能给当前 writer 传外部路径或以 symlink 冒充支持。不得自动迁移已有 tracked 记录。
另一个确定的边界：模板的“最大值加一”到 `1000` 不满足 writer 正则。注明旧 OMP 三位编号上限与用尽后停止/报告的行为，不暗示工具自动分配或可回收覆盖旧 invocation。
保留未完成：自动隔离、编号、CAS、持久历史、迁移与更强文件系统保证，均不属于现有 writer。

## 4. 文档入口：整仓链接成立不等于纯 skill 可达

事实：[总入口:31–37](<../../../README.md>)把方法和 adapter 写成代码路径，真正的设计入口链接却直达 DSH 草案；[方法说明:218](<../../../skills/ensemble/README.md>)用 `../../docs/ensemble/README.md` 跳出技能目录。[总入口:21–29](<../../../README.md>)承诺的是安装选定 portable skill，不能据此保证仓库级设计文档也被复制。
最小改法：根入口增加可点击的“当前方法/OMP使用/DSH未实现设计”导航；可移植技能内的跨包参考改成稳定仓库 URL，或明确为整仓读者参考。核心执行不能依赖那个跨包相对链接。
保留：技能六份文档之间的现有本地链接与 native-agent selection anchor 对得上已读文件/标题；不必为了入口问题复制整套 DSH 文档进技能。安装后链接可达性仍待实际包消费验收。

## 5. 应保留的正确约束：上下文、独立性和学习证据

事实：[技能:25–35](<../../../skills/ensemble/SKILL.md>)、[方法选择表:124–144](<../../../skills/ensemble/README.md>)要求先匹配任务与已有上下文，允许 fresh/fork/续用，分开核验共享任务与消息；fresh 不保证独立，指导修订不计新样本，无关旧历史也不自动否定新问题的独立性。[术语 Member/Attempt](<../../../skills/ensemble/GLOSSARY.md>)与[rc.4 接入:7–26](<../NATIVE-AGENTS.md>)一致，不应回退成固定角色矩阵或一律只复用/只 fresh。
教学：[方法:166–184](<../../../skills/ensemble/README.md>)、[演进模板:19–29](<../../../skills/ensemble/EVOLUTION-TEMPLATE.md>)、[模式:300–320](<../../../skills/ensemble/PATTERNS.md>)区分原例修复、未见例迁移、非适用反例、非作者因果审阅、出版与可复用 lesson；reviewer 正文也检查迁移证据，worker 正文也区分指导修订。
最小改法：保留这些方法要求；将“插件管理 identities/source links/publication”等句始终写成 managed 条件句，明确人工模板可以执行同样的审阅问题，但当前 OMP 不提供自动 review/publication/retrieval。不要将非作者审阅或旧日志保存说成已经学习成功。
保留未完成：实际教学迁移、检索再应用、反证更正与程序出版闭环；DSH rc.4 实际组合/授权/模型请求/冷恢复也仍待验收，不能用本次文档闭合将路线图整项勾完。

[omp-skills]: https://unpkg.com/@oh-my-pi/pi-coding-agent@17.2.15/src/extensibility/skills.ts
[omp-executor]: https://unpkg.com/@oh-my-pi/pi-coding-agent@17.2.15/src/task/executor.ts
