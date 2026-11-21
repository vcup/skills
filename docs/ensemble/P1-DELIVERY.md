# P1 有界探针交付记录（维护者用）

本记录只汇总 P1 有界探针在**工作树**中的实现与验证状态，面向维护者与独立验收者；它不是发布说明，也不把探针等同于 [P1 总出口](../../ROADMAP.md#p1先证明选用的原生能力能够组合)。设计基线固定为 DSH `0.2.2-rc.4`（提交 `3f321d32bfe382212a8ed8785c1d47a5a300aa23`）；本节以下逐项结果保留当时的观测时态，不因后续支持集合变化而改写。当前受测 DSH 集合、默认版本、已提交/未发布状态与升级流程以[版本支持与升级](../UPGRADING.md)为唯一权威；0.3.0 有界 owner 档案面与 CLI 的维护者重放步骤与边界见 [DSH adapter guide](../../adapters/dsh/README.md#owner-archive-replay-maintainers)，它不是 P2 完成声明；三路径分发约定见[分发设计](DISTRIBUTION.md)，验收向量见[实施准备](IMPLEMENTATION.md#6-代表输入与预期结果)。

## 1. 状态口径

下表三态分别报告，互不推导：

- **工作树已实现/已生成/已测试**：产物存在于当前工作树，相关测试与检查已在可复现命令下通过，并已有非作者复核。
- **已提交**：产物是否进入产品 Git 提交。内容装配与包探针见提交 749df3d；Make 主入口见提交 3160333；profile 与隔离检查见提交 d6ebc2d。这不表示已发布。
- **已发布/远端可安装**：产物是否已进入 registry 或可从远端安装。本轮所有行为**否**。

凡只有作者自报、未经非作者独立复核的结论，均标 **未独立复核** 并保持设计文档原时态，不据此改写“工作树已实现”。本文不写 provider/model 清单、环境具体配置、操作流水、私有或临时绝对路径。

## 2. 交付状态总表

| 切片 | 工作树已实现/已生成/已测试 | 已提交 | 已发布/远端可安装 | 对应 D/C/R | 独立复核 |
|---|---|---|---|---|---|
| 确定性三路径内容装配（`content/ensemble/**`、`scripts/build-ensemble.ts`） | 是：`build/check/write(target)`，target 仅 skill/omp/dsh；显式文件清单、SHA256 清单、链接闭包、symlink/越界防护、drift 检查；`skills/ensemble/`（6 文件）由 `check skill` 判定 up to date；OMP/DSH 产物仅在忽略的 `build/ensemble/{omp,dsh}/` | 是（提交 749df3d） | 否 | D01/C01/C15/R18 | 非作者独立复核通过 |
| 纯 skill 本地安装回读 | 是：真实 `npx skills@1.9.0` 本地安装本地仓成功，`.agents/skills/ensemble` 与产物逐字节一致 | 是（提交 749df3d） | 否（远端 `vcup/skills` 未验） | C01/C15/R18 | 纳入内容独立验收 |
| OMP 独立安装根（`scripts/pack-omp.ts`、`adapters/omp/package/`） | 是：staging 14 文件；tgz `build/pack/omp/vcup-skills-0.2.0.tgz`；包身份保留 `@vcup/skills@0.2.0`；真实发现器回读三角色 frontmatter、`autoloadSkills:["ensemble"]`、三个技能与注册工具 `ensemble_state` | 是（提交 749df3d） | 否 | C01/C15/R18 | 包独立复核通过 |
| DSH Host-only 探针（`adapters/dsh/**`、`scripts/pack-dsh.ts`） | 是：tgz `build/pack/dsh/dsh-ensemble-probe-0.1.0.tgz`；隔离安装 rc.4 发布依赖后经公开 Loader 运行检查 44 PASS / 0 FAIL；固定参考枚举读回、未知名/路径拒绝、输出预算、插件释放 | 是（提交 749df3d） | 否 | D10/C12/C15/R18 | 包独立复核通过（44 PASS/0 FAIL 已由非作者在独立隔离目录重跑） |
| GitHub Actions 内容一致性工作流（`.github/workflows/ensemble-content.yml`） | 是（仅工作树定义）：只做 `check skill` 与 builder 测试 | 是（提交 749df3d） | 否（未在 GitHub 实跑） | C15 | 未独立复核 |
| Make 主入口与离线/发布门 | 是：Make 是唯一主界面；`check` 离线只读、`package-check`/`all` 离线聚合、`release-check` 需 `INSTALL_DIR` 的严格门 | 是（提交 3160333） | 否 | C15 | 随主入口提交有复核 |
| profile 与执行世界隔离诊断 | 是：rc.4 上 profile 形态矩阵按预期通过；容器内 confine+spawn 探针按预期；对应门缺前置即失败 | 是（提交 d6ebc2d） | 否 | D10/C15/R18 | 随检查提交有复核 |

## 3. 稳定可复现命令

当前推荐操作统一走仓库根的 Make 主界面；各 target 的归属、参数与副作用见[开发环境与操作指南](../DEVELOPMENT.md)。下面只列稳定命令形态，具体输出以实际环境为准。

```bash
# 内容装配一致性（TARGET 默认 skill，非法值 exit 2）
make content TARGET=skill
make content TARGET=omp
make content TARGET=dsh

# OMP 独立包：生成到本地 staging，从目录安装
make pack-omp
omp install ./build/pack/omp/staging

# DSH Host-only 探针包：生成到 build/pack/dsh
make pack-dsh

# 文档与全量回归
make docs
make test
make typecheck

# DSH Host 入口类型检查（独立 gate，需已存在的隔离 rc.4 install）
make typecheck-host INSTALL_DIR=<isolated-rc4-install-dir>
```

`index.ts` / `loader-check.ts` import `@deepseek-ai/*`，不在任何仓库 tsconfig 内，因此 `tsc --noEmit` 与 `tsc -p adapters/dsh/tsconfig.json` 都不检查 Host 入口。Host 入口由独立脚本对着真实的隔离 rc.4 install 检查（`adapters/dsh/tsconfig.host.json` + `adapters/dsh/typecheck-host.ts`），属于单独 gate，不属于仓库的 typecheck（`make typecheck`）。实测：指向已存在的隔离 install 时 exit 0；指向没有 install 的仓库根时 exit 2 并明确报错。

构建 API 契约：`build(target)` 只在内存组装并返回 `{target, files, manifest}`，`files[].content` 供打包器写入自己的 staging root；`write(target)` 只覆盖获准文件；`check(target)` 比较产物与磁盘并报告漂移。打包器不读取默认 staging 路径，避免陈旧产物泄漏。

## 4. 已知安装器偏差（O-1）

安装器把技能写入通用 `agent/` 目标时会改写 frontmatter 并丢失 `disable-model-invocation`。逐字节核对以 `.agents/skills/ensemble` 副本为准；该偏差不表示技能正文源有误，但通用目标副本不可作为“正文完全保留”的证据。OMP 包内的三个角色文件逐字打包，角色语义与包内 `ensemble_state` 工具一致。

## 5. 未验门槛（均保持未完成）

- profile 启动已有**有界诊断证据**：rc.4 上三种 profile 形态符合预期（含 app 行消费 `--help` 并结束、无 app 行时启动后静默等待）。早期 `--profile` 超时/卡死的根因是组合缺少 app/startup 行，而非 Loader 不可用。该结论只说明诊断成立，不等于完整交互或模型请求可用。
- 执行世界隔离已有**有界证据**：rc.4 容器内 confine+spawn 探针按预期；但容器内 confinement 只描述执行该命令的环境（共享 Host kernel），不等于 Host/进程/文件坐标的隔离已验证。
- 仍未验：外部 Git 与档案写、授权与绑定看板、领域工具、模型选型、Client/GUI、完整交互会话与真实模型请求。
- OMP 未验：registry 发布、live profile 安装、交互式会话 UI 呈现、旧 `omp install github:vcup/skills` 入口的真实迁移流程。
- 远端 `vcup/skills` 未发布/未验；纯 skill 的 `npx skills@latest add vcup/skills` Git 入口保留，本地安装证据不延伸到远端。
- GitHub 工作流未在 GitHub 实跑；工作树 `check skill` 一致不等于 CI 已运行。
- rc.4 是唯一设计与类型 gate 基线。
- **类型面实验观察（不是门）**：用 rc.5 自带的公开发布 tsc 在隔离 install 内编译 Host 入口，0 error，注入的类型错误能被抓到 → rc.5 类型面实验通过；正式 `typecheck-host` 仍 pin rc.4。
- **Loader 观察**：以包树复制形态在 rc.5 下运行 44 项，全部通过；此形态不是标准安装。
- **标准安装（当时观测，probe 0.1.0）**：向 rc.5 标准 `npm install` 探针包被 peer 求解拒绝（ERESOLVE），强制安装会移除 21 个 peer 包 → 当时的 P1 结论是不扩大支持范围。此条保留历史时态；当前支持集合与 probe 0.3.0 的声明见 [版本支持与升级](../UPGRADING.md)，不得以本条否定后续经完整矩阵取得的结论。
- P1 出口仍是“技术探针，不是协调功能完成”：[ROADMAP 阶段表](../../ROADMAP.md#4-从设计闭合到交付的阶段)与 §5 的 D/C/R 覆盖均不因本轮工作树产物而批量标记完成。
- DSH 不提供 `verify`/`check` 子命令：`bundle-manifest.json` 是打包时生成的产物清单，不是对已产出 tgz 的校验输入。重跑 `make pack-dsh` 会覆盖并重新生成 staging 与 tgz，不提供对已发布 tgz 的篡改检测或签名校验；这是明确的能力边界，属后续能力，不是本轮交付要求。
- DSH Host 入口类型检查需要一个已存在的隔离 rc.4 install；在没有该 install 的环境里这条 gate 不可运行，因此不能把“双 tsc 通过”表述为“DSH 全部类型已检”。
- 两个包的独立复核结论为**通过**；收尾时提出的两项条件均已关闭（OMP 包内 README 安装命令已修正并复核；DSH 不新增 verify 能力，已在上条记录为明确能力边界）。复核通过不代表 P1 出口或产品验收完成。
