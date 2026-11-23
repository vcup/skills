# 开发环境与操作指南

本指南面向在本仓库工作的维护者。**Make 是唯一主界面**：构建、检查、测试、打包、生产门、诊断与安装都通过仓库根的 Makefile target 完成，包管理器脚本不作为推荐入口。命令均在仓库根执行。安装后的技能与插件包不引用母仓 Makefile，用户按各自包的说明操作。

## 最短日常路径

```bash
make doctor                 # 自诊断：缺什么、阻塞哪些 target
make setup                  # 首次需要：联网装依赖，然后 doctor + check
make check                  # 日常默认门：离线、不写产品文件
make package-check          # 交付前离线聚合：check + test + pack + inspect
```

日常改动后先跑 `make check`；准备交付时跑 `make package-check`。要得出「已安装的产品真的可用」这一结论，必须再跑生产门（见[生产门](#生产门已安装产品而非仅-loader)）。

## 工具前置与自诊断

需要 bun、node、npm/npx、python3、git；本地 OMP 安装另需 omp，浏览器门另需 Chrome/Chromium 与官方 slot 包。**不要记忆版本号或写死**：运行 `make doctor` 确认当前环境满足哪些、缺少哪项会阻塞哪些 target。

运行环境分原生环境与开发容器两类：默认容器只提供 Make 与 Python，缺少 bun/node；开发容器提供完整工具链。两个容器的临时目录互不共享，在一个容器准备的隔离 install 不能假定在另一个容器可见。依赖安装只在 `make setup` 进行，它串联 `bun install --frozen-lockfile`、doctor 与 check，任一失败即停；Make 不会隐式联网。

## 准备隔离 install

Host 门与生产门都不针对本工作树运行，而是针对**一次真实安装的受测 DSH 发行版**（`0.2.2-rc.4` 或 `0.2.2-rc.5`，默认后者）。原因：Host 入口 import 的 `@deepseek-ai/*` 不在仓库依赖里，对着工作树检查无法证明公开类型、真实 Loader 或已安装包的行为。

维护者只需记住一个 target：

```bash
make pack                                   # 先构建三个包
make runtime-setup INSTALL_DIR="$HOME/dsh-install" DSH_VERSION=0.2.2-rc.5
```

`runtime-setup` 是唯一准备 install 的 target：它 `npm install --ignore-scripts` 一个**受测**发行版与随包构建产物，`DSH_VERSION` 不在受测集合时直接 exit 2 且什么都不装。目录在仓库外，可任意可写位置；不要写仓库、不改 live profile、不提交、不跨容器复用。

类型门还需要一个只用于类型的目录：官方 slot 包（版本精确等于该 install 的 `@deepseek-ai/dsh`）加官方 Client 插件声明的 React major。它由下面这条生成，不要手写：

```bash
make client-types INSTALL_DIR="$HOME/dsh-install" CLIENT_TYPES="$HOME/dsh-client-types"
```

`SLOTS`（给 `client-check`）与 `CLIENT_TYPES`（给类型门）不是同一个东西，不要合并。

后续所有门都用同一组变量：

```bash
make host-check       INSTALL_DIR="$HOME/dsh-install" CLIENT_TYPES="$HOME/dsh-client-types"
make production-check INSTALL_DIR="$HOME/dsh-install"
```

`INSTALL_DIR` 只接受已存在的 install：缺变量、缺目录、缺该目录内的候选包，门都会先打印缺什么并 exit 2，说明什么都没验证，而不是抛出模块解析栈或静默跳过。`CLIENT_TYPES` 缺目录、或目录里没有版本匹配的官方 slot 包，同样 exit 2。生产门另可用 `PACKAGE=` 指定精确 tarball、`RUNTIME=` 指定发布运行时（缺省回落到 `INSTALL_DIR`）；发布门还要 `PACKAGE_SHA256=`。

## 完整 target 一览（按目标分组）

类别列标出**是否需要网络**与**是否写 live profile**；未标注者不联网、不写 profile。所有公开 target 以 `make help` 为准。

### 初次上手

| Target | 作用 | 参数 / 条件 | 类别 |
|---|---|---|---|
| `help` | 列出所有公开 target（默认 target） | 无 | 只读 |
| `doctor` | 报告工具、依赖与产物状态，指出阻塞项 | 无 | 只读 |
| `setup` | 装依赖 → doctor → check，串联执行 | 无 | 联网、写依赖目录 |
| `runtime-setup` | 在一个隔离 install 中准备受测 DSH 发行版与构建产物 | `INSTALL_DIR`、`DSH_VERSION`（须为受测版本） | 联网、写 INSTALL_DIR |
| `client-types` | 生成 Client program 需要的**只用于类型**的目录：`@deepseek-ai/dsh-client-ui-slots` 精确等于该 install 的 `@deepseek-ai/dsh` 版本，加官方 Client 插件声明的 React major | `INSTALL_DIR`、`CLIENT_TYPES` | 联网、写 CLIENT_TYPES |

### 日常验证（离线）

| Target | 作用 | 参数 / 条件 | 类别 |
|---|---|---|---|
| `check` | 默认门：内容漂移 + 两个类型检查 + CLI bundle 闭包 + 文档检查 | 无 | 离线、仓库内只读 |
| `test` | 全量测试 | 无 | 写临时目录 |
| `test-narrow` | 窄测试（内容构建器），CI 使用的快速门 | 无 | 写临时目录 |
| `test-watch` | 监视模式测试，Ctrl-C 退出 | 无 | 写临时目录、长驻 |
| `typecheck` | 两个 plain program：`tsc --noEmit` 与 `tsc -p adapters/dsh/tsconfig.json`；**离线子集**，无 install 也能跑 | 无 | 只读 |
| `typecheck-strict` | 完整类型声明：两个 plain + Host program + Client program + 闭包检查；闭包覆盖 `.ts`/`.tsx`/`.mts`/`.cts`，任一 maintained 文件不在四个 program 之一即失败 | `INSTALL_DIR`、`CLIENT_TYPES` 必需 | 只读 |
| `typecheck-client` | 只编译 Client program（与 strict 同一个 program，不是更弱的变体） | `INSTALL_DIR`、`CLIENT_TYPES` 必需 | 只读 |
| `docs` | 文档链接、标题锚点与引用检查 | 无 | 只读 |
| `check-upstream` | 显式联网读取公开 npm dist-tags，并按受测版本集分类 | 无；不在离线链路中 | 联网、只读；见[版本支持与升级](UPGRADING.md) |

### 改内容

| Target | 作用 | 参数 / 条件 | 类别 |
|---|---|---|---|
| `content` | 报告 TARGET 的生成漂移，不写文件 | `TARGET=skill\|omp\|dsh`，默认 skill | 只读 |
| `content-build` | 从单份源重新生成 TARGET | 同上 | 写产品文件 |

skill 产物在 `skills/ensemble/`（提交产物）；omp/dsh 产物在 `build/ensemble/{omp,dsh}/skills/ensemble/`（ignored，需先 content-build）。`TARGET` 非法值 exit 2 并列出三个合法值。

### 打包与产物

| Target | 作用 | 参数 / 条件 | 类别 |
|---|---|---|---|
| `pack` | 三个包：OMP staging root、`dsh-ensemble` tarball、`dsh-agent-wait` tarball | 无 | 写 ignored `build/` |
| `pack-omp` / `pack-dsh` / `pack-dsh-agent-wait` | 只生成对应包 | 无 | 写 ignored `build/` |
| `inspect` | 列出 tarball 与内容 | 需先 `make pack` | 只读 |
| `dsh-bundle` | 从指定 install 重新生成 CLI 的私有 transport bundle | `DSH_BUNDLE_INSTALL` 必需 | 写提交产物 |
| `dsh-bundle-check` | 校验已提交 bundle 与其输入闭包一致 | 无；在 `check` 中执行 | 只读 |

### 运行门（Loader 与启动）

**门（gate）与观察（observe）的区别**：`*-check` 是门，只有所有必需检查都真实运行并一致时才返回 0，前置缺失一律非 0；`diagnose` 只观察，恒返回 0，不构成通过。

| Target | 作用 | 参数 / 条件 |
|---|---|---|
| `typecheck-host` | Host **与** Client 两个 program 对受测发行版公开类型的检查（单点调试入口；发布门用 `typecheck-strict`） | `INSTALL_DIR`、`CLIENT_TYPES` 必需 |
| `host-check` | Host 类型 + 真实 Loader，两者都必须通过 | `INSTALL_DIR` 必需，且该目录已安装候选包 |
| `typecheck-wait-host` | 等待插件 Host 入口类型检查 | `INSTALL_DIR` 必需 |
| `wait-host-check` | 等待插件 Host 类型 + 真实 Loader | `INSTALL_DIR` 必需 |
| `wait-runtime-check` | 新 profile 标准安装、真实原生等待生命周期、CLI 启动与卸载 | `INSTALL_DIR` 必需 |
| `profile-check` | DSH profile 启动形态 | `INSTALL_DIR` 必需 |
| `isolation-check` | 执行世界 confine 必须被观察到 | `INSTALL_DIR` 必需 |
| `cli-check` | `ensemble-archive` 在两个发行版的新 profile 中安装、运行、卸载 | `RC4_INSTALL` 与 `RC5_INSTALL` 都必需 |
| `dsh-bundle-check` | 已提交的 CLI transport bundle 与其 provenance 一致（在 `check` 中执行） | 无 |
| `diagnose` | 观察环境实际行为，首行 `OBSERVATION ONLY — not a check` | 有 install 时传 `INSTALL_DIR` |

### 生产门（已安装产品，而非仅 Loader）

Loader 门只证明插件**能加载**；生产门证明**已安装的产品能用**：标准 `dsh plugin add`、真实原生 AgentLoop 工具调用、已认证 owner Remote、随包 CLI、真实浏览器中的打包 Client factory，以及存档／维护／环境行为。**这些门都无法离线满足，也不降级为 skip**：每个缺失前置都 exit 2 并给出补前置的命令。

| Target | 覆盖 | 参数 / 条件 |
|---|---|---|
| `product-check` | 标准安装候选 tarball → 真实 AgentLoop 写入、已认证 owner HTTP Remote、随包 headless CLI | `INSTALL_DIR`、已构建候选 |
| `client-check` | 打包 Client factory 在真实浏览器、官方 `ClientModuleSystem` 与发布的 SlotRegistry renderer 中运行 | 追加 `BROWSER`、`SLOTS` |
| `maintenance-check` | 真实内核上的**引擎回归**：导入导出、备份、恢复、迁移、迁移位置、复制与受批准清除 | `INSTALL_DIR` |
| `maintenance-live-check` | **已安装产品**经随包 CLI 对真实 Host 的维护实跑（发布门调用的是这个，引擎回归不能替代它） | `INSTALL_DIR`、`PACKAGE` |
| `replica-acceptance-check` | 独立复制的 typed 反例（真实已认证 HTTP） | `INSTALL_DIR` |
| `environment-check` | 环境账本对原生 Settings，含响应丢失后的对账 | `INSTALL_DIR` |
| `selection-check` | 选型证据来自真实成员 Session 日志：不可读时返回 `unavailable` 而不是编造答案，别的 Session 不会被归属到本 attempt，请求的模型与实际不同的仍报告真实值，重复读取逐字节一致 | `RUNTIME`（或 `INSTALL_DIR`） |
| `runtime-test-check` | 离线 `make test` 会跳过的 native 测试族，逐个真实执行；**除 live CLI 一族外，任何 skip 都判失败**（环境没生效等于没跑）。live CLI 一族缺 `LIVE_ORIGIN`/`LIVE_COOKIE_FILE` 时如实记为 skipped，绝不计为通过 | `INSTALL_DIR`；可选 `LIVE_ORIGIN`、`LIVE_COOKIE_FILE`（只传凭证文件路径，不传值） |
| `live-cli-test` | `adapters/dsh/cli.test.ts` 的 live lane（describe `packaged CLI against a live Host`）：自起 Host，`projects` → `query{context}` → `manage pause` → `manage resume` → 重读校验 revision/epoch；skip / fail / 零用例都算失败。仅覆盖单个 Host 上的本地管理写与回滚，与复制无关 | `INSTALL_DIR`、`PACKAGE`、`PACKAGE_SHA256` |
| `store-acceptance-check` | 非作者独立存档事务、损坏与 CAS 反例（按运行时路径 11–12 项；不要把整数当固定总数） | `INSTALL_DIR` |
| `native-acceptance-check` | 非作者独立执行世界与身份边界（23 项） | `INSTALL_DIR` |
| `source-acceptance-check` | 跨容器 source 读取的裸门：需要**已在别处运行**的 fixture；未给令牌或 URL 即 exit 2 并声明**未运行** | `INSTALL_DIR`、`ENSEMBLE_SOURCE_TEST_TOKEN`、`ENSEMBLE_SOURCE_TEST_URL` |
| `source-sidecar` | 在一次性容器里起 source-world fixture，打印 URL 与令牌（`eval "$(make -s source-sidecar)"` 取用） | 需要容器运行时 |
| `source-sidecar-stop` | 停止并删除该容器 | `CONTAINER` |
| `source-acceptance-sidecar-check` | **发布门使用的那一个**：自起容器 → 跑跨容器读取 → 任何退出路径都停容器 | `INSTALL_DIR`、容器运行时 |
| `auth-ui-check` | **已认证 UI 门**：真实 Host 启动并下发 cookie，真实浏览器加载随包 Client，做一次 owner 写入并观察 revision 前进、停 cookie 后失去管理能力 | `INSTALL_DIR`、`PACKAGE`、`BROWSER` |
| `fixture-test` | 仅测试用 source-world 服务的契约测试 | 无；离线 |
| `matrix-check` | 已打包清单声明的受测版本与维护声明一致 | 已构建包 |
| `production-check` | 产品门按依赖顺序串联，**不含**浏览器门与跨容器门（它不是发布结论） | `INSTALL_DIR`、已构建候选 |

### Owner 档案（需要运行中的 Host）

`archive-owner-help`、`archive-owner-status`、`archive-owner-call` 调用随包 `ensemble-archive` CLI；它们需要 `INSTALL_DIR`，且前者不是门、不需要凭证。凭证只从 `ENSEMBLE_ARCHIVE_COOKIE` 读取，不会打印。

### 安装（显式选择，不属于日常路径）

| Target | 作用 | 参数 / 条件 | 类别 |
|---|---|---|---|
| `install-omp` | 把本地 OMP staging root 装入 live profile（替换已安装的同名包） | `CONFIRM=yes` 且 staging 已存在 | 写 live profile |
| `install-smoke` | 在临时目录安装锁定的 skills CLI 并逐字节比对 | 无 | 联网、写临时目录 |

### Git 只读辅助

`status`（分支、改动路径与产物状态）、`diff`（工作树差异）、`git-review`（状态 + diffstat + 近期提交）均为只读，不改工作树或提交历史。

### 清理与交付

| Target | 作用 | 参数 / 条件 | 类别 |
|---|---|---|---|
| `package-check` | 离线聚合 `check + test + pack + inspect` | 无 | 写 ignored `build/`，无需隔离 install |
| `all` | `package-check` 的别名 | 无 | 同上 |
| `release-check` | 严格发布门，**全部无条件**（与当前 Makefile 的先决条件逐项一致）：`check` + `test` + `inspect` + `matrix-check` + `typecheck-strict` + 两个插件的 Host 类型与真实 Loader（`host-check`／`wait-host-check`）+ `wait-runtime-check` + `maintenance-live-check` + `selection-check` + `live-cli-test` + `runtime-test-check` + `production-check` + `replica-acceptance-check` + `client-check` + `auth-ui-check` + `fresh-journey-check` + `source-acceptance-sidecar-check` | `INSTALL_DIR`、`PACKAGE`、`PACKAGE_SHA256`、`BROWSER`/`SLOTS`、`CLIENT_TYPES`、容器运行时；**缺任一项即 exit 2** | 写 ignored `build/` |
| `clean` | 只删除 Makefile 拥有的生成路径 | 不接受路径参数；build 是 symlink／含受版本控制内容／非目录时拒绝 | 写 ignored `build/` |
| `clean-all` | clean 之外再删 node_modules | `CONFIRM=yes` | 危险、写依赖目录 |

**三层门，不要互相冒充。**

| 层 | 命令 | 能得出的结论 |
|---|---|---|
| 离线 | `package-check`（= `check` + `test` + `pack` + `inspect`）、`all` | 内容、类型（plain 子集）、测试、打包一致；**不是**发布结论，不含任何 install 或浏览器 |
| 产品聚合 | `production-check` | 已安装产品的 product/archive/environment/matrix 与两个非作者验收套件；**不含**浏览器门与跨容器门，**不是**发布结论 |
| 严格发布 | `release-check` | 上面全部 + 完整类型声明（含闭包检查）+ 真实浏览器已认证 UI + 跨容器 source 世界；**唯一**可作为发布结论的门。它要求 `PACKAGE_SHA256`，未 pin 直接 exit 2 |

`release-check` 没有任何可选门，也没有“打印未验证项但返回 0”的路径：浏览器、容器运行时、`CLIENT_TYPES`、source fixture 缺任一项都 exit 2。

**同包同字节。** `release-check` **强制要求** `PACKAGE=` 与 `PACKAGE_SHA256=` 指向同一个不可变 tarball：

- 缺 `PACKAGE_SHA256` → exit 2（`PACKAGE_SHA256 is not set`）：未 pin 的运行无法证明被审阅的产物就是被测量的那个，因而不构成发布结论；
- `PACKAGE_SHA256` 不是 64 位小写十六进制 → exit 2；
- 与实测字节不符 → exit 2，打印 expected / measured / file 三行，并在安装任何东西之前拒绝。

未 pin 的诊断请用 `package-check` 或 `production-check`：它们不依赖 pin，也在自己的输出里声明不是发布结论。

## 副作用速查

| 操作 | 仓库内产品文件 | ignored `build/` | 临时目录 | live profile | 网络 |
|---|---|---|---|---|---|
| `check` / `docs` / `content` / `git-*` / `matrix-check` / `fixture-test` | — | — | — | — | — |
| `test` / `test-narrow` / `test-watch` | — | — | 写 | — | — |
| `content-build` | 写（skill 或 staging） | 写（omp/dsh staging） | — | — | — |
| `pack` / `pack-omp` / `pack-dsh` / `pack-dsh-agent-wait` / `inspect` | — | 写 | — | — | — |
| `dsh-bundle` | 写提交的 bundle | — | — | — | — |
| `runtime-setup` | — | — | — | — | 写；写 INSTALL_DIR |
| `client-types` | — | — | — | — | 写；写 CLIENT_TYPES |
| `source-sidecar` / `source-sidecar-stop` | — | — | 起/停一次性容器 | — | 容器运行时 |
| `source-acceptance-sidecar-check` | — | — | 起/停一次性容器 + 写 | — | 容器运行时（loopback） |
| `auth-ui-check` | — | 写 `CLIENT_OUT/auth` | 写；真实 Host + 浏览器 | — | 仅 loopback |
| Loader 门（`typecheck-host`／`host-check`／`typecheck-wait-host`／`wait-host-check`／`profile-check`／`isolation-check`／`wait-runtime-check`／`cli-check`） | — | — | 在 INSTALL_DIR 内建 scratch | — | — |
| 生产门（`product-check`／`maintenance-check`／`environment-check`／`store-acceptance-check`／`native-acceptance-check`／`production-check`） | — | 写 ignored `build/` | 写 | — | — |
| `client-check` | — | 写 `CLIENT_OUT` | 写 | — | — |
| `source-acceptance-check` | — | — | 写 | — | 仅 pod loopback |
| `diagnose` | — | — | 在 INSTALL_DIR 内建 scratch（恒 exit 0） | — | — |
| `install-smoke` | — | — | 写 | — | 写 |
| `install-omp` | — | — | — | 写 | — |
| `clean` / `clean-all` | — | 删生成路径 | — | — | — |

## 变量

| 变量 | 用法 |
|---|---|
| `TARGET` | `skill\|omp\|dsh`，默认 skill；用于 `content`/`content-build` |
| `INSTALL_DIR` | 隔离 install；所有 Host 门与生产门必需，`diagnose` 可选 |
| `RUNTIME` | 生产门验证的发布运行时；缺省回落到 `INSTALL_DIR` |
| `PACKAGE` | 生产门验证的候选 tarball；缺省用本树最后打包的 `build/pack/dsh/dsh-ensemble-*.tgz` |
| `RC4_INSTALL` / `RC5_INSTALL` | `cli-check` 的两个隔离 install，都必须给 |
| `DSH_VERSION` | `runtime-setup` 安装的发行版，必须是受测版本之一 |
| `PACKAGE_SHA256` | 候选 tarball 的 sha256。`release-check` **必需**（缺失 exit 2，非 64 位小写十六进制也 exit 2）；与 `PACKAGE` 实测字节不符时在安装前拒绝。`package-check`/`production-check` 不需要它 |
| `BROWSER` | `client-check` 与 `auth-ui-check` 使用的 Chrome/Chromium 可执行文件；必须显式给出，不会被自动发现 |
| `SLOTS` | `client-check` 加载的官方静态 slot 包目录（`@deepseek-ai/dsh-client-ui-slots`）。与 `CLIENT_TYPES` 不是同一个东西 |
| `CLIENT_TYPES` | 只用于类型的目录：官方 slot 包版本精确等于该 install 的 `@deepseek-ai/dsh`，加官方 Client 插件声明的 React major。由 `make client-types` 生成 |
| `CONTAINER` | `source-sidecar-stop` 要删除的容器名（`make source-sidecar` 会打印） |
| `LIVE_ORIGIN` / `LIVE_COOKIE_FILE` | `runtime-test-check` 的可选输入：运行中 Host 的 origin 与**凭证文件路径**（只传路径，不传值）。未提供时该门的 live CLI 一族如实记为 skipped，不计为通过 |
| `ENSEMBLE_SOURCE_TEST_TOKEN` / `ENSEMBLE_SOURCE_TEST_URL` | 裸 `source-acceptance-check` 需要的、已在别处运行的 fixture 令牌与 URL |
| `DSH_BUNDLE_INSTALL` | `dsh-bundle` 生成 bundle 时使用的 install |
| `CONFIRM` | `install-omp` 与 `clean-all` 需取值 `yes` |

含空格目录示例：`make host-check INSTALL_DIR="$dsh_install"`（变量值带空格时加引号即可）。示例路径均为可移植占位。

## 失败与修复

| 症状 | 原因 | 修复 |
|---|---|---|
| 默认容器报缺 bun/node | 该容器只提供 Make 与 Python | 切到开发容器或原生环境；`make doctor` 复查 |
| 提示缺依赖 | 未运行 setup | `make setup`；不要以裸测试命令能否通过判断依赖是否就绪 |
| 内容检查报漂移或缺失 | 源已改但产物未重生成 | `make content-build TARGET=<target>` 后再 `make content TARGET=<target>` |
| `TARGET` 非法 | 不是三个合法值之一 | 改用 `skill`、`omp` 或 `dsh` |
| 门报 `INSTALL_DIR is not set` | 未准备隔离 install | `make runtime-setup INSTALL_DIR=... DSH_VERSION=...` |
| `runtime-setup` 拒绝 `DSH_VERSION` | 该版本不在受测集合 | 用 `make check-upstream` 观察，再按[升级流程](UPGRADING.md)评估后加入支持集 |
| 门报「no candidate package」 | 本树还没打包或 `PACKAGE=` 指向不存在文件 | `make pack-dsh`，或给精确 `PACKAGE=` |
| `host-check` 报 install 内没有 `dsh-ensemble` | 该 install 未安装候选包 | 让 `runtime-setup` 准备，或在该目录 `npm install --ignore-scripts <tarball>` |
| 门报 `CLIENT_TYPES is not set` | 类型门需要该 install 精确版本的官方 slot 包 | `make client-types INSTALL_DIR=... CLIENT_TYPES=...` |
| 门报 `no @deepseek-ai/dsh-client-ui-slots in <dir>` | `CLIENT_TYPES` 指向了不含 slot 包的目录 | 用 `make client-types` 生成，不要手写目录 |
| 门报 `PACKAGE_SHA256 is not set` | 发布门要求按字节冻结产物，未 pin 的运行不是发布结论 | 给出该 tarball 的 sha256；只想要诊断聚合就用 `package-check`/`production-check` |
| 门报 `the candidate is not the pinned artifact` | `PACKAGE_SHA256` 与 `PACKAGE` 不是同一份字节 | 确认两者指向同一个不可变 tarball；不要为了过门改 hash |
| 门报 `no container runtime on PATH` | 跨容器 source 门需要 podman 或 docker | 装一个容器运行时；在同一个容器里跑该门只能测到本机文件系统，不算通过 |
| `auth-ui-check` 报错 | 该门在真实浏览器里执行，失败位置会随实现与环境变化 | 按门的实际输出定位；不要把某一次的具体失败位置当作稳定事实写进文档 |
| `client-check` 报缺 `BROWSER`/`SLOTS` | 浏览器门需要显式指定的浏览器与官方 slot 包 | 传两个变量；缺失时该门失败而非跳过 |
| `source-acceptance-check` 报缺令牌 | 跨容器 fixture 需要测试令牌 | 先启动 fixture 容器并传同样令牌；未给即声明未运行 |
| `release-check` 直接失败 | 严格发布门要求 `INSTALL_DIR` | 提供隔离 install；无隔离 install 时改用 `package-check` |
| `release-check` 报 `BROWSER is not set` / `SLOTS is not set` | 严格门把浏览器 UI 与跨容器 source 当作必要条件 | 补变量与容器运行时；这两项无法用“少跑一个门”绕过 |
| `inspect` 报没有 tarball | 还没打包 | 先 `make pack` |
| `install-omp` 或 `clean-all` 拒绝执行 | 缺确认或 staging 不存在 | 补 `CONFIRM=yes`；install-omp 还需先 `make pack-omp` |
| `clean` 拒绝执行 | build 是 symlink、含受版本控制内容或非目录 | clean 只处理仓库根的生成路径；不要手工伪造该目录 |

**Skip 不是通过。** 需要 `INSTALL_DIR`、`PACKAGE`、`BROWSER`、令牌的环境条件不满足时，门以非 0 退出并说明什么都没验证。看到 `pass`/`skip` 混合的测试输出时，不能把 skip 计入发布结论。

## 未验边界

- **认证界面门已在冻结候选上通过。** `auth-ui-check` 是发布门的必要组成部分，在 rc.4 与 rc.5 上各执行过一次；门在缺浏览器时仍 exit 2，不会 skip。
- **类型闭包的边界要读准。** 闭包检查覆盖 `.ts`/`.tsx`/`.mts`/`.cts`；`make check` 的离线部分确认每个 plain maintained 文件都在某个 program 中，另有 36 个 runtime-typed 文件需要真实 DSH install 与精确 Client types，只有 `typecheck-strict`（`--strict --host-install DIR --client-types DIR`）才会编译它们。所以“离线 `check` 绿”**不等于**“全部类型已编译”，后者要求 `typecheck-strict`。
- **跨容器 source 门需要容器运行时**：`source-acceptance-sidecar-check` 在 runner 环境里真实执行过（自起容器 → 跨容器读取 → 停容器）；在缺少 podman/docker 的环境里它会 exit 2 并说明未运行，而不是跳过。
- **CI 从未在 GitHub 上跑过**：工作流文件不是通过的 run。
- **`replica-acceptance-check` 与 `maintenance-live-check` 由维护线实现**，并由发布门无条件调用；两者都在冻结候选的双版本运行中执行。
- 未发布到 registry，也没有发布地址。

`diagnose` 只是观察，恒 0 不构成通过。逐项状态以[生产状态](PRODUCTION.md)为准。

## 环境与并行说明

- Make 以 `.NOTPARALLEL` 全局串行；`make -j8 all` 与 `make -j8 pack` 可用，并行被忽略是有意设计。
- 原生环境与开发容器都能运行 Make；工具链差异用 `make doctor` 确认，不在本文固化版本数字。
- 两个容器临时目录互不共享；隔离 install 与 tarball 解包目录不要跨容器复用。
- CI 使用同一组 Make 入口（[工作流](../.github/workflows/ensemble-content.yml)）；工作流文件本身不是通过记录。
