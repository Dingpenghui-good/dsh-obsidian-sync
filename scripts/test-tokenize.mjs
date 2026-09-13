/**
 * 测试：CJK bigram 分词 + ASCII 重叠三元组
 *
 * 验证 "知识库" 可命中 "知识"，"连不上" 可命中 "连接不上"。
 */
import { readFileSync } from 'node:fs'

// 从构建产物中提取 tokenize 逻辑（或直接内联）
function tokenize(text) {
  const lower = String(text).toLowerCase()
  const seen = new Set()
  const asciiRe = /[a-z0-9]+/g
  let m
  while ((m = asciiRe.exec(lower)) !== null) {
    const p = m[0]
    if (p.length < 2) continue
    seen.add(p)
    if (p.length >= 4) {
      for (let i = 0; i + 3 <= p.length; i++) seen.add(p.slice(i, i + 3))
    }
  }
  const cjkRe = /[\u4e00-\u9fff]+/g
  while ((m = cjkRe.exec(lower)) !== null) {
    const p = m[0]
    if (p.length === 1) {
      seen.add(p)
    } else {
      for (let i = 0; i + 2 <= p.length; i++) seen.add(p.slice(i, i + 2))
      if (p.length >= 3) seen.add(p.slice(p.length - 3))
    }
  }
  return seen
}

function assert(condition, msg) {
  if (!condition) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
  console.log('PASS:', msg)
}

// CJK bigram
const t1 = tokenize('知识库')
assert(t1.has('知识'), '知识库 → bigram 包含 知识')
assert(t1.has('识库'), '知识库 → bigram 包含 识库')

const t2 = tokenize('知识')
assert(t2.has('知识'), '知识 → 直接命中 知识')

// 互查
assert(t1.has('知识') && t2.has('知识'), '知识库 和 知识 共享 token 知识')

const t3 = tokenize('连不上')
const t4 = tokenize('连接不上')
assert(t3.has('不上') && t4.has('不上'), '连不上 和 连接不上 共享 bigram 不上')

// ASCII 重叠三元组
const t5 = tokenize('publish')
assert(t5.has('pub'), 'publish → 三元组包含 pub')
assert(t5.has('ubl'), 'publish → 三元组包含 ubl')

// ASCII 短词
const t6 = tokenize('npm')
assert(t6.has('npm'), 'npm → 直接命中')

console.log('\n✅ tokenize 测试全部通过')
