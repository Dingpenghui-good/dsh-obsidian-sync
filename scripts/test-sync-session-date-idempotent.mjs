// 回归测试：obsidian_sync_session 的 `date` 参数与摘要幂等比较
// 运行前需先构建：pnpm build && node scripts/test-sync-session-date-idempotent.mjs
// 用内存 fs 模拟 vault，直接驱动构建产物 lib/index.js。
import assert from 'node:assert'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.cwd()
const mod = await import(pathToFileURL(path.join(root, 'lib', 'index.js')).href)

const VAULT = 'X:/fake-vault'
const files = new Map()

function makeCtx() {
  return {
    get: (name) => (name === 'settings'
      ? { describe: () => [{ ns: 'dsh-obsidian-sync', value: { vaultPath: VAULT, searchEnabled: false } }] }
      : undefined),
    fs: {
      async resolve(p) { return { targetKey: p, displayPath: p } },
      async stat(p) {
        const key = typeof p === 'string' ? p : p.targetKey
        if (!files.has(key)) throw new Error('ENOENT')
        return undefined
      },
      async readText(p) {
        const key = typeof p === 'string' ? p : p.targetKey
        if (!files.has(key)) throw new Error('ENOENT')
        return files.get(key)
      },
      async listDir(dir) {
        const raw = typeof dir === 'string' ? dir : String(dir?.targetKey ?? dir?.displayPath ?? '')
        const prefix = raw.replace(/\/$/, '') + '/'
        return [...files.keys()]
          .filter(k => k.startsWith(prefix) && !k.slice(prefix.length).includes('/'))
          .map(k => ({ type: 'file', name: k.slice(prefix.length) }))
      },
      async writeText(p, text) {
        const key = typeof p === 'string' ? p : p.targetKey
        files.set(key, String(text))
      },
    },
    tools: { register(def) { registered.push(def); return () => {} } },
    effect(fn) { /* 定时 effect 不执行，避免测试进程被 interval 挂住 */ },
    on() {}, emit() {},
  }
}

const registered = []
mod.apply(makeCtx(), {})
const tool = registered.find(t => t.name === 'obsidian_sync_session')
assert.ok(tool, 'obsidian_sync_session tool found')

const SUMMARY = '这是用于验证幂等比较的较长摘要文本，包含需求、过程与交付物，长度足够绕过噪声会话过滤。'
const base = { session_id: 'a9095879-df9e-4fbf-ad5d-bee10f641363', title: '会话归档日期与幂等验证' }

const entryPath = '04-Archive/2026-09-11-a9095879-会话归档日期与幂等验证.md'
const indexPath = VAULT + '/DSH-会话归档-索引.md'

// 真实 vault 中索引文件本就存在（updateIndexFile 对缺失索引文件返回 false，不应重写）
function seedIndex() {
  files.set(indexPath, '# DSH 会话归档索引\n\n## 按日期\n\n### 2026-09-10\n\n- [[04-Archive/2026-09-10-aaaaaaaa-旧会话.md|旧会话]] (2026-09-10, aaaaaaaa)\n\n## 主题分类\n')
}
seedIndex()

// 1) 显式 date → 文件名前缀 / frontmatter / 基本信息表 / 索引行 全部采用该日期
const r1 = await tool.execute({ ...base, summary: SUMMARY, date: '2026-09-11' })
assert.equal(r1.skipped, false, 'first run should write')
assert.equal(r1.file, entryPath, 'file path uses passed date, got ' + r1.file)
const doc1 = files.get(VAULT + '/' + entryPath)
assert.ok(doc1.includes('date: 2026-09-11'), 'frontmatter date uses passed date')
assert.ok(doc1.includes('| **日期** | 2026-09-11 |'), 'basic info table date uses passed date')
const idx1 = files.get(indexPath)
assert.ok(idx1 !== undefined, 'index file should exist')
assert.ok(idx1.includes('### 2026-09-11'), 'index day section uses passed date')
assert.ok(idx1.includes('(2026-09-11, a9095879-df9e-4fbf-ad5d-bee10f641363)'), 'index line date uses passed date')

// 2) 再次调用、摘要未变 → skipped（幂等比较修复点）
const r2 = await tool.execute({ ...base, summary: SUMMARY, date: '2026-09-11' })
assert.equal(r2.skipped, true, 'second run with same summary should skip, got ' + JSON.stringify(r2))
assert.equal(r2.reason, 'summary unchanged', 'skip reason')
assert.equal(r2.index, 'unchanged', 'index unchanged on skip')

// 3) 摘要变化 → 重写
const r3 = await tool.execute({ ...base, summary: SUMMARY + '（追加一段新结论）', date: '2026-09-11' })
assert.equal(r3.skipped, false, 'changed summary should rewrite')

// 4) 传非法 date → 回退当前 UTC 日期（回退后同样具备幂等性）
const today = new Date().toISOString().slice(0, 10)
for (const bad of ['2026/09/11', '20260911', '2026-9-1', 'abc', '']) {
  const r4a = await tool.execute({ ...base, summary: SUMMARY, date: bad })
  assert.ok(r4a.file.startsWith('04-Archive/' + today + '-'), 'bad date "' + bad + '" falls back to UTC today, got ' + r4a.file)
  const r4b = await tool.execute({ ...base, summary: SUMMARY, date: bad })
  assert.equal(r4b.skipped, true, 'bad date "' + bad + '" still idempotent after fallback')
}

// 5) 不传 date → 与旧行为一致（文件名用 UTC 当天）
files.clear()
seedIndex()
const r5 = await tool.execute({ ...base, summary: SUMMARY })
assert.ok(r5.file.startsWith('04-Archive/' + today + '-'), 'omitted date keeps old behavior, got ' + r5.file)
const doc5 = files.get(VAULT + '/' + r5.file)
assert.ok(doc5.includes('date: ' + today), 'omitted date frontmatter uses today')
assert.ok(doc5.includes('| **日期** | ' + today + ' |'), 'omitted date table uses today')

// 6) 带 ## 关联 区块的文档仍能幂等跳过（真实场景）
files.clear()
seedIndex()
const relatedArgs = { ...base, summary: SUMMARY, date: '2026-09-11', related: ['2026-09-11-a9095879-会话归档日期与幂等验证.md'] }
const r6a = await tool.execute(relatedArgs)
assert.equal(r6a.skipped, false, 'related run writes')
const doc6 = files.get(VAULT + '/' + r6a.file)
assert.ok(doc6.includes('## 关联'), 'related section present')
const r6b = await tool.execute(relatedArgs)
assert.equal(r6b.skipped, true, 'doc with ## 关联 section must still skip, got ' + JSON.stringify(r6b))

// 7) 带 raw_log 落款时同样幂等
const rawArgs = { ...base, summary: SUMMARY, date: '2026-09-11', raw_log: '~/.dsh/sessions/x/session.v3.jsonl.zstd' }
files.clear()
seedIndex()
await tool.execute(rawArgs)
const r7 = await tool.execute(rawArgs)
assert.equal(r7.skipped, true, 'doc with raw_log logline must still skip, got ' + JSON.stringify(r7))

// 8) 噪声会话仍被过滤（不因新增 date 参数而回归）
const noise = await tool.execute({ session_id: 'aaaaaaaa', title: '你是谁', summary: '短摘要', date: '2026-09-11' })
assert.equal(noise.skipped, true, 'noise session still filtered')
assert.equal(noise.noise, true, 'noise flag present')

// 9) 带 "session-" 前缀的完整 ID 归一化为 uuid 前 8 位（而非 "sessionX"），
//    且与裸 uuid 落同一幂等键（date + shortId 相同）
files.clear()
seedIndex()
const rA = await tool.execute({ session_id: 'session-9f10d319-c1d3-4629-bf6d-a360d6729221', title: '前缀归一化验证', summary: SUMMARY, date: '2026-09-11' })
assert.equal(rA.skipped, false, 'prefixed ID first write')
assert.equal(rA.file, '04-Archive/2026-09-11-9f10d319-前缀归一化验证.md', 'shortId strips session- prefix, got ' + rA.file)
const rB = await tool.execute({ session_id: '9f10d319-c1d3-4629-bf6d-a360d6729221', title: '前缀归一化验证', summary: SUMMARY, date: '2026-09-11' })
assert.equal(rB.file, '04-Archive/2026-09-11-9f10d319-前缀归一化验证.md', 'bare uuid maps to same file as prefixed form')
assert.equal(rB.skipped, true, 'prefixed and bare uuid share the same idempotent key')

console.log('PASS: date 参数（文件名/frontmatter/表格/索引）与摘要幂等比较全部通过')
console.log('  file:', r1.file)
console.log('  index line:', idx1.split('\n').find(l => l.includes('a9095879')))
console.log('  prefixed → shortId:', rA.file)
process.exit(0)
