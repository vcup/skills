# 新版 DSH 适配的源码基线

核验日期：2026-11-17，Asia/Shanghai。用户已选定仅面向新版 DSH 设计 ensemble 适配，并要求先复制挂载源码再拉取上游。本次没有实施或安装插件，也没有替换当前 GUI 运行构建。

## 副本与上游

- 挂载原件：[deepseek-harness](/home/vcup/projects/deepseek-harness)，保持只读、未修改。
- 可写副本：[deepseek-harness](../../.scratch/extra-src/deepseek-harness)，通过 `git clone --no-hardlinks` 从原件复制已提交源码与 Git 历史；不复制 `node_modules`、未跟踪的会话修复目录，不依赖共享 Git 对象。
- 副本 origin：`https://github.com/deepseek-ai/deepseek-harness.git`。
- 官方默认分支：`refs/heads/master`，由 `git ls-remote --symref origin HEAD` 确认。
- `git pull --ff-only origin master` 成功，输出 `Already up to date.`；本次没有新增上游提交，不存在虚构的版本差异。
- 本地 `HEAD`、`origin/master`、`FETCH_HEAD` 与远端 `HEAD` 均为 `39163dd30f703a79079e2d2446545cff3c453738`。
- 顶部提交：`Merge pull request #8422 from deepseek-harness/worktree-sync-release-dsh-0.2.2-rc.3-to-master`，提交时间 `2026-11-13T15:37:50+08:00`。
- [根 manifest](../../.scratch/extra-src/deepseek-harness/package.json#L1-L10) 标识 `0.2.2-rc.3`。本设计以确切源码提交为准；用户所说“尚未发布的新版”不被替换成 npm 最新稳定版，也不凭版本字符串推断 npm/产品分发状态。

可写检查通过：源码 manifest 与 Git 目录均可写；副本 `git status --short` 为空。工作区 [忽略规则](../../.gitignore#L2) 新增 `/.scratch/extra-src/`，避免嵌套源码和构建产物进入当前包的提交或分发。已有用户暂存修改保持原样。

## 可复核命令

以下均已成功执行；clone 和 pull 的后台作业已收集，退出码均为 0。嵌套副本不是独立注册的 DSH workspace，故命令从本工作区根运行，使用 `git -C` 指定副本。

```sh
git clone --no-hardlinks /home/vcup/projects/deepseek-harness /home/vcup/projects/vcup-skills/.scratch/extra-src/deepseek-harness
git -C .scratch/extra-src/deepseek-harness remote set-url origin https://github.com/deepseek-ai/deepseek-harness.git
git -C .scratch/extra-src/deepseek-harness pull --ff-only origin master
git -C .scratch/extra-src/deepseek-harness rev-parse HEAD origin/master FETCH_HEAD
git -C .scratch/extra-src/deepseek-harness ls-remote --symref origin HEAD
git -C .scratch/extra-src/deepseek-harness rev-list --count 39163dd30f703a79079e2d2446545cff3c453738..HEAD
git -C .scratch/extra-src/deepseek-harness status --short
```

## 设计范围的变化

源码相对上一轮基线没有变化，**支持目标发生了收敛**：

- 目标是普通 subagent 树、原生逐子代理选型、可选 Team 任务板；不再包含旧 `spawn_teammate`、旧 roster 或配置转交补丁。
- 当前会话的旧工具只用于执行本次研究，不决定待开发插件的 Interface；本次研究也不构成新版运行验收。
- 原生能力按源码直接复用；专用插件明确实现用户技能入口、包内参考资料访问和既有 Markdown 看板。
- 不新增执行器、模型路由器、成员注册表、任务镜像或 invocation 持久化格式。
- 新主线见 [综合设计](DESIGN.md)、[执行适配](EXECUTION-ADAPTER-DESIGN.md)、[新版执行复核](NEW-DSH-EXECUTION-RESEARCH.md)和[新版看板复核](NEW-DSH-PLUGIN-RESEARCH.md)。历史研究留作证据，不再是当前支持矩阵。
