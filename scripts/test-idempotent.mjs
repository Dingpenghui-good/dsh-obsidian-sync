/**
 * 测试：幂等键 = date + shortId
 *
 * 验证 normalizeShortId 行为。
 */
function normalizeShortId(sessionId) {
  let s = sessionId.replace(/[^A-Za-z0-9]/g, '')
  if (s.length >= 8) return s.slice(0, 8)
  let hash = 0
  for (let i = 0; i < sessionId.length; i++) {
    hash = ((hash << 5) - hash + sessionId.charCodeAt(i)) | 0
  }
  s = s + Math.abs(hash).toString(16).slice(0, 8)
  return s.slice(0, 8)
}

function assert(condition, msg) {
  if (!condition) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
  console.log('PASS:', msg)
}

// 纯 UUID → 取前 8 位
assert(normalizeShortId('76bb60dbbdde') === '76bb60db', '短 UUID 76bb60dbbdde → 76bb60db')
assert(normalizeShortId('a9095879-df9e-4fbf-ad5d-bee10f641363') === 'a9095879', 'UUID a9095879-… → a9095879')
assert(normalizeShortId('e9179cc1-914d-4572-bbbd-476eecaf38a0') === 'e9179cc1', 'UUID e9179cc1-… → e9179cc1')

// 不足 8 位 → 补 hash
const short = normalizeShortId('current')
assert(short.length === 8, `short ID 补齐到 8 位 (got ${short})`)
assert(short.startsWith('current'), `short ID 保留前缀 (got ${short})`)

// 确定性
assert(normalizeShortId('current') === short, 'short ID 生成是确定性的')

console.log('\n✅ normalizeShortId 测试全部通过')
