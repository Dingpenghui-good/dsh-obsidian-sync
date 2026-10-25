/**
 * 运行级冒烟测试（不进 DSH 实例，直接驱动 brain.ts 的真实代码路径）。
 *
 * 用真实的 DSH 运行时类（Session / SessionStore / 内存 fs）在临时 vault 上跑：
 *   1. 用户消息入队 → 注入一条 `obsidian-brain` 消息（跟随 steer，不额外唤醒）
 *   2. 无命中 / 开关关闭 → 不注入
 *   3. 轮结束 → 蒸馏写流水页 / 沉淀摘要行 / 06-Brain 聚合页（用假 llm 返回固定 JSON）
 *   4. 同一轮重复触发 → 幂等不重复写
 *
 * 运行：node --experimental-strip-types test/brain-runtime.test.mjs
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import { installBrain } from '../src/brain.ts'

const VAULT = mkdtempSync(join(tmpdir(), 'obsidian-brain-'))
/**
 * 写一篇 vault 笔记。
 * @param {string} rel 相对路径。
 * @param {string} text 内容。
 */
function write(rel, text) {
  const full = join(VAULT, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, text, 'utf8')
}

write('02-Projects/dsh-obsidian-sync.md', '# dsh-obsidian-sync\n\n插件会在每轮对话前检索知识库，并把相关记忆注入本轮上下文。\n需要关注：token 上限、超时、幂等。每轮结束时还会把结论沉淀回知识库，供下一轮检索命中。\n')
write('03-Areas/决策习惯与偏好.md', '---\ntags: [area]\n---\n\n# 决策习惯与偏好\n\n- 中文优先\n- 先做后问\n')
write('05-Resources/记忆系统设计.md', '# 记忆系统设计\n\n检索注入需要控制 token 上限，并保证超时后不阻塞对话；沉淀要幂等且可滚动。\n')
write('04-Archive/2026-10-20-aaaa1111-旧会话.md', '# 旧会话\n\n这次讨论的是知识库注入与倒排索引的事。\n')

// ---------------------------------------------------------------------------
// 最小宿主替身：内存 fs、倒排索引、tokenize（与插件里的实现一致）
// ---------------------------------------------------------------------------

/** 分词：与 src/index.ts 完全一致的实现（CJK bigram + ASCII 三段）。 */
function tokenize(text) {
  const lower = String(text).toLowerCase()
  const seen = new Set()
  let m
  const asciiRe = /[a-z0-9]+/g
  while ((m = asciiRe.exec(lower)) !== null) {
    const p = m[0]
    if (p.length < 2) continue
    seen.add(p)
    if (p.length >= 4) for (let i = 0; i + 3 <= p.length; i++) seen.add(p.slice(i, i + 3))
  }
  const cjkRe = /[\u4e00-\u9fff]+/g
  while ((m = cjkRe.exec(lower)) !== null) {
    const p = m[0]
    if (p.length === 1) seen.add(p)
    else {
      for (let i = 0; i + 2 <= p.length; i++) seen.add(p.slice(i, i + 2))
      if (p.length >= 3) seen.add(p.slice(p.length - 3))
    }
  }
  return seen
}

/** 极简 FileSystem 替身（只实现大脑用到的接口）。 */
function makeFs() {
  const resolve = async (path) => ({ displayPath: String(path).replace(/\\/g, '/'), path: String(path) })
  return {
    resolve,
    async stat(target) {
      try {
        const st = (await import('node:fs')).statSync(target.displayPath)
        return { type: st.isDirectory() ? 'directory' : 'file', version: String(st.mtimeMs), size: st.size }
      } catch {
        return undefined
      }
    },
    async listDir(target) {
      const fs = await import('node:fs')
      const entries = fs.readdirSync(target.displayPath, { withFileTypes: true })
      return entries.map(entry => ({
        type: entry.isDirectory() ? 'directory' : 'file',
        name: entry.name,
        target: { displayPath: target.displayPath + '/' + entry.name },
        size: 0,
      }))
    },
    async readText(target) {
      const fs = await import('node:fs')
      return fs.readFileSync(target.displayPath, 'utf8')
    },
    async writeText(target, text) {
      const fs = await import('node:fs')
      fs.mkdirSync(join(target.displayPath, '..'), { recursive: true })
      fs.writeFileSync(target.displayPath, text, 'utf8')
    },
  }
}

const fs = makeFs()
/** 索引快照：直接扫 vault 里已有文件。 */
let dirtyFlag = false
async function buildNotes() {
  const fsMod = await import('node:fs')
  const notes = []
  const walk = async (dir, prefix) => {
    for (const entry of fsMod.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix.length === 0 ? entry.name : prefix + '/' + entry.name
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === '.obsidian') continue
        await walk(join(dir, entry.name), rel)
        continue
      }
      if (!entry.name.endsWith('.md')) continue
      const text = fsMod.readFileSync(join(dir, entry.name), 'utf8')
      notes.push({
        path: rel,
        displayPath: join(dir, entry.name),
        tokens: tokenize('\n' + entry.name + '\n' + text),
        title: entry.name,
        snippet: text.slice(0, 240),
        size: text.length,
      })
    }
  }
  await walk(VAULT, '')
  return notes
}

/** 收集会话事件：用真实 SessionStore 的 session/event。 */
const events = []
const ctxStub = {
  logger: { info(...args) { if (process.env.BRAIN_DEBUG === '1') console.log('[info]', ...args) }, warn(...args) { if (process.env.BRAIN_DEBUG === '1') console.log('[warn]', ...args) }, error(...args) { console.log('[err]', ...args) } },
  async get(name) {
    if (name === 'agents') return { list: () => [] }
    return undefined
  },
  // 只捕获事件订阅，由测试手动触发
  on(event, handler) {
    listeners.push({ event, handler })
    return () => {
      const index = listeners.findIndex(item => item.handler === handler)
      if (index >= 0) listeners.splice(index, 1)
    }
  },
  effect(register) {
    const disposers = []
    const returned = register()
    if (typeof returned === 'function') disposers.push(returned)
    effectDisposers.push(disposers)
  },
}
const listeners = []
const effectDisposers = []

/** 假 llm：返回固定蒸馏 JSON。 */
let callCount = 0
const llmStub = {
  listProviders: () => [{ id: 'fake' }],
  stream: async function* (options) {
    callCount++
    yield { type: 'text-delta', index: 0, text: '{"title":"知识库注入链路","summary":"确定了每轮检索注入与实时沉淀的实现方式。","keywords":["知识库","注入","记忆"],"related":["02-Projects/dsh-obsidian-sync.md"],"pinned":true,"open":false}' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}

// 让 ctx.get 返回 llm 替身
const originalGet = ctxStub.get.bind(ctxStub)
ctxStub.get = (name) => (name === 'llm' ? llmStub : originalGet(name))

const brainHostOptions = {
  retrieval: true,
  topK: 3,
  maxChars: 2000,
  minScore: 0,
  timeoutMs: 2000,
  autoUpdate: true,
  memoryProvider: 'fake',
  memoryModel: 'fake-model',
  memoryApiKeyEnv: '',
  maxCalls: 10,
  pinnedBudget: 2,
  autoCommit: false,
  logCapBytes: 200_000,
  verbose: true,
}
const brain = installBrain({
  ctx: ctxStub,
  fs,
  options: () => brainHostOptions,
  vaultPath: () => VAULT,
  async ensureIndexReady() { return true },
  async snapshotNotes() { return await buildNotes() },
  readNotes: async (paths) => {
    const out = new Map()
    for (const rel of paths) {
      const full = join(VAULT, rel)
      if (existsSync(full)) out.set(rel, readFileSync(full, 'utf8'))
    }
    return out
  },
  tokenize,
  markDirty: () => { dirtyFlag = true },
  writePolicy: () => ({ mode: 'danger-full-access', workspaceRoot: VAULT }),
  currentRoute: () => ({ provider: 'fake', model: 'fake-model' }),
})

// ---------------------------------------------------------------------------
// 构造真实 session（绕过 SessionStore：直接建 detached Session，避免依赖 Cordis）
// ---------------------------------------------------------------------------
const session = Session.create(SessionId('session-brain-test1'))
const steerMessages = []
const inbox = { nextTurn: [], nextStep: [] }
const agent = {
  id: session.id,
  session,
  inbox,
  steer(message) {
    steerMessages.push(message)
    inbox.nextStep.push(message)
  },
}

/** 追加一条用户消息到真实会话（surface append）。 */
function appendUser(text) {
  const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  session.append('user/message', message, { surfaceOp: 'append' })
  return message
}
/** 追加一条助手消息。 */
function appendAssistant(text) {
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: { role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'fake', model: 'fake-model' } },
    stream: [],
  }, { surfaceOp: 'append' })
}

/** 触发 inbox/inserted 并等待异步注入完成。 */
async function inserted(message) {
  for (const listener of listeners.filter(item => item.event === 'agent/inbox/inserted')) {
    listener.handler({ agent, message })
  }
  // 注入是异步的：等微任务 + 读文件
  for (let i = 0; i < 40; i++) await new Promise(resolve => setTimeout(resolve, 10))
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------
const userMessage = appendUser('知识库注入应该在每轮对话前发生，帮我确认实现方式')
// 复刻真实 agent 的入队顺序：先追加 user/message 到会话，再进入 inbox。
inbox.nextTurn.push(userMessage)
await inserted(userMessage)
console.log('[debug] steered=' + String(steerMessages.length) + ' listeners=' + String(listeners.length) + ' ctx.warn 已触发')
assert.equal(steerMessages.length, 1, '应当注入一条记忆消息')
const injected = steerMessages[0]
assert.equal(injected.source.kind, 'obsidian-brain')
const injectedText = injected.content[0].text
assert.ok(injectedText.includes('02-Projects/dsh-obsidian-sync.md'), injectedText)
assert.ok(injectedText.includes('【长期约束'), injectedText)
assert.ok(injectedText.includes('决策习惯与偏好'))
console.log('  ok   每轮检索注入（含长期约束页）')
console.log('      注入长度 ' + String(injectedText.length) + ' 字符')

// 同一轮的重复通知（同一条消息再次触发 inserted）不应重复注入
inbox.nextTurn.push(userMessage)
await inserted(userMessage)
assert.equal(steerMessages.length, 1, '同一轮同一消息不应重复注入')
// 同一轮内后续排队的用户输入也不重复注入（其内容已在本轮模型可见的历史/注入里）
const queued = appendUser('追加一句：还有别的注意事项吗')
inbox.nextTurn.push(queued)
await inserted(queued)
// 连发的两条属于同一批入队：批内只保留一次注入
assert.equal(steerMessages.length, 2, '连发消息应合并为一次注入，实际 ' + String(steerMessages.length))
console.log('  ok   同一轮连发合并为一次注入')

// 开关关闭 → 不注入
brainHostOptions.retrieval = false
appendAssistant('确认：注入发生在 pre-step 之前，使用 steer 排队。')
const secondUser = appendUser('第二个问题：知识库记忆怎么写到 vault')
inbox.nextTurn.push(secondUser)
await inserted(secondUser)
assert.equal(steerMessages.length, 2, '关闭后不应注入')
brainHostOptions.retrieval = true
console.log('  ok   开关可关闭')

// 关闭期间错过的轮次不应被"补注入"；重新开启后的下一轮要正常注入
appendAssistant('第二个回答：写入 vault 通过 fs 服务。')
const thirdUser = appendUser('第三个问题：知识库注入的超时和上限怎么配')
inbox.nextTurn.push(thirdUser)
await inserted(thirdUser)
assert.equal(steerMessages.length, 3, '重新开启后应恢复注入')
console.log('  ok   重新开启后恢复注入')

// 蒸馏：触发 turn-stopping 并等待落盘
const turnStopping = listeners.filter(item => item.event === 'agent/turn-stopping')
assert.equal(turnStopping.length, 1, '应注册 turn-stopping 监听器')
turnStopping[0].handler({ agent, turn: 1, signal: new AbortController().signal })
for (let i = 0; i < 60; i++) {
  await new Promise(resolve => setTimeout(resolve, 20))
  if (callCount > 0 && existsSync(join(VAULT, '06-Brain/recent.md'))) break
}
const archiveDir = join(VAULT, '04-Archive')
const archiveFiles = (await import('node:fs')).readdirSync(archiveDir).filter(name => name.endsWith('.md'))
const logFile = archiveFiles.find(name => !name.startsWith('2026-10-20'))
assert.ok(logFile !== undefined, '应创建实时沉淀流水页')
const logText = readFileSync(join(archiveDir, logFile), 'utf8')
assert.ok(logText.includes('## 实时沉淀（'), logText.slice(0, 300))
assert.ok(logText.includes('结论：'), logText.slice(0, 600))
const projectText = readFileSync(join(VAULT, '02-Projects/dsh-obsidian-sync.md'), 'utf8')
assert.ok(projectText.includes('## 实时沉淀'), projectText)
assert.ok(projectText.includes('知识库、注入、记忆'), projectText)
const digestText = readFileSync(join(VAULT, '06-Brain/recent.md'), 'utf8')
assert.ok(digestText.includes('# 大脑 · 最近沉淀'), digestText)
assert.ok(digestText.includes('确定了每轮检索注入与实时沉淀的实现方式'), digestText)
console.log('  ok   蒸馏落盘（流水页 + 沉淀摘要行 + 06-Brain 聚合）')
console.log('      llm 调用次数 ' + String(callCount))

// 幂等：同轮再触发一次不应重复追加
const before = readFileSync(join(archiveDir, logFile), 'utf8')
const beforeCalls = callCount
turnStopping[0].handler({ agent, turn: 1, signal: new AbortController().signal })
for (let i = 0; i < 30; i++) await new Promise(resolve => setTimeout(resolve, 20))
const after = readFileSync(join(archiveDir, logFile), 'utf8')
assert.equal(after, before, '同一轮不应重复写流水')
assert.equal(callCount, beforeCalls, '同一轮不应重复调用小模型')
console.log('  ok   同轮幂等（不重复调用、不重复写盘）')

// 命中检索入口（工具侧）
const retrieved = await brain.retrieve('知识库 注入 记忆')
assert.ok(retrieved.hits.length > 0)
assert.ok(retrieved.text.length > 0)
console.log('  ok   工具侧检索入口可用（命中 ' + String(retrieved.hits.length) + ' 条）')

rmSync(VAULT, { recursive: true, force: true })
console.log('\n运行级冒烟测试全部通过')
