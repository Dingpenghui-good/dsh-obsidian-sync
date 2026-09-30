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
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'

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

/**
 * 占位 ConfigForm：宿主未提供 settings 传输（configForms 服务缺失）时，
 * 详情页以只读「不可用」快照呈现，保存控件随之禁用 —— 条目永不因缺失
 * 而抛错。所有 getter 为惰性 thunk（与真实 scope 的快照模型一致）。
 */
function unavailableForm(): ConfigForm<ObsidianSyncSettings> {
  const snapshot = () => ({
    status: 'unavailable' as const,
    value: undefined as ObsidianSyncSettings | undefined,
    base: undefined,
    user: undefined,
    writable: false,
    revision: 0,
    mode: 'host' as const,
  })
  return {
    getSnapshot: snapshot,
    subscribe: (listener) => {
      // 只读占位永不提交；返回一个真实的空 disposer（与真实订阅同形）。
      listener()
      return () => {}
    },
    set: () => Promise.resolve(false),
    unset: () => Promise.resolve(false),
    mutate: () => Promise.resolve(false),
  } as ConfigForm<ObsidianSyncSettings>
}

export const inject = ['slots', 'locale'] as const

export function apply(ctx: ClientContext): void {
  const slots = ctx.get('slots')!
  const locale = ctx.get('locale')!

  // Register locale dictionaries
  ctx.effect(() => locale.register(DICT_NS, { zh: zhDict, en: enDict }), 'obsidian-sync: dictionaries')

  // 详情页：把前提条件表单（vault 路径 / 搜索开关 / 索引间隔）挂到插件详情页。
  // 激活健壮性（0.2.0-rc.2）：configForms 不是硬依赖，缺失时降级为只读占位
  // 表单（status: unavailable），条目永不因服务缺失而抛错；slot 注册本身
  // 不读 configForms，随页面打开才惰性拉取快照。
  const configForms = ctx.get('configForms')

  const scope: ConfigForm<ObsidianSyncSettings> = configForms
    ? configForms.get(OBSIDIAN_SYNC_NAMESPACE)
    : unavailableForm()

  const detailPage = new ObsidianSyncPageController(scope)
  ctx.effect(() => () => {
    detailPage.dispose()
  }, 'obsidian-sync: detail form subscriptions')

  ctx.effect(() => {
    // configForms 缺失（宿主未提供 settings 传输）时不注册详情页 slot，
    // 但仍返回一个空 cleanup，保持 effect 回调返回类型一致（Disposable）。
    if (configForms === undefined) return () => {}
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
  }, 'obsidian-sync: detail page')
}
