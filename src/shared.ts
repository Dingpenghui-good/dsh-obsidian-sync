/**
 * Shared constants usable by both the Host bundle and the Client bundle.
 * The client reads the settings namespace through this barrel so it never
 * value-imports a Host-only package such as `@deepseek-ai/dsh-fs`.
 */

/** The settings namespace is the profile entry id of this plugin row (cordis.yml `id`). */
export const OBSIDIAN_SYNC_NAMESPACE = 'dsh-obsidian-sync'

/** npm 包名：`plugins.bundle.config` slot 的 key。 */
export const PLUGIN_PACKAGE_NAME = 'dsh-obsidian-sync'

/** `plugins.row.config` slot 的 key：`<package>#<row id>`。 */
export const PLUGIN_ROW_CONFIG_KEY = `${PLUGIN_PACKAGE_NAME}#${OBSIDIAN_SYNC_NAMESPACE}`

/** 详情页编辑的字段 —— 命名空间 schema 的子集（前提条件）。 */
export interface ObsidianSyncSettings {
  /** Obsidian vault 绝对路径（前提条件 1：已存在的 vault 目录）。 */
  vaultPath?: string
  /** 是否启用按需搜索索引。 */
  searchEnabled?: boolean
  /** 索引增量重建间隔（毫秒，下限 5000）。 */
  indexRefreshMs?: number
}
