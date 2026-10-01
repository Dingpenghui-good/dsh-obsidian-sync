/**
 * 测试：幂等键 = date + shortId
 *
 * 验证 normalizeShortId 行为（与 src/index.ts 同步）。
 */
function normalizeShortId(sessionId) {
  const stripped = sessionId.replace(/^session-/i, '')
  let s = stripped.replace(/[^A-Za-z0-9]/g, '')
  if (s.length >= 8) return s.slice(0, 8)
  let hash = 0
  for (let i = 0; i < stripped.length; i++) {
    hash = ((hash << 5) - hash + stripped.charCodeAt(i)) | 0
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

// 带 "session-" 前缀的完整 ID → 剥离前缀后取 uuid 前 8 位（v3.4.6 修复）
assert(normalizeShortId('session-9f10d319-c1d3-4629-bf6d-a360d6729221') === '9f10d319', 'session-9f10d319-… → 9f10d319（剥离 session- 前缀）')
assert(normalizeShortId('session-905ba53a-60b6-4bea-8c8f-726faf09fca5') === '905ba53a', 'session-905ba53a-… → 905ba53a')
assert(normalizeShortId('session-9f10d319-c1d3-4629-bf6d-a360d6729221') === normalizeShortId('9f10d319-c1d3-4629-bf6d-a360d6729221'), '带前缀与裸 uuid 幂等键一致')

// 不足 8 位 → 补 hash
const short = normalizeShortId('current')
assert(short.length === 8, `short ID 补齐到 8 位 (got ${short})`)
assert(short.startsWith('current'), `short ID 保留前缀 (got ${short})`)

// 确定性
assert(normalizeShortId('current') === short, 'short ID 生成是确定性的')

console.log('\n✅ normalizeShortId 测试全部通过')
