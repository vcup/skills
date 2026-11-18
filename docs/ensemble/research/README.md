# Ensemble 研究与审阅依据

这里保存可随项目共享的源码研究、方案比较和独立审阅。当前约定从[设计入口](../README.md)阅读；判断怎样改变见[设计演进](../EVOLUTION.md)。研究记录保留当时的假设、反例与更正，不把历史结论自动升级为现行规范。

## 源码与方法研究

| 主题 | 阅读材料 | 适用范围 |
|---|---|---|
| Lead教学与迁移验证 | [教学研究](LEAD-LEARNING.md) | 原例修复、新例迁移、非作者评估与因果限制 |
| Host、档案与公开接入 | [Archive接入研究](ARCHIVE-SEAMS.md) | 原开发快照的公共接口；具体发行差异再看rc.4记录 |
| 原生代理与任务 | [能力核验](NATIVE-AGENT-CAPABILITIES.md)、[驱动选择](AGENT-DRIVING-CHOICES.md) | fresh/fork/续用、通信、共享任务、上下文与权限分工 |
| 模型选择 | [定向选型复核](MODEL-SELECTION-FLASH.md) | 默认、授权、effort和作用域；保留Lead纠正 |
| rc.4正式发行 | [基线](RC4-BASELINE.md)、[代理接口](RC4-AGENTS.md)、[插件接入](RC4-PLUGIN-SEAMS.md) | 固定发行SHA；区分官方版本净变化与开发快照差异 |
| rc.1旧接口 | [发布与协作](RC1-BASELINE.md)、[选型差异](RC1-MODEL-CHECK.md) | 历史registry查询与固定源码；不改变当前rc.4目标 |

原开发快照`39163dd30f703a79079e2d2446545cff3c453738`的包版本虽标rc.3，它不是正式rc.3发行tag。当前rc.4固定提交为`3f321d32bfe382212a8ed8785c1d47a5a300aa23`。报告中的npm标签是当次查询结果；源码、发行和实际部署分别取证。

## 设计审阅与处分

| 阶段 | 材料 | 如何使用 |
|---|---|---|
| 路线图缺口识别 | [覆盖审查](ROADMAP-COVERAGE.md)、[交付依赖](ROADMAP-DELIVERY.md) | 了解P0–P7为何包含管理、环境历史、数据寿命与真实组合 |
| 文档初审 | [领域缺口](DOC-CLOSURE-DOMAIN.md)、[方法与OMP指南](DOC-CLOSURE-GUIDES.md) | 看待补约定及可用能力差异，当前状态查处分报告 |
| 契约与旅程复核 | [契约反例](DOC-CLOSURE-CONTRACT-REVIEW.md)、[三条旅程](DOC-CLOSURE-JOURNEY-REVIEW.md)、[定向复核](DOC-CLOSURE-FINAL-REVIEW.md) | 保留覆盖/判据原子更新、旧pass掩盖fail、退役复活、旧备份收据丢失等反例 |
| 修正结果 | [文档闭合与处分](DOC-CLOSURE-RESULT.md) | 初审、复核发现如何进入命令约定和验收表 |
| 三路径隔离 | [方案比较](PATH-ISOLATION-DESIGN.md)、[OMP发现器核验](PATH-ISOLATION-OMP.md) | common源与独立产物的依据；最终方案保留纯skill的原Git安装地址，见[分发设计](../DISTRIBUTION.md) |

审阅正文中出现的行号是当时的定位。迁入时本机绝对链接改为仓库相对链接，容易漂移的产品行号锚点不再作为当前精确位置；上游固定SHA来源保留。审阅发现的当时判定与后续处分共同阅读，不能将旧“不通过”当作仍未处理。

## 保存规则

- 稳定源码依据、重要方案取舍、有效反例、审阅处分、可复用的演进阅读和检查工具进入产品仓库。
- 具体部署偏好、凭证、Session/agent运行标识、逐次工具输出和临时环境探针留在私有运行档案；需要长期保留的结论提炼为有范围的研究说明。
- 上游源码checkout、下载缓存和临时生成文件留在忽略目录，通过公开URL与固定revision引用，不复制进本仓库。
- 早期材料已在[既有研究目录](../../../.ensemble/002-dsh-adaptation/STATE.md)跟踪，临时档案中的prior-design副本不重复提交。原始临时资料保留作迁入核对，正式版本此后在本目录维护。

本目录是维护者资料，不由skill入口、角色autoload或DSH reference加载；各路径发行继续使用显式文件清单。

## 文档检查

在仓库根运行（Python 3.9及以上，无第三方依赖）：

```bash
python3 scripts/check-docs.py
```

检查维护文档的本地文件、标题/行号引用、JSON示例及D/C/R编号覆盖，同时拒绝依赖本机绝对路径或私有临时文件的链接。默认不访问网络、不依赖上游checkout。外部引用未校验的数量单独报告；如有对应源码，可选传入`--upstream <完整SHA>=<checkout路径>`，校验HEAD匹配后再检查该SHA的文件与行号。完整脚本见[check-docs.py](../../../scripts/check-docs.py)。
