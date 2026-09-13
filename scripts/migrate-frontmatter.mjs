/**
 * 一次性迁移脚本：给 04-Archive/ 下所有缺少 YAML frontmatter 的笔记补上。
 *
 * 用法: node scripts/migrate-frontmatter.mjs
 *
 * 从每篇笔记的「基本信息」表格中提取：
 *   - 日期 (YYYY-MM-DD)
 *   - 会话ID (完整 session-xxx)
 *   - 分类 (标签)
 * 生成最小 frontmatter，插入文件顶部。
 * 已有 frontmatter 的文件跳过。
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const archiveDir = 'E:/dsh-workspace/obsidian-vault/04-Archive'

/** 从笔记内容提取字段。 */
function extractMeta(text) {
  const dateMatch = text.match(/\|\s*\*\*日期\*\*\s*\|\s*(\d{4}-\d{2}-\d{2})/)
  const idMatch = text.match(/\|\s*\*\*会话ID\*\*\s*\|\s*`([^`]+)`/)
  const tagMatch = text.match(/\|\s*\*\*分类\*\*\s*\|\s*(.+?)\s*\|/)
  const statusMatch = text.match(/\|\s*\*\*状态\*\*\s*\|\s*(.+?)\s*\|/)

  const date = dateMatch ? dateMatch[1] : ''
  const fullId = idMatch ? idMatch[1] : ''
  // 短 ID：去掉 session- 前缀，取前 8 位 hex
  const shortId = fullId.replace(/^session-/, '').replace(/[^a-z0-9]/g, '').slice(0, 8)

  // 标签：从分类行提取反引号代码块
  let tags = []
  if (tagMatch) {
    const raw = tagMatch[1]
    tags = [...raw.matchAll(/`([^`]+)`/g)].map(m => m[1])
    if (tags.length === 0) tags = [raw.trim()]
  }

  // 状态
  let status = 'archived'
  if (statusMatch) {
    const s = statusMatch[1]
    if (s.includes('进行中') || s.includes('滚动')) status = 'in_progress'
    else if (s.includes('部分完成')) status = 'partial'
    else if (s.includes('未完成')) status = 'incomplete'
  }

  return { date, shortId, fullId, tags, status }
}

/** 生成 YAML frontmatter 块。 */
function buildFrontmatter(meta) {
  const lines = ['---']
  if (meta.shortId) lines.push(`session_id: ${meta.shortId}`)
  if (meta.fullId) lines.push(`full_session_id: ${meta.fullId}`)
  if (meta.date) lines.push(`date: ${meta.date}`)
  if (meta.status) lines.push(`status: ${meta.status}`)
  if (meta.tags.length > 0) lines.push(`tags: [${meta.tags.join(', ')}]`)
  lines.push('---')
  lines.push('')
  return lines.join('\n')
}

// 主逻辑
let migrated = 0
let skipped = 0

for (const name of readdirSync(archiveDir)) {
  if (!name.endsWith('.md')) continue
  const path = join(archiveDir, name)
  const text = readFileSync(path, 'utf-8')

  if (text.startsWith('---')) {
    skipped++
    continue
  }

  const meta = extractMeta(text)
  const fm = buildFrontmatter(meta)
  writeFileSync(path, fm + text, 'utf-8')
  migrated++
  console.log(`+ ${name}  [${meta.date} ${meta.shortId}]`)
}

console.log(`\n完成: 迁移 ${migrated} 篇, 跳过 ${skipped} 篇（已有 frontmatter）`)
