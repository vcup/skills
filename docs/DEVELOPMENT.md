# 开发环境与操作指南

本指南面向在本仓库工作的维护者。**Make 是唯一主界面**：构建、测试、文档检查、打包、诊断与安装都通过仓库根的 Makefile target 完成；包管理器的脚本入口不作为推荐操作。命令均在仓库根执行。安装后的技能与插件包不引用母仓 Makefile，用户仍按各自包的说明操作。

## 最短日常路径

```bash
make doctor                 # 自诊断：缺什么、阻塞哪些 target
make setup                  # 首次需要：联网装依赖，然后 doctor + check
make check                  # 日常默认门：离线、不写产品文件
make package-check          # 交付前离线聚合：check + test + pack + inspect
```

`make doctor` 不修改任何东西，只报告工具、依赖与产物状态；日常改动后先跑 `make check`，准备交付时跑 `make package-check`。需要 Host 相关结论时再按下面的步骤准备隔离 install。

## 工具前置与自诊断

需要 bun、node、npm/npx、python3、git；安装本地 OMP 包还需要 omp。具体版本**不要自行记忆或写死**，运行 `make doctor` 确认当前环境是否满足、缺少哪一项会阻塞哪些 target。

运行环境分原生环境与开发容器两类：默认容器只提供 Make 与 Python，缺少 bun/node；开发容器提供完整工具链。两个容器的临时目录互不共享，在一个容器准备的隔离 install 不能假定在另一个容器可见。依赖安装只在 `make setup` 进行，它串联 `bun install --frozen-lockfile`、doctor 与 check，任一失败即停；Make 不会自动联网。

## 准备隔离 rc.4 install（Host 相关 target 的前置）

`typecheck-host`、`host-check`、`profile-check`、`isolation-check` 与 `release-check` 都不针对本工作树跑，而是针对**一次真实安装的 DSH 0.2.2-rc.4**（固定发行基线）运行。原因：Host 入口 import 的 `@deepseek-ai/*` 不在仓库依赖里；对着工作树检查无法证明公开类型与真实 Loader 的行为。该目录不是仓库产物，不提交、不共享给另一容器；仓库外的任意可写目录都可以。

在仓库外准备一次（用环境变量指向可写位置，不写死路径）：

```bash
dsh_install="$(mktemp -d)/dsh-rc4"        # 临时且可丢弃；无需预设 TMPDIR
mkdir -p "$dsh_install" && cd "$dsh_install" && npm init -y
npm install --ignore-scripts @deepseek-ai/dsh@0.2.2-rc.4 typescript@5.9 @types/node@24
cd -                                    # 回到仓库根
make host-check INSTALL_DIR="$dsh_install"
```

需要 Host gate 时统一用 `INSTALL_DIR="$dsh_install"` 传入。没有该目录时这些 target 会明确报 `INSTALL_DIR is not set` 或配置错误并退出非 0，不会静默跳过。

## 完整 target 一览（按目标分组）

下表的类别列标出**是否需要网络**与**是否写 live profile**；未标注者不联网、不写 profile。

### 初次上手

| Target | 作用 | 参数 / 条件 | 类别 |
|---|---|---|---|
| `help` | 列出所有公开 target（默认 target） | 无 | 只读 |
| `doctor` | 报告工具、依赖与产物状态，指出阻塞项 | 无 | 只读 |
| `setup` | 装依赖 → doctor → check，串联执行 | 无 | 联网、写依赖目录 |

### 日常验证

| Target | 作用 | 参数 / 条件 | 类别 |
|---|---|---|---|
| `check` | 默认门：内容漂移 + 两个类型检查 + 文档检查 | 无 | 离线、仓库内只读 |
| `test` | 全量测试 | 无 | 写临时目录 |
| `test-narrow` | 窄测试（内容构建器） | 无 | 写临时目录 |
| `test-watch` | 监视模式测试，Ctrl-C 退出 | 无 | 写临时目录、长驻 |
| `typecheck` | 仓库类型检查与无 DSH 依赖的模块 | 无 | 只读 |
| `docs` | 文档链接与引用检查 | 无 | 只读 |

### 改内容

| Target | 作用 | 参数 / 条件 | 类别 |
|---|---|---|---|
| `content` | 报告 TARGET 的生成漂移，不写文件 | `TARGET=skill\|omp\|dsh`，默认 skill | 只读 |
| `content-build` | 从单份源重新生成 TARGET | 同上 | 写产品文件 |

skill 产物在 `skills/ensemble/`（提交产物）；omp/dsh 产物在 `build/ensemble/{omp,dsh}/skills/ensemble/`（ignored，需先 content-build）。`TARGET` 非法值退出非 0 并列出三个合法值。

### 打包与产物

| Target | 作用 | 参数 / 条件 | 类别 |
|---|---|---|---|
| `pack` | 生成 OMP staging root 与 DSH tarball | 无 | 写 ignored `build/` |
| `pack-omp` | 只生成 OMP 包 | 无 | 写 ignored `build/` |
| `pack-dsh` | 只生成 DSH 探针包 | 无 | 写 ignored `build/` |
| `inspect` | 列出 tarball 与内容 | 需先 `make pack`（无产物时报错） | 只读 |

### 运行门与诊断

**门（gate）与观察（observe）的区别**：`*-check` 是门，只有所有必需检查都真实运行并一致时才返回 0，前置缺失或不可用一律非 0；`diagnose` 只观察环境、不下结论，始终返回 0。

| Target | 作用 | 参数 / 条件 | 类别 |
|---|---|---|---|
| `typecheck-host` | Host 入口对 rc.4 公开类型的检查 | `INSTALL_DIR` 必需 | 门；在隔离 install 内建临时 scratch |
| `host-check` | Host 类型 + 真实 Loader，两者都必须通过 | `INSTALL_DIR` 必需 | 门；在隔离 install 内建临时 scratch |
| `profile-check` | DSH profile 启动诊断 | `INSTALL_DIR` 必需 | 门；无 install 即失败 |
| `isolation-check` | 执行世界隔离必须被观察到 | `INSTALL_DIR` 必需 | 门；无 install 即失败 |
| `diagnose` | 观察环境实际行为，首行 `OBSERVATION ONLY — not a check` | 有 install 时传 `INSTALL_DIR` | 观察型，恒 0，不下结论 |

这些门可以给出正向通过（所有必需检查真实运行且一致时返回 0），也可以如实失败（前置缺失或检查不一致时非 0）；`diagnose` 返回 0 只表示观察完成，不构成通过。门的正向结论有边界：profile 的形态矩阵只证明启动分类，不等于完整交互或模型请求可用；容器内的隔离探针只描述执行该命令的环境（共享 Host kernel），不等于 Host/执行世界分离已验证。

### 安装（显式选择，不属于日常路径）

| Target | 作用 | 参数 / 条件 | 类别 |
|---|---|---|---|
| `install-omp` | 把本地 OMP staging root 装入 live profile（会替换已安装的同名包） | `CONFIRM=yes` 且需已存在 staging | 写 live profile |
| `install-smoke` | 在临时目录安装锁定的 skills CLI 并逐字节比对 | 无 | 联网、写临时目录，不写 profile |

### Git 只读辅助

`status`（分支、改动路径与产物状态）、`diff`（工作树差异）、`git-review`（状态 + diffstat + 近期提交）均为只读，不改工作树或提交历史。

### 清理与交付

| Target | 作用 | 参数 / 条件 | 类别 |
|---|---|---|---|
| `package-check` | 离线聚合 check + test + pack + inspect | 无 | 写 ignored `build/`，无需隔离 install |
| `all` | `package-check` 的别名，离线链，不含 Host 门 | 无 | 写 ignored `build/` |
| `release-check` | 严格发布门：离线门 + 两个包 + Host 类型 + 真实 Loader | `INSTALL_DIR` 必需，缺则失败 | 写 ignored `build/`，需隔离 install |
| `clean` | 只删除 Makefile 拥有的生成路径 | 不接受路径参数；build 是 symlink/含受版本控制内容/非目录时拒绝 | 写 ignored `build/` |
| `clean-all` | clean 之外再删 node_modules | `CONFIRM=yes` | 危险、写依赖目录 |

发布门前区分：`make package-check` 是没有隔离 install 时的本地离线交付门；`make release-check INSTALL_DIR="$dsh_install"` 才是要求 Host 类型与真实 Loader 已验证的严格门。发布门返回 0 也不表示包已发布。

## 副作用速查

| 操作 | 仓库内产品文件 | ignored `build/` | 临时目录 | live profile | 网络 |
|---|---|---|---|---|---|
| `check` / `docs` / `content` / `git-*` | — | — | — | — | — |
| `test` / `test-narrow` / `test-watch` | — | — | 写 | — | — |
| `content-build` | 写（skill 或 staging） | 写（omp/dsh staging） | — | — | — |
| `pack` / `pack-omp` / `pack-dsh` / `inspect` | — | 写 | — | — | — |
| Host 门（`typecheck-host`/`host-check`/`profile-check`/`isolation-check`） | — | — | 在 INSTALL_DIR 内建 scratch | — | — |
| `install-smoke` | — | — | 写 | — | 写 |
| `install-omp` | — | — | — | 写 | — |
| `clean` / `clean-all` | — | 删生成路径 | — | — | — |

## 变量

| 变量 | 用法 |
|---|---|
| `TARGET` | `skill\|omp\|dsh`，默认 skill；用于 `content`/`content-build` |
| `INSTALL_DIR` | 指向上面准备的隔离 rc.4 install；Host 门与 `release-check` 必需，`diagnose` 可选 |
| `CONFIRM` | `install-omp` 与 `clean-all` 需取值 `yes` |

含空格目录示例：`make host-check INSTALL_DIR="$dsh_install"`（变量值带空格时加引号即可）。所有示例路径均为可移植占位，具体位置由使用者环境决定。

## 失败与修复

| 症状 | 原因 | 修复 |
|---|---|---|
| 默认容器报缺 bun/node | 该容器只提供 Make 与 Python | 切到开发容器或原生环境；用 `make doctor` 复查 |
| 提示缺依赖 | 未运行 setup | `make setup`；不要以裸测试命令能否通过判断依赖是否就绪 |
| 内容检查报漂移或缺失 | 源已改但产物未重生成 | `make content-build TARGET=<target>` 后再 `make content TARGET=<target>` |
| `TARGET` 非法 | 不是三个合法值之一 | 改用 `skill`、`omp` 或 `dsh` |
| Host 门报 `INSTALL_DIR is not set` 或配置错误 | 未准备/不可用隔离 install | 按上文准备 install 并用 `INSTALL_DIR="$dsh_install"` 传入 |
| `release-check` 直接失败 | 严格发布门要求 Host 类型与真实 Loader 已验证 | 提供 `INSTALL_DIR`；无隔离 install 时改用 `package-check` |
| `inspect` 报没有 tarball | 还没打包 | 先 `make pack` |
| `install-omp` 或 `clean-all` 拒绝执行 | 缺确认或 staging 不存在 | 补 `CONFIRM=yes`；install-omp 还需先 `make pack-omp` |
| `clean` 拒绝执行 | build 是 symlink、含受版本控制内容或非目录 | clean 只处理仓库根的生成路径；不要手工伪造该目录 |

## 未验边界

本仓库当前没有覆盖 profile 启动、Host/执行世界隔离、registry 发布、CI 远端实跑与 rc.5 兼容性的绿色结论。相关 `*-check` 是门，前置不齐即失败；`diagnose` 只是观察，返回 0 不构成通过。历史探针的边界仍以 [P1 交付记录](ensemble/P1-DELIVERY.md)为准。

## 环境与并行说明

- Make 以 `.NOTPARALLEL` 全局串行；`make -j8 all` 与 `make -j8 pack` 可用，并行被忽略是有意设计，不是配置错误。
- 原生环境与开发容器都能运行 Make；工具链差异用 `make doctor` 确认，不在本文固化版本数字。
- 两个容器临时目录互不共享；隔离 install 与 tarball 解包目录不要跨容器复用。
