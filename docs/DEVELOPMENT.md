# 开发环境与操作指南

本指南面向在本仓库工作的维护者。**Make 是唯一主界面**：构建、测试、文档检查、打包与诊断都通过仓库根的 Makefile target 完成。命令均在仓库根执行；本指南不教授包管理器的脚本快捷方式，也不把母仓的 Makefile 带入安装后的技能或插件包——安装后的用户仍按各自包的说明操作。

本文命令已在开发容器实跑；下方记录的输出要点与退出码来自实际执行，不是预期值。

运行环境分两类：**原生环境**与**开发容器**都有 Make 与 Python；默认容器缺少 bun/node，开发容器提供完整工具链（bun、node 及相关版本要求见容器模板声明）。两个容器各自的临时目录互不共享，不能把一处生成的隔离安装目录当作另一处的输入。依赖安装需要网络，只在指定的联网入口进行。

## 1. 三条最短主路径

### 1.1 初次上手

```bash
git clone <仓库地址>
cd <仓库目录>
make setup      # 联网：bun install --frozen-lockfile → doctor → check，三步串联，任一失败即停；exit 0
make check      # 离线；exit 0，末行 `== check: ok (offline; nothing written)`
```

`make setup` 是常规流程里唯一需要联网的依赖入口；`make check` 不联网、不写产品文件，也不依赖 `build/` 或 ignored staging。位置：setup 写入依赖目录，check 只读取工作树并报告结果。

### 1.2 日常验证

```bash
make check                 # 离线：内容一致性 + 两个类型检查 + 文档检查
make test                  # 全量测试
make test-narrow           # 窄测试
make typecheck             # 仓库类型检查
make docs                  # 文档检查
```

实测退出码：`make check` 0（末行 `== check: ok (offline; nothing written)`；文档检查行 `Checked 45 documents, 654 file/heading/line references`）；`make test` 0（120 pass / 0 fail，6 files）；`make test-narrow` 0（30 pass，1 file）；`make typecheck` 0；`make docs` 0。全部为只读操作，不改产品文件。

### 1.3 改内容源

```bash
make content TARGET=skill                  # 检查生成结果，默认 TARGET=skill
make content-build TARGET=skill            # 从单份源生成，会写产品文件
make content TARGET=omp                    # 检查 OMP 路径
make content TARGET=dsh                    # 检查 DSH 路径
```

`TARGET` 合法值为 `skill|omp|dsh`，默认 `skill`；非法值由 make 层拒绝（exit 2，例如 `make content TARGET=dsh2` 输出 `error: TARGET=dsh2 is not a content path.` 并列出 `skill omp dsh`）。`content-build` 是常规流程中唯一写产品文件的 target：skill → `skills/ensemble/`（提交产物）；omp/dsh → `build/ensemble/{omp,dsh}/skills/ensemble/`（ignored，需先 `content-build`）。

### 1.4 交付前

```bash
make package-check                                  # 本地离线门：check + test + pack + inspect；无需隔离 install
make release-check INSTALL_DIR=<isolated-install-dir> # 严格发布门：离线门 + 两个包 + Host 类型 + 真实 Loader
```

`package-check` 是不具备隔离 rc.4 install 时的离线交付门（与 `all` 等价），只覆盖离线检查与本地产物。`release-check` 是**严格发布门**：必须提供 `INSTALL_DIR` 指向已存在的隔离 rc.4 install，缺则 exit 2 并说明“发布门要求 Host 类型与真实 Loader 已验证”；它串联离线门、两个包、Host 类型检查与真实 Loader。二者不能互换，发布门绿不等于已发布。

## 2. 完整 target 表

取自 `make help` 实跑输出（exit 0），公开 target 与类别已逐项核对。

| Target | 作用 | 类别 | 参数 | 副作用 |
|---|---|---|---|---|
| `help`（默认） | 列出所有公开 target | 只读 | 无 | 无 |
| `setup` | `bun install --frozen-lockfile` → `doctor` → `check` 三步串联，任一失败即停 | 联网 | 无 | 写依赖目录 |
| `check` | 内容一致性 + 两个 tsc + 文档检查 | 离线、只读 | 无 | 无；不依赖 build/ 与 ignored staging |
| `test` | 全量测试 | 只读 | 无 | 无 |
| `test-narrow` | 窄测试 | 只读 | 无 | 无 |
| `test-watch` | 监视模式测试 | 只读 | 无 | 无 |
| `typecheck` | 仓库类型检查 | 只读 | 无 | 无 |
| `typecheck-host` | Host 入口对隔离 rc.4 install 的类型检查 | 只读、依赖隔离 install | `INSTALL_DIR=...` | 无 |
| `host-check` | Host 入口实装检查 | 只读、依赖隔离 install | `INSTALL_DIR=...` | 无 |
| `docs` | 文档检查 | 只读 | 无 | 无 |
| `content` | 内容生成一致性检查 | 只读 | `TARGET=skill\|omp\|dsh` | 无 |
| `content-build` | 从单份源生成内容 | 写产品文件 | `TARGET=skill\|omp\|dsh` | 写技能目录或 ignored staging |
| `pack` | 打包所有路径 | 写 ignored 产物 | 无 | 写打包 staging |
| `pack-omp` | 打包 OMP 独立包 | 写 ignored 产物 | 无 | 写 OMP staging |
| `pack-dsh` | 打包 DSH 探针包 | 写 ignored 产物 | 无 | 写 DSH staging |
| `inspect` | 列出 tgz 及内容 | 只读 | 无 | 无产物时非 0（`no package tarballs under build/pack — nothing has been packed…` + 提示 `make pack`）；有产物 0 |
| `status` | 工作树状态概览 | 只读 | 无 | 无 |
| `git-review` | 变更审阅辅助 | 只读 | 无 | 无 |
| `diff` | 变更差异 | 只读 | 无 | 无 |
| `package-check` | 离线聚合：check + test + pack + inspect（等价 `all`） | 写 build/pack 产物 | 无 | 写打包 staging；无需隔离 install |
| `release-check` | 严格发布门：离线门 + 两个包 + Host 类型 + 真实 Loader | `[needs INSTALL_DIR]`、非只读 | `INSTALL_DIR` 必需 | 写 build/pack 产物；缺 `INSTALL_DIR` exit 2 并说明“发布门要求 Host 类型与真实 Loader 已验证” |
| `install-omp` | 安装 OMP 本地 staging root | 写用户 profile、显式 opt-in | `CONFIRM=yes` 且需已存在 `build/pack/omp/staging` | 改用户 OMP 配置；两前置缺失时 exit 2 并提示 `make pack-omp` |
| `install-smoke` | 安装器冒烟（锁 `skills@1.9.0`） | 联网、显式 opt-in、不写 profile | 无 | 在临时目录安装并逐字节 `cmp`，不碰 `.agents/` 与 live profile |
| `profile-check` | profile 启动诊断 | 诊断 | 无（脚本缺失时 `INSTALL_DIR` 不参与判断） | 无；底层脚本缺失时先 exit 2 报 `not implemented yet`/`unverified`/`nothing is claimed` |
| `isolation-check` | 执行世界隔离诊断 | 诊断 | 无 | 无；底层脚本缺失时 exit 2 报能力未验 |
| `clean` | 只清理仓库根的 `build/`（`clean-all` 才加 `node_modules/`） | 写 ignored 产物 | 不接受路径参数 | symlink、含 Git-tracked 内容或非目录一律 exit 2；有产物时 `removing build/`，无产物时 `nothing to remove`，均 0 |
| `clean-all` | 另清理依赖目录 | 危险 | `CONFIRM=yes` | 删除依赖目录，需确认 |
| `all` | 离线链，等价 `package-check` | 写 build/pack 产物 | 无 | 写打包 staging；不含 Host gate |

## 3. 变量

| 变量 | 合法值 / 默认 | 行为 | 示例 |
|---|---|---|---|
| `TARGET` | `skill\|omp\|dsh`，默认 `skill` | 非法值 exit 2，列出三值，例：`error: TARGET=dsh2 is not a content path.` / `Expected one of: skill omp dsh` | `make content-build TARGET=omp` |
| `INSTALL_DIR` | 已存在的隔离 rc.4 安装目录；无默认值 | 用于 `typecheck-host`/`host-check`/`release-check`；缺失时这些 Host gate exit 2；`profile-check` 脚本缺失时不依赖本变量 | `make host-check INSTALL_DIR=./isolated-install` |
| `CONFIRM` | `clean-all` 与 `install-omp` 需精确取值 `yes` | 缺失或错误值 exit 2 | `make clean-all CONFIRM=yes` |

含空格路径的写法：`make host-check INSTALL_DIR="./path with spaces/install"`。本指南不写具体环境路径；隔离安装目录由使用者按包说明预先准备。

## 4. 副作用矩阵

| 类别 | Target | 说明 |
|---|---|---|
| 联网 | `setup`、`install-smoke` | `install-smoke` 是显式 opt-in，在临时目录装锁定的 `skills@1.9.0` 并逐字节比对；常规离线流程不触发 |
| 写产品文件 | `content-build` | 常规流程中唯一写产品文件的 target |
| 写 ignored 产物 | `pack`、`pack-omp`、`pack-dsh`、`package-check`、`all`、`release-check`、`clean` | 只触及 ignored 的 build/staging 目录；`release-check` 还需隔离 install |
| 写用户 profile | `install-omp` | 需显式 `CONFIRM=yes` 且已有 staging，不属于日常验证；`install-smoke` 不写 profile |
| 危险 | `clean-all` | 需 `CONFIRM=yes`，另删依赖目录 |
| 只读 | `help`、`check`、`test*`、`typecheck*`、`host-check`、`docs`、`content`、`inspect`、`status`、`git-review`、`diff`、`profile-check`、`isolation-check` | 诊断类在能力未落地时退出 2，不表示通过 |

## 5. 失败与修复

| 症状 | 原因 | 修复 |
|---|---|---|
| 默认容器报缺 bun/node | 该容器只有 Make 与 Python | 切到提供完整工具链的开发容器，或在原生环境安装工具链 |
| 提示缺依赖 | 未运行 `make setup` | 先 `make setup`（联网）；Make 不自动联网。缺 node_modules 时 `make check` 的类型检查环节失败并引导 setup |
| `bun test` 在无 node_modules 时仍可通过，不能当作依赖就绪 | 裸测试命令不依赖 node_modules | 以 `make check`（含类型检查与文档检查）为依赖就绪判据；缺依赖时运行 `make setup` |
| 新 clone 无 staging 时对 OMP/DSH 执行 content 检查 | 产物尚未生成 | `make content TARGET=omp` exit 2（6 条 missing）；先 `make content-build TARGET=omp` 生成 |
| `TARGET` 非法 | 非 `skill\|omp\|dsh` | 用三值之一；如 `TARGET=dsh2` 时 exit 2 并列出三值 |
| 缺 `INSTALL_DIR` | Host 相关 target 与发布门需要真实隔离 install | `make host-check`/`make typecheck-host`/`make release-check` 缺变量时 exit 2；发布门说明“要求 Host 类型与真实 Loader 已验证”。准备隔离 install 后用 `INSTALL_DIR=<isolated-install-dir>` 传入；仅本地离线交付用 `make package-check` |
| `install-omp` / `clean-all` 缺 `CONFIRM=yes` | 需显式确认 | exit 2；`install-omp` 还需已存在 `build/pack/omp/staging`，否则提示 `make pack-omp` |
| `inspect` 无产物 | 尚未打包 | exit 2 并提示 `make pack`；先 `make pack` |
| `clean` 拒绝执行 | `build/` 是 symlink、含 Git-tracked 文件或非目录 | exit 2；`clean` 不接受路径参数，只考虑仓库根的 `build/`（有产物 `removing build/`，无产物 `nothing to remove`，均 0） |

## 6. 未验边界

以下能力**没有任何绿色 target**，不能据本仓库当前证据表述为已验证：profile 启动、`profile-check` 涉及的诊断路径、Host/执行世界隔离、registry 发布、CI 远端实跑、rc.5 与 rc.4 基线的兼容性。`profile-check`（脚本未落地时先 exit 2，`INSTALL_DIR` 不参与判断）与 `isolation-check`（无参数）明确报 `not implemented yet` / `unverified` / `nothing is claimed`，这既不是失败也不是通过，不得据此宣称 P1 完成。`release-check` 是严格发布门，缺 `INSTALL_DIR` 时 exit 2，不提供跳过 Host gate 的绿色分支；没有隔离 install 时只使用离线门 `package-check`/`all`。历史探针的未验门槛仍以 [P1 交付记录](ensemble/P1-DELIVERY.md)为准。

## 7. native 与开发容器；Make 作为主界面

- Make 是唯一主界面；包管理器脚本入口不作为推荐操作，安装后的技能与插件包不引用母仓 Makefile。
- 默认容器提供 Make 与 Python，但缺少 bun/node；开发容器提供完整工具链。依赖安装只在 `make setup` 进行。
- Makefile 以 `.NOTPARALLEL` 全局串行，`make -j8 all` / `make -j8 pack` 实测 exit 0；并行被忽略是有意设计，不是配置错误。
- 两个容器的临时目录互不共享：在一个容器准备的隔离安装目录不能假定在另一个容器可见。
- 容器模板定义见仓库的容器配置文件；工具链版本以模板声明为准，不在本文固化数字。
