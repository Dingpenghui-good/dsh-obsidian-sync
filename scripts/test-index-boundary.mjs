/**
 * 测试：索引文件边界插入（双井号终止）+ 同 shortId 去重
 */
function findDayEnd(idxContent, dayAnchor, afterAnchor) {
  const nextH3 = idxContent.indexOf('\n### ', afterAnchor)
  const nextH2 = idxContent.indexOf('\n## ', afterAnchor)
  let dayEnd = -1
  if (nextH3 !== -1 && nextH2 !== -1) dayEnd = Math.min(nextH3, nextH2)
  else if (nextH3 !== -1) dayEnd = nextH3
  else if (nextH2 !== -1) dayEnd = nextH2
  else dayEnd = idxContent.length
  return dayEnd
}

function assert(condition, msg) {
  if (!condition) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
  console.log('PASS:', msg)
}

// 模拟索引文件：当天段落后紧跟 ## 主题分类
const mock = [
  '### 2026-09-13',
  '',
  '- [[04-Archive/2026-09-13-abc12345-test.md|test]] (2026-09-13, abc12345)',
  '',
  '## 主题分类',
  '',
  '### DSH 插件开发',
  '',
  '- [[x|y]]',
].join('\n')

const dayAnchor = '### 2026-09-13'
const dayPos = mock.indexOf(dayAnchor)
assert(dayPos !== -1, '找到当天段落锚点')

const afterAnchor = dayPos + dayAnchor.length
const dayEnd = findDayEnd(mock, dayAnchor, afterAnchor)

// dayEnd 应该指向 "## 主题分类" 前那个 \n
// mock.slice(dayEnd) 应该以 "## 主题分类" 开头（跳过可能的 \n）
const rest = mock.slice(dayEnd)
assert(rest.startsWith('\n## 主题分类') || rest.startsWith('## 主题分类'),
  `dayEnd 停在 ## 双井号前（实际: ${rest.slice(0, 20).replace(/\n/g, '\\n')}）`)

// 验证：dayEnd 之后不应包含 "### DSH 插件开发"（旧 bug 会误插到这里）
const section = mock.slice(afterAnchor, dayEnd)
assert(!section.includes('DSH 插件开发'), '当天段落不含主题分类内容')
assert(section.includes('abc12345'), '当天段落包含已有条目')

// 模拟追加新条目
const line = '\n- [[04-Archive/2026-09-13-def45678-new.md|new]] (2026-09-13, def45678)\n'
const updated = mock.slice(0, dayEnd) + line + mock.slice(dayEnd)
assert(updated.includes('def45678'), '新条目追加成功')
// 新条目在 ## 主题分类 之前
const newPos = updated.indexOf('def45678')
const themePos = updated.indexOf('## 主题分类')
assert(newPos < themePos, '新条目在 ## 主题分类 之前')

// 去重：同 shortId 已有条目 → 替换
const mock2 = [
  '### 2026-09-13',
  '',
  '- [[04-Archive/2026-09-13-abc12345-old.md|old]] (2026-09-13, abc12345)',
  '',
  '## 主题分类',
].join('\n')
const dedupePattern = new RegExp('^- \\[\\[[^\\]]*2026-09-13-abc12345-[^\\]]*\\]\\]\\s*\\([^\\)]*\\)$', 'm')
const daySection = mock2.slice(mock2.indexOf('### 2026-09-13') + 15, mock2.indexOf('\n## '))
const existingMatch = daySection.match(dedupePattern)
assert(existingMatch !== null, '去重：找到同 shortId 已有条目')

console.log('\n✅ 索引边界测试全部通过')
