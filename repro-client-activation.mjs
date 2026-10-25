/**
 * Reproduce the real web-boot activation of the obsidian-sync client entry.
 *
 * Uses the REAL SettingsFormModel class source extracted from the real
 * @deepseek-ai/dsh-client-ui-primitives bundle (the full bundle cannot load
 * in Node because of CSS-module imports), plus a faithful configForms
 * stand-in mirroring the ui-settings describe mirror at boot time
 * (status 'loading', no Host view yet). This exercises the exact
 * constructor/bind/shell/field code path that threw during activation.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

// Repo root: the script's own directory (overridable), not a hardcoded path.
const root = process.env.DSH_OBSIDIAN_SYNC_ROOT
  ? path.resolve(process.env.DSH_OBSIDIAN_SYNC_ROOT)
  : path.dirname(fileURLToPath(import.meta.url))
const cjsRequire = createRequire(path.join(root, 'package.json'))

// Minimal DOM stubs so CSS injection + primitives code can run headless.
globalThis.window = globalThis
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, style: { setProperty() {} } }),
  head: { appendChild() {} },
}

// --- Extract the REAL SettingsFormModel from the real primitives bundle. ---
function loadRealFormModel() {
  const file = path.join(
    root,
    'node_modules',
    '@deepseek-ai',
    'dsh-client-ui-primitives',
    'lib',
    'index.js'
  )
  const src = fs.readFileSync(file, 'utf8')
  const start = src.indexOf('var SettingsFormModel = class')
  if (start < 0) throw new Error('SettingsFormModel not found in real bundle')
  const endMarker = src.indexOf('#endregion', start)
  const classSrc = src.slice(start, endMarker === -1 ? start + 6000 : endMarker)
  const factory = new Function(
    'createSnapshotStore',
    `
      ${classSrc}
      return SettingsFormModel;
    `
  )
  function createSnapshotStore(initial) {
    let value = initial
    const listeners = new Set()
    return {
      get: () => value,
      set(next) { value = next; for (const l of listeners) l() },
      subscribe(l) { listeners.add(l); return () => listeners.delete(l) },
    }
  }
  return factory(createSnapshotStore)
}

let capturedModule = null
globalThis.window.__ModuleLoader__ = { load(m) { capturedModule = m } }
const clientSrc = fs.readFileSync(path.join(root, 'lib', 'client.js'), 'utf8')
eval(clientSrc)

const slotsService = {
  inject: (name, factory) => {
    const reg = factory()
    return () => reg?.disposer?.()
  },
  register: () => ({ disposer() {} }),
}
const localeService = {
  register: (ns, dict) => {
    const pairs = typeof dict === 'string' ? [[dict, undefined]] : Object.entries(dict)
    for (const [locale] of pairs) {
      if (!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(locale)) {
        throw new Error(`locale id "${locale}" invalid`)
      }
    }
    return () => {}
  },
}

// A configForms stand-in mirroring the ui-settings describe mirror at boot:
// the namespace form starts 'loading' (no Host view yet).
function realConfigForms() {
  let snapshot = {
    status: 'loading',
    value: undefined,
    base: undefined,
    user: undefined,
    writable: false,
    revision: undefined,
    mode: 'host',
  }
  const subs = new Set()
  return {
    get(ns) {
      return {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
          subs.add(listener)
          return () => subs.delete(listener)
        },
        set: () => Promise.resolve(false),
        unset: () => Promise.resolve(false),
        mutate: () => Promise.resolve(false),
      }
    },
    whileServed: () => () => {},
  }
}

const effects = []
const ctx = {
  get(name) {
    if (name === 'slots') return slotsService
    if (name === 'locale') return localeService
    if (name === 'configForms') return realConfigForms()
    return undefined
  },
  effect(fn, label) { effects.push(label); return fn() },
}

const factory = capturedModule.factory
const SettingsFormModel = loadRealFormModel()
console.log('real SettingsFormModel extracted:', SettingsFormModel ? 'OK' : 'NULL')

const resolveForFactory = (spec) => {
  if (spec === 'react/jsx-runtime') return cjsRequire('react/jsx-runtime')
  if (spec === 'react') return cjsRequire('react')
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') {
    return { SettingsFormModel, SettingsForm: () => null, Switch: () => null }
  }
  return {}
}

try {
  const mod = factory(resolveForFactory)
  mod.apply(ctx)
  console.log('APPLY OK, effects ran:', effects.join(', '))
} catch (e) {
  console.log('APPLY THREW:', e.constructor?.name, '-', e.message)
  console.log((e.stack || '').split('\n').slice(0, 8).join('\n'))
  process.exitCode = 1
}
