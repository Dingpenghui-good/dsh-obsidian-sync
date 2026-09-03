#!/usr/bin/env node
/**
 * 搜索 Obsidian 知识库
 * 用法: node search-knowledge.js <topic> [limit]
 */

const fs = require('fs')
const path = require('path')

const VAULT_PATH = process.env.VAULT_PATH || 'D:/DSH/workspace/knowledge-base'
const topic = process.argv[2]
const limit = parseInt(process.argv[3]) || 3

if (!topic) {
  console.error('Usage: node search-knowledge.js <topic> [limit]')
  process.exit(1)
}

function searchDir(dir) {
  const results = []
  if (!fs.existsSync(dir)) return results
  
  const files = fs.readdirSync(dir, { withFileTypes: true })
  for (const file of files) {
    if (file.isFile() && file.name.endsWith('.md')) {
      try {
        const content = fs.readFileSync(path.join(dir, file.name), 'utf-8')
        if (content.includes(topic)) {
          results.push({
            file: file.name,
            path: path.relative(VAULT_PATH, path.join(dir, file.name)),
            preview: content.substring(0, 400)
          })
        }
      } catch (e) { /* skip */ }
    } else if (file.isDirectory() && !file.name.startsWith('.')) {
      results.push(...searchDir(path.join(dir, file.name)))
    }
  }
  return results
}

console.log(JSON.stringify(searchDir(VAULT_PATH).slice(0, limit), null, 2))
