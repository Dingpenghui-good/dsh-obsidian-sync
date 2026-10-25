/**
 * 大脑接入层（Host 侧）：把 `brain-core.ts` 的纯逻辑接到 DSH 的运行期。
 *
 * 两条链路：
 *   1. 每轮检索注入（`brainRetrieval`）
 *      监听 `agent/inbox/inserted` → 判定是否新一轮 → 检索倒排索引 →
 *      `agent.steer(createUserMessage(source.kind='obsidian-brain'))`。
 *      注入消息属于「非唤醒」的 steering：它跟随已排队的用户输入一起进入本轮，
 *      既不会额外起一轮，也不会让模型被无事唤醒。
 *   2. 实时更新大脑（`brainAutoUpdate`）
 *      监听 `agent/turn-stopping` → 本轮用户输入 + 助手可见结论 → 小模型蒸馏 →
 *      写 04-Archive 流水 / 02-03-05 沉淀摘要行 / 06-Brain 聚合页 → 索引置脏。
 *
 * 设计约束：
 *   - 任何异常都在本模块内吞掉并降级 —— 记忆能力不能影响对话本身；
 *   - 检索注入有严格超时与 token 上限；蒸馏是 fire-and-forget；
 *   - 所有写入幂等（同一轮重复触发只写一次），并按小节大小滚动。
 *
 * @module dsh-obsidian-sync/brain
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import type { Message, StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
// 仅类型导入：把 `agent/inbox/inserted` / `agent/turn-stopping` 的事件声明与本文件关联。
import type {} from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import {
  appendDistillSection,
  appendTurnBlock,
  collectAssistantText,
  collectTurnUserText,
  extractJsonObject,
  extractPinnedExcerpt,
  isInjectedBrainMessage,
  isNewUserTurn,
  isSystemNoticeMessage,
  normalizeDistill,
  pickPinned,
  renderDistillLine,
  renderInjectText,
  searchBrain,
  turnKey,
  worthDistilling,
  type BrainHit,
  type BrainNote,
  type DistilledMemory,
} from './brain-core.ts'
import { PLUGIN_PACKAGE_NAME } from './shared.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * 本插件每轮自动注入的知识库记忆（v4.0.0）。它是 user 角色消息，参与
     * 历史推导，但不再是「用户输入」——蒸馏与轮次判定都会排除它。
     */
    'obsidian-brain': { kind: 'obsidian-brain'; plugin: string; path?: string }
  }
}

/** 大脑接入所需的宿主能力与配置读取器。 */
export interface BrainHost {
  /** 插件上下文（取 agents/llm/credentials/storage/fs/logger 用）。 */
  ctx: Context
  /** 进程内文件服务。 */
  fs: FileSystem
  /** 每次调用都重读 settings，保证保存后立即生效。 */
  options: () => BrainOptions
  /** 当前 vault 绝对路径（惰性读取 settings）。 */
  vaultPath: () => string
  /** 等到索引可用；返回 false 表示超时/不可用。 */
  ensureIndexReady: (timeoutMs: number) => Promise<boolean>
  /** 索引快照（交给 `searchBrain` 的笔记列表）。 */
  snapshotNotes: () => readonly BrainNote[] | Promise<readonly BrainNote[]>
  /** 批量读取若干笔记正文（相对路径 → 全文；读不到则缺省）。 */
  readNotes: (paths: readonly string[]) => Promise<Map<string, string>>
  /** 查询分词（复用插件的 CJK bigram + ASCII 分词）。 */
  tokenize: (text: string) => Set<string>
  /** 标记索引脏（下一轮检索即可命中新写入内容）。 */
  markDirty: () => void
  /** 写入 vault 文件的沙箱策略（vault 在 workspace 之外）。 */
  writePolicy: () => SandboxExecutionPolicy
  /** 当前 agent 的路由（provider/model），用于未指定蒸馏模型时跟随。 */
  currentRoute: () => { provider?: string; model?: string }
}

/** 大脑相关配置（全部来自 `dsh-obsidian-sync` 命名空间）。 */
export interface BrainOptions {
  retrieval: boolean
  topK: number
  maxChars: number
  minScore: number
  timeoutMs: number
  autoUpdate: boolean
  memoryProvider: string
  memoryModel: string
  memoryApiKeyEnv: string
  maxCalls: number
  pinnedBudget: number
  autoCommit: boolean
  logCapBytes: number
  /** 检索失败时是否记日志（默认 true）。 */
  verbose: boolean
}

/** 默认值（与 Config schema 保持一致；schema 缺省时由这里兜底）。 */
export function defaultBrainOptions(): BrainOptions {
  return {
    retrieval: true,
    topK: 3,
    maxChars: 1800,
    minScore: 2.5,
    timeoutMs: 1500,
    autoUpdate: false,
    memoryProvider: '',
    memoryModel: '',
    memoryApiKeyEnv: '',
    maxCalls: 20,
    pinnedBudget: 2,
    autoCommit: false,
    logCapBytes: 200_000,
    verbose: true,
  }
}

/** 注入文本的硬上限：即使配置写错也不至于把请求撑爆。 */
const HARD_MAX_CHARS = 8000
/** 蒸馏请求的输入上限（字符）：只取本轮末尾部分。 */
const DISTILL_INPUT_CHARS = 6000
/** 最近一次安装的统计读取器；重装插件时由新的实例覆盖。 */
let brainStatsReadout: (() => Record<string, number>) | undefined

/** 读取当前进程内的大脑运行计数（未启用则返回 undefined）。 */
export function readBrainStats(): Record<string, number> | undefined {
  try {
    return brainStatsReadout?.()
  } catch (_error) {
    return undefined
  }
}
/** 流水页小节标题。 */
const LOG_HEADING = '## 实时沉淀'
/** 沉淀页小节标题。 */
const DISTILL_HEADING = '## 实时沉淀'
/** 记忆聚合页相对路径。 */
const DIGEST_PATH = '06-Brain/recent.md'
/** 决策与偏好页（长期约束，优先钉住）。 */
const PREFERENCE_PATH = '03-Areas/决策习惯与偏好.md'

/** 每个会话的处理状态（进程内，会话结束即释放）。 */
interface SessionState {
  /** 已处理/已尝试处理的轮次键（注入侧）。 */
  injectedTurnKey: string
  /** 已蒸馏的轮次键集合（防重复调用小模型）。 */
  distilledTurns: Set<string>
  /** 最近一次识别到的轮次键（供 turn-stopping 时取本轮）。 */
  lastTurnKey: string
  /** 当前进行中蒸馏任务。 */
  inflight: Promise<void> | undefined
  /** 上一轮已注入的路径（避免每轮重复大段注入同一篇）。 */
  lastInjectedPaths: Set<string>
  /** 最近一次「看过」的用户消息位置（surface 节点下标），用于同轮去重。 */
  lastSeenSeq: number
}

/** 蒸馏调用失败的分类（用于日志与预算控制）。 */
type DistillFailure = 'no-route' | 'no-credential' | 'empty' | 'abort'

/**
 * 创建大脑接入层。
 * @param host - 宿主能力与配置读取器。
 * @returns `capture`（把注册动作交给调用方的 `ctx.effect`，卸载即释放）与
 *   供工具复用的检索入口。诊断计数通过 {@link brainStatsReadout} 暴露。
 */
export function installBrain(host: BrainHost): {
  capture: (register: () => void) => void
  retrieve: (query: string) => Promise<{ hits: BrainHit[]; text: string }>
} {
  const { ctx, fs } = host
  const states = new Map<string, SessionState>()
  /** 单会话状态；会话被释放后再取会得到全新状态（幂等键因此失效，属预期）。 */
  const stateOf = (sessionId: string): SessionState => {
    let state = states.get(sessionId)
    if (state === undefined) {
      state = {
        injectedTurnKey: '',
        distilledTurns: new Set<string>(),
        lastTurnKey: '',
        inflight: undefined,
        lastInjectedPaths: new Set<string>(),
        lastSeenSeq: -1,
      }
      states.set(sessionId, state)
    }
    return state
  }

  /** 进程内蒸馏预算（所有会话共享，防止小模型调用失控）。 */
  let callsUsed = 0

  /**
   * 把一段注册动作挂到插件 fiber 的生命周期上：`ctx.on` 返回的 disposer 会成为
   * 本效果的清理动作，插件卸载或 HMR 重载时监听器随之解绑。
   * @param register - 执行注册；返回清理函数（可选）。
   */
  const capture = (register: () => unknown): void => {
    ctx.effect(() => {
      const returned = register()
      const dispose = typeof returned === 'function' ? returned as () => void : undefined
      return () => {
        try {
          dispose?.()
        } catch (_error) {
          // 释放期异常一律吞掉：它不能影响宿主卸载流程
        }
      }
    }, 'obsidian-sync: brain listener')
  }

  /** 检索/蒸馏的可观测计数（供诊断工具读取，不外泄任何对话内容）。 */
  const stats = {
    injected: 0,
    skippedEmpty: 0,
    skippedNoHit: 0,
    skippedNotNewTurn: 0,
    errors: 0,
    distilled: 0,
    distillSkipped: 0,
  }
  brainStatsReadout = () => ({ ...stats, callsUsed })

  // -------------------------------------------------------------------------
  // 会话事件视图（用 surface 推导历史，避免直接读事件日志的已废弃 API）
  // -------------------------------------------------------------------------

  /** 读取一个 session 的 surface 节点事件（旧 → 新）。 */
  const surfaceEvents = (session: Session): SessionEvent[] => {
    const events: SessionEvent[] = []
    for (const seq of session.surface.nodes) {
      const event = session.eventAt(seq)
      if (event !== undefined) events.push(event)
    }
    return events
  }

  /** 最近一次用户输入的位置与文本：返回末尾连续用户消息块。 */
  const tailUserMessages = (session: Session, derive: readonly Message[]): { index: number; messages: Message[] } => {
    const events = surfaceEvents(session)
    let lastUserIndex = -1
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]?.type === 'user/message') {
        lastUserIndex = i
        break
      }
    }
    if (lastUserIndex < 0) return { index: -1, messages: [] }
    let start = lastUserIndex
    while (start > 0 && events[start - 1]?.type === 'user/message') start--
    const out: Message[] = []
    for (let i = start; i <= lastUserIndex; i++) {
      const event = events[i]
      if (event?.type !== 'user/message') continue
      const message = derive.find(candidate => candidate.id === String(event.data.id)) ?? event.data
      out.push(message)
    }
    return { index: lastUserIndex, messages: out }
  }

  /** session 的派生历史（缓存版；异常时降级为空）。 */
  const deriveMessages = (session: Session): Message[] => {
    try {
      return session.deriveMessages()
    } catch (error) {
      if (host.options().verbose) ctx.logger.warn('[obsidian-sync] deriveMessages failed: ' + describeError(error))
      return []
    }
  }

  /** 当前轮次号（从 surface 末尾向前找最近一条 assistant/message 的 turn）。 */
  const currentTurn = (session: Session): number => {
    const events = surfaceEvents(session)
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      if (event !== undefined && event.type === 'assistant/message' && typeof event.data.turn === 'number') {
        return event.data.turn
      }
    }
    return 0
  }

  // -------------------------------------------------------------------------
  // 1. 每轮检索注入
  // -------------------------------------------------------------------------

  /** 超时包装：超时返回 `sentinel`。 */
  const withTimeout = async <T>(promise: Promise<T>, ms: number, sentinel: T): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        promise,
        new Promise<T>(resolve => {
          timer = setTimeout(() => resolve(sentinel), Math.max(50, ms))
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /**
   * 为一个查询检索记忆并渲染注入文本。
   * @param query - 用户本轮输入。
   * @param previousPaths - 上一轮已注入的路径（本轮降权，避免重复占预算）。
   * @returns 命中与注入文本（无可注入内容时 text 为空串）。
   */
  const retrieve = async (query: string, previousPaths?: ReadonlySet<string>): Promise<{ hits: BrainHit[]; text: string }> => {
    const options = host.options()
    const ready = await withTimeout(host.ensureIndexReady(options.timeoutMs).catch(() => false), options.timeoutMs, false)
    if (!ready) return { hits: [], text: '' }
    // 注意：`host.snapshotNotes()` 是宿主注入的回调，这里必须显式传入 query 参数。
    const readyNotes = await host.snapshotNotes()
    const notes = Array.isArray(readyNotes) ? readyNotes : []
    if (notes.length === 0) return { hits: [], text: '' }
    const queryTokens = host.tokenize(query)
    // 多取一些候选，随后按「上一轮已注入」降权，再做最终截断。
    // 全部笔记都参与打分（IDF 需要真实文档频率），候选上限只用于重排阶段。
    const scored = searchBrain(notes, queryTokens, notes.length, options.minScore)
    const candidateCap = Math.max(options.topK * 4, 12)
    const candidates = scored.length > candidateCap ? scored.slice(0, candidateCap) : scored
    const reranked = candidates
      .map(hit => ({ hit, penalty: previousPaths?.has(hit.path) === true ? hit.score * 0.4 : hit.score }))
      .sort((a, b) => b.penalty - a.penalty)
      .map(entry => entry.hit)
      .slice(0, options.topK)
    if (reranked.length === 0) return { hits: [], text: '' }
    const contents = await withTimeout(host.readNotes(reranked.map(hit => hit.path)).catch(() => new Map<string, string>()), options.timeoutMs, new Map<string, string>())
    const hits: BrainHit[] = reranked.map(hit => {
      const body = contents.get(hit.path)
      return body === undefined || body.length === 0 ? hit : { ...hit, snippet: body }
    })
    const pinned = [...pickPinned(hits, options.pinnedBudget)]
    // 长期约束页（决策习惯与偏好）单独成段注入：它是最高价值的"人格记忆"，
    // 因此在命中列表里剔除，避免同一内容占两份预算。
    const preference = hits.find(hit => hit.path === PREFERENCE_PATH || hit.path.endsWith('/' + PREFERENCE_PATH))
    const listed = hits.filter(hit => hit !== preference)
    const pinnedListed = pinned.filter(path => path !== preference?.path)
    let text = renderInjectText(query, listed, {
      maxChars: Math.min(options.maxChars, HARD_MAX_CHARS),
      pinned: pinnedListed,
      originLabel: '每轮自动检索',
    })
    if (preference !== undefined) {
      // 即使因为阈值没进命中集，偏好页也值得附带——但它不是"检索命中"，用量压小。
      const excerpt = extractPinnedExcerpt(preference.snippet, 400)
      if (excerpt.length > 0) {
        const head = '【长期约束 · 用户决策习惯与偏好】\n' + excerpt
        text = text.length === 0 ? head : head + '\n\n' + text
      }
    } else {
      // 未被任何查询命中时，偏好页仍作为"常驻记忆"注入（只读一次，成本极小）。
      const constant = (await host.readNotes([PREFERENCE_PATH]).catch(() => new Map<string, string>())).get(PREFERENCE_PATH)
      const excerpt = constant === undefined ? '' : extractPinnedExcerpt(constant, 400)
      if (excerpt.length > 0) {
        const head = '【长期约束 · 用户决策习惯与偏好】\n' + excerpt
        text = text.length === 0 ? head : head + '\n\n' + text
      }
    }
    return { hits, text: text.length > HARD_MAX_CHARS ? text.slice(0, HARD_MAX_CHARS) : text }
  }

  /** 读取一条消息当前所在的 inbox 边界：'next-turn' | 'next-step' | undefined。 */
  const boundaryOf = (agent: { inbox?: { nextTurn: readonly { id: string }[]; nextStep: readonly { id: string }[] } }, message: { id: string }): 'next-turn' | 'next-step' | undefined => {
    try {
      const inbox = agent.inbox
      if (inbox === undefined) return undefined
      if (inbox.nextTurn.some(candidate => candidate.id === message.id)) return 'next-turn'
      if (inbox.nextStep.some(candidate => candidate.id === message.id)) return 'next-step'
    } catch (_error) {
      // inbox 不可用时按"未知"处理，交由后续轮次判定兜底
    }
    return undefined
  }

  /** 注入一条记忆消息：steering（跟随本轮排队输入，不额外唤醒）。 */
  const injectMemory = (agent: { steer: (message: UserMessage) => void }, text: string, query: string): void => {
    try {
      const message = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'obsidian-brain', plugin: PLUGIN_PACKAGE_NAME, path: query.slice(0, 120) },
      }) as UserMessage
      agent.steer(message)
    } catch (error) {
      stats.errors++
      if (host.options().verbose) ctx.logger.warn('[obsidian-sync] inject failed: ' + describeError(error))
    }
  }

  /**
   * 本轮幂等键：同一轮内的重复通知必须得到同一个键。
   *
   * 规则：
   *   - 末尾有 ≥2 条连续用户消息 = 用户又排队了一条新输入 → 用最后一条的 seq 做键；
   *   - 只有 1 条且已处理过 → 是同一轮的后续插入 → 用"已处理轮次的原键"，
   *     从而被调用方的 `injectedTurnKey` 拦下（不重复注入、不重复检索）。
   *   - 会话第一轮（尚未处理过）→ 用当前 seq 做键。
   *
   * @param state - 该会话的处理状态。
   * @param session - 会话（取轮次号）。
   * @param tail - 末尾用户消息块。
   * @param userText - 该块的用户文本。
   * @returns 幂等键。
   */
  const turnKeyOf = (
    state: SessionState,
    session: Session,
    tail: { index: number; messages: Message[] },
    userText: string,
  ): string => {
    const turn = currentTurn(session)
    const isBatch = tail.messages.length > 1
    const fresh = turnKey(turn, tail.index, userText) + (isBatch ? ':batch' : '')
    if (!isBatch) {
      // 单条消息：若它已被"处理过"（注入过，或在关闭期被看过），视为同一轮的
      // 后续通知 → 沿用旧键触发去重；否则就是新的一轮。
      if (state.lastSeenSeq === tail.index) return state.injectedTurnKey
      state.lastSeenSeq = tail.index
      return fresh
    }
    return fresh
  }

  /**
   * `agent/inbox/inserted` 处理器：识别新一轮 → 检索 → 注入。
   *
   * 注意：这里**不能** await 长时间操作。注入的消息必须与已排队的用户输入
   * 一起被本轮 pre-step 认领，所以检索必须在极短时间内完成（默认 1.5s 超时）。
   */
  const onInboxInserted = (payload: { agent: { id: string; session: Session; inbox?: { nextTurn: readonly { id: string }[]; nextStep: readonly { id: string }[] }; steer: (message: UserMessage) => void }; message: UserMessage }): void => {
    const options = host.options()
    if (!options.retrieval) return
    const message = payload.message
    if (isInjectedBrainMessage(message)) return
    if (isSystemNoticeMessage(message)) return
    // 只有「排队等下一轮」的用户消息才会开启新一轮；next-step 的 steering 是
    // 运行中追加的输入，不重新检索（否则同一用户意图会重复注入）。
    const boundary = boundaryOf(payload.agent, message)
    if (boundary === 'next-step') return
    const session = payload.agent.session
    const state = stateOf(String(payload.agent.id))
    const derived = deriveMessages(session)
    const tail = tailUserMessages(session, derived)
    if (tail.index < 0) return
    const userText = collectTurnUserText(tail.messages)
    if (userText.trim().length === 0) return
    const key = turnKeyOf(state, session, tail, userText)
    if (state.injectedTurnKey === key) {
      stats.skippedNotNewTurn++
      return
    }
    // 先占位：同一轮后续插入不再重复处理。
    state.injectedTurnKey = key
    state.lastTurnKey = key
    void retrieve(userText, state.lastInjectedPaths)
      .then(({ hits, text }) => {
        if (text.trim().length === 0) {
          stats.skippedNoHit++
          return
        }
        state.lastInjectedPaths = new Set(hits.map(hit => hit.path))
        injectMemory(payload.agent, text, userText)
        stats.injected++
      })
      .catch((error: unknown) => {
        stats.errors++
        if (host.options().verbose) ctx.logger.warn('[obsidian-sync] retrieval failed: ' + describeError(error))
      })
  }

  // -------------------------------------------------------------------------
  // 2. 实时更新大脑（蒸馏）
  // -------------------------------------------------------------------------

  /** 解析蒸馏使用的路由与 API key 引用。 */
  const resolveDistillRoute = (): { provider: string; model: string; apiKeyEnv: string } => {
    const options = host.options()
    const route = host.currentRoute()
    return {
      provider: options.memoryProvider || route.provider || '',
      model: options.memoryModel || route.model || '',
      apiKeyEnv: options.memoryApiKeyEnv,
    }
  }

  /** 调用一次模型，取回完整文本（用于蒸馏与静默摘要）。 */
  const callModel = async (input: {
    prompt: string
    provider: string
    model: string
    apiKeyEnv: string
    maxTokens: number
    signal?: AbortSignal
  }): Promise<{ text: string } | { failure: DistillFailure }> => {
    const llm = ctx.get('llm') as
      | {
        stream: (options: unknown) => AsyncIterable<StreamChunk>
        listProviders: () => { id: string }[]
      }
      | undefined
    if (llm === undefined) return { failure: 'no-route' }
    const providers = llm.listProviders().map(provider => provider.id)
    if (!providers.includes(input.provider)) return { failure: 'no-route' }
    // 凭据平面属于 provider 自己（`dsh-llm-pi-ai` 用 apiKeyEnv 在每次请求时解析）。
    // 本模块只做一次「预检」：配置了 `brainMemoryApiKeyEnv` 但解析不到时立刻跳过，
    // 免得把必然 MISSING_CREDENTIAL 的请求发出去；解析成功时也仅用于判定可用性。
    if (input.apiKeyEnv.length > 0) {
      const credentials = ctx.get('credentials') as
        | { resolve: (ref: string) => Promise<{ value: string } | undefined> }
        | undefined
      const resolved = credentials === undefined ? undefined : await credentials.resolve(input.apiKeyEnv).catch(() => undefined)
      if (resolved?.value === undefined || resolved.value.length === 0) return { failure: 'no-credential' }
    }
    let text = ''
    let finished = false
    for await (const chunk of llm.stream({
      provider: input.provider,
      model: input.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: input.prompt }] }],
      maxTokens: input.maxTokens,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })) {
      if (input.signal?.aborted === true) return { failure: 'abort' }
      switch (chunk.type) {
        case 'text-delta':
          text += chunk.text
          break
        case 'finish':
          finished = true
          if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') return { failure: 'abort' }
          break
        default:
          break
      }
    }
    if (!finished && text.trim().length === 0) return { failure: 'empty' }
    return { text: text.trim() }
  }

  /** 蒸馏提示词：要求严格 JSON，降低 token、便于解析。 */
  const buildDistillPrompt = (input: { userText: string; assistantText: string; titles: readonly string[]; date: string }): string => [
    '你是知识库的「沉淀器」。请把下面这轮对话压缩成可长期复用的记忆条目。',
    '',
    '【已有相关笔记】',
    input.titles.length > 0 ? input.titles.map(title => '- ' + title).join('\n') : '（无）',
    '',
    '【本轮用户需求】',
    clipForPrompt(input.userText, 2000),
    '',
    '【本轮助手给出的结论/改动】',
    clipForPrompt(input.assistantText, 3500),
    '',
    '【输出要求】',
    '只输出一个 JSON 对象，不要任何解释或 Markdown 围栏，字段：',
    '- title: 一句话主题（≤ 40 字）',
    '- summary: 结论/要点（≤ 200 字，写清"做了什么/结论是什么/为什么"）',
    '- keywords: 检索关键词数组（3~8 个，中英文均可，避免"的/了/the"等虚词）',
    '- related: 与已有相关笔记有关联的路径数组（只能从上面列表里原样挑选，没有就 []）',
    '- pinned: 布尔，是否长期有效（偏好、决策、架构事实 = true；一次性琐事 = false）',
    '- open: 布尔，是否还有未完成事项',
    `今天日期：${input.date}`,
  ].join('\n')

  /** 截断长文本用于提示词。 */
  const clipForPrompt = (text: string, max: number): string => {
    const value = String(text ?? '').trim()
    return value.length <= max ? value : '…' + value.slice(value.length - max)
  }

  /** 安全写 vault 文件（路径相对 vault 根）。返回是否写入成功。 */
  const writeVaultFile = async (relPath: string, content: string): Promise<boolean> => {
    try {
      const target: FsTarget = await fs.resolve(host.vaultPath() + '/' + relPath)
      await fs.writeText(target, content, undefined, undefined, host.writePolicy())
      return true
    } catch (error) {
      if (host.options().verbose) ctx.logger.warn('[obsidian-sync] write ' + relPath + ' failed: ' + describeError(error))
      return false
    }
  }

  /** 读取 vault 文件；不存在返回空串。 */
  const readVaultFile = async (relPath: string): Promise<string> => {
    try {
      const target = await fs.resolve(host.vaultPath() + '/' + relPath)
      return String(await fs.readText(target))
    } catch (_error) {
      return ''
    }
  }

  /** 蒸馏结果落盘：流水页 + 沉淀摘要行 + 聚合页。 */
  const persistDistill = async (input: {
    date: string
    time: string
    sessionTitle: string
    turnKey: string
    userText: string
    memory: DistilledMemory
    hits: readonly BrainHit[]
  }): Promise<string[]> => {
    const options = host.options()
    const written: string[] = []
    const { memory, date, time } = input
    // (a) 04-Archive 流水页：找本会话今天已有的归档页（由 obsidian_sync_session 创建），没有则新建。
    const archiveRel = await findOrCreateArchivePage(input.sessionTitle, date, input.userText)
    if (archiveRel !== undefined) {
      const block = [
        '### 轮次 · ' + time + (memory.title.length > 0 ? ' · ' + memory.title : ''),
        '- 用户：' + oneLineText(input.userText, 400),
        memory.summary.length > 0 ? '- 结论：' + memory.summary : '',
        memory.open ? '- 待办：未完成事项见本轮对话（需人工确认）' : '',
      ].filter(line => line.length > 0).join('\n')
      const previous = await readVaultFile(archiveRel)
      const next = appendTurnBlock(previous, input.turnKey, block, { date, capBytes: options.logCapBytes, heading: LOG_HEADING })
      if (next.changed && await writeVaultFile(archiveRel, next.content)) written.push(archiveRel)
    }
    // (b) 02/03/05 沉淀页：追加一行摘要（幂等，行级去重）
    const line = renderDistillLine({
      date,
      title: memory.title,
      keywords: memory.keywords,
      summary: memory.summary.length > 0 ? memory.summary : memory.title,
      pinned: memory.pinned,
      open: memory.open,
    })
    const targets = new Set<string>(memory.related)
    for (const hit of input.hits) {
      if (hit.tier !== 'distilled') continue
      targets.add(hit.path)
      if (targets.size >= 3) break
    }
    for (const relPath of targets) {
      if (!relPath.endsWith('.md')) continue
      const previous = await readVaultFile(relPath)
      if (previous.length === 0) continue
      const next = appendDistillSection(previous, line, DISTILL_HEADING)
      if (next.changed && await writeVaultFile(relPath, next.content)) written.push(relPath)
    }
    // (c) 06-Brain/recent.md：最近沉淀聚合（7 天）
    const digestPrevious = await readVaultFile(DIGEST_PATH)
    const digestNext = appendDigest(digestPrevious, line, date)
    if (digestNext.changed && await writeVaultFile(DIGEST_PATH, digestNext.content)) written.push(DIGEST_PATH)
    if (written.length > 0) host.markDirty()
    if (options.autoCommit && written.length > 0) await gitCommit('live-brain: ' + date + ' · ' + written.length + ' files')
    return written
  }

  /** 找本会话当天的归档页；不存在则创建（保证实时流水有落点）。 */
  const findOrCreateArchivePage = async (title: string, date: string, userText: string): Promise<string | undefined> => {
    try {
      const archiveDir = await fs.resolve(host.vaultPath() + '/04-Archive')
      const entries = await fs.listDir(archiveDir)
      // 归档页命名：`<date>-<shortId>-<标题>.md`；这里用标题收敛，避免多个会话共用一页。
      const safe = sanitizeTitle(title.length > 0 ? title : firstLine(userText))
      const matches = entries.filter(entry => entry.type === 'file' && entry.name !== undefined && entry.name.startsWith(date + '-') && entry.name.endsWith('.md'))
      const sameTitle = matches.find(entry => (entry.name ?? '').includes(safe))
      if (sameTitle?.name !== undefined) return '04-Archive/' + sameTitle.name
      if (matches.length === 1 && matches[0]?.name !== undefined) return '04-Archive/' + matches[0].name
      const name = date + '-' + Date.now().toString(36) + '-' + safe + '.md'
      const frontmatter = [
        '---',
        'date: ' + date,
        'status: active',
        'tags: [archive, 实时沉淀]',
        '---',
        '',
        '# DSH 会话: ' + (title.length > 0 ? title : safe),
        '',
        '## 摘要',
        '',
        '（实时沉淀页：由 dsh-obsidian-sync 大脑在每轮结束时追加）',
        '',
      ].join('\n')
      if (!await writeVaultFile('04-Archive/' + name, frontmatter)) return undefined
      return '04-Archive/' + name
    } catch (error) {
      if (host.options().verbose) ctx.logger.warn('[obsidian-sync] archive lookup failed: ' + describeError(error))
      return undefined
    }
  }

  /** 执行本轮的蒸馏与落盘（内部实现，带预算与去重）。 */
  const distillTurn = async (session: Session, sessionTitle: string): Promise<void> => {
    const options = host.options()
    if (!options.autoUpdate) return
    const state = stateOf(session.id)
    const derived = deriveMessages(session)
    const tail = tailUserMessages(session, derived)
    if (tail.index < 0) return
    const userText = collectTurnUserText(tail.messages)
    const assistantText = collectAssistantText(derived.slice(-12))
    if (!worthDistilling(userText, assistantText)) {
      stats.distillSkipped++
      return
    }
    const key = turnKey(currentTurn(session), tail.index, userText)
    if (state.distilledTurns.has(key)) return
    state.distilledTurns.add(key)
    if (callsUsed >= options.maxCalls) {
      stats.distillSkipped++
      if (options.verbose) ctx.logger.info('[obsidian-sync] distill budget exhausted (' + String(options.maxCalls) + ' calls)')
      return
    }
    const route = resolveDistillRoute()
    if (route.provider.length === 0 || route.model.length === 0) return
    callsUsed++
    const now = new Date()
    const date = now.toISOString().slice(0, 10)
    const time = now.toTimeString().slice(0, 5)
    // 用本轮用户输入做检索，取得相关沉淀页，供蒸馏指路（也避免写入无关页面）。
    const related = await retrieve(userText).catch(() => ({ hits: [] as BrainHit[], text: '' }))
    const prompt = buildDistillPrompt({
      userText,
      assistantText,
      titles: related.hits.map(hit => hit.path),
      date,
    })
    const result = await callModel({
      prompt,
      provider: route.provider,
      model: route.model,
      apiKeyEnv: route.apiKeyEnv,
      maxTokens: 400,
    }).catch(() => ({ failure: 'empty' as DistillFailure }))
    if ('failure' in result) {
      stats.distillSkipped++
      if (options.verbose) ctx.logger.info('[obsidian-sync] distill skipped: ' + result.failure)
      return
    }
    const memory = normalizeDistill(extractJsonObject(result.text), {
      allowedPaths: [...related.hits.map(hit => hit.path), ...await distillablePaths()],
      summaryMaxChars: 400,
    })
    if (memory === undefined) {
      stats.distillSkipped++
      return
    }
    stats.distilled++
    await persistDistill({
      date,
      time,
      sessionTitle,
      turnKey: key,
      userText,
      memory,
      hits: related.hits,
    })
  }

  /** 可用于 related 白名单的沉淀层路径（防模型编造路径）。 */
  const distillablePaths = async (): Promise<string[]> => {
    try {
      const dirs = ['02-Projects', '03-Areas', '05-Resources']
      const out: string[] = []
      for (const dir of dirs) {
        const target = await fs.resolve(host.vaultPath() + '/' + dir)
        const entries = await fs.listDir(target)
        for (const entry of entries) {
          if (entry.type === 'file' && entry.name !== undefined && entry.name.endsWith('.md')) out.push(dir + '/' + entry.name)
        }
      }
      return out
    } catch (_error) {
      return []
    }
  }

  /** v2 的会话标题（如已生成）；取不到时用首条用户输入首行。 */
  const sessionTitleOf = (session: Session, derived: readonly Message[]): string => {
    const header = session.header as unknown as { title?: unknown }
    if (typeof header.title === 'string' && header.title.length > 0) return header.title
    for (const message of derived) {
      if (message.role !== 'user') continue
      if (isSystemNoticeMessage(message)) continue
      const text = collectTurnUserText([message as never])
      const line = firstLine(text)
      if (line.length > 0) return line
    }
    return ''
  }

  /** `agent/turn-stopping` 处理器：转结束前把本轮沉淀进大脑（不 await，避免拖慢收尾）。 */
  const onTurnStopping = (payload: { agent: { id: string; session: Session } }): void => {
    const options = host.options()
    if (!options.autoUpdate) return
    const session = payload.agent.session
    const derived = deriveMessages(session)
    const state = stateOf(String(payload.agent.id))
    const tail = tailUserMessages(session, derived)
    const userText = collectTurnUserText(tail.messages)
    const key = turnKey(currentTurn(session), tail.index, userText)
    if (state.lastTurnKey === '' || state.lastTurnKey !== key) state.lastTurnKey = key
    const run = distillTurn(session, sessionTitleOf(session, derived)).catch((error: unknown) => {
      stats.errors++
      if (host.options().verbose) ctx.logger.warn('[obsidian-sync] distill failed: ' + describeError(error))
    })
    state.inflight = run
    // 不等待：turn 收尾不应被小模型阻塞；仍在后台完成落盘。
    void run
  }

  // -------------------------------------------------------------------------
  // 3. 工具侧共享能力
  // -------------------------------------------------------------------------

  /** 供工具复用检索链路（`obsidian_brain`）。 */
  const exposeRetrieve = async (query: string): Promise<{ hits: BrainHit[]; text: string }> => {
    return await retrieve(query)
  }

  // -------------------------------------------------------------------------
  // 事件注册（用 capture 包住 ctx，保证插件卸载时监听器随之释放）
  // -------------------------------------------------------------------------

  /** 订阅 agent 事件；`ctx.on` 返回的 disposer 由外层 `ctx.effect` 托管。 */
  const register = (name: 'agent/inbox/inserted' | 'agent/turn-stopping', handler: (...args: never[]) => void): void => {
    capture(() => {
      const on = ctx.on as unknown as (event: string, listener: (...args: never[]) => void) => unknown
      on(name, handler)
    })
  }
  register('agent/inbox/inserted', onInboxInserted as never)
  register('agent/turn-stopping', onTurnStopping as never)

  return {
    capture,
    retrieve: exposeRetrieve,
  }

  // ---------------------------------------------------------------------------
  // 内部工具函数（放在闭包内，便于共享 ctx / fs）
  // ---------------------------------------------------------------------------

  /** git commit + push（失败静默，仅日志）。 */
  async function gitCommit(message: string): Promise<void> {
    try {
      const { execSync } = await import('node:child_process')
      const status = execSync('git add -A && git status --porcelain', {
        cwd: host.vaultPath(),
        timeout: 15_000,
        encoding: 'utf-8',
      })
      if (status.trim().length === 0) return
      execSync('git commit -m "' + message.replace(/"/g, '\\"') + '" && git push', {
        cwd: host.vaultPath(),
        timeout: 60_000,
        encoding: 'utf-8',
      })
    } catch (error) {
      if (host.options().verbose) ctx.logger.warn('[obsidian-sync] git commit failed: ' + describeError(error))
    }
  }
}

/** 错误信息收敛。 */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** 压缩为单行并截断。 */
function oneLineText(text: string, max: number): string {
  const flat = String(text ?? '').replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : flat.slice(0, Math.max(0, max - 1)) + '…'
}

/** 取第一行非空文本（用作标题兜底）。 */
function firstLine(text: string): string {
  for (const line of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const trimmed = line.replace(/^[#>*\-\s]+/, '').trim()
    if (trimmed.length > 0) return trimmed.slice(0, 40)
  }
  return ''
}

/** 文件名安全化（与既有归档器规则一致：去掉路径分隔与括号，限 40 字）。 */
function sanitizeTitle(title: string): string {
  const base = String(title || '')
    .replace(/[\\/:*?"<>|（）()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return base.length > 0 ? base.slice(0, 40) : '会话'
}

/**
 * 追加到 `06-Brain/recent.md` 的当日列表，并只保留最近 7 天的条目。
 * @param content - 全文。
 * @param line - 行内容（已被沉淀页使用过，行级幂等）。
 * @param date - 当天日期。
 * @returns 新全文与是否变更。
 */
function appendDigest(content: string, line: string, date: string): { content: string; changed: boolean } {
  const heading = '# 大脑 · 最近沉淀'
  const intro = '> 由 dsh-obsidian-sync 在每轮结束时自动追加，仅保留最近 7 天。'
  const existing = String(content ?? '').trim().length === 0
    ? heading + '\n\n' + intro + '\n'
    : String(content)
  const dayHeading = '## ' + date
  const lines = existing.split('\n')
  if (lines.some(item => item.trim() === line.trim())) return { content: existing, changed: false }
  const dayIndex = lines.findIndex(item => item.trim() === dayHeading)
  let next: string[]
  if (dayIndex === -1) {
    const insertPoints = ['## ']
    let at = lines.length
    for (const marker of insertPoints) {
      const found = lines.findIndex((item, index) => index > 0 && item.startsWith(marker))
      if (found !== -1 && found < at) at = found
    }
    next = [...lines.slice(0, at), dayHeading, '', line, '', ...lines.slice(at)]
  } else {
    let insertAt = dayIndex + 1
    for (let i = dayIndex + 1; i < lines.length; i++) {
      const item = lines[i] ?? ''
      if (/^#{1,2}\s/.test(item)) break
      if (item.trim().length > 0) insertAt = i + 1
    }
    next = [...lines.slice(0, insertAt), line, ...lines.slice(insertAt)]
  }
  // 只保留最近 7 天的日期段
  const daySections: { date: string; lines: string[] }[] = []
  let header: string[] = []
  let current: { date: string; lines: string[] } | undefined
  for (const item of next) {
    const match = /^## (\d{4}-\d{2}-\d{2})$/.exec(item)
    if (match !== null) {
      current = { date: match[1] ?? '', lines: [] }
      daySections.push(current)
      continue
    }
    if (current === undefined) header.push(item)
    else current.lines.push(item)
  }
  const keep = daySections
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 7)
    .sort((a, b) => b.date.localeCompare(a.date))
  const rebuilt = [...header, ...keep.flatMap(section => ['## ' + section.date, ...trimBlankEdges(section.lines)])]
  return { content: rebuilt.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n', changed: true }
}

/** 去掉数组首尾空行。 */
function trimBlankEdges(lines: readonly string[]): string[] {
  let start = 0
  let end = lines.length
  while (start < end && (lines[start] ?? '').trim().length === 0) start++
  while (end > start && (lines[end - 1] ?? '').trim().length === 0) end--
  return lines.slice(start, end)
}
