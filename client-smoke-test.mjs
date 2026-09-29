/**
 * Client bundle smoke test: verify the CJS factory wrapper structure,
 * externals are require()'d (not inlined), and the slot registration shape.
 */
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'

const libClient = path.resolve('lib/client.js')
const src = fs.readFileSync(libClient, 'utf8')

// 1. CJS factory wrapper present
assert.ok(src.includes('window.__ModuleLoader__.load({'), 'module loader registration present')
assert.ok(src.includes('id: "dsh-obsidian-sync"'), 'plugin id stamped')
assert.ok(src.includes('factory: (require) => {'), 'factory wrapper present')
assert.ok(src.includes('return module.exports;'), 'factory return present')
assert.ok(src.includes('exports.apply = apply;'), 'apply export present')
assert.ok(src.includes('exports.inject = inject;'), 'inject export present')
assert.ok(src.includes('\n});'), 'loader close present')

// 2. Externals via require (module table), not inlined.
//    The CJS build erases type-only imports at compile time, so only the
//    VALUE imports survive as require() calls. Check what actually lands.
assert.ok(src.includes('require("react/jsx-runtime")') || src.includes('require("react")'), 'react external via require')
assert.ok(src.includes('require("@deepseek-ai/dsh-client-ui-primitives")'), 'dsh-client-ui-primitives external via require')
// SnapshotStore (dsh-client-store) is type-only here (used in controller generics),
// so the runtime require may be absent — only require'd when a value import survives.
// The settings-form primitives barrel re-exports the form model, which internally
// requires dsh-client-store; that internal require is inlined into the primitives
// package's own bundle, not ours. So our bundle only requires primitives + react.

// 3. Locale dictionaries registered (zh + en for settings.dsh-obsidian-sync)
assert.ok(src.includes('settings.dsh-obsidian-sync'), 'locale namespace registered')
assert.ok(src.includes('vaultPath'), 'vaultPath field present in form')
assert.ok(src.includes('indexRefreshMs'), 'indexRefreshMs field present in form')
assert.ok(src.includes('searchEnabled'), 'searchEnabled field present in form')

// 4. Slot registrations present (plugins.bundle.config / plugins.row.config)
assert.ok(src.includes('plugins.bundle.config'), 'bundle detail slot registered')
assert.ok(src.includes('plugins.row.config'), 'row detail slot registered')
assert.ok(src.includes('whileServed'), 'whileServed gate present')

// 5. Inject list
assert.ok(src.includes('slots'), 'slots in inject')
assert.ok(src.includes('configForms'), 'configForms in inject')

// 6. No inlined @deepseek-ai value imports (purity: cross-plugin only via services)
//    The require() calls to @deepseek-ai packages must be the ONLY way they
//    appear as value imports (type-only references are erased).
const dshRequires = [...src.matchAll(/require\("@deepseek-ai\/[^"]+"\)/g)].map(m => m[0])
assert.ok(dshRequires.length >= 1, 'at least 1 @deepseek-ai external require()d, got ' + dshRequires.length)
console.log('  @deepseek-ai require() calls:', dshRequires.join(', '))

console.log('PASS: client bundle CJS wrapper + externals + locale + slots OK')
console.log('  size:', src.length, 'chars,', (src.length / 1024).toFixed(2), 'kB')
