/**
 * 归档索引写入回归测试（无第三方依赖，直接跑 `node test/index-entry.test.mjs`）。
 *
 * 覆盖：日期段按倒序插入 / 当日段追加 / 同 shortId 幂等替换 /
 *      不越过尾部二级标题（历史 bug：新日期段被追加到 `## 未归档清单` 之后）/
 *      CRLF 保持 / 老索引回退 / shortId 归一化。
 */

import assert from 'node:assert/strict'
import { applyIndexEntry, normalizeShortId } from '../src/index-core.ts'

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

/** 提取内容中所有日期段标题（按出现顺序）。 */
function dateHeadings(content) {
  return [...content.matchAll(/^### (\d{4}-\d{2}-\d{2})[ \t]*\r?$/gm)].map(m => m[1])
}

const HEAD = '# DSH 会话归档索引\n\n## 约定说明\n\n- 说明\n\n## 按日期（倒序）\n\n'
const TAIL = '## 未归档清单\n\n- 无（全部会话已归档）\n'

/** 一份带 11-19、11-07 两个日期段和尾部未归档清单的索引。 */
function sampleIndex() {
  return HEAD
    + '### 2026-11-19\n\n'
    + '- [[04-Archive/2026-11-19-aaaa1111-旧会话.md|旧会话]] (2026-11-19, aaaa1111-0000-0000-0000-000000000000)\n\n'
    + '### 2026-11-07\n\n'
    + '- [[04-Archive/2026-11-07-bbbb2222-更旧会话.md|更旧会话]] (2026-11-07, bbbb2222-0000-0000-0000-000000000000)\n\n'
    + TAIL
}

/** 构造条目参数。 */
function entry(dateStr, sessionId, title) {
  return {
    entryRelPath: '04-Archive/' + dateStr + '-' + sessionId.slice(0, 8) + '-' + title + '.md',
    title,
    sessionId,
    dateStr,
  }
}

test('中间日期：按倒序插入到相邻两段之间', () => {
  const out = applyIndexEntry(sampleIndex(), entry('2026-11-14', 'cccc3333-0000-0000-0000-000000000000', '新会话'))
  assert.deepEqual(dateHeadings(out), ['2026-11-19', '2026-11-14', '2026-11-07'])
  assert.ok(out.includes('- [[04-Archive/2026-11-14-cccc3333-新会话.md|新会话]] (2026-11-14, cccc3333-0000-0000-0000-000000000000)'))
  // 未归档清单必须仍在所有日期段之后
  assert.ok(out.indexOf('## 未归档清单') > out.indexOf('### 2026-11-07'))
})

test('最新日期：插到「按日期（倒序）」段最前', () => {
  const out = applyIndexEntry(sampleIndex(), entry('2026-12-01', 'dddd4444-0000-0000-0000-000000000000', '最新'))
  assert.deepEqual(dateHeadings(out), ['2026-12-01', '2026-11-19', '2026-11-07'])
  assert.ok(out.indexOf('## 按日期（倒序）') < out.indexOf('### 2026-12-01'))
})

test('最旧日期：落在最后一个日期段之后，不越过未归档清单', () => {
  const out = applyIndexEntry(sampleIndex(), entry('2026-08-01', 'eeee5555-0000-0000-0000-000000000000', '最旧'))
  assert.deepEqual(dateHeadings(out), ['2026-11-19', '2026-11-07', '2026-08-01'])
  assert.ok(out.indexOf('### 2026-08-01') < out.indexOf('## 未归档清单'))
})

test('当日段已存在：追加到段末，不新建段落', () => {
  const out = applyIndexEntry(sampleIndex(), entry('2026-11-19', 'ffff6666-0000-0000-0000-000000000000', '同日第二条'))
  assert.deepEqual(dateHeadings(out), ['2026-11-19', '2026-11-07'])
  const section = out.slice(out.indexOf('### 2026-11-19'), out.indexOf('### 2026-11-07'))
  assert.ok(section.includes('旧会话'))
  assert.ok(section.includes('同日第二条'))
})

test('同 shortId 重复写入：原地替换，行数不增、不产生多余空行', () => {
  const first = applyIndexEntry(sampleIndex(), entry('2026-11-14', 'cccc3333-0000-0000-0000-000000000000', '标题一'))
  const second = applyIndexEntry(first, entry('2026-11-14', 'cccc3333-0000-0000-0000-000000000000', '标题二'))
  assert.equal((second.match(/^- \[\[/gm) ?? []).length, 3)
  assert.ok(second.includes('标题二'))
  assert.ok(!second.includes('标题一'))
  assert.ok(!/\n\n\n/.test(second), '替换后不应出现连续空行')
})

test('写两次不同 shortId 的当日条目：段内保持一个空行分隔', () => {
  let out = applyIndexEntry(sampleIndex(), entry('2026-11-19', 'ffff6666-0000-0000-0000-000000000000', '同日A'))
  out = applyIndexEntry(out, entry('2026-11-19', '9999aaaa-0000-0000-0000-000000000000', '同日B'))
  assert.ok(!/\n\n\n/.test(out), '条目不应用两个空行分隔')
})

test('顺序不被打乱：连续插入多个日期后仍严格倒序', () => {
  let out = sampleIndex()
  for (const d of ['2026-10-01', '2026-12-25', '2026-11-01', '2026-09-15', '2026-11-20']) {
    out = applyIndexEntry(out, entry(d, '1234abcd-0000-0000-0000-000000000000', '会话' + d))
  }
  const dates = dateHeadings(out)
  assert.deepEqual(dates, [...dates].sort().reverse())
  assert.deepEqual(dates, ['2026-12-25', '2026-11-20', '2026-11-19', '2026-11-07', '2026-11-01', '2026-10-01', '2026-09-15'])
})

test('CRLF 索引：写入保持 CRLF，不混入裸 LF', () => {
  const crlf = sampleIndex().replace(/\n/g, '\r\n')
  const out = applyIndexEntry(crlf, entry('2026-11-14', 'cccc3333-0000-0000-0000-000000000000', '换行'))
  assert.ok(out.includes('\r\n'))
  assert.ok(!/(?<!\r)\n/.test(out), '不应出现裸 LF')
  assert.deepEqual(dateHeadings(out), ['2026-11-19', '2026-11-14', '2026-11-07'])
})

test('老索引（无按日期段）：回退插到「## 主题分类」之前', () => {
  const legacy = '# 索引\n\n## 主题分类\n\n- 分类说明\n'
  const out = applyIndexEntry(legacy, entry('2026-11-14', 'cccc3333-0000-0000-0000-000000000000', '老格式'))
  assert.ok(out.indexOf('### 2026-11-14') < out.indexOf('## 主题分类'))
  assert.ok(out.includes('老格式'))
})

test('空内容：直接以日期段开头，不留前导空行', () => {
  const out = applyIndexEntry('', entry('2026-11-14', 'cccc3333-0000-0000-0000-000000000000', '空'))
  assert.equal(out, '### 2026-11-14\n\n- [[04-Archive/2026-11-14-cccc3333-空.md|空]] (2026-11-14, cccc3333-0000-0000-0000-000000000000)\n')
})

test('normalizeShortId：剥离 session- 前缀、取 uuid 前 8 位', () => {
  assert.equal(normalizeShortId('session-9f10d319-1111-2222-3333-444444444444'), '9f10d319')
  assert.equal(normalizeShortId('b4624eb8-14ac-4904-abe9-cc812e0a1f8c'), 'b4624eb8')
  assert.equal(normalizeShortId('abc').length, 8)
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
