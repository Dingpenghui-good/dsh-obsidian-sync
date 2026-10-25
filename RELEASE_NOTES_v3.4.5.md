# @dingpenghui/dsh-obsidian-sync v3.4.5

新增归档日期回填能力，并修复「摘要未变则跳过」长期失效的缺陷。

## 新增

### `obsidian_sync_session` 支持可选参数 `date`

- 传 `date: "YYYY-MM-DD"` 时，该日期同时决定四件事：**文件名前缀**、frontmatter `date`、正文「基本信息」表格日期、以及归档索引挂载的日期段。
- 省略该参数，或值不符合 `YYYY-MM-DD` 格式时，回退为运行当天（UTC），行为与旧版本完全一致。
- 典型用途：**回填历史会话**。此前插件只能把历史会话归档到"同步执行日"，导致索引日期与实际发生日不符。

```jsonc
{
  "session_id": "0c0c4b4e-361d-440b-ab58-948a2ee43a26",
  "title": "Proton VPN 单机逐步诊断",
  "summary": "…",
  "date": "2026-09-12"
}
```

## 修复

### 「摘要未变则跳过」实际从未生效

- **现象**：同一会话重复同步时，每次都返回 `skipped: false` 并重写笔记、追加一次 git 提交，幂等只在文件名层面成立。
- **根因**：判断逻辑把 `## 摘要` 之后的**全部剩余内容**与本次摘要比较，而这段内容还包含 `## 关联` 区块与 `> 📎 原始日志` 落款，因此永不相等。
- **修复**：比较范围截取到摘要区块末尾 —— 取「下一个 `## ` 标题」「`\n---\n` 分隔线」「空行起的 `> ` 落款行」三者中最早出现的位置；三者都不存在时截到文末。
- 边界细节：只判断前两种边界是不够的 —— 未传 `related` 时摘要后直接跟落款，仍会带上落款，故补入第三种边界。

## 测试

- 新增回归脚本 `scripts/test-sync-session-date-idempotent.mjs`（8 组断言）：显式 `date` 的四处落点、同摘要跳过、摘要变化重写、5 种非法 `date` 回退且仍幂等、不传 `date` 保持旧行为、含 `## 关联` / 含落款 / 噪声过滤三种场景。
- `pnpm typecheck`、`pnpm build`、`node smoke-test.mjs`、`node client-smoke-test.mjs`、`node contract-test.mjs`（ALL PASS）、`scripts/test-tokenize.mjs`、`scripts/test-idempotent.mjs`、`scripts/test-index-boundary.mjs` 全部通过。

## 升级

```bash
dsh plugin --profile web add @dingpenghui/dsh-obsidian-sync@3.4.5
```

---

# @dingpenghui/dsh-obsidian-sync v3.4.5

Adds backdated archiving and fixes a long-broken "skip when summary unchanged" check.

## Added

### Optional `date` parameter for `obsidian_sync_session`

- When `date: "YYYY-MM-DD"` is supplied it drives four things at once: the **filename prefix**, the frontmatter `date`, the date row in the note body, and the day section in the archive index.
- Omit it (or pass a malformed value) and it falls back to today's UTC date — identical to previous behaviour.
- Typical use: **backfilling historical sessions**. Previously every archived session landed on the day the sync ran, so index dates did not match when the session actually happened.

## Fixed

### "Skip when summary unchanged" never actually triggered

- **Symptom**: re-syncing the same session always returned `skipped: false`, rewrote the note and produced another git commit; idempotency only held at the filename level.
- **Root cause**: the comparison took *everything* after `## 摘要` and compared it with the incoming summary — but that span also contains the `## 关联` section and the `> 📎 原始日志` footer, so it never matched.
- **Fix**: the comparison now stops at the end of the summary block — the earliest of the next `## ` heading, a `\n---\n` separator, or a blank-line-prefixed `> ` footer line; falling back to end-of-file when none exist.
- Boundary note: handling only the first two cases was insufficient — without `related`, the footer follows the summary directly and was still included, hence the third boundary.

## Tests

- New regression script `scripts/test-sync-session-date-idempotent.mjs` (8 assertion groups): the four places `date` lands, skip on unchanged summary, rewrite on changed summary, five malformed dates falling back while staying idempotent, omitted `date` keeping old behaviour, and the `## 关联` / footer / noise-filter scenarios.
- `pnpm typecheck`, `pnpm build`, `node smoke-test.mjs`, `node client-smoke-test.mjs`, `node contract-test.mjs` (ALL PASS), `scripts/test-tokenize.mjs`, `scripts/test-idempotent.mjs`, `scripts/test-index-boundary.mjs` all pass.

## Upgrade

```bash
dsh plugin --profile web add @dingpenghui/dsh-obsidian-sync@3.4.5
```
