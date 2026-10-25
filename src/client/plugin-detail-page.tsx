/**
 * dsh-obsidian-sync 详情页：点击插件列表中的插件名字后打开的画面。
 * 展示使用前提条件（vault 路径 / 搜索开关 / 索引间隔）并带保存控件。
 */
import type * as React from 'react'
import type { PropsLocale, PropsRuntime, InjectFace, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { SettingsForm, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObsidianSyncPageFace } from './plugin-detail-controller.ts'
import css from './PluginDetailPage.module.css'

/** 渲染器为详情页绑定的 props。 */
export type ObsidianSyncDetailPageProps =
  & PropsRuntime<'plugins.bundle.config'>
  & PropsLocale<'settings.dsh-obsidian-sync'>
  & InjectFace<ObsidianSyncPageFace>

/** 从 locale 字典派生 SettingsForm 的标签文案。 */
function formLabels(t: TranslateNS<'settings.dsh-obsidian-sync'>) {
  return {
    unavailable: t('form.unavailable'),
    readOnly: t('form.readOnly'),
    saveFailed: t('form.saveFailed'),
    save: t('form.save'),
    saving: t('form.saving'),
  }
}

/**
 * 渲染详情页：一行摘要（`view: 'summary'`）或前提条件表单（`view: 'page'`）。
 * @param props - 视图、locale 文案、表单快照与动作。
 * @returns 摘要文字，或带保存控件的前提条件表单。
 */
export function ObsidianSyncDetailPage(props: ObsidianSyncDetailPageProps) {
  const { t } = props
  const state = props.useObsidianSyncPage((snapshot) => snapshot)

  if (props.view === 'summary') {
    return t('description')
  }

  const disabled = !state.writable
  const vaultPath = state.vaultPath
  const searchEnabled = state.searchEnabled
  const indexRefreshMs = state.indexRefreshMs

  // 布尔字段：以宿主当前值决定开/关，空草稿视为无用户覆盖 → 回落默认（true）。
  const searchOn = searchEnabled.text !== '' ? searchEnabled.text === 'true' : true

  return (
    <SettingsForm labels={formLabels(t)} state={state} onSave={props.save} onDiscard={props.discard}>
      <div className={css.page}>
        <div className={css.hint}>{t('page.vaultPath.hint')}</div>
        <div className={css.field}>
          <div className={css.fieldText}>
            <div className={css.title}>{t('page.vaultPath.label')}</div>
          </div>
          <input
            type="text"
            className={css.input}
            value={vaultPath.text}
            placeholder="E:/dsh-workspace/obsidian-vault"
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
              props.edit('vaultPath', e.target.value)
            }}
            disabled={disabled}
          />
        </div>

        <div className={css.field}>
          <div className={css.fieldText}>
            <div className={css.title}>{t('page.searchEnabled.label')}</div>
            <div className={css.subHint}>{t('page.searchEnabled.hint')}</div>
          </div>
          <Switch
            checked={searchOn}
            onChange={(next: boolean) => {
              props.edit('searchEnabled', String(next))
            }}
            label={t('page.searchEnabled.label')}
            disabled={disabled}
          />
        </div>

        <div className={css.field}>
          <div className={css.fieldText}>
            <div className={css.title}>{t('page.indexRefreshMs.label')}</div>
            <div className={css.subHint}>{t('page.indexRefreshMs.hint')}</div>
          </div>
          <input
            type="text"
            inputMode="numeric"
            className={css.inputSmall}
            value={indexRefreshMs.text}
            placeholder="60000"
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
              props.edit('indexRefreshMs', e.target.value)
            }}
            disabled={disabled}
          />
        </div>

        <div className={css.gitHint}>{t('page.gitHint')}</div>
      </div>
    </SettingsForm>
  )
}
