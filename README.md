# DSH Obsidian Sync

> DSH Cordis 插件：按需搜索 Obsidian 知识库 + 幂等归档 DSH 会话（零 token 注入）

## 设计理念

纯模型 Tool 按需调用，不注入系统提示词。默认 token 成本 ≈ 两个 Tool 的 schema。

- 进程内 fs 服务（resolve/stat/listDir/readText/writeText），不起子进程
- 倒排索引 + 60s 增量重建（dirty 标记，跳过 .obsidian/.git）
- CJK bigram 分词 + 全文索引 + IDF 加权排序
- 按 `date + shortId` 幂等 upsert（标题变更不影响去重）
- 笔记写入 `vault/04-Archive/`，YAML frontmatter + Obsidian 原生标签
- 自动挂 `DSH-会话归档-索引.md` 的按日期段（双井号边界 + 同 shortId 去重）

## 提供的 Tool

### `obsidian.search`

在 Obsidian 知识库中按关键词搜索相关笔记（中英文均可，自动 CJK bigram 分词）。

```jsonc
// 输入
{ "topic": "npm 发布 2FA", "limit": 5 }

// 输出
{
  "ok": true,
  "matches": [
    {
      "file": "04-Archive/2026-09-12-3073121a-…",
      "score": 3.72,
      "snippet": "npm 2FA 查证：TOTP 已废弃…",
      "size": 4200,
      "matchReason": "npm pub lis 2fa"
    }
  ],
  "count": 5,
  "vaultPath": "E:/dsh-workspace/obsidian-vault"
}
```

### `obsidian.sync_session`

把当前 DSH 会话幂等归档到 Obsidian vault。摘要未变则跳过写盘。

```jsonc
// 输入
{
  "session_id": "session-76bb60db-bdde-…",
  "title": "dsh-obsidian-sync 优化与发布",
  "summary": "用户需求：… 过程要点：… 交付物：…",
  "tags": ["dsh", "obsidian", "cordis"],
  "related": ["2026-09-11-a9095879-dsh-tool-agnes工具升级与发布.md"],
  "raw_log": "C:\\Users\\dph\\.dsh\\sessions\\--E-dsh-workspace--\\session-76bb60db\\session.v3.jsonl.zstd"
}

// 输出（首次写入）
{ "ok": true, "skipped": false, "file": "04-Archive/2026-09-13-76bb60db-…", "index": "updated" }

// 输出（摘要未变）
{ "ok": true, "skipped": true, "file": "…", "reason": "summary unchanged", "index": "unchanged" }

// 输出（失败）
{ "ok": false, "error": "writeText failed: …", "code": "WRITE_FAILED" }
```

## 安装

### 方式一：从 npm 安装（推荐）

```bash
dsh plugin --profile web add dsh-obsidian-sync
```

### 方式二：从本地路径安装

```bash
cd dsh-obsidian-sync
pnpm install
pnpm build
dsh plugin --profile web add .
```

## 配置

在 `~/.dsh/settings.yaml` 中添加：

```yaml
obsidian-sync:
  vaultPath: "E:/dsh-workspace/obsidian-vault"
  searchEnabled: true
  indexRefreshMs: 60000
```

所有字段均有默认值，可不配置直接挂载。

## 开发

```bash
pnpm install
pnpm build        # tsdown 构建 → lib/
pnpm typecheck    # tsc 类型检查
```

### 测试

```bash
node scripts/test-tokenize.mjs      # CJK bigram 分词
node scripts/test-idempotent.mjs    # 幂等 upsert
node scripts/test-index-boundary.mjs # 索引边界插入
```

## 发布

```bash
pnpm version patch
git push origin main --tags
npm publish
```

`.npmrc` 不入版本库（含 npm access token），发布前需本地配置。

## 许可证

MIT

---

**作者**: Dingpenghui-good  
**仓库**: https://github.com/Dingpenghui-good/dsh-obsidian-sync
