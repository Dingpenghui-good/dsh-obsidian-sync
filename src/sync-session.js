#!/usr/bin/env node
/**
 * 同步 DSH 会话到 Obsidian
 * 用法: node sync-session.js --session=<id> --summary=<text> --tags=<a,b,c>
 */

const fs = require('fs')
const path = require('path')

const VAULT_PATH = process.env.VAULT_PATH || 'D:/DSH/workspace/knowledge-base'

const args = process.argv.slice(2)
let sessionId = 'unknown'
let summary = ''
let tags = []

for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--session=')) sessionId = args[i].substring(10)
  else if (args[i].startsWith('--summary=')) summary = args[i].substring(10)
  else if (args[i].startsWith('--tags=')) tags = args[i].substring(7).split(',').filter(Boolean)
}

const dateStr = new Date().toISOString().substring(0, 10)
const monthDir = dateStr.substring(0, 7)
const safeId = sessionId.replace(/[^a-zA-Z0-9]/g, '-').substring(0, 12)

const content = `---
type: session-summary
date: "${dateStr}"
month: "${monthDir}"
created: "${new Date().toISOString()}"
session_id: "${sessionId}"
conversationCount: 1
messageCount: 1
toolCalls: 0
errors: 0
topics: [${tags.map(t => `"${t}"`).join(', ')}]
---

# DSH 会话摘要 ${dateStr}

> **会话ID**: ${sessionId}
> **创建时间**: ${new Date().toLocaleString('zh-CN')}
> **主题标签**: ${tags.join(', ') || '通用'}

## 会话内容

${summary || '（暂无摘要）'}

## 自动整理标记

- [x] 已提取主题标签
- [x] 已创建主题关联
- [x] 待归档检查

---
*由 DSH Obsidian Sync 插件自动同步*
`

const outputDir = path.join(VAULT_PATH, '01-Daily', monthDir)
fs.mkdirSync(outputDir, { recursive: true })
const outputFile = path.join(outputDir, `${dateStr}-DSH-${safeId}.md`)
fs.writeFileSync(outputFile, content, 'utf-8')

console.log(JSON.stringify({ success: true, file: outputFile, session_id: sessionId }))
