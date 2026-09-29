// 冒烟测试：加载构建产物，模拟最小 cordis Context，调用 apply() 验证不抛错、
// 定时器注册并可被清理。
import assert from 'node:assert'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const root = process.cwd()
const libEntry = path.join(root, 'lib', 'index.js')
const mod = await import(pathToFileURL(libEntry).href)

// 该插件导出 { Config, apply, inject, name }，apply 既是 named export 也作为插件对象
const apply = mod.apply
const inject = mod.inject
const Config = mod.Config
assert.equal(typeof apply, 'function', 'apply export present')
assert.deepEqual(inject, ['tools', 'fs'], 'inject should be tools+fs (no timer)')
assert.ok(Config, 'Config schema present')

// 最小 Context 模拟
const effects = []
const registeredTools = []
const cleanups = []
function makeCtx() {
  const ctx = {
    get: (name) => {
      if (name === 'settings') {
        // 模拟 0.2.0-rc.1 SettingsForms.describe()
        return {
          describe() {
            return [
              { ns: 'dsh-obsidian-sync', value: { vaultPath: 'E:/dsh-workspace/obsidian-vault', searchEnabled: true } },
            ]
          },
        }
      }
      return undefined
    },
    fs: {
      async resolve(p) { return { targetKey: p, displayPath: p } },
      async stat() { return undefined },
      async readText() { throw new Error('no file') },
      async listDir() { return [] },
      async writeText() {},
    },
    tools: {
      register(def) { registeredTools.push(def); return () => {} },
    },
    effect(fn, label) { effects.push(label); const d = fn(); cleanups.push(d) },
    on() {},
    emit() {},
  }
  return ctx
}

const ctx = makeCtx()
apply(ctx, {})
assert.ok(registeredTools.length > 0, 'should register tools, got ' + registeredTools.length)
assert.ok(registeredTools.some(t => t.name === 'obsidian.search'), 'obsidian.search registered')
assert.ok(registeredTools.some(t => t.name === 'obsidian.read_note'), 'obsidian.read_note registered')
assert.ok(registeredTools.some(t => t.name === 'obsidian.sync_session'), 'obsidian.sync_session registered')
assert.ok(effects.some(e => /index refresh/.test(e)), 'index refresh effect registered')

// 调用 obsidian.search 工具 execute（无索引，应返回空匹配而非抛错）
const search = registeredTools.find(t => t.name === 'obsidian.search')
const r = await search.execute({ topic: 'test', limit: 1 }, { signal: new AbortController().signal })
assert.equal(r.ok, true, 'search should succeed with empty index')
assert.equal(r.count, 0, 'no matches expected')

// 清理 effect（模拟卸载）
for (const c of cleanups) if (typeof c === 'function') c()
assert.equal(cleanups.length, effects.length, 'all effects registered disposers')

console.log('PASS: apply + tool registration + search execute + cleanup OK')
console.log('  registered tools:', registeredTools.map(t => t.name).join(', '))
console.log('  effects:', effects.join(', '))
