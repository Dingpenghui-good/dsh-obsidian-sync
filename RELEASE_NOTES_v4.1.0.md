# v4.1.0 — 会话结束自动归档 + 索引写入修复

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

## 修复：索引新日期段被追加到文件末尾

`updateIndexFile` 原先把新日期段直接追加到文件末尾（或插到并不存在的 `## 主题分类` 前），导致 `DSH-会话归档-索引.md` 里 `## 未归档清单` 之后堆积出一串倒序错乱的日期段。

现在抽出纯函数 `applyIndexEntry`（`src/index-core.ts`）：

- **当天段落已存在** → 同 shortId 原地替换，否则追加到段末；
- **当天段落不存在** → 按日期倒序插入「## 按日期（倒序）」段内的正确位置，绝不越过尾部二级标题；
- 顺带修复三处边界：同 shortId 替换后多出空行、CRLF 索引混入裸 LF、空内容产生前导空行；
- 老索引（无「## 按日期（倒序）」段）仍回退插到 `## 主题分类` 之前。

新增回归测试 `test/index-entry.test.mjs`（11 用例），已纳入 `npm test`。同时补 `tsconfig` 的 `noEmit`，使 `pnpm typecheck` 可用（此前报 TS5096 直接失败）。

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
- **历史乱序索引不会自愈**：本次修复只保证此后新增的日期段自动归位；已堆积在 `## 未归档清单` 之后的旧段落需要一次手工重排。
