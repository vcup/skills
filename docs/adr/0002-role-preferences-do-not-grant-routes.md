# 角色偏好应用不改变原生模型授权

环境历史的应用目标是 Ensemble 在 DSH Settings 中注册的 `rolePreferences` 实例：owner 以原生 revision 做 CAS 更新并读回，推荐器消费已应用偏好，项目历史分别记录 requested、created 和 actual 的选型证据。模型执行仍使用原生显式选型字段，并接受当前 Session 的路由授权检查。

没有选择把偏好写入原生子代理的 `agentOptions` 默认值：这些默认值属于 trusted 配置，可能绕过对模型提交参数的路由检查，也会影响共享配置的其它 Session。这个决定保留环境偏好的独立历史、应用与故障对账，代价是“应用偏好”不会自动切换 Lead 或既有成员的模型；界面必须明确显示设置实例与各 Session 的可用性诊断，不能宣称二者是一件事。
