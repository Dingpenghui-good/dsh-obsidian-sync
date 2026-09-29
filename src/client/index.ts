/**
 * Client-side entry for the dsh-obsidian-sync plugin.
 * Registers a plugin detail page (the screen opened when clicking the plugin's
 * name in the Plugins list) through the Plugins page's `plugins.bundle.config`
 * and `plugins.row.config` slots. The page hosts the prerequisite form:
 * vaultPath / searchEnabled / indexRefreshMs, saved through the Host's
 * settings form.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the Plugins page slot contract (plugins.bundle.config /
// plugins.row.config); the owner's SlotMap merge, never a runtime import.
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
// Type-only: pulls the ctx.locale merge.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.configForms Context merge and the settings slot types.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'

import { ObsidianSyncPageController } from './plugin-detail-controller.ts'
import type { ObsidianSyncSettings } from '../shared.ts'
import { ObsidianSyncDetailPage } from './plugin-detail-page.tsx'
import { zh as zhDict, en as enDict } from '../locales/index.ts'
// Shared barrel: keeps this bundle free of Host-only package value imports.
import {
  OBSIDIAN_SYNC_NAMESPACE,
  PLUGIN_PACKAGE_NAME,
  PLUGIN_ROW_CONFIG_KEY,
} from '../shared.ts'

const DICT_NS = 'settings.dsh-obsidian-sync'

export const inject = ['slots', 'locale', 'configForms', 'connection'] as const

export function apply(ctx: ClientContext): void {
  const slots = ctx.get('slots')!
  const locale = ctx.get('locale')!

  // Register locale dictionaries
  ctx.effect(() => locale.register(DICT_NS, { zh: zhDict, en: enDict }), 'obsidian-sync: dictionaries')

  // 详情页：把前提条件表单（vault 路径 / 搜索开关 / 索引间隔）挂到插件详情页。
  // 参照 ui-settings-shell：whileServed 保证部署从未组合宿主侧命名空间时，
  // 页面不留任何痕迹；注册随 served 变化自动增删。
  const detailPage = new ObsidianSyncPageController(
    ctx.get('configForms')!.get<ObsidianSyncSettings>(OBSIDIAN_SYNC_NAMESPACE)
  )
  ctx.effect(() => () => {
    detailPage.dispose()
  }, 'obsidian-sync: detail form subscriptions')

  ctx.effect(() => ctx.get('configForms')!.whileServed([OBSIDIAN_SYNC_NAMESPACE], () => {
    // Bundle 详情页（点击插件名字打开的画面）：描述与行之间的配置区块。
    const bundleDisposer = slots.inject('plugins.bundle.config', () => slots.register({
      name: 'plugins.bundle.config',
      key: PLUGIN_PACKAGE_NAME,
      locale: DICT_NS,
      inject: () => detailPage.inject(),
    }, ObsidianSyncDetailPage))
    // 行详情页（行上"配置"控件打开的画面）：`<package>#<row id>` key。
    const rowDisposer = slots.inject('plugins.row.config', () => slots.register({
      name: 'plugins.row.config',
      key: PLUGIN_ROW_CONFIG_KEY,
      locale: DICT_NS,
      inject: () => detailPage.inject(),
    }, ObsidianSyncDetailPage))
    return () => {
      rowDisposer()
      bundleDisposer()
    }
  }), 'obsidian-sync: detail page')
}
