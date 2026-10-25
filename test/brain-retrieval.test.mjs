/**
 * 大脑核心纯函数回归测试（无第三方依赖，直接跑 `node test/brain-retrieval.test.mjs`）。
 *
 * 覆盖：分词输入 → 打分/排序 → 注入文本上限 → 轮次判定 → 蒸馏规范化 →
 *      幂等追加与章节滚动 → 对话文本提取。
 */

import assert from 'node:assert/strict'
import {
  appendDistillSection,
  appendTurnBlock,
  collectAssistantText,
  collectTurnUserText,
  documentFrequencies,
  extractJsonObject,
  extractPinnedExcerpt,
  isNewUserTurn,
  normalizeDistill,
  noteTitle,
  noteTier,
  pickPinned,
  renderDistillLine,
  renderInjectText,
  scoreNote,
  searchBrain,
  turnKey,
  worthDistilling,
} from '../src/brain-core.ts'

let passed = 0
const cases = []
/**
 * 注册一个测试用例。
 * @param {string} name 用例名。
 * @param {() => void} fn 断言函数。
 */
function test(name, fn) {
  cases.push({ name, fn })
}

/** 造一篇笔记。 */
function note(path, tokens, snippet = '片段' + path) {
  return {
    path,
    displayPath: path,
    tokens: new Set(tokens),
    title: noteTitle(path),
    snippet,
    size: snippet.length,
  }
}

test('分词目录分层：02/03/05/06 是沉淀层，04/01/00 是流水层', () => {
  assert.equal(noteTier('02-Projects/dsh.md'), 'distilled')
  assert.equal(noteTier('03-Areas/偏好.md'), 'distilled')
  assert.equal(noteTier('05-Resources/x.md'), 'distilled')
  assert.equal(noteTier('06-Brain/recent.md'), 'distilled')
  assert.equal(noteTier('04-Archive/2026-10-25-a.md'), 'stream')
  assert.equal(noteTier('01-Daily/2026-10-25.md'), 'stream')
})

test('打分：沉淀层权重更高、标题命中加成、通用词权重更低', () => {
  const notes = [
    note('02-Projects/dsh-obsidian-sync.md', ['obsidian', 'sync', '知识', '库']),
    note('04-Archive/2026-10-01-x.md', ['obsidian', 'sync']),
    note('04-Archive/2026-10-02-y.md', ['obsidian']),
  ]
  const df = documentFrequencies(notes)
  const query = new Set(['obsidian', 'sync', '知识'])
  const distilled = scoreNote(notes[0], query, df)
  const stream = scoreNote(notes[1], query, df)
  assert.ok(distilled.score > stream.score, '沉淀层应高于流水层')
  // 标题/路径命中（obsidian 出现在文件名里）
  assert.ok(distilled.score > 0)
  // 完全无关的查询分数为 0
  assert.equal(scoreNote(notes[0], new Set(['zzz']), df).score, 0)
})

test('检索：按分数降序、阈值过滤、条数截断', () => {
  const notes = [
    note('02-Projects/dsh-obsidian-sync.md', ['obsidian', 'sync', '记忆']),
    note('04-Archive/2026-10-01-a.md', ['obsidian']),
    note('03-Areas/偏好.md', ['偏好']),
  ]
  const hits = searchBrain(notes, new Set(['obsidian', 'sync']), 5, 0)
  assert.equal(hits.length, 2)
  assert.equal(hits[0].path, '02-Projects/dsh-obsidian-sync.md')
  assert.equal(hits[0].tier, 'distilled')
  // 阈值过滤
  const filtered = searchBrain(notes, new Set(['偏好']), 5, 100)
  assert.equal(filtered.length, 0)
  // 截断
  assert.equal(searchBrain(notes, new Set(['obsidian', 'sync']), 1, 0).length, 1)
})

test('注入文本：包含路径/命中词，严格遵守字数上限，无命中返回空串', () => {
  const hits = [
    { path: '02-Projects/dsh-obsidian-sync.md', title: 'dsh-obsidian-sync', score: 3, matched: ['知识库', '记忆'], tier: 'distilled', snippet: '正文'.repeat(300) },
    { path: '04-Archive/2026-10-01-a.md', title: 'a', score: 2, matched: ['记忆'], tier: 'stream', snippet: '流水'.repeat(200) },
  ]
  const text = renderInjectText('知识库怎么用', hits, { maxChars: 600, pinned: ['02-Projects/dsh-obsidian-sync.md'] })
  assert.ok(text.includes('02-Projects/dsh-obsidian-sync.md'))
  assert.ok(text.includes('命中：'))
  assert.ok(text.includes('（置顶）'))
  assert.ok(text.length <= 600, '实长 ' + String(text.length))
  assert.equal(renderInjectText('x', [], { maxChars: 600 }), '')
  // 预算充足时两条都能装下，且流水层排在沉淀层之后
  const roomy = renderInjectText('知识库怎么用', hits, { maxChars: 2000 })
  assert.ok(roomy.includes('04-Archive/2026-10-01-a.md'))
  assert.ok(roomy.indexOf('02-Projects') < roomy.indexOf('04-Archive'))
})

test('注入文本：条数受预算约束但不截断到 0 条', () => {
  const hits = Array.from({ length: 6 }, (_, i) => ({
    path: '02-Projects/p' + String(i) + '.md',
    title: 'p' + String(i),
    score: 10 - i,
    matched: ['k'],
    tier: 'distilled',
    snippet: 's'.repeat(400),
  }))
  const text = renderInjectText('q', hits, { maxChars: 350 })
  assert.ok(text.length <= 350, '实长 ' + String(text.length))
  assert.ok(text.includes('02-Projects/p0.md'))
})

test('pickPinned：只挑沉淀层，按分数取前 N', () => {
  const hits = [
    { path: '04-Archive/a.md', title: 'a', score: 9, matched: [], tier: 'stream', snippet: '' },
    { path: '02-Projects/b.md', title: 'b', score: 5, matched: [], tier: 'distilled', snippet: '' },
    { path: '03-Areas/c.md', title: 'c', score: 3, matched: [], tier: 'distilled', snippet: '' },
  ]
  assert.deepEqual(pickPinned(hits, 2), ['02-Projects/b.md', '03-Areas/c.md'])
  assert.deepEqual(pickPinned(hits, 0), [])
})

test('extractJsonObject：容忍围栏与前后解释', () => {
  assert.deepEqual(extractJsonObject('```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(extractJsonObject('说明：{"a":2} 结束'), { a: 2 })
  assert.equal(extractJsonObject('没有对象'), undefined)
  assert.equal(extractJsonObject(''), undefined)
})

test('normalizeDistill：字段收敛、长度截断、路径白名单', () => {
  const memory = normalizeDistill({
    title: '  会话主题  ',
    summary: 's'.repeat(1000),
    keywords: ['知识库', '知识库', '的', 'the', '', 42, 'a b'],
    related: ['02-Projects/x.md', 'https://evil', '02-Projects/y.md'],
    pinned: 'true',
    open: true,
  }, { allowedPaths: ['02-Projects/x.md'], summaryMaxChars: 100 })
  assert.ok(memory !== undefined)
  assert.equal(memory.title, '会话主题')
  assert.ok(memory.summary.length <= 100)
  assert.deepEqual(memory.keywords, ['知识库', 'a b'])
  assert.deepEqual(memory.related, ['02-Projects/x.md'])
  assert.equal(memory.pinned, true)
  assert.equal(memory.open, true)
  // 空内容 → undefined
  assert.equal(normalizeDistill({ title: '', summary: '' }), undefined)
  assert.equal(normalizeDistill(undefined), undefined)
})

test('worthDistilling：噪声与过短输入不入库', () => {
  assert.equal(worthDistilling('好的', '收到', 10), false)
  assert.equal(worthDistilling('继续', '这是一段很长的回答内容用于测试', 5), false)
  assert.equal(worthDistilling('帮我改一下插件的检索逻辑', '已经把索引重建改成了脏标记驱动，并补了超时。', 5), true)
  assert.equal(worthDistilling('', 'x'.repeat(100), 5), false)
})

test('turnKey：优先 seq，其次 turn，最后 hash，且稳定', () => {
  assert.equal(turnKey(3, 42, 'x'), 'seq:42')
  assert.equal(turnKey(3, -1, 'x'), 'turn:3')
  const a = turnKey(0, -1, '同一个输入')
  const b = turnKey(0, -1, '同一个输入')
  assert.equal(a, b)
  assert.ok(a.startsWith('hash:'))
})

test('isNewUserTurn：同轮只处理一次；先 A 后 B 视为新轮', () => {
  assert.equal(isNewUserTurn({ lastKey: '', key: 'seq:1', previousIsUserMessage: false, text: '你好' }), true)
  assert.equal(isNewUserTurn({ lastKey: 'seq:1', key: 'seq:1', previousIsUserMessage: false, text: '你好' }), false)
  assert.equal(isNewUserTurn({ lastKey: 'seq:1', key: 'seq:3', previousIsUserMessage: true, text: '再来' }), true)
  assert.equal(isNewUserTurn({ lastKey: 'seq:1', key: 'seq:3', previousIsUserMessage: false, text: '再来' }), false)
  assert.equal(isNewUserTurn({ lastKey: '', key: 'seq:1', previousIsUserMessage: false, text: '   ' }), false)
})

test('renderDistillLine：稳定可重复、含关键词与待办标记', () => {
  const line = renderDistillLine({
    date: '2026-10-25',
    title: '标题',
    keywords: ['k1', 'k2'],
    summary: '结论',
    pinned: true,
    open: true,
  })
  assert.equal(line, '- 2026-10-25 · k1、k2 — 结论  ⏳待办')
  assert.equal(renderDistillLine({ date: '2026-10-25', title: '标题', keywords: [], summary: '结论', pinned: false, open: false }), '- 2026-10-25 — 结论')
})

test('appendDistillSection：无小节时创建；有则插到小节末尾；行级幂等', () => {
  const base = '# 笔记\n\n正文\n\n## 关联\n\n- [[x]]\n'
  const line = '- 2026-10-25 · k — 结论'
  const first = appendDistillSection(base, line)
  assert.equal(first.changed, true)
  assert.ok(first.content.includes('## 实时沉淀'))
  assert.ok(first.content.indexOf('## 实时沉淀') < first.content.indexOf('## 关联'))
  const second = appendDistillSection(first.content, line)
  assert.equal(second.changed, false)
  const third = appendDistillSection(first.content, '- 2026-10-25 · k2 — 结论2')
  assert.equal(third.changed, true)
  // 第二行仍在「## 实时沉淀」小节内（在「## 关联」之前）
  assert.ok(third.content.indexOf('结论2') < third.content.indexOf('## 关联'))
})

test('appendTurnBlock：同轮幂等；超限后开新节（续）', () => {
  const block = '### 轮次 · 12:00 · 标题\n- 用户：做A\n- 结论：完成B'
  const first = appendTurnBlock('# 会话\n', 'seq:10', block, { date: '2026-10-25', capBytes: 8192 })
  assert.equal(first.changed, true)
  assert.ok(first.content.includes('## 实时沉淀（2026-10-25）'))
  assert.ok(first.content.includes('<!-- turn:seq:10 -->'))
  const again = appendTurnBlock(first.content, 'seq:10', block, { date: '2026-10-25', capBytes: 8192 })
  assert.equal(again.changed, false)
  // 小上限 → 第二批必须落到「续」小节
  let current = first.content
  for (let i = 0; i < 6; i++) {
    const next = appendTurnBlock(current, 'seq:' + String(100 + i), block + '\n' + 'x'.repeat(500), { date: '2026-10-25', capBytes: 3000 })
    assert.equal(next.changed, true)
    current = next.content
  }
  assert.ok(current.includes('实时沉淀（2026-10-25 续1）'), current.slice(0, 400))
})

test('collectTurnUserText：排除系统通知与注入记忆，保留用户文本', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '真实输入' }], source: { kind: 'user' } },
    { role: 'user', content: [{ type: 'text', text: '【知识库记忆】...' }], source: { kind: 'obsidian-brain' } },
    { role: 'user', content: [{ type: 'text', text: '文件变更通知' }], source: { kind: 'file-change' } },
    { role: 'assistant', content: [{ type: 'text', text: '回答' }], source: { kind: 'model' } },
  ]
  assert.equal(collectTurnUserText(messages), '真实输入')
  assert.equal(collectAssistantText(messages), '回答')
})

test('extractPinnedExcerpt：去 frontmatter、压空行、限长', () => {
  const content = '---\ntags: [a]\n---\n\n# 偏好\n\n- 中文优先\n- 先做后问\n'
  assert.equal(extractPinnedExcerpt(content, 500), '# 偏好\n- 中文优先\n- 先做后问')
  assert.ok(extractPinnedExcerpt('x'.repeat(3000), 100).length <= 100)
  assert.equal(extractPinnedExcerpt(''), '')
})

for (const item of cases) {
  try {
    item.fn()
    passed++
    console.log('  ok   ' + item.name)
  } catch (error) {
    console.error('  FAIL ' + item.name)
    console.error(String(error && error.stack ? error.stack : error))
    process.exitCode = 1
  }
}
console.log('\n' + String(passed) + '/' + String(cases.length) + ' passed')
if (process.exitCode !== undefined) process.exit(process.exitCode)
