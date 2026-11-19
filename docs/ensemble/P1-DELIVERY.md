# P1 有界探针交付记录（维护者用）

本记录只汇总 P1 有界探针在**工作树**中的实现与验证状态，面向维护者与独立验收者；它不是发布说明，也不把探针等同于 [P1 总出口](../../ROADMAP.md#p1先证明选用的原生能力能够组合)。设计基线固定为 DSH `0.2.2-rc.4`（提交 `3f321d32bfe382212a8ed8785c1d47a5a300aa23`）；当前运行 host 为 rc.5，与 rc.4 基线的兼容性**未验**，`engines.dsh` 仍锁 rc.4，不放宽。三路径分发约定见[分发设计](DISTRIBUTION.md)，验收向量见[实施准备](IMPLEMENTATION.md#6-代表输入与预期结果)。

## 1. 状态口径

下表三态分别报告，互不推导：

- **工作树已实现/已生成/已测试**：产物存在于当前工作树，相关测试与检查已在可复现命令下通过，并已有非作者复核。
- **已提交**：产物是否已进入产品 Git 提交。本轮所有行为**否**。
- **已发布/远端可安装**：产物是否已进入 registry 或可从远端安装。本轮所有行为**否**。

凡只有作者自报、未经 task-6/task-9 非作者复核的结论，均标 **未独立复核** 并保持设计文档原时态，不据此改写“工作树已实现”。本文不写 provider/model 清单、环境具体配置、操作流水、私有或临时绝对路径。

## 2. 交付状态总表

| 切片 | 工作树已实现/已生成/已测试 | 已提交 | 已发布/远端可安装 | 对应 D/C/R | 独立复核 |
|---|---|---|---|---|---|
| 确定性三路径内容装配（`content/ensemble/**`、`scripts/build-ensemble.ts`） | 是：`build/check/write(target)`，target 仅 skill/omp/dsh；显式文件清单、SHA256 清单、链接闭包、symlink/越界防护、drift 检查；`skills/ensemble/`（6 文件）由 `check skill` 判定 up to date；OMP/DSH 产物仅在忽略的 `build/ensemble/{omp,dsh}/` | 否 | 否 | D01/C01/C15/R18 | p1-scout 独立验收通过 |
| 纯 skill 本地安装回读 | 是：真实 `npx skills@1.9.0` 本地安装本地仓成功，`.agents/skills/ensemble` 与产物逐字节一致 | 否 | 否（远端 `vcup/skills` 未验） | C01/C15/R18 | 纳入内容独立验收 |
| OMP 独立安装根（`scripts/pack-omp.ts`、`adapters/omp/package/`） | 是：staging 14 文件；tgz `build/pack/omp/vcup-skills-0.2.0.tgz`；包身份保留 `@vcup/skills@0.2.0`；真实发现器回读三角色 frontmatter、`autoloadSkills:["ensemble"]`、三个技能与注册工具 `ensemble_state` | 否 | 否 | C01/C15/R18 | task-9 独立复核通过 |
| DSH Host-only 探针（`adapters/dsh/**`、`scripts/pack-dsh.ts`） | 是：tgz `build/pack/dsh/dsh-ensemble-probe-0.1.0.tgz`；隔离安装 rc.4 发布依赖后经公开 Loader 运行检查 44 PASS / 0 FAIL；固定参考枚举读回、未知名/路径拒绝、输出预算、插件释放 | 否 | 否 | D10/C12/C15/R18 | task-9 独立复核通过（44 PASS/0 FAIL 已由非作者在独立隔离目录重跑） |
| GitHub Actions 内容一致性工作流（`.github/workflows/ensemble-content.yml`） | 是（仅工作树定义）：只做 `check skill` 与 builder 测试 | 否 | 否（未在 GitHub 实跑） | C15 | 未独立复核 |

## 3. 稳定可复现命令

全部命令在仓库根执行；输出位置为仓内忽略目录，可由命令重现，不是私有或临时路径。

```bash
# 内容装配一致性
bun scripts/build-ensemble.ts check skill
bun scripts/build-ensemble.ts check omp
bun scripts/build-ensemble.ts check dsh

# OMP 独立包：生成到本地 staging，从目录安装
bun scripts/pack-omp.ts
omp install ./build/pack/omp/staging

# DSH Host-only 探针包：生成到 build/pack/dsh
bun scripts/pack-dsh.ts

# 文档与全量回归
python3 scripts/check-docs.py
bun test
tsc --noEmit

# DSH Host 入口类型检查（独立 gate，需已存在的隔离 rc.4 install）
bun adapters/dsh/typecheck-host.ts <isolated-rc4-install-dir>
```

`index.ts` / `loader-check.ts` import `@deepseek-ai/*`，不在任何仓库 tsconfig 内，因此 `tsc --noEmit` 与 `tsc -p adapters/dsh/tsconfig.json` 都不检查 Host 入口。Host 入口由独立脚本对着真实的隔离 rc.4 install 检查（`adapters/dsh/tsconfig.host.json` + `adapters/dsh/typecheck-host.ts`），属于单独 gate，不属于 `bun run typecheck`。实测：指向已存在的隔离 install 时 exit 0；指向没有 install 的仓库根时 exit 2 并明确报错。

构建 API 契约：`build(target)` 只在内存组装并返回 `{target, files, manifest}`，`files[].content` 供打包器写入自己的 staging root；`write(target)` 只覆盖获准文件；`check(target)` 比较产物与磁盘并报告漂移。打包器不读取默认 staging 路径，避免陈旧产物泄漏。

## 4. 已知安装器偏差（O-1）

安装器把技能写入通用 `agent/` 目标时会改写 frontmatter 并丢失 `disable-model-invocation`。逐字节核对以 `.agents/skills/ensemble` 副本为准；该偏差不表示技能正文源有误，但通用目标副本不可作为“正文完全保留”的证据。OMP 包内的三个角色文件逐字打包，角色语义与包内 `ensemble_state` 工具一致。

## 5. 未验门槛（均保持未完成）

- DSH 只有帮助 Loader 探针：`dsh --profile probe` 与 `--help` 均超时，profile 启动未验；不得把帮助 Loader 等价于完整 profile 启动。
- 未验：真实 Host/执行世界隔离、外部 Git 与档案写、授权与绑定看板、领域工具、模型选型、Client/GUI。
- OMP 未验：registry 发布、live profile 安装、交互式会话 UI 呈现、旧 `omp install github:vcup/skills` 入口的真实迁移流程。
- 远端 `vcup/skills` 未发布/未验；纯 skill 的 `npx skills@latest add vcup/skills` Git 入口保留，本地安装证据不延伸到远端。
- GitHub 工作流未在 GitHub 实跑；工作树 `check skill` 一致不等于 CI 已运行。
- rc.5 运行 host 与 rc.4 基线兼容性未验；不据此放宽 `engines.dsh` 或声明支持 rc.5。
- P1 出口仍是“技术探针，不是协调功能完成”：[ROADMAP 阶段表](../../ROADMAP.md#4-从设计闭合到交付的阶段)与 §5 的 D/C/R 覆盖均不因本轮工作树产物而批量标记完成。
- DSH 不提供 `verify`/`check` 子命令：`bundle-manifest.json` 是打包时生成的产物清单，不是对已产出 tgz 的校验输入。重跑 `bun scripts/pack-dsh.ts` 会覆盖并重新生成 staging 与 tgz，不提供对已发布 tgz 的篡改检测或签名校验；这是明确的能力边界，属后续能力，不是本轮交付要求。
- DSH Host 入口类型检查需要一个已存在的隔离 rc.4 install；在没有该 install 的环境里这条 gate 不可运行，因此不能把“双 tsc 通过”表述为“DSH 全部类型已检”。
- task-9 对两个包的独立复核结论为**通过**；收尾时提出的两项条件均已关闭（OMP 包内 README 安装命令已修正并复核；DSH 不新增 verify 能力，已在上条记录为明确能力边界）。复核通过不代表 P1 出口或产品验收完成。
