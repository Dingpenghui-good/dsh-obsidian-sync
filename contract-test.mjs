/**
 * Client runtime contract test for dsh-obsidian-sync v3.1.0 against the
 * @deepseek-ai/* 0.2.0-rc.1 surface of the web profile.
 *
 * Loads the CJS client bundle, invokes apply(ctx) with a mock cordis Context
 * providing the four injected services (slots, locale, configForms, connection)
 * with 0.2.0-rc.1 semantics, and verifies:
 *   - no settings row registration (detail page is the single entry point)
 *   - locale dictionary registration (settings.dsh-obsidian-sync, zh + en)
 *   - detail pages hidden while namespace unserved
 *   - detail pages register after whileServed fires
 *   - vaultPath / searchEnabled / indexRefreshMs write through the config form
 */
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

// Resolve the client bundle portably, in priority order:
//   1. explicit override (DSH_OBSIDIAN_SYNC_CLIENT)
//   2. the locally built artifact — this is what gets published to npm
//   3. an installed copy in a DSH web profile
const clientCandidates = [
  process.env.DSH_OBSIDIAN_SYNC_CLIENT,
  path.join(here, 'lib', 'client.js'),
  process.env.DSH_PROFILE_NPM
    ? path.join(process.env.DSH_PROFILE_NPM, 'dsh-obsidian-sync', 'lib', 'client.js')
    : undefined,
  path.join(os.homedir(), '.dsh', 'profiles', 'web', 'node_modules', 'dsh-obsidian-sync', 'lib', 'client.js'),
].filter(Boolean)

const clientPath = clientCandidates.find((p) => existsSync(p))
if (!clientPath) {
  console.error('FAIL: client bundle not found; run `pnpm build` first. Tried:')
  for (const p of clientCandidates) console.error('  - ' + p)
  process.exit(1)
}
console.log('client bundle:', clientPath)
const realClient = readFileSync(clientPath, 'utf8')

let failures = 0
function check(name, fn) {
  try { fn(); console.log('PASS:', name) } catch (e) { failures++; console.error('FAIL:', name, '--', e.message) }
}
function assert(cond, msg) { if (!cond) throw new Error(msg) }

// ---- React stub (platform external provided by the DSH client host) -----------
function h(type, props, ...kids) {
  return { $$typeof: 'react.element', type, props: { ...props, children: kids.length ? kids : undefined } }
}
const reactStub = {
  useState(init) {
    let v = typeof init === 'function' ? init() : init
    return [v, (n) => { v = typeof n === 'function' ? n(v) : n }]
  },
}
const jsxRuntimeStub = { jsx: h, jsxs: h, jsxDEV: h, Fragment: 'fragment' }

// ---- mock cordis Context ------------------------------------------------------
function makeCtx() {
  const ctx = {
    effects: [],
    _services: {},
    get(name) { return this._services[name] },
    effect(fn, label) {
      const handle = { label, disposed: false }
      ctx.effects.push(handle)
      try { fn() } catch { /* service may not be ready yet */ }
      return handle
    },
    on() { return () => {} },
  }
  return ctx
}

// ---- 0.2.0-rc.1 configForms mock ---------------------------------------------
class Observable {
  constructor(initial) { this._v = initial; this._subs = new Set() }
  getSnapshot() { return this._v }
  subscribe(fn) { this._subs.add(fn); return () => this._subs.delete(fn) }
  set(v) { this._v = v; this._subs.forEach((f) => f()) }
}

function makeConfigForms(initialValue) {
  const forms = new Map()
  const served = new Observable(false)
  function makeForm(ns, value) {
    let rev = 0
    const subs = new Set()
    return {
      getSnapshot() {
        return { status: 'live', value, base: undefined, user: value, writable: true, revision: rev }
      },
      subscribe(fn) { subs.add(fn); return () => subs.delete(fn) },
      mutate(ops, _expected) {
        for (const op of ops) {
          if (op.op === 'set') value[op.path[0]] = op.value
          else if (op.op === 'unset') delete value[op.path[0]]
        }
        rev++
        subs.forEach((f) => f())
      },
    }
  }
  return {
    get(ns) {
      if (!forms.has(ns)) forms.set(ns, makeForm(ns, initialValue ? { ...initialValue } : {}))
      return forms.get(ns)
    },
    whileServed(_nss, fn) {
      const run = () => fn()
      if (served.getSnapshot()) run()
      return served.subscribe(() => { if (served.getSnapshot()) run() })
    },
    _serve() { served.set(true) },
  }
}

// ---- 0.2.0-rc.1 slots mock ----------------------------------------------------
function makeSlots() {
  const registered = []
  const factories = new Map()
  return {
    registered,
    inject(name, factory) {
      if (!factories.has(name)) factories.set(name, [])
      const list = factories.get(name)
      list.push(factory)
      for (const f of list) f()
      return () => {}
    },
    register(opts, component) {
      const entry = { ...opts, component }
      registered.push(entry)
      if (opts.inject) {
        const bound = opts.store ? opts.store.actions : entry
        opts.inject(bound)
      }
      return entry
    },
  }
}

function makeLocale() {
  const dicts = {}
  return { register(ns, dict) { dicts[ns] = dict }, _dicts: dicts }
}

// ---- load the bundle in a sandbox -------------------------------------------
function loadBundle() {
  const marker = 'factory: (require) => {'
  const start = realClient.indexOf(marker)
  if (start < 0) throw new Error('factory marker not found')
  const bodyStart = start + marker.length
  const tail = '\n\t}\n});'
  const end = realClient.lastIndexOf(tail)
  if (end < 0) throw new Error('arrow-body closing brace not found')
  const body = realClient.slice(bodyStart, end + 2)
  const factory = new Function('require', body)

  function mockRequire(id) {
    if (id === 'react') return reactStub
    if (id === 'react/jsx-runtime') return jsxRuntimeStub
    if (id.startsWith('@deepseek-ai/')) {
      if (id === '@deepseek-ai/dsh-client-ui-primitives') {
        class SettingsFormModel {
          constructor(scope, fields) {
            this.scope = scope
            this.fields = fields
            this._drafts = new Map()
            this._subscribers = new Set()
            this._snapshot = this._project()
            this._scopeSub = scope.subscribe(() => { this._snapshot = this._project(); this._subscribers.forEach((f) => f()) })
            for (const f of fields) this._drafts.set(f.field, { text: '' })
          }
          _project() {
            const s = this.scope.getSnapshot()
            const state = {
              available: true,
              writable: s.writable !== false,
              dirty: false,
              invalid: false,
              saving: false,
              failed: false,
              status: s.status,
              value: s.value ?? {},
              revision: s.revision ?? 0,
            }
            for (const f of this.fields) {
              const raw = state.value?.[f.field]
              const draft = this._drafts.get(f.field)
              state[f.field] = {
                text: draft && draft.text !== '' ? draft.text : f.format(raw),
                overridden: draft ? draft.text !== '' : raw !== undefined && raw !== null,
                invalid: false,
              }
            }
            return state
          }
          getSnapshot() { return this._snapshot }
          subscribe(fn) { this._subscribers.add(fn); return () => this._subscribers.delete(fn) }
          edit(name, text) { this._drafts.set(name, { text }); this._snapshot = this._project(); this._subscribers.forEach((f) => f()) }
          clear(name) { this._drafts.set(name, { text: '' }); this._snapshot = this._project(); this._subscribers.forEach((f) => f()) }
          shell() {
            return {
              available: this._snapshot.available,
              writable: this._snapshot.writable,
              dirty: this._snapshot.dirty,
              invalid: this._snapshot.invalid,
              saving: this._snapshot.saving,
              failed: this._snapshot.failed,
            }
          }
          field(name) { return this._snapshot[name] }
          actions() {
            return {
              edit: (name, text) => this.edit(name, text),
              resetField: (name) => this.clear(name),
              save: () => this.save(),
              discard: () => this.discard(),
            }
          }
          bind(projector) {
            return {
              getSnapshot: () => projector(),
              subscribe: (fn) => this.subscribe(fn),
            }
          }
          save() {
            const ops = []
            for (const f of this.fields) {
              const d = this._drafts.get(f.field)
              if (!d || d.text === '') continue
              const parsed = f.parse(d.text)
              if (parsed?.kind === 'set') ops.push({ op: 'set', path: [f.field], value: parsed.value })
              else if (parsed?.kind === 'clear') ops.push({ op: 'unset', path: [f.field] })
            }
            if (this.scope.mutate) this.scope.mutate(ops, this.scope.getSnapshot().revision)
            for (const k of this._drafts.keys()) this._drafts.set(k, { text: '' })
            this._snapshot = this._project()
            this._subscribers.forEach((f) => f())
          }
          discard() {
            for (const k of this._drafts.keys()) this._drafts.set(k, { text: '' })
            this._snapshot = this._project()
            this._subscribers.forEach((f) => f())
          }
          dispose() {
            if (this._scopeSub) this._scopeSub()
            this._subscribers.clear()
          }
        }
        return {
          SettingsForm: (p) => h('form', p),
          Switch: (p) => h('switch', p),
          SettingsFormModel,
        }
      }
      if (id === '@deepseek-ai/dsh-client-store') {
        return {
          defineStore(decl) {
            const state = decl.init()
            const actions = {}
            for (const [k, fn] of Object.entries(decl.actions)) actions[k] = (...a) => fn(state, ...a)
            const instance = { getSnapshot: () => state, subscribe: () => () => {}, actions, create: () => instance }
            return instance
          },
        }
      }
      return new Proxy(function () {}, { get: () => () => {} })
    }
    throw new Error('unexpected require: ' + id)
  }

  const exportsObj = factory(mockRequire)
  return exportsObj
}

// ---- run ----------------------------------------------------------------------
const bundle = loadBundle()
check('bundle exports apply + inject', () => {
  assert(typeof bundle.apply === 'function', 'apply missing')
  assert(Array.isArray(bundle.inject), 'inject missing')
  assert(bundle.inject.includes('slots') && bundle.inject.includes('locale'), 'inject list mismatch: ' + JSON.stringify(bundle.inject))
})

const ctx = makeCtx()
ctx._services.slots = makeSlots()
ctx._services.locale = makeLocale()
ctx._services.connection = new Proxy({}, { get: () => () => {} })
const configForms = makeConfigForms({ vaultPath: 'E:/dsh-workspace/obsidian-vault', searchEnabled: true, indexRefreshMs: 60000 })
ctx._services.configForms = configForms

bundle.apply(ctx)

const slots = ctx._services.slots
check('no settings row registered (detail page is the single entry point)', () => {
  const row = slots.registered.find((e) => e.name === 'settings.general.item')
  assert(!row, 'settings row should NOT be registered')
})

check('locale dictionaries registered (zh + en for settings.dsh-obsidian-sync)', () => {
  const dict = ctx._services.locale._dicts['settings.dsh-obsidian-sync']
  assert(dict && dict.zh && dict.en, 'dictionary missing')
  assert(dict.zh['page.vaultPath.label'] === 'Obsidian vault 路径', 'zh vaultPath label mismatch: ' + dict.zh['page.vaultPath.label'])
  assert(dict.en['form.save'] === 'Save', 'en save mismatch: ' + dict.en['form.save'])
})

check('detail pages stay hidden while namespace unserved', () => {
  const detail = slots.registered.filter((e) => e.name === 'plugins.bundle.config' || e.name === 'plugins.row.config')
  assert(detail.length === 0, 'detail pages should be hidden, got ' + detail.length)
})

configForms._serve()
check('detail pages register after whileServed fires', () => {
  const bundleCfg = slots.registered.filter((e) => e.name === 'plugins.bundle.config')
  const rowCfg = slots.registered.filter((e) => e.name === 'plugins.row.config')
  assert(bundleCfg.length === 1, 'plugins.bundle.config missing, got ' + bundleCfg.length)
  assert(rowCfg.length === 1, 'plugins.row.config missing, got ' + rowCfg.length)
  assert(bundleCfg[0].key === 'dsh-obsidian-sync', 'bundle key mismatch: ' + bundleCfg[0].key)
  assert(rowCfg[0].key === 'dsh-obsidian-sync#dsh-obsidian-sync', 'row key mismatch: ' + rowCfg[0].key)
})

check('vaultPath writes through the config form', () => {
  const form = configForms.get('dsh-obsidian-sync')
  form.mutate([{ op: 'set', path: ['vaultPath'], value: 'F:/my-vault' }], form.getSnapshot().revision)
  const snap = form.getSnapshot()
  assert(snap.value.vaultPath === 'F:/my-vault', 'form value not updated, got ' + JSON.stringify(snap.value))
})

check('searchEnabled writes through the config form', () => {
  const form = configForms.get('dsh-obsidian-sync')
  form.mutate([{ op: 'set', path: ['searchEnabled'], value: false }], form.getSnapshot().revision)
  const snap = form.getSnapshot()
  assert(snap.value.searchEnabled === false, 'form value not updated, got ' + JSON.stringify(snap.value))
})

check('indexRefreshMs writes through the config form', () => {
  const form = configForms.get('dsh-obsidian-sync')
  form.mutate([{ op: 'set', path: ['indexRefreshMs'], value: 30000 }], form.getSnapshot().revision)
  const snap = form.getSnapshot()
  assert(snap.value.indexRefreshMs === 30000, 'form value not updated, got ' + JSON.stringify(snap.value))
})

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
