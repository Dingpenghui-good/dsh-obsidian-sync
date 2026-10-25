# DSH Obsidian Sync

> DSH Cordis 插件：活大脑 —— 每轮对话前检索并注入知识库记忆 + 每轮结束实时沉淀 + 按需搜索 + 幂等归档 DSH 会话

## 设计理念

- **v4.0.0 活大脑**：每轮首步自动检索知识库并把相关记忆注入本轮（`brainRetrieval`，默认开）；
  每轮结束把结论实时沉淀回知识库（`brainAutoUpdate`，默认关，启用会产生额外小模型调用）
- **零注入的按需检索**：`obsidian_search` / `obsidian_brief` / `obsidian_read_note` 仍按需调用
- 进程内 fs 服务（resolve/stat/listDir/readText/writeText），不起子进程
- 倒排索引 + 60s 增量重建（dirty 标记，跳过 .obsidian/.git）
- CJK bigram 分词 + 全文索引 + IDF 加权排序
- 按 `date + shortId` 幂等 upsert（标题变更不影响去重）
- 笔记写入 `vault/04-Archive/`，YAML frontmatter + Obsidian 原生标签
- 自动挂 `DSH-会话归档-索引.md` 的按日期段（双井号边界 + 同 shortId 去重）

## 活大脑（v4.0.0）

```
用户输入 → agent/inbox/inserted → 检索（沉淀层×2 / 流水层×1 / 标题加成）
        → agent.steer(记忆消息, source.kind='obsidian-brain') → 模型带记忆推理
轮结束   → agent/turn-stopping  → 小模型蒸馏 → 04-Archive 流水 + 02/03/05 摘要行 + 06-Brain/recent.md
```

- 注入是一条 **user 角色**消息，来源标记为 `obsidian-brain`：可审计、可区分，不污染系统提示、不破坏前缀缓存
- 注入用 `steer`（跟随已排队的输入，**不会额外唤醒**模型）；同一轮只注入一次，用户连发会合并
- 全程有上限与超时（`brainRetrievalMaxChars` / `brainRetrievalTimeoutMs`），任何失败都降级为"不注入"，不阻塞对话
- 实时沉淀幂等（同轮只写一次）、去噪（寒暄/纯确认跳过）、按小节大小滚动（`brainLogCapBytes`）
- 详见 [RELEASE_NOTES_v4.0.0.md](RELEASE_NOTES_v4.0.0.md)

## 提供的 Tool

> **命名约束**：工具名只使用 `^[a-zA-Z0-9_-]+$` 允许的字符（下划线，**不含点号**）。v3.4.2 及更早版本曾用 `obsidian.search` 这类点号命名，会被 provider 在请求校验阶段拒绝（HTTP 400，整个会话无法对话），请勿改回。

### `obsidian_brain`（v4.0.0 新增）

查看活大脑状态与手动检索。

```jsonc
// 输入（query 可省略，仅返回状态）
{ "query": "知识库注入的超时和上限" }

// 输出
{
  "ok": true,
  "query": "知识库注入的超时和上限",
  "hits": [{ "path": "02-Projects/dsh-obsidian-sync.md", "score": 8.42, "tier": "distilled", "matched": ["知识", "注入", "超时"] }],
  "injectText": "【知识库记忆 · 每轮自动检索】…",
  "stats": { "injected": 12, "distilled": 3, "callsUsed": 3, "skippedNoHit": 4 },
  "vaultPath": "E:/dsh-workspace/obsidian-vault"
}
```

### `obsidian_search`

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
```

### `obsidian_brief`

开机简报：提炼页 top 3 + 最近 3 条归档 + `03-Areas/决策习惯与偏好.md` 全文。

### `obsidian_read_note`

按 vault 相对路径读取笔记（解析 YAML frontmatter + 正文），补全"搜索 → 阅读"。

### `obsidian_sync_session`

把会话幂等归档进 `04-Archive/`（`date + shortId` 幂等键，摘要未变跳过）并挂到索引页。

## 安装

### 方式一：npm

```bash
dsh plugin --profile desktop add @dingpenghui/dsh-obsidian-sync
```

### 方式二：从本地路径安装（开发调试）

```bash
cd dsh-obsidian-sync
pnpm install
pnpm build
dsh plugin --profile desktop add .
```

> 插件宿主代码不参与 HMR：升级/替换后需**完全退出并重启 DSH**。

## 配置

在 profile 的 `cordis.patch.yml` 中（或插件详情页，保存后热生效）：

```yaml
- id: dsh-obsidian-sync
  name: '@dingpenghui/dsh-obsidian-sync'
  config:
    vaultPath: 'E:/dsh-workspace/obsidian-vault'
    searchEnabled: true
    indexRefreshMs: 60000
    brainRetrieval: true          # 每轮检索注入（默认开）
    brainRetrievalTopK: 3
    brainRetrievalMaxChars: 1800
    brainRetrievalMinScore: 2.5
    brainRetrievalTimeoutMs: 1500
    brainAutoUpdate: false        # 实时沉淀（默认关，会额外调用小模型）
    brainMemoryProvider: ''       # 留空 = 跟随当前 agent 路由
    brainMemoryModel: ''
    brainMemoryApiKeyEnv: ''      # 凭证引用名（不落密钥）
    brainMemoryMaxCalls: 20
    brainPinnedBudget: 2
    brainAutoCommit: false
    brainLogCapBytes: 200000
```

所有字段均有默认值，可不配置直接挂载。

## 开发

```bash
pnpm install      # 首次：安装 tsdown / typescript / lightningcss 等构建工具
pnpm build        # tsdown 构建 → lib/（lib/ 随包发布，必须提交）
pnpm typecheck    # tsc --noEmit
```

`lib/` 的出处与「如何验证 lib 与 src 一致」见 [docs/BUILD-PROVENANCE.md](docs/BUILD-PROVENANCE.md)。
本机离线环境怎么准备 node_modules（含已知坑）也记在那份文档里。

### 测试

```bash
node --experimental-strip-types test/brain-retrieval.test.mjs   # 纯函数回归（16 项）
node --experimental-strip-types test/brain-runtime.test.mjs     # 运行级冒烟（注入/去重/沉淀/幂等）
```

第二个测试用真实的 `@deepseek-ai/dsh-session` 与 `@deepseek-ai/dsh-llm` 构造会话，
驱动真实的 `src/brain.ts`，只把 LLM 换成固定输出的假实现 —— 不需要拉起 DSH 就能验证全链路。

## 发布

```bash
# 1. 确认产物与源码一致
pnpm build && git diff --stat -- lib

# 2. 版本号 + 提交
#    注意 package.json 的 version 与 RELEASE_NOTES_v<version>.md 必须对齐
npm version patch --no-git-tag-version
git commit -am "chore: release vX.Y.Z"

# 3. 打 tag 并发布（npm 需要本地 .npmrc 里的 token）
git push origin main --tags
npm publish
```

`.npmrc` 不入版本库（含 npm access token），发布前需本地配置。
`prepublishOnly` 未挂检查脚本；发布前请手动跑一遍上面两套测试。

## 许可证

MIT

---

**作者**: Dingpenghui-good
**仓库**: https://github.com/Dingpenghui-good/dsh-obsidian-sync
