# DSH Obsidian Sync V2

> DSH Cordis 插件：按需搜索 Obsidian 知识库 + 按 vault 既有 PARA 规则归档 DSH 会话。

## 设计理念（零 token / 高性能）

- **纯模型 Tool 按需调用**，不注入系统提示词——默认 token 成本 ≈ 两个 Tool 的 schema（约 200 token），零注入
- **进程内 fs 服务**（`resolve`/`stat`/`listDir`/`readText`/`writeText`），不起子进程
- **倒排索引 + 定时增量重建**（dirty 标记，跳过 `.obsidian`/`.git`），搜索不重读全文
- **按 session 幂等 upsert**：摘要未变则跳过写盘
- 笔记写入 `vault/04-Archive/`，**自动挂 `DSH-会话归档-索引.md` 的按日期段**
- 落款支持 `raw_log` 原始日志指针，贴合 vault 既有笔记的可追溯惯例

## 提供的 Tool

### `obsidian.search`

```json
{ "topic": "obsidian 安装", "limit": 3 }
```

返回最多 5 条匹配（文件相对路径、命中片段、得分）。按需调用，平时零开销。

### `obsidian.sync_session`

```json
{
  "session_id": "完整 UUID",
  "title": "会话主题标题",
  "summary": "会话结论/摘要（200-800 字）",
  "tags": ["dsh", "obsidian"],
  "related": ["2026-09-11-a9095879-示例笔记"],
  "raw_log": "C:\\Users\\你\\.dsh\\sessions\\--工作区--\\session-<id>\\session.v3.jsonl.zstd"
}
```

按 vault PARA 结构写 `04-Archive/YYYY-MM-DD-<8位短ID>-<标题>.md`，自动挂索引；摘要未变则跳过。

## 安装

```bash
cd dsh-obsidian-sync-v2
pnpm install
pnpm run build
dsh plugin --profile web add .
```

安装后 `dsh.plugin.bundles` 自动追加 `dsh-obsidian-sync-v2`，包自带 `cordis.yml` 作为 bundle patch 挂载，**无需手动改 profile 的 `cordis.patch.yml`**。重启 DSH 生效。

## 配置

包 `cordis.yml` 默认：

```yaml
- id: obsidian-sync-v2
  name: 'dsh-obsidian-sync-v2'
  config:
    vaultPath: 'E:/dsh-workspace/obsidian-vault'
    searchEnabled: true
    indexRefreshMs: 60000
```

改 `vaultPath` 指向你的实际 Obsidian vault。也可不写任何 config，走内置默认。

运行时优先级：行 `config` > `settings` 命名空间 `obsidian-sync` > 内置默认。

## 卸载

```bash
dsh plugin --profile web remove dsh-obsidian-sync-v2
```

## 许可证

MIT

---

# DSH Obsidian Sync V2

> DSH Cordis plugin: on-demand Obsidian knowledge-base search + DSH session archiving that follows your vault's existing PARA rules.

## Design goals (zero token / high performance)

- **Model tools invoked on demand only**, no system-prompt injection — default token cost ≈ the two tools' schemas (~200 tokens), zero injection
- **In-process fs service** (`resolve`/`stat`/`listDir`/`readText`/`writeText`), no child processes
- **Inverted index + periodic incremental rebuild** (dirty flag, skips `.obsidian`/`.git`); search never re-reads full files
- **Per-session idempotent upsert**: if the summary is unchanged, the write is skipped
- Notes are written to `vault/04-Archive/` and **automatically linked into the date section of the session archive index**
- The footer supports a `raw_log` pointer, matching the traceability convention of existing vault notes

## Tools provided

### `obsidian.search`

```json
{ "topic": "obsidian install", "limit": 3 }
```

Returns up to 5 matches (relative file path, hit snippet, score). On-demand; zero cost when not called.

### `obsidian.sync_session`

```json
{
  "session_id": "full UUID",
  "title": "Session title",
  "summary": "Session conclusion / summary (200-800 chars)",
  "tags": ["dsh", "obsidian"],
  "related": ["2026-09-11-a9095879-example-note"],
  "raw_log": "C:\\Users\\you\\.dsh\\sessions\\--workspace--\\session-<id>\\session.v3.jsonl.zstd"
}
```

Writes `04-Archive/YYYY-MM-DD-<8-char-short-id>-<title>.md` following your vault's PARA layout, and updates the index automatically; unchanged summaries are skipped.

## Install

```bash
cd dsh-obsidian-sync-v2
pnpm install
pnpm run build
dsh plugin --profile web add .
```

After install, `dsh.plugin.bundles` automatically picks up `dsh-obsidian-sync-v2`; the bundled `cordis.yml` is mounted as the bundle patch, so **no manual edits to the profile's `cordis.patch.yml` are needed**. Restart DSH to apply.

## Configuration

The bundled `cordis.yml` default:

```yaml
- id: obsidian-sync-v2
  name: 'dsh-obsidian-sync-v2'
  config:
    vaultPath: 'E:/dsh-workspace/obsidian-vault'
    searchEnabled: true
    indexRefreshMs: 60000
```

Point `vaultPath` at your actual Obsidian vault. You can also omit all config and use the built-in defaults.

Runtime precedence: row `config` > `settings` namespace `obsidian-sync` > built-in default.

## Uninstall

```bash
dsh plugin --profile web remove dsh-obsidian-sync-v2
```

## License

MIT
