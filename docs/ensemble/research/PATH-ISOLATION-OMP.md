# Ensemble 路径隔离：OMP 17.2.15 发布源码核验

> **历史审阅与设计比较。** 文档闭合相关发现已通过[文档补齐与审阅处分](<DOC-CLOSURE-RESULT.md>)处理；本文的路径隔离建议及后续纠正最终以[三路径分发约定](<../DISTRIBUTION.md>)为准，不代表当前待办。行号及“当前”等措辞均为当时定位；本次迁存未重新安装或运行验收。纯 skill 已决定保留原 Git 安装源 `vcup/skills`，不是待选发行地址。

## 当时的本地现状

- [包清单：当时 16–18 行](<../../../package.json>)仅声明 `omp.extensions=["./adapters/omp/index.ts"]`，未声明 skills/agents。
- [OMP 指南：当时 3–9 行](<../../../adapters/omp/README.md>)给出的入口是 `omp install github:vcup/skills`，并声称自动发现根 `skills/`、`agents/`；这是当时需要与发布代码对照的本地说明，不是本文新验证的安装结果。

## 官方发布证据与适用范围

- 调查先尝试的[旧插件管理路径](<https://unpkg.com/@oh-my-pi/pi-coding-agent@17.2.15/src/extensibility/plugin-manager.ts>)返回 HTTP 404；实际路径来自 [17.2.15 发布清单](<https://unpkg.com/@oh-my-pi/pi-coding-agent@17.2.15/?meta>)，没有猜测本地缓存路径。404 只说明该路径不存在，不说明插件安装能力不存在。
- [npm 安装器：当时 45–53 行](<https://unpkg.com/@oh-my-pi/pi-coding-agent@17.2.15/src/extensibility/plugins/installer.ts>)以 `Bun.spawn(["bun", "install", packageName], { cwd: PLUGINS_DIR, ... })` 安装包。这支持独立 npm 产物的方案，不证明任何拟议包名已经发布或可用。
- [安装 CLI：当时 353–361、539–547、993–1001、1020–1024 行](<https://unpkg.com/@oh-my-pi/pi-coding-agent@17.2.15/src/cli/plugin-cli.ts>)给出 `plugin install` 用法：npm 包及版本、`github:user/repo[#ref]` 等 Git 简写、完整 Git URL、marketplace 名称与本地目录（以 symlink 连接）。这些源码说明支持的来源类别，不能推出未经核验的 Git 子目录安装语法。

## Lead 复核与错误证据处分

Lead 当时另行读取[实际 OMP provider](<https://unpkg.com/@oh-my-pi/pi-coding-agent@17.2.15/src/discovery/omp-plugins.ts>)，确认 `loadSkills` 对 `allowedRoots` 逐一扫描 `root/skills`。本设计依赖的是 **OMP 包根提供自己的技能，以及 npm 独立产物的安装入口**，不依赖未核验的 skills 路径重定向或关闭自动发现开关。

原调查误引了[通用 agent manifest 格式](<https://unpkg.com/@oh-my-pi/pi-coding-agent@17.2.15/src/discovery/agent-plugin-format.ts>)、[agent plugin discovery](<https://unpkg.com/@oh-my-pi/pi-coding-agent@17.2.15/src/discovery/agent-plugins.ts>)和 [Claude plugin discovery](<https://unpkg.com/@oh-my-pi/pi-coding-agent@17.2.15/src/discovery/claude-plugins.ts>)。它们属于其它 provider，**不得证明 OMP 的 manifest 字段、开关或目录发现行为**。迁存删去这些长摘录，保留误用事实、来源和 Lead 的纠正，避免读者再次把它们当成 OMP 证据。

原稿还摘录了 [legacy Pi 兼容导入](<https://unpkg.com/@oh-my-pi/pi-coding-agent@17.2.15/src/extensibility/plugins/legacy-pi-compat.ts>)中先解析 realpath、再动态导入 extension 的代码；这不是 OMP 技能发现或路径隔离依据，故不再保留该段长摘录。

## 当时的产物边界建议与最终决定

- 当时建议单独发布 OMP npm 产物，示例包名 `@vcup/ensemble-omp` **仅为提案**；包根提供 OMP 版 ensemble skill、OMP agents、extension 入口及 OMP 专属 README，构建复制文件，不要求用户理解仓库内部目录。最终[分发约定](<../DISTRIBUTION.md>)允许 OMP 保留 `@vcup/skills` 身份及其它既有技能；新示例包名不是必须另建的发布地址。
- 纯 skill 保留 `npx skills add vcup/skills --skill ensemble` 的 Git 来源；最终约定的命令使用 `skills@latest`。纯 skill 文本只写通用使用方法。DSH 产物同理独立打包并仅携带 DSH 上下文；本次调查未核验 DSH 安装机制。
- 不依赖未经证实的 GitHub 子目录安装语法，也不把自定义 skills 路径或“关闭自动发现”当作隔离前提。npm 安装用法依据上述版本的发布代码；具体插件包地址确定后仍需真实安装验收。
- 安装产物和模型可见上下文都须隔离：OMP 包不能夹带纯 skill/DSH 专属说明，纯 skill 本体不能残留 OMP/DSH 安装指引。源码仓可共同维护三条路径；维护者多路径说明不进入安装后的阅读闭包。

## 已知限制与未知

- 原调查只读取本地两个指定文件和该版本官方发布源码；没有安装、运行加载流程、全仓审计或修改产品文档。本次迁存不补作这些运行声明。
- 静态源码证据不证明 npm 发布可用性、包名占用或干净环境加载成功；新产物的发布流程和 DSH 实际打包入口在该轮均未核验。
- 自定义技能目录、自动发现关闭开关、Git 子目录安装均未获所需 OMP 依据；方案绕开这些假设，不将未知包装成不支持或已验证。
