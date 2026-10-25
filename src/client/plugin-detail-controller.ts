/**
 * dsh-obsidian-sync 详情页的 staged form：把宿主 settings 命名空间桥接到
 * 插件详情页（plugins.bundle.config / plugins.row.config）的保存控件。
 * 参照 ui-settings-shell 的 ShellCardController 模式。
 */
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  SettingsFormModel,
  type SettingsFieldState,
  type SettingsFormActions,
  type SettingsFormScope,
  type SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ObsidianSyncSettings } from '../shared.ts'

/** 详情页渲染的表单状态。 */
export interface ObsidianSyncPageState extends SettingsFormShell {
  vaultPath: SettingsFieldState
  searchEnabled: SettingsFieldState
  indexRefreshMs: SettingsFieldState
}

/** 注册侧注入给详情页组件的面。 */
export interface ObsidianSyncPageFace extends SettingsFormActions {
  hooks: {
    /** 页面快照，渲染器绑定为 useObsidianSyncPage。 */
    obsidianSyncPage: SnapshotStore<ObsidianSyncPageState>
  }
}

/** vaultPath 字段的 format/parse 规范：非空绝对/相对路径，空串清除回默认。 */
function vaultPathFieldSpec() {
  return {
    field: 'vaultPath',
    format: (value: unknown) => (typeof value === 'string' ? value : ''),
    parse: (text: string) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' as const }
      return { kind: 'set' as const, value: trimmed }
    },
  }
}

/** indexRefreshMs 字段的 format/parse 规范：≥5000 的正整数毫秒。 */
function indexRefreshMsFieldSpec() {
  return {
    field: 'indexRefreshMs',
    format: (value: unknown) => (typeof value === 'number' ? String(value) : ''),
    parse: (text: string) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' as const }
      const n = Number(trimmed)
      if (!Number.isFinite(n) || n < 5000 || !Number.isInteger(n)) return undefined
      return { kind: 'set' as const, value: n }
    },
  }
}

/**
 * searchEnabled 字段的 format/parse 规范：布尔开关。
 * 详情页以 Switch 控件呈现，`format` 把布尔值映射为 'true'/'false' 文本
 * （与页面 `searchEnabled.text === 'true'` 的读法保持一致），
 * `parse` 把 'true'/'false' 文本解析回布尔值；空串清除回默认（true）。
 * 必须注册进 SettingsFormModel 的 specs —— 否则 `field('searchEnabled')`
 * 在 projection() 里抛 "plugin card has no field searchEnabled"。
 */
function searchEnabledFieldSpec() {
  return {
    field: 'searchEnabled',
    format: (value: unknown) =>
      typeof value === 'boolean' ? String(value) : '',
    parse: (text: string) => {
      const trimmed = text.trim().toLowerCase()
      if (trimmed === 'true') return { kind: 'set' as const, value: true }
      if (trimmed === 'false') return { kind: 'set' as const, value: false }
      if (trimmed === '') return { kind: 'clear' as const }
      return undefined
    },
  }
}

/** 把一个宿主 settings 命名空间桥接到详情页的 staged form。 */
function asFormScope(
  scope: ConfigForm<ObsidianSyncSettings>
): SettingsFormScope<ObsidianSyncSettings> {
  return {
    getSnapshot: () => {
      const s = scope.getSnapshot()
      return {
        status: s.status,
        value: s.value,
        base: s.base,
        user: s.user,
        writable: s.writable,
        revision: s.revision,
      }
    },
    subscribe: (listener) => scope.subscribe(listener),
    mutate: (ops, expectedRevision) => scope.mutate(ops as never, expectedRevision),
  }
}

/** 把命名空间的 `ConfigForm` 适配为详情页的 staged form。 */
export class ObsidianSyncPageController {
  private readonly form: SettingsFormModel<ObsidianSyncSettings>
  private readonly store: SnapshotStore<ObsidianSyncPageState>

  /** @param scope - 共享配置表单（命名空间的 ConfigForm）。 */
  constructor(scope: ConfigForm<ObsidianSyncSettings>) {
    this.form = new SettingsFormModel(asFormScope(scope), [
      vaultPathFieldSpec(),
      searchEnabledFieldSpec(),
      indexRefreshMsFieldSpec(),
    ])
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): ObsidianSyncPageState {
    return {
      ...this.form.shell(),
      vaultPath: this.form.field('vaultPath'),
      searchEnabled: this.form.field('searchEnabled'),
      indexRefreshMs: this.form.field('indexRefreshMs'),
    }
  }

  /** 构建详情页 slot 注册注入的面。 */
  inject(): ObsidianSyncPageFace {
    return { hooks: { obsidianSyncPage: this.store }, ...this.form.actions() }
  }

  /** 释放表单订阅。 */
  dispose(): void {
    this.form.dispose()
  }
}
