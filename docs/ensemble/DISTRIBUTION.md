# Ensemble 三条消费路径的隔离设计

这是纯skill、OMP、DSH三条路径的新分发约定，面向维护者。选择**一份通用方法源、三套路径说明、三个独立安装产物**。隔离发生在构建和注册时：每个产物只包含通用内容与本路径内容。本文及跨路径设计资料留在源码仓，不作为任何路径的使用帮助分发。

## 1. 用户与模型实际得到什么

| 路径 | 安装产物 | 本路径的使用内容 |
|---|---|---|
| 纯skill | `vcup/skills`仓库中生成并提交的`skills/ensemble/`完整目录 | 使用所在harness的原生代理与授权文件工具，维护检查点和研究记录；本地模板及通用方法参考 |
| OMP | 独立构建的OMP发布包 | OMP安装/调用、原生角色与通知、`ensemble_state`的实际用法及本路径的记录流程 |
| DSH | 独立DSH插件包 | 原生代理、领域工具、外置档案、授权看板、学习出版及本路径的配置维护 |

每份安装页、包内README、技能正文、角色自动加载内容、工具帮助、按需参考和错误指引都遵守此表。DSH的`ensemble_reference`只读取DSH产物中的固定资源；`checkpoint`说明工具返回的检查点，不包含手工创建状态文件的教程。路径缺少配置或能力时说明本路径的修复动作，不自动切换另一条路径的工作方式。

同一harness内每次只注册一个`ensemble`入口。发现同名安装冲突时报告重复来源，停止重复注册，不拼接两套技能正文。OMP成员的autoload使用包内同一份OMP技能；DSH provider直接注册其包内DSH技能。

## 2. 源码如何保持单份维护

拟议内容布局已实现并有提交证据（提交 749df3d）：`content/ensemble/common/` 为单份方法源，其余三路径专属源由装配脚本组合。

```text
skills/ensemble/    # 生成并提交的纯skill安装产物，含SKILL.md和完整本地参考
skills/always/      # 保留其它既有纯skill
skills/edit-commit-msg/
content/ensemble/
  common/           # 核心方法、术语、指导原则、独立性与教学、参考模式
  skill/            # 纯skill入口、安装/使用、人工记录与模板说明
  omp/              # OMP入口、安装/使用、角色和状态工具说明
  dsh/              # DSH入口、安装/使用、领域工具与档案说明
adapters/omp/       # 已有OMP实现
adapters/dsh/       # DSH实现
scripts/            # 一个确定性的内容装配与产物校验脚本
```

common只陈述跨路径成立的方法，不出现平台名、安装命令、具体状态工具或“有插件时/否则”等路径选择。方法中的记录、学习和恢复动作由各入口的操作章节具体化；shared参考里的链接指向同产物的操作指南。需要不同语义的整节归路径维护，不逐句加条件。

构建入口为`build(target)`，target仅为skill/omp/dsh（`scripts/build-ensemble.ts` 已在工作树实现并通过测试与独立复核）。它使用代码内三份显式文件清单，按固定顺序组合“本路径frontmatter与操作章节 + 通用方法”，复制获准参考，并生成文件/digest清单。产出的`SKILL.md`是完整普通Markdown，harness无需支持include、模板或新增加载协议。通用参考复制进各产物，不形成运行时共享包依赖。`build(target).files[].content` 在内存中返回产物字节，供打包器写入自己的 staging root，不读取默认 staging 路径。

只维护源内容，生成内容不手改。没有第三种运行时mode配置，也不靠删关键词过滤混合正文。脚本负责固定装配、链接解析和文件闭包；不引入通用模板语言、文档DSL或可插拔构建框架。

## 3. 独立分发，独立安装根

纯skill继续以`vcup/skills`为Git安装源，不另建发行仓。`skills/ensemble/`及其全部本地参考由构建生成并随Git提交；安装无需运行构建，也不依赖仓外文件或跨目录symlink。保留以下入口：

```bash
npx skills@latest add vcup/skills
npx skills@latest add vcup/skills --skill ensemble
```

第一条发现仓库中可用的技能供安装选择；第二条明确选择ensemble。其它既有技能继续位于各自目录。`@latest`选择skills安装器版本，不是ensemble发行版本；验收记录实际解析的安装器版本与仓库revision。

Git可发现树中每个技能名只保留一个安装入口。`content/ensemble/`中的入口源不命名为`SKILL.md`；OMP/DSH的同名技能只生成到各自未提交的打包目录，不作为额外入口提交到Git源。校验必须检查真实Git发现结果，不能把npm的files/exports或文件名约定本身当作发现隔离的证明。

隔离对象是安装后的技能目录和可加载参考，不要求维护源码仓隐藏其它Adapter的实现。纯skill目录不链接或加载母仓库的多路径说明，安装结果也不能带入这些说明。母仓库可继续共同维护三条路径。

OMP的[技能发现实现](https://unpkg.com/@oh-my-pi/pi-coding-agent@17.2.15/src/discovery/omp-plugins.ts)扫描获准扩展根下的`skills/`；[安装器](https://unpkg.com/@oh-my-pi/pi-coding-agent@17.2.15/src/extensibility/plugins/installer.ts)支持npm包。因此方案直接提供正确的包根，不依赖自定义技能目录开关或未经核验的Git子目录安装语法。

OMP与DSH分别从干净staging root打包；每个root拥有自己的package manifest、README、exports和文件白名单。OMP包只声明OMP入口；DSH包只声明DSH Host/Client与资源。DSH不依赖OMP包，也不从它读取技能正文；两包都不依赖运行时下载通用方法。

OMP可保留现有`@vcup/skills`包身份及其它既有技能的交付，DSH使用另一个包身份（`dsh-ensemble-probe`）。插件包的发布地址在发布配置中指定；当前两个包都只在工作树生成，未发布、没有远端地址。各路径安装页只给自己的精确命令，删除旧混合入口。纯skill的Git安装地址保持`vcup/skills`。母仓库的多路径README不进入安装后的技能目录或插件包；npm会自动包含的README/package元数据在各自staging root生成，不能只靠根包`files`排除。

OMP 隔离包按“命令 + 输出位置约定”安装（OMP 17.2.15 的安装器接受本地**目录**或 registry spec，不接受 `.tgz` 文件）：

```bash
make pack-omp
omp install ./build/pack/omp/staging
```

产物是本地工作树构建结果，未发布到 registry，远端地址不存在。DSH Host-only 探针包由 `make pack-dsh` 生成在 `build/pack/dsh/`，同样未发布。工作树产物可由上述命令重现，不是私有或临时路径。

原来“给同一包增加DSH exports并携带OMP入口”的方案被此需求取代。需要迁移的是OMP原先指向混合源码仓的Git安装入口（`omp install github:vcup/skills`）；该入口已由本路径的隔离包取代，不再是未解决的远端安装。纯skill的上述命令保留。OMP旧安装的替换由其包管理器完成，保留用户研究记录与配置；迁移说明明确仍交付的其它技能，避免悄悄缩减原包能力。

## 4. 参考内容与链接也属于产物

- 当前[技能正文](../../skills/ensemble/SKILL.md)、[方法说明](../../skills/ensemble/README.md)、[模式](../../skills/ensemble/PATTERNS.md)、[状态模板](../../skills/ensemble/STATE-TEMPLATE.md)和[演进模板](../../skills/ensemble/EVOLUTION-TEMPLATE.md)需要按上述归属拆开；只改入口不足以隔离按需加载。
- 安装、操作、限制与排障整节属于路径；独立尝试、证据取舍、教学、经验条件等属于common。相同检查点字段或反思问题可以共享，谁保存、用什么工具、保存在哪里由路径说明。
- 所有产品参考链接在产物内可解析，外部使用文档只指向本路径或相关官方规范。运行时参考不链接母仓库的多路径总览，也不直接打包整个维护者设计目录。
- DSH工具帮助以实际schema与DSH操作源生成；维护者设计可跨路径比较，产品帮助只讲当前操作。整个依赖图，包括角色、locale、资源枚举和source map，都按内容归属检查。

## 5. 验收与维护成本

| 检查 | 通过条件 |
|---|---|
| 文件归属 | 每个输出文件来自common、本target或必要构建元数据；另一target文件与依赖不在产物中 |
| 内容检查 | 公共内容无路径分支；本target正文无其它路径的名称、安装命令、工具说明或比较段落；关键词检查配合审阅 |
| 参考闭包 | 每个入口、角色autoload和按需参考逐一展开；内部链接存在且留在本产物，缺文件直接使构建失败 |
| 单独安装 | 在干净环境用上述两条`npx skills@latest add vcup/skills`命令分别检查技能发现与ensemble选择；OMP/DSH从独立包安装。安装根、README与帮助只含本路径内容；同名重复安装不合并 |
| 实际加载 | OMP检查用户入口和成员autoload；DSH检查skill provider、全部reference枚举与Client帮助；纯skill在无构建工具、无母仓库本地文件时读完安装目录的所有参考 |
| 同步与迁移 | 同一source revision构建三产物，common部分digest一致；CI重新生成纯skill后须与提交内容无差异，防止只改源而漏提交；升级保留用户数据与纯skill原安装地址。当前工作树产物经 `check skill` 一致；内容装配与包探针见提交 749df3d，CI 工作流在工作树定义且已提交，但**未在 GitHub 实跑**、包**未发布**（逐项状态见 [P1 交付记录](P1-DELIVERY.md)） |

内容隔离归C01/C15与P1打包职责，最终由P7逐路径验收。工作树已实现并已提交的顺序：先分出common和三套路径内容（749df3d）→生成并提交纯skill目录（749df3d）→构建OMP/DSH独立包（749df3d）→验证三条路径的本地安装与加载闭包；**GitHub CI 实跑、OMP入口迁移、发布与远端安装仍待完成**。构建规则和路径归属只有这一处维护；每个平台只维护自己的操作说明与Adapter。
