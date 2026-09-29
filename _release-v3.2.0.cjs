#!/usr/bin/env node
const { execSync } = require('child_process')

const cred = execSync('git credential fill', {
  input: 'url=https://github.com\n',
  encoding: 'utf-8',
  timeout: 30000,
}).toString()
const token = (cred.split('\n').find(l => l.startsWith('password=')) || '').replace('password=', '').trim()
if (token.length < 20) { console.error('token too short'); process.exit(1) }

const body = [
'## 简体中文',
'',
'修复"插件详情页不包含任何组件"：让详情页前提条件设置真正生效（v3.1.0 的客户端半未被宿主加载的根因修复）。',
'',
'### 根因',
'v3.1.0 的 `package.json` 声明 `dsh.bundle.patch: ./cordis.yml`，而 `cordis.yml` 是**说明性文档**（注释 + 非 loader 形态的条目）。',
'宿主从该文件派生 settings 命名空间行 `dsh-obsidian-sync` 时失败 → 行未服务 → 客户端 whileServed 门控永远不触发',
'→ `plugins.bundle.config` / `plugins.row.config` 槽位未注册 → 详情页继续显示"不包含任何组件"。',
'',
'### 修复',
'- **bundle patch 对齐**：`dsh.bundle.patch` 现指向 `cordis.patch.yml`（与 `dsh-conversation-language` 相同的 loader patch 文档：',
'  顶层 `- id: dsh-obsidian-sync` + 完整 `config`，重述行拥有的全部 key——patch 整体替换行配置）',
'- **安装方式对齐**：通过 `pnpm add dsh-obsidian-sync@file:...` 正式安装到 web profile（取代此前手动拷入 node_modules 的非正式路径）',
'- **cordis.yml 降为参考文档**：保留 4 个 Tool 与使用前提的说明性索引，不再被宿主加载',
'- **宿主半 apply() 对齐**：去掉 config 参数，改经 `settings.describe()` 读命名空间行值（volatile HMR 保存即重建）',
'- **冒烟测试增强**：验证 bundle patch 形态（loader 文档 + 全 key 重述 + `dsh.bundle.patch` 指针对齐）',
'',
'### 验证',
'`tsc --noEmit` PASS · tsdown 双构建 PASS · 宿主冒烟 PASS（含 patch 形态）· 客户端冒烟 PASS · 契约测试 8/8 PASS · 安装后验证 PASS',
'',
'### 使用前提条件（详情页可设定，保存后无需重启 DSH）',
'1. **vaultPath** —— 必须指向已存在的 Obsidian vault 目录（PARA 结构），错则搜索/归档全失败',
'2. **searchEnabled** —— 是否启用倒排索引搜索（关闭后仅保留 read_note 与 sync_session）',
'3. **indexRefreshMs** —— 索引增量重建间隔（≥5000ms，默认 60000ms）',
'4. **git 自动推送**（隐含前提，页面有说明）：vault 为 git 仓库且有 remote 时归档自动 commit + push',
'',
'---',
'',
'## English',
'',
'Fixes the detail page still showing "This plugin contains no components": the v3.1.0 client half was never mounted by the host (root-cause fix).',
'',
'### Root cause',
'v3.1.0 declared `dsh.bundle.patch: ./cordis.yml`, but `cordis.yml` is a **descriptive doc**, not a loader patch document.',
'The host failed to derive the settings row `dsh-obsidian-sync` → namespace unserved → the client `whileServed` gate never fired',
'→ `plugins.bundle.config` / `plugins.row.config` slots never registered → detail page kept showing "no components".',
'',
'### Fix',
'- **Bundle patch alignment**: `dsh.bundle.patch` now points to `cordis.patch.yml` (same loader patch document shape as `dsh-conversation-language`:',
'  top-level `- id: dsh-obsidian-sync` + full `config`, restating every key the row owns)',
'- **Install alignment**: installed into the web profile via `pnpm add dsh-obsidian-sync@file:...` (replaces the earlier ad-hoc manual copy)',
'- **`cordis.yml` demoted to a reference doc**: keeps the 4-tool index and prerequisite notes, no longer host-loaded',
'- **Host `apply()` alignment**: dropped the config parameter; reads the namespace row via `settings.describe()` (volatile HMR re-mounts on save)',
'- **Enhanced smoke test**: validates bundle patch shape (loader doc + full key restatement + pointer alignment)',
'',
'### Verification',
'`tsc --noEmit` PASS · tsdown dual build PASS · host smoke PASS (incl. patch shape) · client smoke PASS · contract 8/8 PASS · post-install verify PASS',
'',
'### Prerequisites (settable on the detail page; live apply, no DSH restart)',
'1. **vaultPath** — must point to an existing Obsidian vault (PARA structure); a wrong path breaks all search/archiving',
'2. **searchEnabled** — toggle the inverted-index search tools (off leaves only read_note + sync_session)',
'3. **indexRefreshMs** — index refresh interval (min 5000ms, default 60000ms)',
'4. **Git auto-push** (implicit prerequisite, noted on the page): vault as a git repo with a remote enables auto commit + push on archive',
].join('\n')

const payload = JSON.stringify({
  tag_name: 'v3.2.0',
  target_commitish: 'main',
  name: 'v3.2.0 - Detail page prerequisites actually mount',
  body,
})

const https = require('https')
const req = https.request({
  hostname: 'api.github.com',
  path: '/repos/Dingpenghui-good/dsh-obsidian-sync/releases',
  method: 'POST',
  headers: {
    'Authorization': `token ${token}`,
    'Accept': 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'dsh-release-bot',
    'Content-Length': Buffer.byteLength(payload),
  },
  timeout: 30000,
}, (res) => {
  let out = ''
  res.on('data', c => out += c)
  res.on('end', () => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      const parsed = JSON.parse(out)
      console.log('Release created:', parsed.html_url)
    } else {
      console.error('HTTP', res.statusCode, out.slice(0, 800))
      process.exit(1)
    }
  })
})
req.write(payload)
req.end()
