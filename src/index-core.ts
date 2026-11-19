/**
 * 归档索引纯字符串处理（无 Cordis / fs 依赖，便于单独测试）。
 *
 * 职责：把一条会话归档条目挂到 `DSH-会话归档-索引.md` 的正确位置。
 *   - 当天段落已存在：段内去重（同 shortId 替换为最新行）或追加到段末；
 *   - 当天段落不存在：按日期倒序插入到「## 按日期（倒序）」段的正确位置，
 *     不越过 `## 未归档清单` 等紧随其后的二级标题。
 *
 * 历史 bug：新日期段被直接追加到文件末尾，导致索引里 `## 未归档清单`
 * 之后堆积出一串倒序错乱的日期段；本模块按日期定位插入点修复该问题。
 *
 * @module dsh-obsidian-sync/index-core
 */

/** 一条待写入索引的归档条目。 */
export interface IndexEntryParams {
  /** 条目指向的笔记 vault 相对路径（`04-Archive/xxx.md`）。 */
  entryRelPath: string
  /** 双链显示名（笔记标题）。 */
  title: string
  /** 会话完整 ID（用于去重键与索引行落款）。 */
  sessionId: string
  /** 归档日期 `YYYY-MM-DD`。 */
  dateStr: string
}

/** 日期段所属的二级标题（其下按日期倒序排列）。 */
const DATE_SECTION_TITLE = '## 按日期（倒序）'
/** 老索引里可能出现、且同样位于日期段之后的二级标题，作为回退插入锚点。 */
const LEGACY_TAIL_TITLE = '## 主题分类'

/** 确保 shortId 恰好 8 位：不足时补 hash 前缀。 */
export function normalizeShortId(sessionId: string): string {
  // 剥离约定的 "session-" 前缀：传 "session-<uuid>" 时短 ID 应取 uuid 首 8 位，
  // 而非把 "session" 字样计入（否则 "session-9f10d319…" 会误归一化为 "session9"）。
  // 仅影响入参形态，幂等键与既有归档（裸 uuid / 8 位短 ID）保持一致。
  const stripped = sessionId.replace(/^session-/i, '')
  let s = stripped.replace(/[^A-Za-z0-9]/g, '')
  if (s.length >= 8) return s.slice(0, 8)
  // 不足 8 位：用剥离前缀后的 sessionId 的简单 hash 补齐
  let hash = 0
  for (let i = 0; i < stripped.length; i++) {
    hash = ((hash << 5) - hash + stripped.charCodeAt(i)) | 0
  }
  s = s + Math.abs(hash).toString(16).slice(0, 8)
  return s.slice(0, 8)
}

/** 渲染索引条目行（含行尾换行，不含前导空行）。 */
function renderLine(p: IndexEntryParams): string {
  return '- [[' + p.entryRelPath + '|' + p.title + ']] (' + p.dateStr + ', ' + p.sessionId + ')\n'
}

/** 正则转义。 */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 在内容中定位一个「独立成行」的标题，返回行首偏移；找不到返回 -1。 */
function findHeadingLine(text: string, heading: string): number {
  let pos = text.indexOf(heading)
  while (pos !== -1) {
    const prevOk = pos === 0 || text[pos - 1] === '\n'
    const after = pos + heading.length
    const afterOk = after >= text.length || text[after] === '\n'
    if (prevOk && afterOk) return pos
    pos = text.indexOf(heading, pos + 1)
  }
  return -1
}

/**
 * 在「## 按日期（倒序）」段内，按日期倒序计算新日期段的插入偏移。
 * 返回位置指向某个 `\n### ` 的换行符，或下一个二级标题的换行符，或内容末尾。
 */
function findDateInsertPos(text: string, afterSection: number, dateStr: string): number {
  const dayRe = /\n### (\d{4}-\d{2}-\d{2})(?=\n|$)/g
  dayRe.lastIndex = afterSection
  let m: RegExpExecArray | null
  while ((m = dayRe.exec(text)) !== null) {
    // 倒序排列下，第一个日期 <= 新日期 的段落就是新段的插入点（新段插在它前面）
    if (m[1] <= dateStr) return m.index
  }
  // 新日期比所有已有段都旧（或该段还没有任何日期段）：落到下一个二级标题之前
  const nextH2 = text.indexOf('\n## ', afterSection)
  return nextH2 === -1 ? text.length : nextH2
}

/** 判断插入点之前是否已存在空行（插入点在 `\n` 上，前一个字符为 `\n` 即为空行边界）。 */
function hasBlankLineBefore(text: string, pos: number): boolean {
  if (pos <= 0) return false
  return text[pos - 1] === '\n'
}

/** LF 规范化后的索引写入实现（调用方保证入参不含 `\r\n`）。 */
function applyIndexEntryLf(text: string, p: IndexEntryParams): string {
  const line = renderLine(p)
  const shortId = normalizeShortId(p.sessionId)
  const dayAnchor = '### ' + p.dateStr

  const dayPos = findHeadingLine(text, dayAnchor)
  if (dayPos !== -1) {
    // 当天段落已存在：段末 = 下一个 `### ` 或 `## ` 标题行的换行符
    const afterAnchor = dayPos + dayAnchor.length
    const nextH3 = text.indexOf('\n### ', afterAnchor)
    const nextH2 = text.indexOf('\n## ', afterAnchor)
    let dayEnd: number
    if (nextH3 !== -1 && nextH2 !== -1) dayEnd = Math.min(nextH3, nextH2)
    else if (nextH3 !== -1) dayEnd = nextH3
    else if (nextH2 !== -1) dayEnd = nextH2
    else dayEnd = text.length

    // 去重：段内已有同 shortId 的条目 → 原地替换为最新行
    const daySection = text.slice(afterAnchor, dayEnd)
    const dedupe = new RegExp(
      '^- \\[\\[[^\\]]*' + escapeRe(p.dateStr) + '-' + escapeRe(shortId) + '-[^\\]]*\\]\\]\\s*\\([^)]*\\)[ \\t]*$',
      'm',
    )
    const existing = dedupe.exec(daySection)
    if (existing !== null) {
      const absPos = afterAnchor + existing.index
      // existing[0] 不含行尾换行，用去尾换行的新行替换，避免多出空行
      return text.slice(0, absPos) + line.slice(0, -1) + text.slice(absPos + existing[0].length)
    }

    // 否则追加到段末，并保证与上下段落之间各有一个空行
    const gap = hasBlankLineBefore(text, dayEnd) ? '\n' : '\n\n'
    return text.slice(0, dayEnd) + gap + line + text.slice(dayEnd)
  }

  // 当天段落不存在：按日期倒序插入到正确位置
  const block = '### ' + p.dateStr + '\n\n' + line
  const secPos = findHeadingLine(text, DATE_SECTION_TITLE)
  const insertAt = secPos !== -1
    ? findDateInsertPos(text, secPos + DATE_SECTION_TITLE.length, p.dateStr)
    : (() => {
        // 回退：老索引没有「按日期（倒序）」段 → 插到末尾二级标题之前，否则追加末尾
        const tailPos = findHeadingLine(text, LEGACY_TAIL_TITLE)
        return tailPos === -1 ? text.length : tailPos
      })()

  if (insertAt === 0) return block + text
  const gap = hasBlankLineBefore(text, insertAt) ? '\n' : '\n\n'
  return text.slice(0, insertAt) + gap + block + text.slice(insertAt)
}

/**
 * 把一条归档条目写入索引内容（纯函数，幂等）。
 *
 * @param content 索引文件全文（LF 或 CRLF 均可，输出沿用输入的换行风格）。
 * @param p 归档条目参数。
 * @returns 更新后的全文；若无需改动则原样返回。
 */
export function applyIndexEntry(content: string, p: IndexEntryParams): string {
  const crlf = content.includes('\r\n')
  const text = crlf ? content.replace(/\r\n/g, '\n') : content
  const updated = applyIndexEntryLf(text, p)
  return crlf ? updated.replace(/\n/g, '\r\n') : updated
}
