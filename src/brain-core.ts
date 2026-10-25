/**
 * 大脑检索核心（纯函数，无 Cordis / fs 依赖，便于单独测试）。
 *
 * 职责：
 *   - 领域判定：一篇笔记属于「沉淀层」还是「流水层」；
 *   - 相关性打分：token 命中 × IDF × 目录权重 + 标题/路径加成 + 钉住加成；
 *   - 注入文本渲染：把命中的笔记拼成一段带截断的上下文（token 上限可控）；
 *   - 蒸馏结果的规范化与去噪（小模型输出的 JSON → 安全、可落盘的结构）；
 *   - 轮次键、要点去重、章节滚动等知识库写入侧的纯逻辑。
 *
 * 本文件不导入任何 `@deepseek-ai/*` 运行时模块：打包时被 Host 与测试同时复用。
 *
 * @module dsh-obsidian-sync/brain-core
 */

/** 一台「大脑」里的一篇已索引笔记。 */
export interface BrainNote {
  /** vault 相对路径（`02-Projects/xxx.md`）。 */
  path: string
  /** 与 `path` 相同的绝对或解析后路径，供读取正文。 */
  displayPath: string
  /** 索引侧 token 集合（由插件既有 `tokenize` 生成）。 */
  tokens: ReadonlySet<string>
  /** 命中理由可读化用：笔记标题。 */
  title: string
  /** 正文开头片段（用于注入预览）。 */
  snippet: string
  /** 正文长度。 */
  size: number
}

/** 一条检索命中。 */
export interface BrainHit {
  path: string
  title: string
  score: number
  /** 命中的 token（取前若干个，供可读理由）。 */
  matched: string[]
  /** 目录分层：沉淀层（长期知识）或流水层（会话记录）。 */
  tier: 'distilled' | 'stream'
  snippet: string
}

/** 打分参数。 */
export interface BrainScoreOptions {
  /** 沉淀层目录前缀（命中权重 ×2）。 */
  distilledPrefixes?: readonly string[]
  /** 流水层目录前缀（命中权重 ×1）。 */
  streamPrefixes?: readonly string[]
  /** 每篇最多保留若干命中 token 做理由。 */
  maxMatched?: number
  /** 笔记总数（IDF 的分母；省略时按 1 处理，仅用于单独调用）。 */
  totalDocuments?: number
}

const DEFAULT_DISTILLED = ['02-Projects/', '03-Areas/', '05-Resources/', '06-Brain/'] as const
const DEFAULT_STREAM = ['04-Archive/', '01-Daily/', '00-Inbox/'] as const

/** 判断笔记属于哪一层：沉淀层优先，其余按流水层处理。 */
export function noteTier(
  path: string,
  distilledPrefixes: readonly string[] = DEFAULT_DISTILLED,
): 'distilled' | 'stream' {
  return distilledPrefixes.some(prefix => path.includes(prefix)) ? 'distilled' : 'stream'
}

/** 取路径最后一段作为标题（去掉 `.md`）。 */
export function noteTitle(path: string): string {
  const base = path.split('/').pop() ?? path
  return base.replace(/\.md$/i, '')
}

/**
 * 给一篇笔记打分。
 *
 * 公式（全部为正数叠加，便于设阈值）：
 *   score = Σ tierWeight × idf + titleHits × 1.5
 * 其中 `idf = log((N + 1) / (df + 0.5))`（N = 笔记总数，df = 含该 token 的笔记数），
 * 与插件既有 `obsidian_search` 的 IDF 同量级（约 0.5~3），阈值语义因此可预测：
 * 单篇笔记命中 2~3 个中频词即可越过默认阈值 2.5。
 *
 * @param note - 待打分笔记。
 * @param queryTokens - 查询 token 集合。
 * @param df - token → 文档频率（有多少篇笔记含该 token）。
 * @param options - 分层目录与参数。
 * @returns 分数与命中 token；0 表示完全无关。
 */
export function scoreNote(
  note: BrainNote,
  queryTokens: ReadonlySet<string>,
  df: ReadonlyMap<string, number>,
  options: BrainScoreOptions = {},
): { score: number; matched: string[] } {
  if (queryTokens.size === 0) return { score: 0, matched: [] }
  const distilled = options.distilledPrefixes ?? DEFAULT_DISTILLED
  const tierWeight = noteTier(note.path, distilled) === 'distilled' ? 2 : 1
  const maxMatched = options.maxMatched ?? 6
  const total = options.totalDocuments ?? 1
  let score = 0
  const matched: string[] = []
  for (const token of queryTokens) {
    if (!note.tokens.has(token)) continue
    const tokenDf = df.get(token) ?? 0
    const idf = Math.log((total + 1) / (tokenDf + 0.5))
    score += tierWeight * Math.max(idf, 0.05)
    if (matched.length < maxMatched) matched.push(token)
  }
  if (score <= 0) return { score: 0, matched: [] }
  // 标题/路径命中：话题词直接出现在文件名里，往往是最强信号。
  const loweredTitle = note.path.toLowerCase()
  for (const token of queryTokens) {
    if (token.length >= 2 && loweredTitle.includes(token)) score += 1.5
  }
  return { score: Math.round(score * 1000) / 1000, matched }
}

/** 从笔记集合计算文档频率表（查询前一次性建好）。 */
export function documentFrequencies(notes: Iterable<BrainNote>): Map<string, number> {
  const df = new Map<string, number>()
  for (const note of notes) {
    for (const token of note.tokens) df.set(token, (df.get(token) ?? 0) + 1)
  }
  return df
}

/**
 * 检索：对全部笔记打分、排序、截断。
 * @param notes - 已索引笔记。
 * @param queryTokens - 查询 token。
 * @param limit - 最多返回条数。
 * @param minScore - 低于该分视为无命中。
 * @param options - 打分选项。
 * @returns 按分数降序的命中。
 */
export function searchBrain(
  notes: readonly BrainNote[],
  queryTokens: ReadonlySet<string>,
  limit: number,
  minScore: number,
  options: BrainScoreOptions = {},
): BrainHit[] {
  if (limit <= 0 || queryTokens.size === 0) return []
  const df = documentFrequencies(notes)
  const scoring: BrainScoreOptions = { ...options, totalDocuments: notes.length }
  const hits: BrainHit[] = []
  for (const note of notes) {
    const { score, matched } = scoreNote(note, queryTokens, df, scoring)
    if (score <= 0 || score < minScore) continue
    hits.push({
      path: note.path,
      title: noteTitle(note.path),
      score,
      matched,
      tier: noteTier(note.path, options.distilledPrefixes ?? DEFAULT_DISTILLED),
      snippet: note.snippet,
    })
  }
  hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
  return hits.slice(0, limit)
}

/** 注入渲染选项。 */
export interface InjectTextOptions {
  /** 总字数上限（超出截断）；硬上限由调用方另行夹紧。 */
  maxChars: number
  /** 每篇正文预览的最大字符数（沉淀层默认更大）。 */
  distilledExcerptChars?: number
  streamExcerptChars?: number
  /** 置顶（钉住）的笔记路径：总是包含，且排在最前。 */
  pinned?: readonly string[]
  /** 是否附带一句"结合记忆推理"的行为指令。 */
  instruct?: boolean
  /** 本条上下文的行为来源描述（如"每轮自动检索"）。 */
  originLabel?: string
}

const FALLBACK_INSTRUCTION = [
  '（以上是知识库中与你本轮问题相关的既有记忆，来源：Obsidian vault。）',
  '使用要求：把其中有用的结论/偏好/历史决策当成本轮推理的前提，与当前请求结合后再回答；',
  '若记忆与当前情况冲突，以当前事实为准并说明差异；不要逐条复述记忆原文，也不要编造记忆中没有的内容。',
].join('\n')

/** 压平空白，避免注入文本里出现大段换行/缩进。 */
function oneLine(text: string, limit: number): string {
  const flat = text.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim()
  if (flat.length <= limit) return flat
  return flat.slice(0, Math.max(0, limit - 1)) + '…'
}

/**
 * 把笔记正文压成适合注入的「单段行」：去掉 YAML frontmatter、连续空行、
 * 行首列表符号与标题井号，只保留可读要点。
 * @param text - 笔记全文。
 * @param limit - 最大字符数。
 * @returns 单段文本（超长以省略号结尾）。
 */
export function excerptBody(text: string, limit: number): string {
  const body = String(text ?? '').replace(/^---\n[\s\S]*?\n---\n?/, '')
  const lines: string[] = []
  for (const raw of body.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/^#{1,6}\s+/, '').replace(/^[-*+>]\s+/, '').replace(/\s+/g, ' ').trim()
    if (line.length === 0) continue
    lines.push(line)
  }
  return oneLine(lines.join(' / '), limit)
}

/**
 * 渲染注入文本。
 *
 * 结构：标题行 → 行为指令（可选）→ 每条命中（路径 + 命中理由 + 正文预览）。
 * 命中条数不设独立上限（由 `maxChars` 决定实际能装下几条），保证 token 预算可控。
 *
 * @param query - 本轮查询（展示用，截断到 40 字）。
 * @param hits - 检索命中（已排序）。
 * @param options - 渲染参数。
 * @returns 注入正文；无命中且无钉住项时返回空串。
 */
export function renderInjectText(query: string, hits: readonly BrainHit[], options: InjectTextOptions): string {
  const pinned = new Set(options.pinned ?? [])
  const ordered = [...hits].sort((a, b) => Number(pinned.has(b.path)) - Number(pinned.has(a.path)) || b.score - a.score)
  if (ordered.length === 0) return ''
  // 允许很小的字数额度（测试与极端配置），但至少给标题行留出空间。
  const maxChars = Math.max(80, Math.floor(options.maxChars))
  const head = '【知识库记忆 · ' + (options.originLabel ?? '每轮自动检索') + '】\n'
    + '本轮查询：「' + oneLine(String(query ?? ''), 40) + '」'
  const parts: string[] = [head]
  if (options.instruct !== false) parts.push(FALLBACK_INSTRUCTION)
  parts.push('命中记忆：')
  let used = parts.join('\n').length
  let included = 0
  for (const hit of ordered) {
    const excerptLimit = hit.tier === 'distilled'
      ? options.distilledExcerptChars ?? 420
      : options.streamExcerptChars ?? 180
    const reason = hit.matched.length > 0 ? hit.matched.slice(0, 6).join('、') : ''
    const line = '- ' + hit.path
      + (pinned.has(hit.path) ? '（置顶）' : '')
      + (reason.length > 0 ? ' | 命中：' + reason : '')
      + '\n  摘录：' + excerptBody(hit.snippet, excerptLimit)
    if (used + line.length > maxChars) {
      if (included > 0) break
      // 预算连第一条都装不下：把这一条截到剩余空间，保证总能给出至少一条。
      const room = maxChars - used
      if (room <= 20) break
      parts.push(line.slice(0, room - 1) + '…')
      included++
      break
    }
    parts.push(line)
    used += line.length + 1
    included++
  }
  if (included === 0) return ''
  const rendered = parts.join('\n')
  // 头部（标题 + 指令）本身可能就超过预算：此时按预算硬截断，保证调用方的
  // token 上限永远成立。
  return rendered.length <= maxChars ? rendered : rendered.slice(0, Math.max(0, maxChars - 1)) + '…'
}

// ---------------------------------------------------------------------------
// 蒸馏（实时更新大脑）
// ---------------------------------------------------------------------------

/** 小模型蒸馏输出（已规范化）。 */
export interface DistilledMemory {
  /** 一句话主题（≤ 60 字）。 */
  title: string
  /** 结论/摘要（≤ 400 字）。 */
  summary: string
  /** 检索关键词（≤ 10 个，去重、去噪）。 */
  keywords: string[]
  /** 相关已有笔记路径（仅保留命中集内的路径）。 */
  related: string[]
  /** 是否长期有效（写入沉淀层摘要行）。 */
  pinned: boolean
  /** 是否含未完成事项。 */
  open: boolean
}

/** 规范化参数。 */
export interface NormalizeDistillOptions {
  /** 允许写回沉淀层的路径白名单（命中集 / 已有笔记）。 */
  allowedPaths?: readonly string[]
  /** summary 最大长度。 */
  summaryMaxChars?: number
}

/** 停用词：过短的纯虚词不配当关键词。 */
const STOPWORDS = new Set<string>([
  '的', '了', '是', '在', '和', '与', '也', '就', '都', '而', '及', '或', '这', '那', '一个', '我们', '你们',
  '他们', 'the', 'and', 'for', 'with', 'that', 'this', 'you', 'are', 'was', 'have', 'has',
])

/** 去噪并限制长度。 */
function clip(text: string, max: number): string {
  const flat = String(text ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim()
  return flat.length <= max ? flat : flat.slice(0, Math.max(0, max - 1)) + '…'
}

/**
 * 从模型原始输出中抽出 JSON 对象（容忍 ```json 围栏与前后解释文字）。
 * @param raw - 模型原始文本。
 * @returns 解析后的对象，或 undefined。
 */
export function extractJsonObject(raw: string): Record<string, unknown> | undefined {
  const text = String(raw ?? '').trim()
  if (text.length === 0) return undefined
  const candidates: string[] = []
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced?.[1] !== undefined) candidates.push(fenced[1].trim())
  candidates.push(text)
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1))
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch (_error) {
      // 尝试下一个候选
    }
  }
  return undefined
}

/** 把任意值收敛为字符串数组（去空、去停用词、去重、限量）。 */
function stringList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const token = item.trim()
    if (token.length === 0 || token.length > 40) continue
    if (STOPWORDS.has(token.toLowerCase())) continue
    if (seen.has(token)) continue
    seen.add(token)
    out.push(token)
    if (out.length >= limit) break
  }
  return out
}

/**
 * 规范化模型蒸馏结果：字段收敛、长度截断、路径白名单过滤。
 * @param raw - `extractJsonObject` 的结果。
 * @param options - 白名单与长度上限。
 * @returns 规范化后的记忆；`title` 与 `summary` 皆空时返回 undefined（该轮不值得入库）。
 */
export function normalizeDistill(
  raw: Record<string, unknown> | undefined,
  options: NormalizeDistillOptions = {},
): DistilledMemory | undefined {
  if (raw === undefined) return undefined
  const title = clip(typeof raw.title === 'string' ? raw.title : '', 60)
  const summary = clip(typeof raw.summary === 'string' ? raw.summary : '', options.summaryMaxChars ?? 400)
  if (title.length === 0 && summary.length === 0) return undefined
  const allowed = options.allowedPaths
  const relatedAll = Array.isArray(raw.related)
    ? raw.related.filter((item): item is string => typeof item === 'string')
    : []
  const related = relatedAll
    .map(item => item.trim().replace(/^\[\[|\]\]$/g, '').trim())
    .filter(item => item.length > 0 && (allowed === undefined || allowed.includes(item)))
    .slice(0, 5)
  return {
    title,
    summary,
    keywords: stringList(raw.keywords, 10),
    related,
    pinned: raw.pinned === true || raw.pinned === 'true',
    open: raw.open === true || raw.open === 'true' || raw.hasOpenItems === true,
  }
}

/**
 * 判断一段对话是否值得蒸馏（避免把寒暄/工具回执也写进大脑）。
 * @param userText - 本轮用户输入拼接。
 * @param assistantText - 本轮助手可见文本（已剔除注入）。
 * @param minChars - 低于该长度视为无实质内容。
 * @returns 值得入库时返回 true。
 */
export function worthDistilling(userText: string, assistantText: string, minChars = 24): boolean {
  const user = String(userText ?? '').trim()
  const assistant = String(assistantText ?? '').trim()
  if (user.length === 0) return false
  if (user.length + assistant.length < minChars) return false
  // 纯确认类（好/继续/ok）不单独入库
  if (/^(好|好的|继续|可以|嗯|ok|OK|yes|no|行)\s*[。.!！?？]*$/.test(user)) return false
  return true
}

/**
 * 计算轮次键：同一轮内多次触发只处理一次。
 * @param turn - 轮次号（未知时给 0）。
 * @param userSeq - 该轮最后一条用户消息的 seq（未知给 -1）。
 * @param userText - 用户输入（兜底散列）。
 * @returns 稳定的轮次键。
 */
export function turnKey(turn: number, userSeq: number, userText: string): string {
  if (userSeq >= 0) return 'seq:' + String(userSeq)
  if (turn > 0) return 'turn:' + String(turn)
  let hash = 0
  for (let i = 0; i < userText.length; i++) hash = (Math.imul(hash, 31) + userText.charCodeAt(i)) | 0
  return 'hash:' + String(hash >>> 0)
}

/** 「是否新一轮」判定输入。 */
export interface NewTurnSignals {
  /** 上一轮已被注入/处理过的轮次键（空串表示本会话尚未处理过）。 */
  lastKey: string
  /** 当前候选轮次键。 */
  key: string
  /** 本轮候选输入之前是否还有一个用户消息节点（先 A 后 B ⇒ 新一轮）。 */
  previousIsUserMessage: boolean
  /** 候选输入文本。 */
  text: string
}

/**
 * 是否进入新一轮：同一轮只处理第一次，且只有在「上一条 surface 不是用户消息」
 * 或「本会话尚未处理过」时才算新一轮 —— 这样用户连发的多条排队消息只触发一次检索。
 *
 * @param signals - 判定信号。
 * @returns 需要为本轮做检索/处理时返回 true。
 */
export function isNewUserTurn(signals: NewTurnSignals): boolean {
  const text = String(signals.text ?? '').trim()
  if (text.length === 0) return false
  if (signals.key === signals.lastKey) return false
  return signals.lastKey === '' || signals.previousIsUserMessage
}

/** 一条沉淀摘要行的字段。 */
export interface DistillLine {
  date: string
  title: string
  keywords: readonly string[]
  summary: string
  pinned: boolean
  open: boolean
}

/**
 * 渲染沉淀行。同一轮重复渲染必须完全相同（幂等），因此所有易变字段都来自入参。
 * @param line - 字段。
 * @returns 一行 Markdown（无前导缩进）。
 */
export function renderDistillLine(line: DistillLine): string {
  const keywordText = line.keywords.slice(0, 6).join('、')
  const oneLineSummary = clip(line.summary || line.title, 160)
  return '- ' + line.date
    + (keywordText.length > 0 ? ' · ' + keywordText : '')
    + ' — ' + oneLineSummary
    + (line.open ? '  ⏳待办' : '')
}

/**
 * 把一行沉淀追加到「## 实时沉淀」小节（不存在则创建）。
 * 幂等：文本中已含该行（trim 后相同）时原样返回。
 * @param content - 笔记全文。
 * @param line - 已渲染的沉淀行。
 * @param heading - 小节标题（默认 `## 实时沉淀`）。
 * @returns 新全文；`changed=false` 表示无需写盘。
 */
export function appendDistillSection(
  content: string,
  line: string,
  heading = '## 实时沉淀',
): { content: string; changed: boolean } {
  const target = line.trim()
  const existing = String(content ?? '')
  const lines = existing.split('\n')
  if (lines.some(item => item.trim() === target)) return { content: existing, changed: false }
  const headingIndex = lines.findIndex(item => item.trim() === heading)
  if (headingIndex === -1) {
    // 新建小节：优先落在「## 关联」之前（沉淀行属于正文，不该跑到关联区下面）。
    const relatedIndex = lines.findIndex(item => item.trim() === '## 关联')
    const block = [heading, '', target, '']
    if (relatedIndex === -1) {
      const body = existing.endsWith('\n') || existing.length === 0 ? existing : existing + '\n'
      return { content: body + '\n' + block.join('\n'), changed: true }
    }
    const next = [...lines.slice(0, relatedIndex), ...block, ...lines.slice(relatedIndex)]
    return { content: next.join('\n'), changed: true }
  }
  // 小节内的最后一个非空行之后插入，保证新行在小节末尾而不是跑到下一节去。
  let insertAt = headingIndex + 1
  for (let i = headingIndex + 1; i < lines.length; i++) {
    const item = lines[i] ?? ''
    if (/^#{1,2}\s/.test(item)) break
    if (item.trim().length > 0) insertAt = i + 1
  }
  if (insertAt === headingIndex + 1) {
    lines.splice(insertAt, 0, '', target)
  } else {
    lines.splice(insertAt, 0, target)
  }
  return { content: lines.join('\n'), changed: true }
}

/**
 * 在流水页追加本轮小节，并做单节大小滚动。
 *
 * 结构：
 * ```
 * ## 实时沉淀（YYYY-MM-DD）
 * ### 轮次 3 · 14:05
 * - 用户：…
 * - 结论：…
 * ```
 * 当某个 `## 实时沉淀` 小节超过 `capBytes` 时，把后续内容写入
 * `## 实时沉淀（续）`，避免单篇笔记无限增长。
 *
 * @param content - 既有全文。
 * @param key - 小节幂等键（同一轮重复调用不重复追加）。
 * @param block - 已渲染好的小节正文（包含 `### ` 标题行）。
 * @param options - 小节标题、大小上限、当前日期。
 * @returns 新全文与是否变更。
 */
export function appendTurnBlock(
  content: string,
  key: string,
  block: string,
  options: { date: string; capBytes?: number; heading?: string },
): { content: string; changed: boolean } {
  const baseHeading = options.heading ?? '## 实时沉淀'
  const existing = String(content ?? '')
  if (existing.includes('<!-- turn:' + key + ' -->')) return { content: existing, changed: false }
  const cap = Math.max(512, Math.floor(options.capBytes ?? 200_000))
  const body = '<!-- turn:' + key + ' -->\n' + block.trim() + '\n'
  const full = existing.endsWith('\n') || existing.length === 0 ? existing : existing + '\n'
  const byteLength = (text: string): number => Buffer.byteLength(text, 'utf8')
  /** 第 n 个小节的标题行（n 从 1 开始）。 */
  const headingOf = (n: number): string => n === 1
    ? baseHeading + '（' + options.date + '）'
    : baseHeading + '（' + options.date + ' 续' + String(n - 1) + '）'
  // 小节终点：下一个以 `## 实时沉淀` 开头的行；没有则到文件末尾。
  const sectionEndFrom = (start: number): number => {
    const next = full.indexOf('\n' + baseHeading, start)
    return next === -1 ? full.length : next + 1
  }
  let n = 1
  for (;;) {
    const headingLine = headingOf(n)
    const headingPos = full.indexOf(headingLine)
    if (headingPos === -1) {
      return { content: full + '\n' + headingLine + '\n\n' + body, changed: true }
    }
    const sectionEnd = sectionEndFrom(headingPos)
    const sectionBytes = byteLength(full.slice(headingPos, sectionEnd))
    if (sectionBytes + byteLength(body) <= cap) {
      const head = full.slice(0, sectionEnd)
      const tail = full.slice(sectionEnd)
      const glued = head.endsWith('\n') ? head + body : head + '\n' + body
      return { content: glued + (tail.length > 0 ? '\n' + tail.replace(/^\n+/, '') : ''), changed: true }
    }
    n++
    if (n > 64) {
      // 极端情况的上限保护：直接追加到文件尾
      return { content: full + '\n' + baseHeading + '\n\n' + body, changed: true }
    }
  }
}

// ---------------------------------------------------------------------------
// 对话文本提取
// ---------------------------------------------------------------------------

/** 一条已派生消息的最小结构（与 `Message` 结构兼容，避免引入类型依赖）。 */
export interface MinimalMessage {
  readonly role: string
  readonly content: readonly { readonly type: string; readonly text?: string }[]
  readonly source?: { readonly kind?: string }
}

/** 拼接一条消息中的全部文本块。 */
export function messageText(message: MinimalMessage): string {
  const parts: string[] = []
  for (const block of message.content) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/** 是否为插件自己注入的记忆消息（参与轮次判定，但不参与蒸馏）。 */
export function isInjectedBrainMessage(message: { readonly source?: { readonly kind?: string } }): boolean {
  return message.source?.kind === 'obsidian-brain'
}

/** 是否为 DSH 自身的系统通知（文件变更、定时任务、目标续轮等），不作为用户输入。 */
export function isSystemNoticeMessage(message: { readonly source?: { readonly kind?: string } }): boolean {
  const kind = message.source?.kind ?? ''
  if (kind === '' || kind === 'user') return false
  return kind !== 'obsidian-brain'
}

/**
 * 从一轮消息中抽取可用于检索的用户输入。
 * @param messages - 本轮的用户消息（surface 顺序）。
 * @returns 拼接后的输入文本（只保留最后 2000 字，避免超长粘贴）。
 */
export function collectTurnUserText(messages: readonly MinimalMessage[]): string {
  const parts: string[] = []
  for (const message of messages) {
    if (isSystemNoticeMessage(message)) continue
    if (isInjectedBrainMessage(message)) continue
    const text = messageText(message)
    if (text.length > 0) parts.push(text)
  }
  const joined = parts.join('\n').trim()
  return joined.length > 2000 ? joined.slice(joined.length - 2000) : joined
}

/**
 * 从一轮消息中抽取助手的可见结论（用于蒸馏）。
 * @param messages - 本轮与助手相关的消息。
 * @param maxChars - 保留末尾多少字符。
 * @returns 拼接后的助手文本。
 */
export function collectAssistantText(messages: readonly MinimalMessage[], maxChars = 4000): string {
  const parts: string[] = []
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    const text = messageText(message)
    if (text.length > 0) parts.push(text)
  }
  const joined = parts.join('\n\n').trim()
  return joined.length > maxChars ? joined.slice(joined.length - maxChars) : joined
}

/** 从命中集合中挑出「钉住」项：沉淀层里分数最高的若干篇。 */
export function pickPinned(hits: readonly BrainHit[], budget: number): string[] {
  const distilled = hits.filter(hit => hit.tier === 'distilled')
  return distilled.slice(0, Math.max(0, Math.floor(budget))).map(hit => hit.path)
}

/**
 * 从用户偏好页等固定文件里抽取「长期约束」段落（避免把整页塞进注入文本）。
 * @param content - 页面全文。
 * @param maxChars - 截断上限。
 * @returns 可注入的片段；空串表示没有可用内容。
 */
export function extractPinnedExcerpt(content: string, maxChars = 500): string {
  const text = String(content ?? '').replace(/\r\n?/g, '\n')
  if (text.trim().length === 0) return ''
  const stripped = text.replace(/^---\n[\s\S]*?\n---\n?/, '').trim()
  const flat = stripped.split('\n').filter(line => line.trim().length > 0).join('\n')
  return flat.length <= maxChars ? flat : flat.slice(0, Math.max(0, maxChars - 1)) + '…'
}
