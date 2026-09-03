/**
 * DSH Obsidian Sync Plugin
 * 自动将 DSH 对话内容同步到 Obsidian 知识库
 */

import fs from 'fs'
import path from 'path'

// 默认配置
const DEFAULT_CONFIG = {
  vaultPath: process.env.OBSIDIAN_VAULT_PATH || 'D:/DSH/workspace/knowledge-base',
  autoSync: true,
  syncOnTurnEnd: true,
  readBeforeTurn: true,
  maxRelatedNotes: 3,
  tagKeywords: [
    '知识库', 'obsidian', 'ai', 'deepseek', '插件', '安装',
    'python', 'node', 'cordis', '自动化', '同步', 'npm',
    'github', 'release', '发布', '代码', '编程'
  ]
}

/**
 * 搜索 Obsidian 知识库
 */
export function searchKnowledgeBase(topic, limit = 3) {
  const results = []
  const vaultPath = DEFAULT_CONFIG.vaultPath
  
  function searchDir(dir) {
    if (!fs.existsSync(dir)) return
    
    const files = fs.readdirSync(dir, { withFileTypes: true })
    for (const file of files) {
      if (file.isFile() && file.name.endsWith('.md')) {
        try {
          const filePath = path.join(dir, file.name)
          const content = fs.readFileSync(filePath, 'utf-8')
          
          if (content.includes(topic)) {
            results.push({
              file: file.name,
              path: path.relative(vaultPath, filePath),
              preview: content.substring(0, 400)
            })
          }
        } catch (e) { /* skip */ }
      } else if (file.isDirectory() && !file.name.startsWith('.')) {
        searchDir(path.join(dir, file.name))
      }
    }
  }
  
  searchDir(vaultPath)
  return results.slice(0, limit)
}

/**
 * 同步会话到 Obsidian
 */
export function syncSession(sessionId, summary, tags = []) {
  const vaultPath = DEFAULT_CONFIG.vaultPath
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
  
  const outputDir = path.join(vaultPath, '01-Daily', monthDir)
  fs.mkdirSync(outputDir, { recursive: true })
  
  const outputFile = path.join(outputDir, `${dateStr}-DSH-${safeId}.md`)
  fs.writeFileSync(outputFile, content, 'utf-8')
  
  return { success: true, file: outputFile, session_id: sessionId }
}

/**
 * 提取关键词
 */
export function extractKeywords(text, keywords) {
  const found = []
  const textLower = text.toLowerCase()
  for (const kw of keywords) {
    if (textLower.includes(kw.toLowerCase()) && !found.includes(kw)) {
      found.push(kw)
    }
  }
  return found
}

/**
 * 生成会话摘要
 */
export function generateSummary(messages) {
  const userMsgs = messages.filter(m => m.role === 'user')
  const assistantMsgs = messages.filter(m => m.role === 'assistant')
  
  const lastUser = userMsgs[userMsgs.length - 1]?.content?.substring(0, 200) || ''
  const lastAssistant = assistantMsgs[assistantMsgs.length - 1]?.content?.substring(0, 500) || ''
  
  return {
    text: `用户: ${lastUser}\n\n助手: ${lastAssistant}`,
    userQuery: lastUser,
    assistantResponse: lastAssistant
  }
}

/**
 * 提取标签
 */
export function extractTags(messages, tagKeywords) {
  const allText = messages.map(m => m.content || '').join(' ')
  const tags = []
  
  for (const kw of tagKeywords) {
    if (allText.includes(kw) && !tags.includes(kw)) {
      tags.push(kw)
    }
  }
  
  return tags
}

// 导出主函数
export default {
  searchKnowledgeBase,
  syncSession,
  extractKeywords,
  generateSummary,
  extractTags,
  config: DEFAULT_CONFIG
}
