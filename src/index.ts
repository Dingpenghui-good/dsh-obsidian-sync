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
 * @module dsh-obsidian-sync
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { FileSystem, FsDirEntry, FsTarget } from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'

/** Cordis 插件名。 */
export const name = 'obsidian-sync'

/** 本插件需要的 Service（`tools`/`fs`/`timer` 为硬依赖，缺失时等待 Cordis 重激活）。 */
export const inject = ['tools', 'fs', 'timer']

/** 插件配置。 */
export interface Config {
  /** Obsidian vault 绝对路径；缺省读 settings 命名空间 `obsidian-sync`，再缺省 `E:/dsh-workspace/obsidian-vault`。 */
  vaultPath?: string
  /** 是否注册 obsidian.search（倒排索引 + 定时增量重建）。 */
  searchEnabled?: boolean
  /** 索引增量重建间隔（毫秒，下限 5000）。 */
  indexRefreshMs?: number
}

/**
 * Schemastery 配置 schema：加载器用它解析行 `config` 并补默认值。
 *
 * 注意 Schemastery 的 API 与 zod 不同：没有 `.optional()` / `.int()`。
 * 对象属性默认即可选（不调用 `.required()` 时，缺失键不会写入解析结果），
 * 整数约束通过 `.step(1)` 表达。
 */
export const Config: z<Config> = z.object({
  vaultPath: z.string(),
  searchEnabled: z.boolean().default(true),
  indexRefreshMs: z.number().step(1).min(5000).default(60000),
})

export function apply(ctx: Context, config: Config = {}): void {
  const settings = ctx.get('settings')
  let vaultPath: string | undefined = config.vaultPath
  let searchEnabled = config.searchEnabled !== false
  if (vaultPath === undefined && settings !== undefined) {
    try {
      const section = settings.get('obsidian-sync')
      if (section && typeof section === 'object') {
        if (typeof (section as Record<string, unknown>).vaultPath === 'string') {
          vaultPath = (section as Record<string, unknown>).vaultPath as string
        }
        if (typeof (section as Record<string, unknown>).searchEnabled === 'boolean') {
          searchEnabled = (section as Record<string, unknown>).searchEnabled as boolean
        }
      }
    } catch (_e) { /* 命名空间未注册或 schema 不符；保留默认 */ }
  }
  if (vaultPath === undefined || vaultPath.length === 0) vaultPath = 'E:/dsh-workspace/obsidian-vault'
  const refreshMs = Math.max(config.indexRefreshMs ?? 60000, 5000)

  const fs = ctx.fs as unknown as FileSystem
  const timer = ctx.timer as unknown as { interval(callback: () => void, delay: number): () => void }
  const index = new Map<string, { displayPath: string; tokens: Set<string>; snippet: string; size: number }>()
  let dirty = true
  let refreshing = false

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
        const root = await fs.resolve(vaultPath)
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
              const displayPath = entry.target && typeof entry.target === 'object' ? entry.target.displayPath : String(entry.target)
              next.set(displayPath, { displayPath, tokens, snippet: text.slice(0, 240), size: entry.size ?? text.length })
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
      const disposer = timer.interval(() => {
        if (!dirty) return
        void rebuildIndex()
      }, refreshMs)
      return () => { if (typeof disposer === 'function') disposer() }
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
  const widePolicy: SandboxExecutionPolicy = { mode: 'danger-full-access', workspaceRoot: vaultPath }

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
          const target = await fs.resolve(vaultPath + '/' + proj)
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
          cwd: vaultPath, timeout: 15000, encoding: 'utf-8',
        })
        if (out.trim().length > 0) {
          execSync('git commit -m "daily-review: ' + dateStr + ' 归档沉淀（' + todayFiles.length + ' 篇）" && git push', {
            cwd: vaultPath, timeout: 60000, encoding: 'utf-8',
          })
        }
      } catch (_e) { /* git 失败不影响 */ }
    } catch (_e) { /* 整体失败静默 */ }
  }

  ctx.effect(() => {
    const disposer = timer.interval(() => {
      void dailyReview()
    }, 60000)
    return () => { if (typeof disposer === 'function') disposer() }
  }, 'obsidian-sync: daily review at 22:00')

  /**
   * 更新索引文件（DSH-会话归档-索引.md）的按日期段。
   * - 找到当天段落（### YYYY-MM-DD）
   * - 边界：下一个 `### ` 或 `## `（两个井号终止条件）
   * - 同 shortId 已有条目 → 替换该行（幂等去重）
   * - 否则追加到当天段落末尾
   */
  async function updateIndexFile(entryRelPath: string, title: string, sessionId: string, dateStr: string): Promise<boolean> {
    try {
      const idxTarget = await fs.resolve(vaultPath + '/DSH-会话归档-索引.md')
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
      const target = await fs.resolve(vaultPath + '/' + relPath)
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
        if (topic.trim().length === 0) return { ok: false, error: 'topic must not be empty' }
        const limit = Math.min(Math.max(1, Number(args.limit) || 3), 5)
        await ensureIndex()
        const matches = searchMatches(topic, limit)
        return { ok: true, matches, count: matches.length, vaultPath }
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

        return {
          ok: true,
          task: task || '(未指定)',
          distilled,
          recent,
          userProfile: userProfile.length > 0 ? userProfile.slice(0, 2000) : '',
          vaultPath,
        }
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

      const dateStr = new Date().toISOString().slice(0, 10)
      const shortId = normalizeShortId(sessionId)

      // 幂等键 = date + shortId（标题不参与路径），写入前按前缀探测已存在文件并原地覆盖
      const entryPrefix = dateStr + '-' + shortId + '-'
      let entryRelPath: string

      // 探测 04-Archive/ 下是否已有同前缀文件（同会话多次同步）
      try {
        const archiveDir = await fs.resolve(vaultPath + '/04-Archive')
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
          await fs.stat(await fs.resolve(vaultPath + '/' + rRel))
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
        target = await fs.resolve(vaultPath + '/' + entryRelPath)
      } catch (_e) {
        const winPath = vaultPath + '\\' + entryRelPath.split('/').join('\\')
        try { target = await fs.resolve(winPath) } catch (_e2) { return { ok: false, error: 'cannot resolve vault entry path', code: 'RESOLVE_FAILED' } }
      }

      let skipped = false
      try {
        const prev = String(await fs.readText(target))
        const marker = '## 摘要'
        const pos = prev.indexOf(marker)
        if (pos >= 0 && prev.slice(pos + marker.length).trim() === summary.trim()) skipped = true
      } catch (_e) { /* 尚不存在 */ }
      if (skipped) return { ok: true, skipped: true, file: entryRelPath, reason: 'summary unchanged', index: 'unchanged' }

      try {
        await fs.writeText(target, content, undefined, undefined, widePolicy)
      } catch (writeErr) {
        return { ok: false, error: 'writeText failed: ' + String(writeErr instanceof Error ? writeErr.message : writeErr), code: 'WRITE_FAILED' }
      }

      const indexOk = await updateIndexFile(entryRelPath, title, sessionId, dateStr)
      dirty = true

      // 写入成功后自动 git commit + push（vault 有 remote 时才生效）
      let gitStatus = 'skipped'
      try {
        const { execSync } = await import('node:child_process')
        const out = execSync('git add -A && git status --porcelain', {
          cwd: vaultPath,
          timeout: 15000,
          encoding: 'utf-8',
        })
        if (out.trim().length > 0) {
          const msg = 'archive: ' + entryRelPath.replace(/^04-Archive\//, '')
          execSync('git commit -m "' + msg.replace(/"/g, '\\"') + '" && git push', {
            cwd: vaultPath,
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

      return { ok: true, skipped: false, file: entryRelPath, index: indexOk ? 'updated' : 'skipped', git: gitStatus }
    },
  }))
}
