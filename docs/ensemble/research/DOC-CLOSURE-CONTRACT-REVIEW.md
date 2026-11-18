# P0 文档契约独立复核

> **历史审阅记录。** 本文保留当次工作树的发现、反例和建议；文档发现已通过[文档补齐与审阅处分](<DOC-CLOSURE-RESULT.md>)处理，不代表当前待办。正文中的“当前”“尚未”及行号均为当时定位，不代表现行产品状态或当前行号；链接指向正式维护文件。文档闭合不等于实现或运行验收；迁存的静态校验不补作历史产品验收。

结论：不通过；以下五项有具体执行后果，需在实现前闭合。仅复核四份设计文档，未运行 DSH、未改产品文件。

1. **Learning 的 invocation 归属与封闭输入冲突。** [COMMANDS:3–7](<../COMMANDS.md>) 要求 payload 明示 invocation 且拒绝未列字段，但 [COMMANDS:62–73](<../COMMANDS.md>) 多项动作不列 invocation_id。
   - 最小输入：同 project 有 I1/Lead A、I2/Lead B，A 调 `organize_domain(change=create{title,questions,audience,overview})`。无目标对象可反查 invocation；补 invocation_id 又是未知字段。
   - 后果：合法建域无可接受请求，或执行器擅自用某个 invocation 的 Lead 身份写项目对象；同类问题也影响 publication/lesson 的授权定位。
   - 建议文本：“所有 ensemble_learn payload 必含 invocation_id，表中省略此公共字段；L/M 身份按该 invocation 核验，review 权限仍按 proposal exact revision 核验。domain 为项目对象，其组织动作使用该调用 invocation 的当前 Lead 身份，不得猜测当前 invocation。”

2. **frame 的 coverage/criteria 无合法原子修订入口。** [COMMANDS:24](<../COMMANDS.md>) 规定 key 仅请求内引用且每项 required coverage 必有关联 criterion；[COMMANDS:33](<../COMMANDS.md>) 却只许一次完整替换一个 group。
   - 最小输入：已有 required A/cA，要增加 required B/cB。先改 coverage 会使 B 暂无 criterion；先改 criteria 会引用不存在的 B。单独 criteria 请求中的 coverage_keys 也没有同请求 coverage 定义可解析。
   - 后果：不能直接完成合法范围增加；借“先 optional 再 required”绕行仍未解决请求内 key，且依赖未约定的中间状态。
   - 建议文本：“amend_frame 增加 requirements {coverage,criteria} 原子变体，统一验证最终图；创建项用本请求 key，既存项用稳定 id，criteria 可引用 coverage_ids。不得要求以暂时失效状态分次提交。”

3. **可只挑旧 passed 完成，绕过同版本已知失败。** [COMMANDS:53–54](<../COMMANDS.md>)、[COMMANDS:86](<../COMMANDS.md>) 仅要求存在 passed，未定义相冲突执行结果的当前效力；[DOMAIN-MODEL:36](<../DOMAIN-MODEL.md>) 却要求关键检查失败时拒绝完成。
   - 最小输入：关键 C、候选 V、必要覆盖已有 accepted；记录 E1(V,C,passed)，再记录同 method/action 的 E2(V,C,failed)，无 challenge；completion 仅列 E1。
   - 后果：按 COMMANDS 的存在性检查可 completed，按 DOMAIN-MODEL 必须拒绝；遗漏 E2 即可隐藏当前已知失败。
   - 建议文本：“完成校验扫描当前候选/criterion 的全部适用检查，不只扫描 completion 所列引用；相冲突的 failed/partial 必须有显式后继复验或有证据的适用性处分，否则拒绝完成。completion 必须引用该冲突的解除链。”

4. **反例会把 retired lesson 自动复活。** [COMMANDS:71](<../COMMANDS.md>) 要求任何持权成员提交 contradicts 后先标 contested；[COMMANDS:83](<../COMMANDS.md>) 却不允许 retired→contested，恢复须新内容版本再评估。
   - 最小输入：lesson L@1 已 retired；应用者提交该 exact revision 的 application(result=contradicts)。
   - 后果：接受并自动 contested 违反退役终态，还可再 decision(supported) 绕过新版本要求；拒绝则丢失本应允许保留的应用反证。
   - 建议文本：“所有版本可追加 application；只有当前且非 retired 的版本可被反例自动标 contested。retired 与旧版本只追加证据，不改变当前状态；恢复仍须新 proposed 版本及重新评估。”

5. **旧备份恢复为同一 archive 后，会遗失已确认提交及其重试收据。** [OPERATIONS:55](<../OPERATIONS.md>) 规定收据终身保留、清历史必须新 archive id；[OPERATIONS:100–102](<../OPERATIONS.md>) 却只验证备份自身完整/旧主停写，未约束候选 head 与最后权威 head 的关系。
   - 最小输入：H1 完整备份；随后 H2 已成功提交 operation k；停写旧主，把 H1 恢复、重新授权并按同 archive id 切换注册；查询 k 返回 not_found；按当前 revision 重试 k 可成为新动作，sequence 也从旧分叉点重新开始。
   - 后果：H2 的业务事实和幂等保证从活动档案消失；停写、完整备份校验和重发 grant 均不能证明没有回退。
   - 建议文本：“同 archive id 的恢复候选必须保留经交接证据确认的最后权威 head、全部历史及 receipts；不能证明或候选落后时只读。owner 明确接受回退则按破坏性恢复生成新 archive id，记录丢失区间/未知提交，旧重试键不得用于新库。”

已核对但不另列缺陷：review 阻断跨版本保留且须提出者/owner 指派替代者逐项解除；仓锁串行 revoke/commit、响应前 epoch 复核；正常单主历史按 sequence 首次出现定位 receipt；导入 stale_inventory、partial 例外、原始字节/碰撞重命名与历史保留。上述正常路径不消除第五项的旧 head 恢复问题。
