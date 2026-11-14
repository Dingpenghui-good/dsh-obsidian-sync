# v4.0.2 — 文档修正（README 重写为纯 UTF-8）

> `@dingpenghui/dsh-obsidian-sync@4.0.2`

**本版无代码改动**，只重写 README，让 npm 包页面与 GitHub 仓库显示正确的文档。

## 为什么发这个版本

4.0.1 已修复 `obsidian_brief` 在 Windows 上失效的真实 bug，但 README 内容还停留在
4.0.0，且之前有几处表述错误。npm 上已发布版本的 README **无法覆盖**，因此用
patch 版本重新发布，让 npm 包页面同步。

## README 的具体改动

| 项目 | 修复 |
|---|---|
| 版本信息 | 补上「当前版本 4.0.2」与 DSH 兼容区间 |
| `obsidian_search` 输出 | 补 `displayPath` 字段，并说明 4.0.1 起 `file` 返回 **vault 相对路径**（打通 search→read_note 闭环） |
| `obsidian_brief` | 补 4.0.1 的 Windows 路径 bug 说明与修复指引 |
| jsonc 代码块 | 修正 `obsidian_search` 示例未闭合的问题 |
| `BUILD-PROVENANCE.md` 路径 | 原写 `docs/BUILD-PROVENANCE.md`，实际在仓库根目录 |
| 重装提示 | 补充「残留 junction 会让 pnpm 以 EPERM 失败，需先删 profile 里的链接（别删源目录）」 |
| 目录约定 | 新增一节：源码只放 `dsh-obsidian-sync-plugin/`，不要拷进 vault |
| 测试命令 | 去掉不需要的 `--experimental-strip-types`（测试文件是 `.mjs`） |
| 编码 | 全文 **UTF-8 无 BOM、统一 LF**（校验通过，无 U+FFFD 替换字符） |

## 关于「README 是 GBK 乱码」的澄清

排查时一度以为 README 是 GBK 混编码，实际**它一直是合法 UTF-8**。
之前看到的乱码是 PowerShell `Get-Content` 按系统 ANSI（GBK/936）解码 UTF-8 文件造成的
显示假象 —— 相同现象也出现在读 `package.json` 时（`ConvertFrom-Json` 报语法错误）。

验证方式（PowerShell）：

```powershell
$bytes = [IO.File]::ReadAllBytes('README.md')
[Text.UTF8Encoding]::new($false, $true).GetString($bytes)   # 严格 UTF-8，失败会抛异常
```

## 工作区整理

同期把 vault（`dsh-obsidian-sync/`，知识库仓库）里误拷进去的插件工程副本清掉了：

- 删除重复的 `src/`（11 个文件，与插件工程一致）
- 删除 `lib/`、`test/`、`cordis.patch.yml`、`tsconfig.json`、`tsdown.config.ts`、
  `README.plugin.md`、`DESIGN-brain-retrieval-v4.md`、`RELEASE_NOTES_v3.4.x/4.0.0.md`
- 恢复被插件清单覆盖的 vault 自己的 `package.json`（`AI-Knowledge-Base`）
- 补充 vault 的 `.gitignore`（忽略 `node_modules/`、`.npmrc` 等）

现在 `src/` 只保留在 `dsh-obsidian-sync-plugin/` 一处，避免两份代码造成
「改了不生效」的错觉。

> ⚠️ 注意：vault 仓库与插件仓库配置了**同一个 GitHub 远端**。
> vault 本地有 6 个知识库提交从未推送到远端（远端 main 是插件历史），
> 本次未推送 vault，避免污染插件仓库历史。
