# v4.0.1 — 修复 `obsidian_brief` 在 Windows 上完全失效

> `@dingpenghui/dsh-obsidian-sync@4.0.1`

## 症状

`obsidian_brief` 在 Windows 上**永远返回空结果**，即使 vault 里存在大量笔记：

```json
{"ok": true, "task": "检查 DSH 插件", "distilled": [], "recent": [], "userProfile": ""}
```

同一时刻 `obsidian_search` / `obsidian_brain` 都能正常命中——所以这个失效很隐蔽，
只有对比两个工具的返回才能发现。

## 根因

索引条目的 `displayPath` 在 Windows 上是**反斜杠绝对路径**：

```
E:\dsh-workspace\obsidian-vault\02-Projects\dsh-obsidian-sync.md
```

但 `obsidian_brief` 的分层判定用的是**正斜杠前缀**做 `includes()`：

```ts
entry.displayPath.includes('02-Projects/')   // 永远为 false
entry.displayPath.includes('04-Archive/')    // 永远为 false
e.displayPath === '03-Areas/决策习惯与偏好.md'  // 永远为 false
```

于是三个区块（提炼页 / 最近归档 / 偏好页）全部落空。

同类问题还波及两处静默定时任务：

- **每日 22:00 复盘**：`todayFiles` 汇总永远为空 → 直接 `return`，从不产出
- **周日 22:30 周报**：`weekFiles` 汇总永远为空 → 同样静默跳过

`obsidian_brain` 之所以正常，是因为 v4.0.0 引入它时专门写了 `vaultRelativePath()`
把绝对路径归一化成相对路径；**旧的 `brief` 链路漏了这一步**。

## 修复

索引改为以 **vault 相对路径（正斜杠）** 为 key，并在条目里同时保留
`relPath`（分层判定用）与 `displayPath`（仅供 `fs.resolve` 与追溯）：

```ts
interface IndexEntry {
  relPath: string      // 02-Projects/xxx.md —— 分层判定与对外展示
  displayPath: string  // E:\...\02-Projects\xxx.md —— 仅供 fs.resolve
  // ...
}
```

所有目录判定改用 `relPath`（`startsWith` 判前缀，比原来的 `includes` 更严谨）：

| 位置 | 修复 |
|---|---|
| `topDistilled()` | `relPath.startsWith('02-Projects/')` 等 |
| `recentArchives()` | `relPath.startsWith('04-Archive/')` |
| 偏好页判定 | `index.has('03-Areas/决策习惯与偏好.md')` |
| 每日 22:00 复盘 | `todayFiles` 用 `relPath` |
| 周日 22:30 周报 | `weekFiles` 用 `relPath` |
| 外部变更感知 | `index.has(sub + '/' + name)`，不再线性扫全表 |

## 附带修复：搜索→阅读闭环断开

`obsidian_search` 的 `file` 字段原先返回**绝对路径**，而 `obsidian_read_note`
按**相对路径**解析 —— 直接把搜索结果喂给阅读工具会失败。现在：

- `file` 返回 vault 相对路径（可直接传给 `obsidian_read_note`）
- 另给 `displayPath` 保留绝对路径，便于追溯

实测闭环已通：

```
obsidian_search {topic:"DSH 插件"}
  → file: "02-Projects/dsh-conversation-language.md"
obsidian_read_note {path:"02-Projects/dsh-conversation-language.md"}
  → { ok: true, frontmatter: {...}, body: "..." }
```

## 工程修复

| 项目 | 修复 |
|---|---|
| `pnpm typecheck` 失败（21 个 TS 错误） | 补 `dsh-client-store` / `ui-primitives` / `ui-slots` / `ui-plugin-manager` / `ui-settings` 到 devDependencies，全部对齐到 `0.2.2-rc.3` |
| `dsh.client.inject` 无效声明 | 移除 `ui-primitives` / `ui-slots` / `client-store`（0.2.2 中它们是 Web shell 的静态平台模块，不是可加载 Loader 行），只保留 locale / ui-renderer / ui-settings / ui-plugin-manager |
| 发布产物来源错位 | 已提交的 `lib/client.js` 里 CSS 路径指向 `dsh-obsidian-sync\src`（vault 副本目录）。本次从 `dsh-obsidian-sync-plugin` 重新构建，产物路径与工程目录一致 |

## 验证

| 检查 | 结果 |
|---|---|
| `pnpm typecheck` | exit 0（此前 exit 2） |
| `tsdown` 构建 | 通过 |
| `test/brain-retrieval.test.mjs` | 16/16 |
| `test/brain-runtime.test.mjs` | 全通过 |
| 客户端 bundle 运行时依赖 | 仅 `ui-primitives` + `jsx-runtime`，均为平台 seed 模块 |
| 装到 DSH `0.2.2-rc.3` 实测 | 行 `include:dsh-obsidian-sync` active |
| `obsidian_brief` 实测 | 提炼页 3 条 + 最近归档 3 条 + 偏好页全文，**全部恢复** |
| `obsidian_search` → `obsidian_read_note` | 相对路径闭环通过 |

DSH 0.2.2 兼容性本身没有问题：`ctx.get('settings').describe()`、`ctx.fs`、`ctx.tools.register`、
`agent/inbox/inserted`、`agent/turn-stopping`、`Session.surface.nodes`、`eventAt`、
`deriveMessages`、`agents.list()`、`llm.stream()`、`credentials.resolve()` 全部存在且签名一致。
本插件不使用 `system-prompt/assemble`，因此不受 0.2.2 移除 `tools` 的影响。

## 升级步骤

```bash
dsh plugin --profile <profile> remove @dingpenghui/dsh-obsidian-sync
dsh plugin --profile <profile> add @dingpenghui/dsh-obsidian-sync@4.0.1
```
