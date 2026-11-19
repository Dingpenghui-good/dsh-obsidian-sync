# v4.1.0 — 会话结束自动归档

## 新功能

### `autoArchive`：会话结束自动归档（默认开启）

无需再手动调用 `obsidian_sync_session`。插件现在会自动把已结束的 DSH 会话写成 `04-Archive/` 笔记，并挂到 `DSH-会话归档-索引.md` 的按日期段，随后 `git commit + push`。

两条触发通道：

1. **静默归档**：每次 `agent/turn-stopping` 重置该会话的计时器；超过 `autoArchiveIdleMs`（默认 15 分钟）没有任何新轮次 → 归档一次。
2. **释放归档**：`session/disposed`（切换 / 关闭 / 进程退出前的会话释放）→ 立即尽力归档一次。

## 归档内容

- **标题**：优先会话 header 的标题，其次首条用户消息首行。
- **摘要**：有 LLM 路由时调用当前模型（或 `autoArchiveProvider` / `autoArchiveModel` 指定）生成 `{title, summary, tags}`；路由不可用或调用失败时降级为启发式摘要（用户需求 + 轮数 + 最后一条助手结论）。
- **raw_log**：尽力推算 `~/.dsh/sessions/.../session.v4.jsonl.zstd` 绝对路径写入落款。
- **幂等**：同一会话内容指纹（用户输入条数 + 总长度 + 最后助手文本长度）未变则跳过；写盘层还会按「摘要未变」二次去重。

## 新的设置项（`dsh-obsidian-sync` 命名空间）

| 键 | 默认 | 说明 |
|---|---|---|
| `autoArchive` | `true` | 会话结束自动归档总开关 |
| `autoArchiveIdleMs` | `900000` | 静默多久视为会话结束（60000..3600000） |
| `autoArchiveMinUserMessages` | `1` | 至少多少条用户消息才归档（跳过空会话） |
| `autoArchiveProvider` | `""` | 摘要所用 provider，留空跟随当前路由 |
| `autoArchiveModel` | `""` | 摘要所用 model，留空跟随当前路由 |

## 行为边界

- **子代理会话不单独归档**（`delegationDepth > 0`），避免一次团队任务生成几十篇碎片笔记。
- **空会话不归档**（用户消息数 < `autoArchiveMinUserMessages`）。
- 身份测试类噪声（"你是谁"等短会话）仍走 `isNoiseSession` 过滤。
- 自动归档失败静默降级，不影响对话；失败原因写入 `ctx.logger.warn`。

## 升级注意

- 升级后需要**完全退出并重启 DSH**（profile 中的插件不会热更新代码）。
- 设置项可在插件详情页看到；保存后经 volatile HMR 即时生效，无需重启（仅代码升级需要重启）。
