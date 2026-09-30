/**
 * DSH Obsidian Sync — 按需搜索 Obsidian 知识库 + 按 vault 既有 PARA 规则归档 DSH 会话。
 *
 * 设计理念（零 token / 高性能）：
 *   - 纯模型 Tool 按需调用，不注入系统提示词（默认 token 成本 ≈ 两个 Tool 的 schema）
 *   - 进程内 fs 服务（resolve/stat/listDir/readText/writeText），不起子进程
 *   - 倒排索引 + 60s 增量重建（dirty 标记，跳过 .obsidian/.git）
 *   - 按 session 幂等 upsert：摘要未变则跳过写盘
 *   - 笔记写入 vault/04-Archive/，自动挂 DSH-会话归档-索引.md 的按日期段
 *   - 落款支持 raw_log 原始日志指针，贴合 vault 既有笔记惯例
 *
 * 使用前提（在插件详情页设置，保存后经 volatile HMR 即时生效，无需重启）：
 *   1. vaultPath —— 必须指向一个已存在的 Obsidian vault 目录（PARA 结构：
 *      02-Projects / 03-Areas / 04-Archive / 05-Resources 与 DSH-会话归档-索引.md）。
 *      路径错则搜索与归档全部失败。默认 E:/dsh-workspace/obsidian-vault。
 *   2. searchEnabled —— 是否注册倒排索引搜索（obsidian.search / obsidian.brief）。
 *      关闭后仅保留 obsidian.read_note 与 obsidian.sync_session。默认 true。
 *   3. indexRefreshMs —— 索引增量重建 / vault 外部变更感知间隔（≥5000ms）。默认 60000ms。
 *   4. git 自动推送（隐含前提，无需设置）：vault 是 git 仓库且配置了 remote 时，
 *      归档笔记会自动 git commit + push；不满足时笔记仍正常写入，git 步骤在结果中降级提示。
 *
 * @module dsh-obsidian-sync
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// 宿主 Service 由运行时组合（宿主包由宿主自己安装）；插件包声明为普通
// 依赖只会与宿主的版本产生 peer 漂移（如 0.2.0-rc.2 vs 0.2.0-rc.1），
// 导致启动时整组插件卡在“等待服务”。因此这里仅做类型导入，不产生运行时依赖。
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { FileSystem, FsDirEntry, FsTarget } from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** 把工具返回值断言为 JsonValue（0.2.0-rc.1 的 execute 要求返回 InferValue，
 *  即 output.schema 推断出的 JsonValue；对象 union 的 undefined 分支在此收敛）。 */
function asJsonValue(v: unknown): JsonValue {
  return v as JsonValue
}

/** Cordis 插件名。 */
export const name = 'obsidian-sync'

/** 本插件需要的 Service（`tools`/`fs` 为硬依赖，缺失时等待 Cordis 重激活）。
 *  仅保留真实消费的 Service：settings 是可选增强（未组合时降级为默认值）。 */
export const inject = ['tools', 'fs']

/** 插件配置。schema 字段标记 `.volatile()`：宿主 settings 框架投影到浏览器
 *  设置页，详情页保存后经 profile Cordis patch + volatile HMR 即时生效，无需重启。
 *  接口本身保留普通类型（与已验证的 conversation-language 插件一致），
 *  volatile 语义由 schema 与 Loader 承担。 */
export interface Config {
  /** Obsidian vault 绝对路径；缺省 `E:/dsh-workspace/obsidian-vault`。 */
  vaultPath: string
  /** 是否注册 obsidian.search（倒排索引 + 定时增量重建）。 */
  searchEnabled: boolean
  /** 索引增量重建间隔（毫秒，下限 5000）。 */
  indexRefreshMs: number
}

/**
 * Schemastery 配置 schema：加载器用它解析行 `config` 并补默认值。
 *
 * 注意 Schemastery 的 API 与 zod 不同：没有 `.optional()` / `.int()`。
 * 对象属性默认即可选（不调用 `.required()` 时，缺失键不会写入解析结果），
 * 整数约束通过 `.step(1)` 表达。
 */
/** 运行时 schema：volatile 标记 + 默认值。Loader 据此解析行 config 并补默认。 */
export const Config = z.object({
  vaultPath: z.string().volatile().default('E:/dsh-workspace/obsidian-vault'),
  searchEnabled: z.boolean().default(true).volatile(),
  indexRefreshMs: z.number().step(1).min(5000).default(60000).volatile(),
})

export function apply(ctx: Context): void {
  // 0.2.0-rc.1 settings API：describe() 返回按 profile entry id 排序的行，
  // 本插件的 entry id 是 dsh-obsidian-sync（cordis.yml 中的 id）。
  // 行 value 由 Loader 按本文件导出的 Config schema 解析并补默认值，
  // volatile HMR 保存后经 settings 框架即时刷新，读到的就是当前生效值。
  /** settings 服务是可选增强：未组合时降级为默认值。
   *  按 SettingsDescriptor 契约读命名空间行（ns + value 由 Loader 按
   *  本文件导出的 Config schema 解析并补默认值；volatile HMR 保存后即时刷新）。 */
  const settings = ctx.get('settings') as {
    describe(): Array<{ ns: string; value?: unknown }>
  } | undefined

  /** 读命名空间行 value。 */
  const readSection = (): Record<string, unknown> | undefined => {
    if (settings === undefined) return undefined
    try {
      const row = settings.describe().find((r) => r.ns === 'dsh-obsidian-sync')
      const v = row?.value
      return (v !== null && typeof v === 'object') ? (v as Record<string, unknown>) : undefined
    } catch (_e) {
      return undefined
    }
  }

  // vault 路径是插件核心前提：缺省 E:/dsh-workspace/obsidian-vault。
  const resolvedVaultPath: string =
    (typeof readSection()?.vaultPath === 'string' && (readSection() as Record<string, string>).vaultPath.length > 0)
      ? (readSection() as Record<string, string>).vaultPath
      : 'E:/dsh-workspace/obsidian-vault'
  const readSearchEnabled = (): boolean => {
    const v = readSection()?.searchEnabled
    return typeof v === 'boolean' ? v : true
  }
  const readIndexRefreshMs = (): number => {
    const v = readSection()?.indexRefreshMs
    return typeof v === 'number' && v >= 5000 ? v : 60000
  }

  let searchEnabled = readSearchEnabled()
  const refreshMs = Math.max(readIndexRefreshMs(), 5000)

  // 详情页保存 searchEnabled 后 volatile HMR 会重新挂载本插件（Loader 重激活），
  // 因此无需在本实例内监听 settings/document-updated 刷新 —— 保存即重建。

  const fs = ctx.fs as unknown as FileSystem
  // 0.2.0-rc.1 不再提供 ctx.timer 服务；改用 Node 原生 setInterval，
  // 通过 ctx.effect 的清理函数保证插件卸载时定时器被清除。
  const index = new Map<string, { displayPath: string; tokens: Set<string>; snippet: string; size: number; version: string }>()
  let dirty = true
  let refreshing = false

  /**
   * vault 外部修改感知（stat 比对 version token）：
   * 快速 stat 每篇已索引文件的 version（不透明新鲜度令牌），发现外部变更
   * （用户手动编辑 / 其他工具写入 / git pull）即置 dirty。
   * 0.2.0-rc.1 的 FsInfo 不再暴露 mtimeMs，改以 opaque version token 比对；
   * 同内容文件的 version 相同，任何写入/删除都会改变它。stat 代价极小（~60 篇 × ms 级）。
   */
  async function detectExternalChanges(): Promise<void> {
    if (index.size === 0) return
    for (const entry of index.values()) {
      try {
        const target = await fs.resolve(entry.displayPath)
        const stat = await fs.stat(target)
        if (stat !== undefined) {
          if (String(stat.version) !== String(entry.version)) {
            dirty = true
            return
          }
        } else {
          // 目标已不存在 → 视为变更
          dirty = true
          return
        }
      } catch (_e) {
        // 文件被外部删除 → 也视为变更
        dirty = true
        return
      }
    }
    // 新文件检测：listDir 顶层 04-Archive / 02-Projects / 03-Areas，出现未知前缀即 dirty
    for (const sub of ['04-Archive', '02-Projects', '03-Areas', '05-Resources']) {
      try {
        const dir = await fs.resolve(resolvedVaultPath + '/' + sub)
        const entries = await fs.listDir(dir)
        for (const e of entries) {
          if (e.type !== 'file' || e.name === undefined || !e.name.endsWith('.md')) continue
          const known = [...index.keys()].some(k => k.endsWith('/' + e.name) || k === sub + '/' + e.name)
          if (!known) {
            dirty = true
            return
          }
        }
      } catch (_e) { /* 目录不存在，跳过 */ }
    }
  }

  /**
   * 分词：ASCII 重叠三元组 + 中文滑动二元组（bigram）。
   *
   * - ASCII 字母数字：长度 ≥2 直接加入；长度 ≥4 额外加 i+=1 重叠三元组
   * - 中文：按 Unicode CJK 字符切分，长度 1 直接加入，≥2 加滑动 bigram
   *   这样「知识库」/「知识」可以互相命中，「连不上」/「连接不上」同理
   */
  function tokenize(text: string): Set<string> {
    const lower = String(text).toLowerCase()
    const seen = new Set<string>()
    // 连续 ASCII 字母数字段
    const asciiRe = /[a-z0-9]+/g
    let m: RegExpExecArray | null
    while ((m = asciiRe.exec(lower)) !== null) {
      const p = m[0]
      if (p.length < 2) continue
      seen.add(p)
      if (p.length >= 4) {
        for (let i = 0; i + 3 <= p.length; i++) seen.add(p.slice(i, i + 3))
      }
    }
    // 连续 CJK 段
    const cjkRe = /[\u4e00-\u9fff]+/g
    while ((m = cjkRe.exec(lower)) !== null) {
      const p = m[0]
      if (p.length === 1) {
        seen.add(p)
      } else {
        for (let i = 0; i + 2 <= p.length; i++) seen.add(p.slice(i, i + 2))
        if (p.length >= 3) seen.add(p.slice(p.length - 3))
      }
    }
    return seen
  }

  /** 为索引 entry 计算 IDF 权重表（token → 1/log(1+df)）。 */
  function buildIdf(entries: Array<{ tokens: Set<string> }>): Map<string, number> {
    const df = new Map<string, number>()
    for (const entry of entries) {
      for (const t of entry.tokens) {
        df.set(t, (df.get(t) ?? 0) + 1)
      }
    }
    const total = entries.length || 1
    const idf = new Map<string, number>()
    for (const [t, count] of df) {
      idf.set(t, Math.log(total / (1 + count)))
    }
    return idf
  }

  async function rebuildIndex(): Promise<void> {
    refreshing = true
    try {
      const next = new Map(index)
      const idfEntries: Array<{ tokens: Set<string> }> = []
      try {
        const root = await fs.resolve(resolvedVaultPath)
        const statRoot = await fs.stat(root)
        if (statRoot !== undefined && statRoot.type === 'directory') {
          const queue: FsTarget[] = [root]
          while (queue.length > 0) {
            const dir = queue.shift()!
            let entries: FsDirEntry[]
            try { entries = await fs.listDir(dir) } catch (_e) { continue }
            for (const entry of entries) {
              if (entry.type === 'directory') {
                const entryName = entry.name || ''
                if (entryName === '.obsidian' || entryName === '.git') continue
                queue.push(entry.target)
                continue
              }
              if (entry.type !== 'file' || entry.name === undefined || !entry.name.endsWith('.md') || entry.name.startsWith('.')) continue
              let text: string
              try { text = await fs.readText(entry.target) } catch (_e) { continue }
              // 索引吃全文（~46 篇 × 几 KB，内存无压力），不再只取前 600 字
              const tokens = tokenize('\n' + entry.name + '\n' + text)
              const displayPath = entry.target && typeof entry.target === 'object' ? entry.target.displayPath : String(entry.target ?? '')
              const stat = await fs.stat(entry.target)
              next.set(displayPath, {
                displayPath,
                tokens,
                snippet: text.slice(0, 240),
                size: entry.size ?? text.length,
                version: stat !== undefined ? String(stat.version) : '',
              })
              idfEntries.push({ tokens })
            }
          }
        }
      } catch (_e) { /* vault 不可达：保留旧索引 */ }
      index.clear()
      for (const kv of next) index.set(kv[0], kv[1])
      // 重建 IDF 权重表
      idfTable = buildIdf(idfEntries)
      dirty = false
    } finally {
      refreshing = false
    }
  }

  let idfTable = new Map<string, number>()

  async function ensureIndex(): Promise<void> {
    if (dirty) await rebuildIndex()
    else while (refreshing) await new Promise(resolve => setTimeout(resolve, 20))
  }

  if (searchEnabled) {
    ctx.effect(() => {
      const handle = setInterval(() => {
        if (dirty) {
          void rebuildIndex()
          return
        }
        // 非 dirty 时做外部修改感知：stat 比对 version token，发现外部变更才置 dirty 下轮重建
        void detectExternalChanges().then(() => {
          if (dirty) void rebuildIndex()
        })
      }, refreshMs)
      return () => { clearInterval(handle) }
    }, 'obsidian-sync: index refresh')
  }

  function searchMatches(topic: string, limit: number): Array<{ file: string; score: number; snippet: string; size: number; matchReason: string }> {
    const topicTokens = tokenize(topic)
    const results: Array<{ file: string; score: number; snippet: string; size: number; matchReason: string }> = []
    for (const entry of index.values()) {
      let score = 0
      const matchedKeywords: string[] = []
      for (const t of topicTokens) {
        if (entry.tokens.has(t)) {
          score += idfTable.get(t) ?? 1
          matchedKeywords.push(t)
        }
      }
      if (score === 0) continue
      results.push({
        file: entry.displayPath,
        score: Math.round(score * 100) / 100,
        snippet: entry.snippet,
        size: entry.size,
        matchReason: matchedKeywords.slice(0, 5).join(' '),
      })
    }
    results.sort((a, b) => b.score - a.score)
    return results.slice(0, limit)
  }

  function sanitizeTitleForFilename(title: string): string {
    const base = String(title || '')
      .replace(/[\\/:*?"<>|（）()]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    return base.length > 0 ? base.slice(0, 40) : '会话'
  }

  /**
   * 噪声会话判定：身份测试类（"你是谁" / "你是什么模型" / "介绍一下自己" / 冒烟测试）
   * 且摘要很短（≤ 摘要阈值字，近似单轮短会话）→ 不写笔记不进索引。
   *
   * 双重条件避免误杀：标题命中噪声模式 且 摘要长度 ≤ 阈值。
   * 摘要长的"你是谁"类会话（用户有实质讨论）仍正常归档。
   */
  const NOISE_TITLE_PATTERNS: RegExp[] = [
    /^你是谁$/,
    /^你是什么(大)?模型$/,
    /^介绍(一下)?自己$/,
    /^自我(介绍|认识)?$/,
    /^echo\s+\S+$/i,
    /^测试$/,
  ]
  const NOISE_SUMMARY_MAX_CHARS = 200

  function isNoiseSession(title: string, summary: string): boolean {
    const t = String(title || '').trim()
    const hit = NOISE_TITLE_PATTERNS.some(re => re.test(t))
    if (!hit) return false
    return String(summary || '').trim().length <= NOISE_SUMMARY_MAX_CHARS
  }

  /** 确保 shortId 恰好 8 位：不足时补 SHA-1 前缀 hash。 */
  function normalizeShortId(sessionId: string): string {
    let s = sessionId.replace(/[^A-Za-z0-9]/g, '')
    if (s.length >= 8) return s.slice(0, 8)
    // 不足 8 位：用原始 sessionId 的简单 hash 补齐
    let hash = 0
    for (let i = 0; i < sessionId.length; i++) {
      hash = ((hash << 5) - hash + sessionId.charCodeAt(i)) | 0
    }
    s = s + Math.abs(hash).toString(16).slice(0, 8)
    return s.slice(0, 8)
  }

  /** vault 在 workspace 之外，写入需按调用抬升到 danger-full-access。 */
  const widePolicy: SandboxExecutionPolicy = { mode: 'danger-full-access', workspaceRoot: resolvedVaultPath }

  /**
   * 每日 22:00 复盘沉淀节律：
   * - 汇总当天 04-Archive 归档（按日期前缀统计笔记数与主题关键词）
   * - 把当天要点追加到 02-Projects/ 下匹配项目的"近期演进"段（幂等：当天已追加则跳过）
   * - git commit + push
   *
   * 实现：60s 轮询，发现跨过当天 22:00 且尚未执行过 → 执行一次。
   */
  let lastReviewDate = ''

  async function dailyReview(): Promise<void> {
    const now = new Date()
    const dateStr = now.toISOString().slice(0, 10)
    // 只在 22:00 之后（本地时区）且当天未执行时触发
    const hour = now.getHours()
    if (hour < 22 || lastReviewDate === dateStr) return
    lastReviewDate = dateStr

    try {
      await ensureIndex()

      // 1. 汇总当天归档
      const todayFiles: Array<{ file: string; date: string; snippet: string }> = []
      for (const entry of index.values()) {
        if (!entry.displayPath.includes('04-Archive/')) continue
        const m = entry.displayPath.match(new RegExp('^.*?(\\d{4}-\\d{2}-\\d{2})'))
        if (m && m[1] === dateStr) {
          todayFiles.push({ file: entry.displayPath, date: dateStr, snippet: entry.snippet })
        }
      }
      if (todayFiles.length === 0) return

      // 2. 对每个 02-Projects 页追加当天归档条目（幂等）
      for (const proj of ['02-Projects/dsh-obsidian-sync.md', '02-Projects/dsh-tool-agnes.md', '02-Projects/dsh-plugin-manager.md', '02-Projects/dsh-conversation-language.md']) {
        try {
          const target = await fs.resolve(resolvedVaultPath + '/' + proj)
          let content = String(await fs.readText(target))
          const marker = '## 近期演进'
          const markerPos = content.indexOf(marker)
          if (markerPos === -1) continue
          // 检查当天是否已追加（幂等）
          if (content.indexOf(dateStr) !== -1 && content.indexOf(dateStr) > markerPos) continue
          const todayLines = todayFiles.map(f => '- [[04-Archive/' + f.file.replace(/^04-Archive\//, '') + ']] — ' + f.snippet.slice(0, 80).replace(/\n/g, ' ')).join('\n')
          content = content.slice(0, content.length) + '\n' + dateStr + ' 归档：\n' + todayLines + '\n'
          await fs.writeText(target, content, undefined, undefined, widePolicy)
        } catch (_e) { /* 文件不存在或写入失败，跳过 */ }
      }

      dirty = true

      // 3. git commit + push
      try {
        const { execSync } = await import('node:child_process')
        const out = execSync('git add -A && git status --porcelain', {
          cwd: resolvedVaultPath, timeout: 15000, encoding: 'utf-8',
        })
        if (out.trim().length > 0) {
          execSync('git commit -m "daily-review: ' + dateStr + ' 归档沉淀（' + todayFiles.length + ' 篇）" && git push', {
            cwd: resolvedVaultPath, timeout: 60000, encoding: 'utf-8',
          })
        }
      } catch (_e) { /* git 失败不影响 */ }
    } catch (_e) { /* 整体失败静默 */ }
  }

  ctx.effect(() => {
    const handle = setInterval(() => {
      void dailyReview()
    }, 60000)
    return () => { clearInterval(handle) }
  }, 'obsidian-sync: daily review at 22:00')

  /**
   * 每周复盘沉淀节律（补齐决策习惯页"周复盘尚未建立"的开放问题）：
   * - 每周日 22:30 触发（本地时区），汇总本 ISO 周（周一~周日）04-Archive 归档
   * - 写入/更新 03-Areas/周复盘-<ISO 周>.md（主题分布 + 归档清单 + 待收敛项）
   * - 幂等：同 ISO 周已生成则跳过；git commit + push
   */
  let lastWeeklyKey = ''

  function isoWeekKey(d: Date): string {
    // ISO 周：周四归属所在周；周一为周首
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
    const day = t.getUTCDay() || 7
    t.setUTCDate(t.getUTCDate() + 4 - day)
    const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
    const week = Math.ceil((((+t - +yearStart) / 86400000) + 1) / 7)
    return t.getUTCFullYear() + '-W' + String(week).padStart(2, '0')
  }

  async function weeklyReview(): Promise<void> {
    const now = new Date()
    const dow = now.getDay() // 0=Sun
    if (dow !== 0 || now.getHours() < 22) return
    const weekKey = isoWeekKey(now)
    if (lastWeeklyKey === weekKey) return
    lastWeeklyKey = weekKey

    try {
      await ensureIndex()
      const weekDate = new Date(now)
      weekDate.setDate(now.getDate() - 6) // 周一
      const monday = weekDate.toISOString().slice(0, 10)

      // 汇总本周归档（文件名日期 >= 周一 且 <= 今天）
      const weekFiles: Array<{ file: string; date: string; snippet: string }> = []
      for (const entry of index.values()) {
        if (!entry.displayPath.includes('04-Archive/')) continue
        const m = entry.displayPath.match(/(\d{4}-\d{2}-\d{2})/)
        if (m && m[1] >= monday && m[1] <= now.toISOString().slice(0, 10)) {
          weekFiles.push({ file: entry.displayPath, date: m[1], snippet: entry.snippet })
        }
      }
      weekFiles.sort((a, b) => a.date.localeCompare(b.date))
      if (weekFiles.length === 0) return

      // 主题分布（按 04-Archive 笔记 frontmatter tags 简化：从 snippet 首行提取）
      const lines = weekFiles.map(f => '- [[04-Archive/' + f.file.replace(/^04-Archive\//, '') + ']]（' + f.date + '）— ' + f.snippet.slice(0, 60).replace(/\n/g, ' ')).join('\n')
      const note = '---\ndate: ' + now.toISOString().slice(0, 10) + '\nstatus: active\ntags: [area, 周复盘]\n---\n\n# 周复盘 ' + weekKey + '\n\n> 自动汇总 ' + monday + ' ~ ' + now.toISOString().slice(0, 10) + ' 的 04-Archive 归档（' + weekFiles.length + ' 篇）。\n\n## 本周归档\n\n' + lines + '\n\n## 待收敛\n\n- [ ] 人工审阅：识别本周新增的长期 Area / Resource 沉淀点\n\n'
      const target = await fs.resolve(resolvedVaultPath + '/03-Areas/周复盘-' + weekKey + '.md')
      let skipped = false
      try {
        const prev = String(await fs.readText(target))
        if (prev.includes(weekKey)) skipped = true
      } catch (_e) { /* 尚不存在 */ }
      if (!skipped) await fs.writeText(target, note, undefined, undefined, widePolicy)

      dirty = true
      try {
        const { execSync } = await import('node:child_process')
        const out = execSync('git add -A && git status --porcelain', { cwd: resolvedVaultPath, timeout: 15000, encoding: 'utf-8' })
        if (out.trim().length > 0) {
          execSync('git commit -m "weekly-review: ' + weekKey + ' 归档沉淀（' + weekFiles.length + ' 篇）" && git push', { cwd: resolvedVaultPath, timeout: 60000, encoding: 'utf-8' })
        }
      } catch (_e) { /* git 失败不影响 */ }
    } catch (_e) { /* 整体失败静默 */ }
  }

  ctx.effect(() => {
    const handle = setInterval(() => {
      void weeklyReview()
    }, 60000)
    return () => { clearInterval(handle) }
  }, 'obsidian-sync: weekly review at Sunday 22:30')

  /**
   * 更新索引文件（DSH-会话归档-索引.md）的按日期段。
   * - 找到当天段落（### YYYY-MM-DD）
   * - 边界：下一个 `### ` 或 `## `（两个井号终止条件）
   * - 同 shortId 已有条目 → 替换该行（幂等去重）
   * - 否则追加到当天段落末尾
   */
  async function updateIndexFile(entryRelPath: string, title: string, sessionId: string, dateStr: string): Promise<boolean> {
    try {
      const idxTarget = await fs.resolve(resolvedVaultPath + '/DSH-会话归档-索引.md')
      const idxContent = String(await fs.readText(idxTarget))
      const dayAnchor = '### ' + dateStr
      const line = '\n- [[' + entryRelPath + '|' + title + ']] (' + dateStr + ', ' + sessionId + ')\n'
      const dayPos = idxContent.indexOf(dayAnchor)
      if (dayPos === -1) {
        // 当天段落不存在：在 "## 主题分类" 之前插入
        const dayHeader = '\n### ' + dateStr + '\n' + line
        const tailPos = idxContent.indexOf('\n## 主题分类')
        const updated = tailPos === -1 ? idxContent + dayHeader : idxContent.slice(0, tailPos) + dayHeader + idxContent.slice(tailPos)
        await fs.writeText(idxTarget, updated, undefined, undefined, widePolicy)
        return true
      }
      // 找当天段落的结尾：下一个 `### ` 或 `## `（双井号终止）
      const afterAnchor = dayPos + dayAnchor.length
      const nextH3 = idxContent.indexOf('\n### ', afterAnchor)
      const nextH2 = idxContent.indexOf('\n## ', afterAnchor)
      let dayEnd = -1
      if (nextH3 !== -1 && nextH2 !== -1) dayEnd = Math.min(nextH3, nextH2)
      else if (nextH3 !== -1) dayEnd = nextH3
      else if (nextH2 !== -1) dayEnd = nextH2
      else dayEnd = idxContent.length

      // 去重：当天段落内是否已有相同 shortId 的条目
      const daySection = idxContent.slice(afterAnchor, dayEnd)
      const shortId = normalizeShortId(sessionId)
      const dedupePattern = new RegExp('^- \\[\\[[^\\]]*' + dateStr + '-' + shortId + '-[^\\]]*\\]\\]\\s*\\([^\\)]*\\)$', 'm')
      const existingMatch = daySection.match(dedupePattern)
      let updated: string
      if (existingMatch !== null) {
        // 替换已有行（幂等）
        const absPos = afterAnchor + daySection.indexOf(existingMatch[0])
        updated = idxContent.slice(0, absPos) + line.trimStart() + '\n' + idxContent.slice(absPos + existingMatch[0].length)
      } else {
        // 追加到段落末尾（dayEnd 前）
        updated = idxContent.slice(0, dayEnd) + line + idxContent.slice(dayEnd)
      }
      await fs.writeText(idxTarget, updated, undefined, undefined, widePolicy)
      return true
    } catch (_e) {
      return false
    }
  }

  /** 从索引中按目录前缀过滤 + 按 task 相关性取 top N 提炼页。 */
  function topDistilled(task: string, limit: number): Array<{ file: string; title: string; score: number; snippet: string }> {
    const distilledDirs = ['02-Projects/', '03-Areas/', '05-Resources/']
    const taskTokens = task.trim().length > 0 ? tokenize(task) : new Set<string>()
    const results: Array<{ file: string; title: string; score: number; snippet: string }> = []
    for (const entry of index.values()) {
      if (!distilledDirs.some(d => entry.displayPath.includes(d))) continue
      let score = 0
      for (const t of taskTokens) {
        if (entry.tokens.has(t)) score += idfTable.get(t) ?? 1
      }
      const title = entry.displayPath.split('/').pop() ?? entry.displayPath
      results.push({ file: entry.displayPath, title, score: taskTokens.size > 0 ? Math.round(score * 100) / 100 : 0, snippet: entry.snippet })
    }
    results.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    return results.slice(0, limit)
  }

  /** 从 04-Archive/ 取最近 N 篇（按文件名日期倒序）。 */
  function recentArchives(limit: number): Array<{ file: string; date: string; snippet: string }> {
    const results: Array<{ file: string; date: string; snippet: string }> = []
    for (const entry of index.values()) {
      if (!entry.displayPath.includes('04-Archive/')) continue
      const dateMatch = entry.displayPath.match(/(\d{4}-\d{2}-\d{2})/)
      results.push({ file: entry.displayPath, date: dateMatch ? dateMatch[1] : 'unknown', snippet: entry.snippet })
    }
    results.sort((a, b) => b.date.localeCompare(a.date))
    return results.slice(0, limit)
  }

  /** 读取指定相对路径的文件内容。 */
  async function readFileContent(relPath: string): Promise<string> {
    try {
      const target = await fs.resolve(resolvedVaultPath + '/' + relPath)
      return String(await fs.readText(target))
    } catch (_e) {
      return ''
    }
  }

  if (searchEnabled) {
    ctx.tools.register(defineTool({
      name: 'obsidian.search',
      description: '在 Obsidian 知识库中按关键词搜索相关笔记，返回最多 5 条匹配（文件相对路径、命中片段、命中关键词）。按需调用，平时不产生任何 token 成本。',
      parameters: {
        topic: { type: 'string', required: true, description: '搜索关键词，可含多个词（中英文均可，自动做 CJK bigram 分词）' },
        limit: { type: 'number', description: '返回结果上限，默认 3，最大 5' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        const topic = String(args.topic ?? '')
        if (topic.trim().length === 0) return asJsonValue({ ok: false, error: 'topic must not be empty' })
        const limit = Math.min(Math.max(1, Number(args.limit) || 3), 5)
        await ensureIndex()
        const matches = searchMatches(topic, limit)
        return asJsonValue({ ok: true, matches, count: matches.length, vaultPath: resolvedVaultPath })
      },
    }))

    ctx.tools.register(defineTool({
      name: 'obsidian.brief',
      description: '每日简报：返回与当前任务最相关的提炼页（02-Projects/03-Areas/05-Resources）top 3 + 最近 3 条归档摘要 + 用户决策习惯与偏好页内容。低成本"开机记忆"入口，建议任务开始前调用一次。',
      parameters: {
        task: { type: 'string', description: '当前任务描述（可选），用于相关性排序；省略则返回全部提炼页按名称排序的 top 3' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        const task = String(args.task ?? '').trim()
        await ensureIndex()

        // 1. 提炼页 top 3
        const distilled = topDistilled(task, 3)

        // 2. 最近归档 3 条
        const recent = recentArchives(3)

        // 3. 用户决策习惯与偏好页（03-Areas 下，如果存在）
        let userProfile = ''
        const profileRelPath = '03-Areas/决策习惯与偏好.md'
        const hasProfile = [...index.values()].some(e => e.displayPath === profileRelPath)
        if (hasProfile) {
          userProfile = await readFileContent(profileRelPath)
        }

        return asJsonValue({
          ok: true,
          task: task || '(未指定)',
          distilled,
          recent,
          userProfile: userProfile.length > 0 ? userProfile.slice(0, 2000) : '',
          vaultPath: resolvedVaultPath,
        })
      },
    }))

    ctx.tools.register(defineTool({
      name: 'obsidian.read_note',
      description: '按相对路径读取 Obsidian 笔记的 frontmatter 与正文，补全 obsidian.search 的"搜索→阅读"闭环。路径相对 vault 根（如 02-Projects/dsh-obsidian-sync.md），自动解析 YAML frontmatter（key: value / [list] / 数值 / 布尔）。按需调用，零 token 成本。',
      parameters: {
        path: { type: 'string', required: true, description: '笔记相对 vault 的路径（如 02-Projects/dsh-obsidian-sync.md 或 04-Archive/xxx.md）' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        const rel = String(args.path ?? '').replace(/^\/+/, '').replace(/\\/g, '/').trim()
        if (rel.length === 0) return asJsonValue({ ok: false, error: 'path must not be empty', code: 'EMPTY_PATH' })
        const content = await readFileContent(rel)
        if (content.length === 0) return asJsonValue({ ok: false, error: 'note not found or unreadable: ' + rel, code: 'NOT_FOUND' })

        // 解析 YAML frontmatter（简单 key: value / key: [a, b] / key: "str"）
        const frontmatter: Record<string, unknown> = {}
        let body = content
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?/)
        if (fmMatch !== null) {
          body = content.slice(fmMatch[0].length)
          for (const line of fmMatch[1].split('\n')) {
            const kv = line.match(/^([A-Za-z0-9_\-]+):\s*(.*)$/)
            if (kv === null) continue
            const key = kv[1]
            let raw = kv[2].trim()
            let val: unknown
            if (raw.startsWith('[') && raw.endsWith(']')) {
              const inner = raw.slice(1, -1).trim()
              val = inner.length === 0 ? [] : inner.split(',').map((s: string) => s.trim().replace(/^["']|["']$/g, ''))
            } else if (raw === 'null') {
              val = null
            } else if (raw === 'true') {
              val = true
            } else if (raw === 'false') {
              val = false
            } else if (/^\d+$/.test(raw)) {
              val = Number(raw)
            } else {
              val = raw.replace(/^["']|["']$/g, '')
            }
            frontmatter[key] = val
          }
        }

        const titleLine = body.match(/^#\s+(.+)$/m)
        return asJsonValue({
          ok: true,
          path: rel,
          frontmatter,
          title: titleLine ? titleLine[1].trim() : (rel.split('/').pop() ?? rel),
          body,
        })
      },
    }))
  }

  ctx.tools.register(defineTool({
    name: 'obsidian.sync_session',
    description: '把当前 DSH 会话按 Obsidian vault 的 PARA 结构与用户既有命名/索引规则，以 Markdown 笔记形式幂等写入 vault/04-Archive/，并自动把新条目挂到 DSH-会话归档-索引.md 的按日期段。摘要未变则跳过。幂等键 = date + shortId（标题变更不影响去重）。',
    parameters: {
      session_id: { type: 'string', required: true, description: '当前会话的完整 SessionId（UUID 或短 ID），原样存入 frontmatter 与正文' },
      title: { type: 'string', required: true, description: '会话主题标题（写入 frontmatter 与正文 # 标题；文件名仅取前 40 字符做安全截断）' },
      summary: { type: 'string', required: true, description: '会话结论/摘要（纯文本，建议 200-800 字，包含用户需求、过程要点、交付物）' },
      tags: { type: 'array', items: { type: 'string' }, description: '主题标签数组，最多 10 个，将写入 frontmatter tags 字段（Obsidian 原生标签）' },
      related: { type: 'array', items: { type: 'string' }, description: '关联笔记完整文件名（含 .md 扩展名，如 2026-09-11-a9095879-xxx.md），将生成为 [[全路径双链]]' },
      raw_log: { type: 'string', description: '原始会话日志绝对路径，格式 ~/.dsh/sessions/<project-dir>/session-<uuid>/session.v3.jsonl.zstd，将写入落款以便追溯' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      const sessionId = String(args.session_id ?? 'unknown')
      const title = String(args.title ?? '')
      const safeTitle = sanitizeTitleForFilename(title)
      const summary = String(args.summary ?? '')
      const tags = Array.isArray(args.tags) ? args.tags.map(String).slice(0, 10) : []
      const related = Array.isArray(args.related) ? args.related.map(String).slice(0, 10) : []
      const rawLog = String(args.raw_log ?? '')

      // 噪声会话过滤：身份测试类 + 摘要极短 → 不写笔记不进索引
      if (isNoiseSession(title, summary)) {
        return asJsonValue({ ok: true, skipped: true, noise: true, reason: 'identity-test noise session filtered out (short title + short summary)', index: 'unchanged' })
      }

      const dateStr = new Date().toISOString().slice(0, 10)
      const shortId = normalizeShortId(sessionId)

      // 幂等键 = date + shortId（标题不参与路径），写入前按前缀探测已存在文件并原地覆盖
      const entryPrefix = dateStr + '-' + shortId + '-'
      let entryRelPath: string

      // 探测 04-Archive/ 下是否已有同前缀文件（同会话多次同步）
      try {
        const archiveDir = await fs.resolve(resolvedVaultPath + '/04-Archive')
        const archiveEntries = await fs.listDir(archiveDir)
        const existing = archiveEntries.find(e => e.type === 'file' && e.name?.startsWith(entryPrefix))
        if (existing !== undefined && existing.name !== undefined) {
          // 已有文件：原地覆盖（标题可能变了但幂等键不变）
          entryRelPath = '04-Archive/' + existing.name
        } else {
          entryRelPath = '04-Archive/' + entryPrefix + safeTitle + '.md'
        }
      } catch (_e) {
        entryRelPath = '04-Archive/' + entryPrefix + safeTitle + '.md'
      }

      // related 双链：生成全路径 [[04-Archive/xxx.md|显示名]]，写入前校验目标存在
      const relatedLines: string[] = []
      for (const r of related) {
        const rFull = r.endsWith('.md') ? r : r + '.md'
        const rRel = '04-Archive/' + rFull
        // 校验目标存在（全路径双链）
        try {
          await fs.stat(await fs.resolve(resolvedVaultPath + '/' + rRel))
          relatedLines.push('- [[' + rRel + '|' + rFull.replace(/^.*\//, '').replace(/\.md$/, '') + ']]')
        } catch (_e) {
          relatedLines.push('- ' + rFull + '（未找到，降级为文字引用）')
        }
      }

      // 生成 YAML frontmatter（Obsidian 原生标签 / Dataview 可查）
      const fmDate = dateStr
      const fmSessionId = sessionId.replace(/[^A-Za-z0-9-]/g, '').slice(0, 8)
      const fmTags = tags.length > 0 ? tags : []
      const frontmatter = [
        '---',
        'session_id: ' + fmSessionId,
        'full_session_id: ' + sessionId,
        'date: ' + fmDate,
        'tags: [' + fmTags.join(', ') + ']',
        '---',
        '',
      ].join('\n')

      const logLine = rawLog.trim().length > 0
        ? '> 📎 原始日志: `' + rawLog.trim() + '`\n\n> 由 DSH Obsidian Sync 自动同步\n'
        : '> 由 DSH Obsidian Sync 自动同步\n'

      const content = frontmatter
        + '# DSH 会话: ' + title + '\n\n'
        + '## 基本信息\n\n'
        + '| 属性 | 值 |\n|------|-----|\n'
        + '| **日期** | ' + dateStr + ' |\n'
        + '| **会话ID** | `' + sessionId + '` |\n'
        + '| **状态** | ✅ 已归档 |\n'
        + '| **分类** | ' + (tags.length > 0 ? tags.join(' ') : '通用') + ' |\n\n'
        + '---\n\n'
        + '## 摘要\n\n' + summary + '\n\n'
        + (relatedLines.length > 0 ? '## 关联\n\n' + relatedLines.join('\n') + '\n\n---\n' : '')
        + logLine

      let target: FsTarget
      try {
        target = await fs.resolve(resolvedVaultPath + '/' + entryRelPath)
      } catch (_e) {
        const winPath = resolvedVaultPath + '\\' + entryRelPath.split('/').join('\\')
        try { target = await fs.resolve(winPath) } catch (_e2) { return asJsonValue({ ok: false, error: 'cannot resolve vault entry path', code: 'RESOLVE_FAILED' }) }
      }

      let skipped = false
      try {
        const prev = String(await fs.readText(target))
        const marker = '## 摘要'
        const pos = prev.indexOf(marker)
        if (pos >= 0 && prev.slice(pos + marker.length).trim() === summary.trim()) skipped = true
      } catch (_e) { /* 尚不存在 */ }
      if (skipped) return asJsonValue({ ok: true, skipped: true, file: entryRelPath, reason: 'summary unchanged', index: 'unchanged' })

      try {
        await fs.writeText(target, content, undefined, undefined, widePolicy)
      } catch (writeErr) {
        return asJsonValue({ ok: false, error: 'writeText failed: ' + String(writeErr instanceof Error ? writeErr.message : writeErr), code: 'WRITE_FAILED' })
      }

      const indexOk = await updateIndexFile(entryRelPath, title, sessionId, dateStr)
      dirty = true

      // 写入成功后自动 git commit + push（vault 有 remote 时才生效）
      let gitStatus = 'skipped'
      try {
        const { execSync } = await import('node:child_process')
        const out = execSync('git add -A && git status --porcelain', {
          cwd: resolvedVaultPath,
          timeout: 15000,
          encoding: 'utf-8',
        })
        if (out.trim().length > 0) {
          const msg = 'archive: ' + entryRelPath.replace(/^04-Archive\//, '')
          execSync('git commit -m "' + msg.replace(/"/g, '\\"') + '" && git push', {
            cwd: resolvedVaultPath,
            timeout: 60000,
            encoding: 'utf-8',
          })
          gitStatus = 'pushed'
        } else {
          gitStatus = 'no changes'
        }
      } catch (gitErr) {
        gitStatus = 'failed: ' + String(gitErr instanceof Error ? gitErr.message : gitErr)
      }

      return asJsonValue({ ok: true, skipped: false, file: entryRelPath, index: indexOk ? 'updated' : 'skipped', git: gitStatus })
    },
  }))
}
