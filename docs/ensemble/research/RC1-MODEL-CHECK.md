# RC1 模型选择快速核验

本文保留 [rc.1 兼容性检查](RC1-BASELINE.md)的定向源码依据。比较正式 rc.1 与 rc.4，不能与旧 master rc.3 开发 snapshot 的端点比较混同；基线区别见 [rc.4 发布核验](RC4-BASELINE.md)。原稿的 tag 源码链接在此固定到核验所得 SHA，不重新查询发布标签。

- 原研究用 `show-ref` 与 `rev-parse refs/tags/dsh-v0.2.2-rc.1^{commit}` 交叉核验正式 tag `dsh-v0.2.2-rc.1`，SHA 为 `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`；仓库 origin 为 `deepseek-ai/deepseek-harness`。[rc.1 commit](https://github.com/deepseek-ai/deepseek-harness/commit/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db)。rc.4 对照固定为 `3f321d32bfe382212a8ed8785c1d47a5a300aa23`。
- rc.1 已支持 `provider`、`model`、`reasoning_effort`，参数名不是 `effort`；provider/model 须成对，但允许仅传 reasoning_effort，并对有效路线执行 Session 授权检查。[rc.1 源码][rc1-model]。
- rc.1 的 standard preset 已为 spawn 型 `subagent` 开启 `modelSelection: true`、`modelDiscovery: true`；fork 型实例未显式开启这两项。rc.4 未改变这些配置。[rc.1 preset][rc1-preset]、[rc.4 preset][rc4-preset]。
- **显式路线省略 effort 的差异**：rc.1 仅在显式路线相对 configured/parent 基线改变且未传 effort 时删除配置 effort；路线不变时保留配置 effort，预检默认还允许继承兼容父路线的 effort。rc.4 任何显式 provider/model 选择若省略 effort，均显式清除 effort，使用所选模型默认值，即使路线不变。[rc.1 源码][rc1-model]、[rc.4 源码][rc4-model]。
- **单独传 effort 的差异**：rc.4 禁止单独传 reasoning_effort，必须同时给 provider/model；rc.1 允许。两版都在无 Session policy 时把显式选择限制到父路线，并非任意 provider/model 均可选。[rc.1 源码][rc1-model]、[rc.4 源码][rc4-model]。
- **全部省略的共同语义**：三项全部省略时，两版 `requestedAgentOptions` 都直接返回 configured；不要把 rc.4 的“显式选路线时采用模型默认 effort”套用于纯继承。[rc.1 源码][rc1-model]、[rc.4 源码][rc4-model]。
- **preset 的其他端点差异**：相对 rc.1，rc.4 有内置技能目录、`tool-subagent-control.config.interrupt: false` 和 `tool-office`；rc.1 无这些条目。此比较不定位具体引入版本。[rc.1 preset][rc1-preset]、[rc.4 preset][rc4-preset]。

原核验方式：只读 Git 标签信息及模型选择、standard preset 两个文件的 `git diff --unified=100`；未读完整 git log、未改产品文件、未安装、未运行测试。这些是静态语义依据，不是实际部署选型成功的证据；当前适配决定见[原生代理接入](../NATIVE-AGENTS.md)。

[rc1-model]: https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/subagent/tool-subagent/src/model-selection.ts
[rc4-model]: https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/packages/subagent/tool-subagent/src/model-selection.ts
[rc1-preset]: https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/bundle/web-app/presets/standard.patch.yml
[rc4-preset]: https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/packages/bundle/web-app/presets/standard.patch.yml
