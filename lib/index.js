import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createUserMessage } from "@deepseek-ai/dsh-llm/message";
//#region src/brain-core.ts
const DEFAULT_DISTILLED = [
	"02-Projects/",
	"03-Areas/",
	"05-Resources/",
	"06-Brain/"
];
/** 判断笔记属于哪一层：沉淀层优先，其余按流水层处理。 */
function noteTier(path, distilledPrefixes = DEFAULT_DISTILLED) {
	return distilledPrefixes.some((prefix) => path.includes(prefix)) ? "distilled" : "stream";
}
/** 取路径最后一段作为标题（去掉 `.md`）。 */
function noteTitle(path) {
	return (path.split("/").pop() ?? path).replace(/\.md$/i, "");
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
function scoreNote(note, queryTokens, df, options = {}) {
	if (queryTokens.size === 0) return {
		score: 0,
		matched: []
	};
	const distilled = options.distilledPrefixes ?? DEFAULT_DISTILLED;
	const tierWeight = noteTier(note.path, distilled) === "distilled" ? 2 : 1;
	const maxMatched = options.maxMatched ?? 6;
	const total = options.totalDocuments ?? 1;
	let score = 0;
	const matched = [];
	for (const token of queryTokens) {
		if (!note.tokens.has(token)) continue;
		const tokenDf = df.get(token) ?? 0;
		const idf = Math.log((total + 1) / (tokenDf + .5));
		score += tierWeight * Math.max(idf, .05);
		if (matched.length < maxMatched) matched.push(token);
	}
	if (score <= 0) return {
		score: 0,
		matched: []
	};
	const loweredTitle = note.path.toLowerCase();
	for (const token of queryTokens) if (token.length >= 2 && loweredTitle.includes(token)) score += 1.5;
	return {
		score: Math.round(score * 1e3) / 1e3,
		matched
	};
}
/** 从笔记集合计算文档频率表（查询前一次性建好）。 */
function documentFrequencies(notes) {
	const df = /* @__PURE__ */ new Map();
	for (const note of notes) for (const token of note.tokens) df.set(token, (df.get(token) ?? 0) + 1);
	return df;
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
function searchBrain(notes, queryTokens, limit, minScore, options = {}) {
	if (limit <= 0 || queryTokens.size === 0) return [];
	const df = documentFrequencies(notes);
	const scoring = {
		...options,
		totalDocuments: notes.length
	};
	const hits = [];
	for (const note of notes) {
		const { score, matched } = scoreNote(note, queryTokens, df, scoring);
		if (score <= 0 || score < minScore) continue;
		hits.push({
			path: note.path,
			title: noteTitle(note.path),
			score,
			matched,
			tier: noteTier(note.path, options.distilledPrefixes ?? DEFAULT_DISTILLED),
			snippet: note.snippet
		});
	}
	hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
	return hits.slice(0, limit);
}
const FALLBACK_INSTRUCTION = [
	"（以上是知识库中与你本轮问题相关的既有记忆，来源：Obsidian vault。）",
	"使用要求：把其中有用的结论/偏好/历史决策当成本轮推理的前提，与当前请求结合后再回答；",
	"若记忆与当前情况冲突，以当前事实为准并说明差异；不要逐条复述记忆原文，也不要编造记忆中没有的内容。"
].join("\n");
/** 压平空白，避免注入文本里出现大段换行/缩进。 */
function oneLine(text, limit) {
	const flat = text.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
	if (flat.length <= limit) return flat;
	return flat.slice(0, Math.max(0, limit - 1)) + "…";
}
/**
* 把笔记正文压成适合注入的「单段行」：去掉 YAML frontmatter、连续空行、
* 行首列表符号与标题井号，只保留可读要点。
* @param text - 笔记全文。
* @param limit - 最大字符数。
* @returns 单段文本（超长以省略号结尾）。
*/
function excerptBody(text, limit) {
	const body = String(text ?? "").replace(/^---\n[\s\S]*?\n---\n?/, "");
	const lines = [];
	for (const raw of body.replace(/\r\n?/g, "\n").split("\n")) {
		const line = raw.replace(/^#{1,6}\s+/, "").replace(/^[-*+>]\s+/, "").replace(/\s+/g, " ").trim();
		if (line.length === 0) continue;
		lines.push(line);
	}
	return oneLine(lines.join(" / "), limit);
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
function renderInjectText(query, hits, options) {
	const pinned = new Set(options.pinned ?? []);
	const ordered = [...hits].sort((a, b) => Number(pinned.has(b.path)) - Number(pinned.has(a.path)) || b.score - a.score);
	if (ordered.length === 0) return "";
	const maxChars = Math.max(80, Math.floor(options.maxChars));
	const parts = ["【知识库记忆 · " + (options.originLabel ?? "每轮自动检索") + "】\n本轮查询：「" + oneLine(String(query ?? ""), 40) + "」"];
	if (options.instruct !== false) parts.push(FALLBACK_INSTRUCTION);
	parts.push("命中记忆：");
	let used = parts.join("\n").length;
	let included = 0;
	for (const hit of ordered) {
		const excerptLimit = hit.tier === "distilled" ? options.distilledExcerptChars ?? 420 : options.streamExcerptChars ?? 180;
		const reason = hit.matched.length > 0 ? hit.matched.slice(0, 6).join("、") : "";
		const line = "- " + hit.path + (pinned.has(hit.path) ? "（置顶）" : "") + (reason.length > 0 ? " | 命中：" + reason : "") + "\n  摘录：" + excerptBody(hit.snippet, excerptLimit);
		if (used + line.length > maxChars) {
			if (included > 0) break;
			const room = maxChars - used;
			if (room <= 20) break;
			parts.push(line.slice(0, room - 1) + "…");
			included++;
			break;
		}
		parts.push(line);
		used += line.length + 1;
		included++;
	}
	if (included === 0) return "";
	const rendered = parts.join("\n");
	return rendered.length <= maxChars ? rendered : rendered.slice(0, Math.max(0, maxChars - 1)) + "…";
}
/** 停用词：过短的纯虚词不配当关键词。 */
const STOPWORDS = /* @__PURE__ */ new Set([
	"的",
	"了",
	"是",
	"在",
	"和",
	"与",
	"也",
	"就",
	"都",
	"而",
	"及",
	"或",
	"这",
	"那",
	"一个",
	"我们",
	"你们",
	"他们",
	"the",
	"and",
	"for",
	"with",
	"that",
	"this",
	"you",
	"are",
	"was",
	"have",
	"has"
]);
/** 去噪并限制长度。 */
function clip(text, max) {
	const flat = String(text ?? "").replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").trim();
	return flat.length <= max ? flat : flat.slice(0, Math.max(0, max - 1)) + "…";
}
/**
* 从模型原始输出中抽出 JSON 对象（容忍 ```json 围栏与前后解释文字）。
* @param raw - 模型原始文本。
* @returns 解析后的对象，或 undefined。
*/
function extractJsonObject(raw) {
	const text = String(raw ?? "").trim();
	if (text.length === 0) return void 0;
	const candidates = [];
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenced?.[1] !== void 0) candidates.push(fenced[1].trim());
	candidates.push(text);
	const first = text.indexOf("{");
	const last = text.lastIndexOf("}");
	if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
	for (const candidate of candidates) try {
		const parsed = JSON.parse(candidate);
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
	} catch (_error) {}
}
/** 把任意值收敛为字符串数组（去空、去停用词、去重、限量）。 */
function stringList(value, limit) {
	if (!Array.isArray(value)) return [];
	const seen = /* @__PURE__ */ new Set();
	const out = [];
	for (const item of value) {
		if (typeof item !== "string") continue;
		const token = item.trim();
		if (token.length === 0 || token.length > 40) continue;
		if (STOPWORDS.has(token.toLowerCase())) continue;
		if (seen.has(token)) continue;
		seen.add(token);
		out.push(token);
		if (out.length >= limit) break;
	}
	return out;
}
/**
* 规范化模型蒸馏结果：字段收敛、长度截断、路径白名单过滤。
* @param raw - `extractJsonObject` 的结果。
* @param options - 白名单与长度上限。
* @returns 规范化后的记忆；`title` 与 `summary` 皆空时返回 undefined（该轮不值得入库）。
*/
function normalizeDistill(raw, options = {}) {
	if (raw === void 0) return void 0;
	const title = clip(typeof raw.title === "string" ? raw.title : "", 60);
	const summary = clip(typeof raw.summary === "string" ? raw.summary : "", options.summaryMaxChars ?? 400);
	if (title.length === 0 && summary.length === 0) return void 0;
	const allowed = options.allowedPaths;
	const related = (Array.isArray(raw.related) ? raw.related.filter((item) => typeof item === "string") : []).map((item) => item.trim().replace(/^\[\[|\]\]$/g, "").trim()).filter((item) => item.length > 0 && (allowed === void 0 || allowed.includes(item))).slice(0, 5);
	return {
		title,
		summary,
		keywords: stringList(raw.keywords, 10),
		related,
		pinned: raw.pinned === true || raw.pinned === "true",
		open: raw.open === true || raw.open === "true" || raw.hasOpenItems === true
	};
}
/**
* 判断一段对话是否值得蒸馏（避免把寒暄/工具回执也写进大脑）。
* @param userText - 本轮用户输入拼接。
* @param assistantText - 本轮助手可见文本（已剔除注入）。
* @param minChars - 低于该长度视为无实质内容。
* @returns 值得入库时返回 true。
*/
function worthDistilling(userText, assistantText, minChars = 24) {
	const user = String(userText ?? "").trim();
	const assistant = String(assistantText ?? "").trim();
	if (user.length === 0) return false;
	if (user.length + assistant.length < minChars) return false;
	if (/^(好|好的|继续|可以|嗯|ok|OK|yes|no|行)\s*[。.!！?？]*$/.test(user)) return false;
	return true;
}
/**
* 计算轮次键：同一轮内多次触发只处理一次。
* @param turn - 轮次号（未知时给 0）。
* @param userSeq - 该轮最后一条用户消息的 seq（未知给 -1）。
* @param userText - 用户输入（兜底散列）。
* @returns 稳定的轮次键。
*/
function turnKey(turn, userSeq, userText) {
	if (userSeq >= 0) return "seq:" + String(userSeq);
	if (turn > 0) return "turn:" + String(turn);
	let hash = 0;
	for (let i = 0; i < userText.length; i++) hash = Math.imul(hash, 31) + userText.charCodeAt(i) | 0;
	return "hash:" + String(hash >>> 0);
}
/**
* 渲染沉淀行。同一轮重复渲染必须完全相同（幂等），因此所有易变字段都来自入参。
* @param line - 字段。
* @returns 一行 Markdown（无前导缩进）。
*/
function renderDistillLine(line) {
	const keywordText = line.keywords.slice(0, 6).join("、");
	const oneLineSummary = clip(line.summary || line.title, 160);
	return "- " + line.date + (keywordText.length > 0 ? " · " + keywordText : "") + " — " + oneLineSummary + (line.open ? "  ⏳待办" : "");
}
/**
* 把一行沉淀追加到「## 实时沉淀」小节（不存在则创建）。
* 幂等：文本中已含该行（trim 后相同）时原样返回。
* @param content - 笔记全文。
* @param line - 已渲染的沉淀行。
* @param heading - 小节标题（默认 `## 实时沉淀`）。
* @returns 新全文；`changed=false` 表示无需写盘。
*/
function appendDistillSection(content, line, heading = "## 实时沉淀") {
	const target = line.trim();
	const existing = String(content ?? "");
	const lines = existing.split("\n");
	if (lines.some((item) => item.trim() === target)) return {
		content: existing,
		changed: false
	};
	const headingIndex = lines.findIndex((item) => item.trim() === heading);
	if (headingIndex === -1) {
		const relatedIndex = lines.findIndex((item) => item.trim() === "## 关联");
		const block = [
			heading,
			"",
			target,
			""
		];
		if (relatedIndex === -1) return {
			content: (existing.endsWith("\n") || existing.length === 0 ? existing : existing + "\n") + "\n" + block.join("\n"),
			changed: true
		};
		return {
			content: [
				...lines.slice(0, relatedIndex),
				...block,
				...lines.slice(relatedIndex)
			].join("\n"),
			changed: true
		};
	}
	let insertAt = headingIndex + 1;
	for (let i = headingIndex + 1; i < lines.length; i++) {
		const item = lines[i] ?? "";
		if (/^#{1,2}\s/.test(item)) break;
		if (item.trim().length > 0) insertAt = i + 1;
	}
	if (insertAt === headingIndex + 1) lines.splice(insertAt, 0, "", target);
	else lines.splice(insertAt, 0, target);
	return {
		content: lines.join("\n"),
		changed: true
	};
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
function appendTurnBlock(content, key, block, options) {
	const baseHeading = options.heading ?? "## 实时沉淀";
	const existing = String(content ?? "");
	if (existing.includes("<!-- turn:" + key + " -->")) return {
		content: existing,
		changed: false
	};
	const cap = Math.max(512, Math.floor(options.capBytes ?? 2e5));
	const body = "<!-- turn:" + key + " -->\n" + block.trim() + "\n";
	const full = existing.endsWith("\n") || existing.length === 0 ? existing : existing + "\n";
	const byteLength = (text) => Buffer.byteLength(text, "utf8");
	/** 第 n 个小节的标题行（n 从 1 开始）。 */
	const headingOf = (n) => n === 1 ? baseHeading + "（" + options.date + "）" : baseHeading + "（" + options.date + " 续" + String(n - 1) + "）";
	const sectionEndFrom = (start) => {
		const next = full.indexOf("\n" + baseHeading, start);
		return next === -1 ? full.length : next + 1;
	};
	let n = 1;
	for (;;) {
		const headingLine = headingOf(n);
		const headingPos = full.indexOf(headingLine);
		if (headingPos === -1) return {
			content: full + "\n" + headingLine + "\n\n" + body,
			changed: true
		};
		const sectionEnd = sectionEndFrom(headingPos);
		if (byteLength(full.slice(headingPos, sectionEnd)) + byteLength(body) <= cap) {
			const head = full.slice(0, sectionEnd);
			const tail = full.slice(sectionEnd);
			return {
				content: (head.endsWith("\n") ? head + body : head + "\n" + body) + (tail.length > 0 ? "\n" + tail.replace(/^\n+/, "") : ""),
				changed: true
			};
		}
		n++;
		if (n > 64) return {
			content: full + "\n" + baseHeading + "\n\n" + body,
			changed: true
		};
	}
}
/** 拼接一条消息中的全部文本块。 */
function messageText(message) {
	const parts = [];
	for (const block of message.content) if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) parts.push(block.text);
	return parts.join("\n").trim();
}
/** 是否为插件自己注入的记忆消息（参与轮次判定，但不参与蒸馏）。 */
function isInjectedBrainMessage(message) {
	return message.source?.kind === "obsidian-brain";
}
/** 是否为 DSH 自身的系统通知（文件变更、定时任务、目标续轮等），不作为用户输入。 */
function isSystemNoticeMessage(message) {
	const kind = message.source?.kind ?? "";
	if (kind === "" || kind === "user") return false;
	return kind !== "obsidian-brain";
}
/**
* 从一轮消息中抽取可用于检索的用户输入。
* @param messages - 本轮的用户消息（surface 顺序）。
* @returns 拼接后的输入文本（只保留最后 2000 字，避免超长粘贴）。
*/
function collectTurnUserText(messages) {
	const parts = [];
	for (const message of messages) {
		if (isSystemNoticeMessage(message)) continue;
		if (isInjectedBrainMessage(message)) continue;
		const text = messageText(message);
		if (text.length > 0) parts.push(text);
	}
	const joined = parts.join("\n").trim();
	return joined.length > 2e3 ? joined.slice(joined.length - 2e3) : joined;
}
/**
* 从一轮消息中抽取助手的可见结论（用于蒸馏）。
* @param messages - 本轮与助手相关的消息。
* @param maxChars - 保留末尾多少字符。
* @returns 拼接后的助手文本。
*/
function collectAssistantText(messages, maxChars = 4e3) {
	const parts = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		const text = messageText(message);
		if (text.length > 0) parts.push(text);
	}
	const joined = parts.join("\n\n").trim();
	return joined.length > maxChars ? joined.slice(joined.length - maxChars) : joined;
}
/** 从命中集合中挑出「钉住」项：沉淀层里分数最高的若干篇。 */
function pickPinned(hits, budget) {
	return hits.filter((hit) => hit.tier === "distilled").slice(0, Math.max(0, Math.floor(budget))).map((hit) => hit.path);
}
/**
* 从用户偏好页等固定文件里抽取「长期约束」段落（避免把整页塞进注入文本）。
* @param content - 页面全文。
* @param maxChars - 截断上限。
* @returns 可注入的片段；空串表示没有可用内容。
*/
function extractPinnedExcerpt(content, maxChars = 500) {
	const text = String(content ?? "").replace(/\r\n?/g, "\n");
	if (text.trim().length === 0) return "";
	const flat = text.replace(/^---\n[\s\S]*?\n---\n?/, "").trim().split("\n").filter((line) => line.trim().length > 0).join("\n");
	return flat.length <= maxChars ? flat : flat.slice(0, Math.max(0, maxChars - 1)) + "…";
}
/** npm 包名：`plugins.bundle.config` slot 的 key。 */
const PLUGIN_PACKAGE_NAME = "@dingpenghui/dsh-obsidian-sync";
//#endregion
//#region src/brain.ts
/** 注入文本的硬上限：即使配置写错也不至于把请求撑爆。 */
const HARD_MAX_CHARS = 8e3;
/** 最近一次安装的统计读取器；重装插件时由新的实例覆盖。 */
let brainStatsReadout;
/** 读取当前进程内的大脑运行计数（未启用则返回 undefined）。 */
function readBrainStats() {
	try {
		return brainStatsReadout?.();
	} catch (_error) {
		return;
	}
}
/** 流水页小节标题。 */
const LOG_HEADING = "## 实时沉淀";
/** 沉淀页小节标题。 */
const DISTILL_HEADING = "## 实时沉淀";
/** 记忆聚合页相对路径。 */
const DIGEST_PATH = "06-Brain/recent.md";
/** 决策与偏好页（长期约束，优先钉住）。 */
const PREFERENCE_PATH = "03-Areas/决策习惯与偏好.md";
/**
* 创建大脑接入层。
* @param host - 宿主能力与配置读取器。
* @returns `capture`（把注册动作交给调用方的 `ctx.effect`，卸载即释放）与
*   供工具复用的检索入口。诊断计数通过 {@link brainStatsReadout} 暴露。
*/
function installBrain(host) {
	const { ctx, fs } = host;
	const states = /* @__PURE__ */ new Map();
	/** 单会话状态；会话被释放后再取会得到全新状态（幂等键因此失效，属预期）。 */
	const stateOf = (sessionId) => {
		let state = states.get(sessionId);
		if (state === void 0) {
			state = {
				injectedTurnKey: "",
				distilledTurns: /* @__PURE__ */ new Set(),
				lastTurnKey: "",
				inflight: void 0,
				lastInjectedPaths: /* @__PURE__ */ new Set(),
				lastSeenSeq: -1
			};
			states.set(sessionId, state);
		}
		return state;
	};
	/** 进程内蒸馏预算（所有会话共享，防止小模型调用失控）。 */
	let callsUsed = 0;
	/**
	* 把一段注册动作挂到插件 fiber 的生命周期上：`ctx.on` 返回的 disposer 会成为
	* 本效果的清理动作，插件卸载或 HMR 重载时监听器随之解绑。
	* @param register - 执行注册；返回清理函数（可选）。
	*/
	const capture = (register) => {
		ctx.effect(() => {
			const returned = register();
			const dispose = typeof returned === "function" ? returned : void 0;
			return () => {
				try {
					dispose?.();
				} catch (_error) {}
			};
		}, "obsidian-sync: brain listener");
	};
	/** 检索/蒸馏的可观测计数（供诊断工具读取，不外泄任何对话内容）。 */
	const stats = {
		injected: 0,
		skippedEmpty: 0,
		skippedNoHit: 0,
		skippedNotNewTurn: 0,
		errors: 0,
		distilled: 0,
		distillSkipped: 0
	};
	brainStatsReadout = () => ({
		...stats,
		callsUsed
	});
	/** 读取一个 session 的 surface 节点事件（旧 → 新）。 */
	const surfaceEvents = (session) => {
		const events = [];
		for (const seq of session.surface.nodes) {
			const event = session.eventAt(seq);
			if (event !== void 0) events.push(event);
		}
		return events;
	};
	/** 最近一次用户输入的位置与文本：返回末尾连续用户消息块。 */
	const tailUserMessages = (session, derive) => {
		const events = surfaceEvents(session);
		let lastUserIndex = -1;
		for (let i = events.length - 1; i >= 0; i--) if (events[i]?.type === "user/message") {
			lastUserIndex = i;
			break;
		}
		if (lastUserIndex < 0) return {
			index: -1,
			messages: []
		};
		let start = lastUserIndex;
		while (start > 0 && events[start - 1]?.type === "user/message") start--;
		const out = [];
		for (let i = start; i <= lastUserIndex; i++) {
			const event = events[i];
			if (event?.type !== "user/message") continue;
			const message = derive.find((candidate) => candidate.id === String(event.data.id)) ?? event.data;
			out.push(message);
		}
		return {
			index: lastUserIndex,
			messages: out
		};
	};
	/** session 的派生历史（缓存版；异常时降级为空）。 */
	const deriveMessages = (session) => {
		try {
			return session.deriveMessages();
		} catch (error) {
			if (host.options().verbose) ctx.logger.warn("[obsidian-sync] deriveMessages failed: " + describeError(error));
			return [];
		}
	};
	/** 当前轮次号（从 surface 末尾向前找最近一条 assistant/message 的 turn）。 */
	const currentTurn = (session) => {
		const events = surfaceEvents(session);
		for (let i = events.length - 1; i >= 0; i--) {
			const event = events[i];
			if (event !== void 0 && event.type === "assistant/message" && typeof event.data.turn === "number") return event.data.turn;
		}
		return 0;
	};
	/** 超时包装：超时返回 `sentinel`。 */
	const withTimeout = async (promise, ms, sentinel) => {
		let timer;
		try {
			return await Promise.race([promise, new Promise((resolve) => {
				timer = setTimeout(() => resolve(sentinel), Math.max(50, ms));
			})]);
		} finally {
			if (timer !== void 0) clearTimeout(timer);
		}
	};
	/**
	* 为一个查询检索记忆并渲染注入文本。
	* @param query - 用户本轮输入。
	* @param previousPaths - 上一轮已注入的路径（本轮降权，避免重复占预算）。
	* @returns 命中与注入文本（无可注入内容时 text 为空串）。
	*/
	const retrieve = async (query, previousPaths) => {
		const options = host.options();
		if (!await withTimeout(host.ensureIndexReady(options.timeoutMs).catch(() => false), options.timeoutMs, false)) return {
			hits: [],
			text: ""
		};
		const readyNotes = await host.snapshotNotes();
		const notes = Array.isArray(readyNotes) ? readyNotes : [];
		if (notes.length === 0) return {
			hits: [],
			text: ""
		};
		const scored = searchBrain(notes, host.tokenize(query), notes.length, options.minScore);
		const candidateCap = Math.max(options.topK * 4, 12);
		const reranked = (scored.length > candidateCap ? scored.slice(0, candidateCap) : scored).map((hit) => ({
			hit,
			penalty: previousPaths?.has(hit.path) === true ? hit.score * .4 : hit.score
		})).sort((a, b) => b.penalty - a.penalty).map((entry) => entry.hit).slice(0, options.topK);
		if (reranked.length === 0) return {
			hits: [],
			text: ""
		};
		const contents = await withTimeout(host.readNotes(reranked.map((hit) => hit.path)).catch(() => /* @__PURE__ */ new Map()), options.timeoutMs, /* @__PURE__ */ new Map());
		const hits = reranked.map((hit) => {
			const body = contents.get(hit.path);
			return body === void 0 || body.length === 0 ? hit : {
				...hit,
				snippet: body
			};
		});
		const pinned = [...pickPinned(hits, options.pinnedBudget)];
		const preference = hits.find((hit) => hit.path === PREFERENCE_PATH || hit.path.endsWith("/" + PREFERENCE_PATH));
		const listed = hits.filter((hit) => hit !== preference);
		const pinnedListed = pinned.filter((path) => path !== preference?.path);
		let text = renderInjectText(query, listed, {
			maxChars: Math.min(options.maxChars, HARD_MAX_CHARS),
			pinned: pinnedListed,
			originLabel: "每轮自动检索"
		});
		if (preference !== void 0) {
			const excerpt = extractPinnedExcerpt(preference.snippet, 400);
			if (excerpt.length > 0) {
				const head = "【长期约束 · 用户决策习惯与偏好】\n" + excerpt;
				text = text.length === 0 ? head : head + "\n\n" + text;
			}
		} else {
			const constant = (await host.readNotes([PREFERENCE_PATH]).catch(() => /* @__PURE__ */ new Map())).get(PREFERENCE_PATH);
			const excerpt = constant === void 0 ? "" : extractPinnedExcerpt(constant, 400);
			if (excerpt.length > 0) {
				const head = "【长期约束 · 用户决策习惯与偏好】\n" + excerpt;
				text = text.length === 0 ? head : head + "\n\n" + text;
			}
		}
		return {
			hits,
			text: text.length > HARD_MAX_CHARS ? text.slice(0, HARD_MAX_CHARS) : text
		};
	};
	/** 读取一条消息当前所在的 inbox 边界：'next-turn' | 'next-step' | undefined。 */
	const boundaryOf = (agent, message) => {
		try {
			const inbox = agent.inbox;
			if (inbox === void 0) return void 0;
			if (inbox.nextTurn.some((candidate) => candidate.id === message.id)) return "next-turn";
			if (inbox.nextStep.some((candidate) => candidate.id === message.id)) return "next-step";
		} catch (_error) {}
	};
	/** 注入一条记忆消息：steering（跟随本轮排队输入，不额外唤醒）。 */
	const injectMemory = (agent, text, query) => {
		try {
			const message = createUserMessage({
				content: [{
					type: "text",
					text
				}],
				source: {
					kind: "obsidian-brain",
					plugin: PLUGIN_PACKAGE_NAME,
					path: query.slice(0, 120)
				}
			});
			agent.steer(message);
		} catch (error) {
			stats.errors++;
			if (host.options().verbose) ctx.logger.warn("[obsidian-sync] inject failed: " + describeError(error));
		}
	};
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
	const turnKeyOf = (state, session, tail, userText) => {
		const turn = currentTurn(session);
		const isBatch = tail.messages.length > 1;
		const fresh = turnKey(turn, tail.index, userText) + (isBatch ? ":batch" : "");
		if (!isBatch) {
			if (state.lastSeenSeq === tail.index) return state.injectedTurnKey;
			state.lastSeenSeq = tail.index;
			return fresh;
		}
		return fresh;
	};
	/**
	* `agent/inbox/inserted` 处理器：识别新一轮 → 检索 → 注入。
	*
	* 注意：这里**不能** await 长时间操作。注入的消息必须与已排队的用户输入
	* 一起被本轮 pre-step 认领，所以检索必须在极短时间内完成（默认 1.5s 超时）。
	*/
	const onInboxInserted = (payload) => {
		if (!host.options().retrieval) return;
		const message = payload.message;
		if (isInjectedBrainMessage(message)) return;
		if (isSystemNoticeMessage(message)) return;
		if (boundaryOf(payload.agent, message) === "next-step") return;
		const session = payload.agent.session;
		const state = stateOf(String(payload.agent.id));
		const derived = deriveMessages(session);
		const tail = tailUserMessages(session, derived);
		if (tail.index < 0) return;
		const userText = collectTurnUserText(tail.messages);
		if (userText.trim().length === 0) return;
		const key = turnKeyOf(state, session, tail, userText);
		if (state.injectedTurnKey === key) {
			stats.skippedNotNewTurn++;
			return;
		}
		state.injectedTurnKey = key;
		state.lastTurnKey = key;
		retrieve(userText, state.lastInjectedPaths).then(({ hits, text }) => {
			if (text.trim().length === 0) {
				stats.skippedNoHit++;
				return;
			}
			state.lastInjectedPaths = new Set(hits.map((hit) => hit.path));
			injectMemory(payload.agent, text, userText);
			stats.injected++;
		}).catch((error) => {
			stats.errors++;
			if (host.options().verbose) ctx.logger.warn("[obsidian-sync] retrieval failed: " + describeError(error));
		});
	};
	/** 解析蒸馏使用的路由与 API key 引用。 */
	const resolveDistillRoute = () => {
		const options = host.options();
		const route = host.currentRoute();
		return {
			provider: options.memoryProvider || route.provider || "",
			model: options.memoryModel || route.model || "",
			apiKeyEnv: options.memoryApiKeyEnv
		};
	};
	/** 调用一次模型，取回完整文本（用于蒸馏与静默摘要）。 */
	const callModel = async (input) => {
		const llm = ctx.get("llm");
		if (llm === void 0) return { failure: "no-route" };
		if (!llm.listProviders().map((provider) => provider.id).includes(input.provider)) return { failure: "no-route" };
		if (input.apiKeyEnv.length > 0) {
			const credentials = ctx.get("credentials");
			const resolved = credentials === void 0 ? void 0 : await credentials.resolve(input.apiKeyEnv).catch(() => void 0);
			if (resolved?.value === void 0 || resolved.value.length === 0) return { failure: "no-credential" };
		}
		let text = "";
		let finished = false;
		for await (const chunk of llm.stream({
			provider: input.provider,
			model: input.model,
			messages: [{
				role: "user",
				content: [{
					type: "text",
					text: input.prompt
				}]
			}],
			maxTokens: input.maxTokens,
			...input.signal === void 0 ? {} : { signal: input.signal }
		})) {
			if (input.signal?.aborted === true) return { failure: "abort" };
			switch (chunk.type) {
				case "text-delta":
					text += chunk.text;
					break;
				case "finish":
					finished = true;
					if (chunk.reason.kind === "error" || chunk.reason.kind === "aborted") return { failure: "abort" };
			}
		}
		if (!finished && text.trim().length === 0) return { failure: "empty" };
		return { text: text.trim() };
	};
	/** 蒸馏提示词：要求严格 JSON，降低 token、便于解析。 */
	const buildDistillPrompt = (input) => [
		"你是知识库的「沉淀器」。请把下面这轮对话压缩成可长期复用的记忆条目。",
		"",
		"【已有相关笔记】",
		input.titles.length > 0 ? input.titles.map((title) => "- " + title).join("\n") : "（无）",
		"",
		"【本轮用户需求】",
		clipForPrompt(input.userText, 2e3),
		"",
		"【本轮助手给出的结论/改动】",
		clipForPrompt(input.assistantText, 3500),
		"",
		"【输出要求】",
		"只输出一个 JSON 对象，不要任何解释或 Markdown 围栏，字段：",
		"- title: 一句话主题（≤ 40 字）",
		"- summary: 结论/要点（≤ 200 字，写清\"做了什么/结论是什么/为什么\"）",
		"- keywords: 检索关键词数组（3~8 个，中英文均可，避免\"的/了/the\"等虚词）",
		"- related: 与已有相关笔记有关联的路径数组（只能从上面列表里原样挑选，没有就 []）",
		"- pinned: 布尔，是否长期有效（偏好、决策、架构事实 = true；一次性琐事 = false）",
		"- open: 布尔，是否还有未完成事项",
		`今天日期：${input.date}`
	].join("\n");
	/** 截断长文本用于提示词。 */
	const clipForPrompt = (text, max) => {
		const value = String(text ?? "").trim();
		return value.length <= max ? value : "…" + value.slice(value.length - max);
	};
	/** 安全写 vault 文件（路径相对 vault 根）。返回是否写入成功。 */
	const writeVaultFile = async (relPath, content) => {
		try {
			const target = await fs.resolve(host.vaultPath() + "/" + relPath);
			await fs.writeText(target, content, void 0, void 0, host.writePolicy());
			return true;
		} catch (error) {
			if (host.options().verbose) ctx.logger.warn("[obsidian-sync] write " + relPath + " failed: " + describeError(error));
			return false;
		}
	};
	/** 读取 vault 文件；不存在返回空串。 */
	const readVaultFile = async (relPath) => {
		try {
			const target = await fs.resolve(host.vaultPath() + "/" + relPath);
			return String(await fs.readText(target));
		} catch (_error) {
			return "";
		}
	};
	/** 蒸馏结果落盘：流水页 + 沉淀摘要行 + 聚合页。 */
	const persistDistill = async (input) => {
		const options = host.options();
		const written = [];
		const { memory, date, time } = input;
		const archiveRel = await findOrCreateArchivePage(input.sessionTitle, date, input.userText);
		if (archiveRel !== void 0) {
			const block = [
				"### 轮次 · " + time + (memory.title.length > 0 ? " · " + memory.title : ""),
				"- 用户：" + oneLineText(input.userText, 400),
				memory.summary.length > 0 ? "- 结论：" + memory.summary : "",
				memory.open ? "- 待办：未完成事项见本轮对话（需人工确认）" : ""
			].filter((line) => line.length > 0).join("\n");
			const next = appendTurnBlock(await readVaultFile(archiveRel), input.turnKey, block, {
				date,
				capBytes: options.logCapBytes,
				heading: LOG_HEADING
			});
			if (next.changed && await writeVaultFile(archiveRel, next.content)) written.push(archiveRel);
		}
		const line = renderDistillLine({
			date,
			title: memory.title,
			keywords: memory.keywords,
			summary: memory.summary.length > 0 ? memory.summary : memory.title,
			pinned: memory.pinned,
			open: memory.open
		});
		const targets = new Set(memory.related);
		for (const hit of input.hits) {
			if (hit.tier !== "distilled") continue;
			targets.add(hit.path);
			if (targets.size >= 3) break;
		}
		for (const relPath of targets) {
			if (!relPath.endsWith(".md")) continue;
			const previous = await readVaultFile(relPath);
			if (previous.length === 0) continue;
			const next = appendDistillSection(previous, line, DISTILL_HEADING);
			if (next.changed && await writeVaultFile(relPath, next.content)) written.push(relPath);
		}
		const digestNext = appendDigest(await readVaultFile(DIGEST_PATH), line, date);
		if (digestNext.changed && await writeVaultFile(DIGEST_PATH, digestNext.content)) written.push(DIGEST_PATH);
		if (written.length > 0) host.markDirty();
		if (options.autoCommit && written.length > 0) await gitCommit("live-brain: " + date + " · " + written.length + " files");
		return written;
	};
	/** 找本会话当天的归档页；不存在则创建（保证实时流水有落点）。 */
	const findOrCreateArchivePage = async (title, date, userText) => {
		try {
			const archiveDir = await fs.resolve(host.vaultPath() + "/04-Archive");
			const entries = await fs.listDir(archiveDir);
			const safe = sanitizeTitle(title.length > 0 ? title : firstLine(userText));
			const matches = entries.filter((entry) => entry.type === "file" && entry.name !== void 0 && entry.name.startsWith(date + "-") && entry.name.endsWith(".md"));
			const sameTitle = matches.find((entry) => (entry.name ?? "").includes(safe));
			if (sameTitle?.name !== void 0) return "04-Archive/" + sameTitle.name;
			if (matches.length === 1 && matches[0]?.name !== void 0) return "04-Archive/" + matches[0].name;
			const name = date + "-" + Date.now().toString(36) + "-" + safe + ".md";
			const frontmatter = [
				"---",
				"date: " + date,
				"status: active",
				"tags: [archive, 实时沉淀]",
				"---",
				"",
				"# DSH 会话: " + (title.length > 0 ? title : safe),
				"",
				"## 摘要",
				"",
				"（实时沉淀页：由 dsh-obsidian-sync 大脑在每轮结束时追加）",
				""
			].join("\n");
			if (!await writeVaultFile("04-Archive/" + name, frontmatter)) return void 0;
			return "04-Archive/" + name;
		} catch (error) {
			if (host.options().verbose) ctx.logger.warn("[obsidian-sync] archive lookup failed: " + describeError(error));
			return;
		}
	};
	/** 执行本轮的蒸馏与落盘（内部实现，带预算与去重）。 */
	const distillTurn = async (session, sessionTitle) => {
		const options = host.options();
		if (!options.autoUpdate) return;
		const state = stateOf(session.id);
		const derived = deriveMessages(session);
		const tail = tailUserMessages(session, derived);
		if (tail.index < 0) return;
		const userText = collectTurnUserText(tail.messages);
		const assistantText = collectAssistantText(derived.slice(-12));
		if (!worthDistilling(userText, assistantText)) {
			stats.distillSkipped++;
			return;
		}
		const key = turnKey(currentTurn(session), tail.index, userText);
		if (state.distilledTurns.has(key)) return;
		state.distilledTurns.add(key);
		if (callsUsed >= options.maxCalls) {
			stats.distillSkipped++;
			if (options.verbose) ctx.logger.info("[obsidian-sync] distill budget exhausted (" + String(options.maxCalls) + " calls)");
			return;
		}
		const route = resolveDistillRoute();
		if (route.provider.length === 0 || route.model.length === 0) return;
		callsUsed++;
		const now = /* @__PURE__ */ new Date();
		const date = now.toISOString().slice(0, 10);
		const time = now.toTimeString().slice(0, 5);
		const related = await retrieve(userText).catch(() => ({
			hits: [],
			text: ""
		}));
		const prompt = buildDistillPrompt({
			userText,
			assistantText,
			titles: related.hits.map((hit) => hit.path),
			date
		});
		const result = await callModel({
			prompt,
			provider: route.provider,
			model: route.model,
			apiKeyEnv: route.apiKeyEnv,
			maxTokens: 400
		}).catch(() => ({ failure: "empty" }));
		if ("failure" in result) {
			stats.distillSkipped++;
			if (options.verbose) ctx.logger.info("[obsidian-sync] distill skipped: " + result.failure);
			return;
		}
		const memory = normalizeDistill(extractJsonObject(result.text), {
			allowedPaths: [...related.hits.map((hit) => hit.path), ...await distillablePaths()],
			summaryMaxChars: 400
		});
		if (memory === void 0) {
			stats.distillSkipped++;
			return;
		}
		stats.distilled++;
		await persistDistill({
			date,
			time,
			sessionTitle,
			turnKey: key,
			userText,
			memory,
			hits: related.hits
		});
	};
	/** 可用于 related 白名单的沉淀层路径（防模型编造路径）。 */
	const distillablePaths = async () => {
		try {
			const dirs = [
				"02-Projects",
				"03-Areas",
				"05-Resources"
			];
			const out = [];
			for (const dir of dirs) {
				const target = await fs.resolve(host.vaultPath() + "/" + dir);
				const entries = await fs.listDir(target);
				for (const entry of entries) if (entry.type === "file" && entry.name !== void 0 && entry.name.endsWith(".md")) out.push(dir + "/" + entry.name);
			}
			return out;
		} catch (_error) {
			return [];
		}
	};
	/** v2 的会话标题（如已生成）；取不到时用首条用户输入首行。 */
	const sessionTitleOf = (session, derived) => {
		const header = session.header;
		if (typeof header.title === "string" && header.title.length > 0) return header.title;
		for (const message of derived) {
			if (message.role !== "user") continue;
			if (isSystemNoticeMessage(message)) continue;
			const line = firstLine(collectTurnUserText([message]));
			if (line.length > 0) return line;
		}
		return "";
	};
	/** `agent/turn-stopping` 处理器：转结束前把本轮沉淀进大脑（不 await，避免拖慢收尾）。 */
	const onTurnStopping = (payload) => {
		if (!host.options().autoUpdate) return;
		const session = payload.agent.session;
		const derived = deriveMessages(session);
		const state = stateOf(String(payload.agent.id));
		const tail = tailUserMessages(session, derived);
		const userText = collectTurnUserText(tail.messages);
		const key = turnKey(currentTurn(session), tail.index, userText);
		if (state.lastTurnKey === "" || state.lastTurnKey !== key) state.lastTurnKey = key;
		state.inflight = distillTurn(session, sessionTitleOf(session, derived)).catch((error) => {
			stats.errors++;
			if (host.options().verbose) ctx.logger.warn("[obsidian-sync] distill failed: " + describeError(error));
		});
	};
	/** 供工具复用检索链路（`obsidian_brain`）。 */
	const exposeRetrieve = async (query) => {
		return await retrieve(query);
	};
	/** 订阅 agent 事件；`ctx.on` 返回的 disposer 由外层 `ctx.effect` 托管。 */
	const register = (name, handler) => {
		capture(() => {
			const on = ctx.on;
			on(name, handler);
		});
	};
	register("agent/inbox/inserted", onInboxInserted);
	register("agent/turn-stopping", onTurnStopping);
	return {
		capture,
		retrieve: exposeRetrieve
	};
	/** git commit + push（失败静默，仅日志）。 */
	async function gitCommit(message) {
		try {
			const { execSync } = await import("node:child_process");
			if (execSync("git add -A && git status --porcelain", {
				cwd: host.vaultPath(),
				timeout: 15e3,
				encoding: "utf-8"
			}).trim().length === 0) return;
			execSync("git commit -m \"" + message.replace(/"/g, "\\\"") + "\" && git push", {
				cwd: host.vaultPath(),
				timeout: 6e4,
				encoding: "utf-8"
			});
		} catch (error) {
			if (host.options().verbose) ctx.logger.warn("[obsidian-sync] git commit failed: " + describeError(error));
		}
	}
}
/** 错误信息收敛。 */
function describeError(error) {
	if (error instanceof Error) return error.message;
	return String(error);
}
/** 压缩为单行并截断。 */
function oneLineText(text, max) {
	const flat = String(text ?? "").replace(/\r\n?/g, "\n").replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : flat.slice(0, Math.max(0, max - 1)) + "…";
}
/** 取第一行非空文本（用作标题兜底）。 */
function firstLine(text) {
	for (const line of String(text ?? "").replace(/\r\n?/g, "\n").split("\n")) {
		const trimmed = line.replace(/^[#>*\-\s]+/, "").trim();
		if (trimmed.length > 0) return trimmed.slice(0, 40);
	}
	return "";
}
/** 文件名安全化（与既有归档器规则一致：去掉路径分隔与括号，限 40 字）。 */
function sanitizeTitle(title) {
	const base = String(title || "").replace(/[\\/:*?"<>|（）()]/g, " ").replace(/\s+/g, " ").trim();
	return base.length > 0 ? base.slice(0, 40) : "会话";
}
/**
* 追加到 `06-Brain/recent.md` 的当日列表，并只保留最近 7 天的条目。
* @param content - 全文。
* @param line - 行内容（已被沉淀页使用过，行级幂等）。
* @param date - 当天日期。
* @returns 新全文与是否变更。
*/
function appendDigest(content, line, date) {
	const existing = String(content ?? "").trim().length === 0 ? "# 大脑 · 最近沉淀\n\n> 由 dsh-obsidian-sync 在每轮结束时自动追加，仅保留最近 7 天。\n" : String(content);
	const dayHeading = "## " + date;
	const lines = existing.split("\n");
	if (lines.some((item) => item.trim() === line.trim())) return {
		content: existing,
		changed: false
	};
	const dayIndex = lines.findIndex((item) => item.trim() === dayHeading);
	let next;
	if (dayIndex === -1) {
		const insertPoints = ["## "];
		let at = lines.length;
		for (const marker of insertPoints) {
			const found = lines.findIndex((item, index) => index > 0 && item.startsWith(marker));
			if (found !== -1 && found < at) at = found;
		}
		next = [
			...lines.slice(0, at),
			dayHeading,
			"",
			line,
			"",
			...lines.slice(at)
		];
	} else {
		let insertAt = dayIndex + 1;
		for (let i = dayIndex + 1; i < lines.length; i++) {
			const item = lines[i] ?? "";
			if (/^#{1,2}\s/.test(item)) break;
			if (item.trim().length > 0) insertAt = i + 1;
		}
		next = [
			...lines.slice(0, insertAt),
			line,
			...lines.slice(insertAt)
		];
	}
	const daySections = [];
	let header = [];
	let current;
	for (const item of next) {
		const match = /^## (\d{4}-\d{2}-\d{2})$/.exec(item);
		if (match !== null) {
			current = {
				date: match[1] ?? "",
				lines: []
			};
			daySections.push(current);
			continue;
		}
		if (current === void 0) header.push(item);
		else current.lines.push(item);
	}
	const keep = daySections.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 7).sort((a, b) => b.date.localeCompare(a.date));
	return {
		content: [...header, ...keep.flatMap((section) => ["## " + section.date, ...trimBlankEdges(section.lines)])].join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n",
		changed: true
	};
}
/** 去掉数组首尾空行。 */
function trimBlankEdges(lines) {
	let start = 0;
	let end = lines.length;
	while (start < end && (lines[start] ?? "").trim().length === 0) start++;
	while (end > start && (lines[end - 1] ?? "").trim().length === 0) end--;
	return lines.slice(start, end);
}
//#endregion
//#region src/index.ts
/** 把工具返回值断言为 JsonValue（0.2.0-rc.1 的 execute 要求返回 InferValue，
*  即 output.schema 推断出的 JsonValue；对象 union 的 undefined 分支在此收敛）。 */
function asJsonValue(v) {
	return v;
}
/** Cordis 插件名。 */
const name = "obsidian-sync";
/** 本插件需要的 Service（`tools`/`fs` 为硬依赖，缺失时等待 Cordis 重激活）。
*  仅保留真实消费的 Service：settings / llm / credentials 是可选增强
*  （未组合时对应能力降级：设置读默认值、实时蒸馏不启用）。 */
const inject = ["tools", "fs"];
/**
* Schemastery 配置 schema：加载器用它解析行 `config` 并补默认值。
*
* 注意 Schemastery 的 API 与 zod 不同：没有 `.optional()` / `.int()`。
* 对象属性默认即可选（不调用 `.required()` 时，缺失键不会写入解析结果），
* 整数约束通过 `.step(1)` 表达。
*/
/** 运行时 schema：volatile 标记 + 默认值。Loader 据此解析行 config 并补默认。 */
const Config = z.object({
	vaultPath: z.string().volatile().default("E:/dsh-workspace/obsidian-vault"),
	searchEnabled: z.boolean().default(true).volatile(),
	indexRefreshMs: z.number().step(1).min(5e3).default(6e4).volatile(),
	brainRetrieval: z.boolean().default(true).volatile(),
	brainRetrievalTopK: z.number().step(1).min(1).max(8).default(3).volatile(),
	brainRetrievalMaxChars: z.number().step(1).min(400).max(8e3).default(1800).volatile(),
	brainRetrievalMinScore: z.number().step(.1).min(0).max(100).default(2.5).volatile(),
	brainRetrievalTimeoutMs: z.number().step(1).min(200).max(1e4).default(1500).volatile(),
	brainAutoUpdate: z.boolean().default(false).volatile(),
	brainMemoryProvider: z.string().default("").volatile(),
	brainMemoryModel: z.string().default("").volatile(),
	brainMemoryApiKeyEnv: z.string().default("").volatile(),
	brainMemoryMaxCalls: z.number().step(1).min(0).max(500).default(20).volatile(),
	brainPinnedBudget: z.number().step(1).min(0).max(5).default(2).volatile(),
	brainAutoCommit: z.boolean().default(false).volatile(),
	brainLogCapBytes: z.number().step(1).min(8192).max(2e6).default(2e5).volatile()
});
function apply(ctx) {
	/** settings 服务是可选增强：未组合时降级为默认值。
	*  按 SettingsDescriptor 契约读命名空间行（ns + value 由 Loader 按
	*  本文件导出的 Config schema 解析并补默认值；volatile HMR 保存后即时刷新）。 */
	const settings = ctx.get("settings");
	/** 读命名空间行 value。 */
	const readSection = () => {
		if (settings === void 0) return void 0;
		try {
			const v = settings.describe().find((r) => r.ns === "dsh-obsidian-sync")?.value;
			return v !== null && typeof v === "object" ? v : void 0;
		} catch (_e) {
			return;
		}
	};
	const DEFAULT_VAULT_PATH = "E:/dsh-workspace/obsidian-vault";
	const currentVaultPath = () => {
		const v = readSection()?.vaultPath;
		return typeof v === "string" && v.length > 0 ? v : DEFAULT_VAULT_PATH;
	};
	const readSearchEnabled = () => {
		const v = readSection()?.searchEnabled;
		return typeof v === "boolean" ? v : true;
	};
	const readIndexRefreshMs = () => {
		const v = readSection()?.indexRefreshMs;
		return typeof v === "number" && v >= 5e3 ? v : 6e4;
	};
	/** 收敛到区间（配置被手改成越界值时兜底，而不是让调度器崩掉）。 */
	const clampNumber = (v, fallback, min, max) => {
		return Math.min(Math.max(typeof v === "number" && Number.isFinite(v) ? v : fallback, min), max);
	};
	/**
	* 读取大脑相关配置。每次调用都重读 settings（与 vaultPath 同一策略）：
	* 详情页保存后对后续轮次立即生效，无需重启。
	*/
	const readBrainOptions = () => {
		const s = readSection();
		const bool = (v, fallback) => typeof v === "boolean" ? v : fallback;
		const text = (v) => typeof v === "string" ? v.trim() : "";
		return {
			retrieval: bool(s?.brainRetrieval, true),
			topK: Math.floor(clampNumber(s?.brainRetrievalTopK, 3, 1, 8)),
			maxChars: Math.floor(clampNumber(s?.brainRetrievalMaxChars, 1800, 400, 8e3)),
			minScore: clampNumber(s?.brainRetrievalMinScore, 2.5, 0, 100),
			timeoutMs: Math.floor(clampNumber(s?.brainRetrievalTimeoutMs, 1500, 200, 1e4)),
			autoUpdate: bool(s?.brainAutoUpdate, false),
			memoryProvider: text(s?.brainMemoryProvider),
			memoryModel: text(s?.brainMemoryModel),
			memoryApiKeyEnv: text(s?.brainMemoryApiKeyEnv),
			maxCalls: Math.floor(clampNumber(s?.brainMemoryMaxCalls, 20, 0, 500)),
			pinnedBudget: Math.floor(clampNumber(s?.brainPinnedBudget, 2, 0, 5)),
			autoCommit: bool(s?.brainAutoCommit, false),
			logCapBytes: Math.floor(clampNumber(s?.brainLogCapBytes, 2e5, 8192, 2e6)),
			verbose: true
		};
	};
	let searchEnabled = readSearchEnabled();
	const refreshMs = Math.max(readIndexRefreshMs(), 5e3);
	const fs = ctx.fs;
	const index = /* @__PURE__ */ new Map();
	let dirty = true;
	let refreshing = false;
	let observedVaultPath = currentVaultPath();
	function markDirtyOnVaultChange() {
		const p = currentVaultPath();
		if (p !== observedVaultPath) {
			observedVaultPath = p;
			dirty = true;
		}
	}
	/**
	* vault 外部修改感知（stat 比对 version token）：
	* 快速 stat 每篇已索引文件的 version（不透明新鲜度令牌），发现外部变更
	* （用户手动编辑 / 其他工具写入 / git pull）即置 dirty。
	* 0.2.0-rc.1 的 FsInfo 不再暴露 mtimeMs，改以 opaque version token 比对；
	* 同内容文件的 version 相同，任何写入/删除都会改变它。stat 代价极小（~60 篇 × ms 级）。
	*/
	async function detectExternalChanges() {
		if (index.size === 0) return;
		for (const entry of index.values()) try {
			const target = await fs.resolve(entry.displayPath);
			const stat = await fs.stat(target);
			if (stat !== void 0) {
				if (String(stat.version) !== String(entry.version)) {
					dirty = true;
					return;
				}
			} else {
				dirty = true;
				return;
			}
		} catch (_e) {
			dirty = true;
			return;
		}
		for (const sub of [
			"04-Archive",
			"02-Projects",
			"03-Areas",
			"05-Resources"
		]) try {
			const dir = await fs.resolve(currentVaultPath() + "/" + sub);
			const entries = await fs.listDir(dir);
			for (const e of entries) {
				if (e.type !== "file" || e.name === void 0 || !e.name.endsWith(".md")) continue;
				if (![...index.keys()].some((k) => k.endsWith("/" + e.name) || k === sub + "/" + e.name)) {
					dirty = true;
					return;
				}
			}
		} catch (_e) {}
	}
	/**
	* 分词：ASCII 重叠三元组 + 中文滑动二元组（bigram）。
	*
	* - ASCII 字母数字：长度 ≥2 直接加入；长度 ≥4 额外加 i+=1 重叠三元组
	* - 中文：按 Unicode CJK 字符切分，长度 1 直接加入，≥2 加滑动 bigram
	*   这样「知识库」/「知识」可以互相命中，「连不上」/「连接不上」同理
	*/
	function tokenize(text) {
		const lower = String(text).toLowerCase();
		const seen = /* @__PURE__ */ new Set();
		const asciiRe = /[a-z0-9]+/g;
		let m;
		while ((m = asciiRe.exec(lower)) !== null) {
			const p = m[0];
			if (p.length < 2) continue;
			seen.add(p);
			if (p.length >= 4) for (let i = 0; i + 3 <= p.length; i++) seen.add(p.slice(i, i + 3));
		}
		const cjkRe = /[\u4e00-\u9fff]+/g;
		while ((m = cjkRe.exec(lower)) !== null) {
			const p = m[0];
			if (p.length === 1) seen.add(p);
			else {
				for (let i = 0; i + 2 <= p.length; i++) seen.add(p.slice(i, i + 2));
				if (p.length >= 3) seen.add(p.slice(p.length - 3));
			}
		}
		return seen;
	}
	/** 为索引 entry 计算 IDF 权重表（token → 1/log(1+df)）。 */
	function buildIdf(entries) {
		const df = /* @__PURE__ */ new Map();
		for (const entry of entries) for (const t of entry.tokens) df.set(t, (df.get(t) ?? 0) + 1);
		const total = entries.length || 1;
		const idf = /* @__PURE__ */ new Map();
		for (const [t, count] of df) idf.set(t, Math.log(total / (1 + count)));
		return idf;
	}
	async function rebuildIndex() {
		refreshing = true;
		try {
			const next = new Map(index);
			const idfEntries = [];
			try {
				const root = await fs.resolve(currentVaultPath());
				const statRoot = await fs.stat(root);
				if (statRoot !== void 0 && statRoot.type === "directory") {
					const queue = [root];
					while (queue.length > 0) {
						const dir = queue.shift();
						let entries;
						try {
							entries = await fs.listDir(dir);
						} catch (_e) {
							continue;
						}
						for (const entry of entries) {
							if (entry.type === "directory") {
								const entryName = entry.name || "";
								if (entryName === ".obsidian" || entryName === ".git") continue;
								queue.push(entry.target);
								continue;
							}
							if (entry.type !== "file" || entry.name === void 0 || !entry.name.endsWith(".md") || entry.name.startsWith(".")) continue;
							let text;
							try {
								text = await fs.readText(entry.target);
							} catch (_e) {
								continue;
							}
							const tokens = tokenize("\n" + entry.name + "\n" + text);
							const displayPath = entry.target && typeof entry.target === "object" ? entry.target.displayPath : String(entry.target ?? "");
							const stat = await fs.stat(entry.target);
							next.set(displayPath, {
								displayPath,
								tokens,
								snippet: text.slice(0, 240),
								size: entry.size ?? text.length,
								version: stat !== void 0 ? String(stat.version) : ""
							});
							idfEntries.push({ tokens });
						}
					}
				}
			} catch (_e) {}
			index.clear();
			for (const kv of next) index.set(kv[0], kv[1]);
			idfTable = buildIdf(idfEntries);
			dirty = false;
		} finally {
			refreshing = false;
		}
	}
	let idfTable = /* @__PURE__ */ new Map();
	async function ensureIndex() {
		markDirtyOnVaultChange();
		if (dirty) await rebuildIndex();
		else while (refreshing) await new Promise((resolve) => setTimeout(resolve, 20));
	}
	if (searchEnabled) ctx.effect(() => {
		const handle = setInterval(() => {
			markDirtyOnVaultChange();
			if (dirty) {
				rebuildIndex();
				return;
			}
			detectExternalChanges().then(() => {
				if (dirty) rebuildIndex();
			});
		}, refreshMs);
		return () => {
			clearInterval(handle);
		};
	}, "obsidian-sync: index refresh");
	function searchMatches(topic, limit) {
		const topicTokens = tokenize(topic);
		const results = [];
		for (const entry of index.values()) {
			let score = 0;
			const matchedKeywords = [];
			for (const t of topicTokens) if (entry.tokens.has(t)) {
				score += idfTable.get(t) ?? 1;
				matchedKeywords.push(t);
			}
			if (score === 0) continue;
			results.push({
				file: entry.displayPath,
				score: Math.round(score * 100) / 100,
				snippet: entry.snippet,
				size: entry.size,
				matchReason: matchedKeywords.slice(0, 5).join(" ")
			});
		}
		results.sort((a, b) => b.score - a.score);
		return results.slice(0, limit);
	}
	function sanitizeTitleForFilename(title) {
		const base = String(title || "").replace(/[\\/:*?"<>|（）()]/g, " ").replace(/\s+/g, " ").trim();
		return base.length > 0 ? base.slice(0, 40) : "会话";
	}
	/** vault 相对路径：`displayPath` 可能带盘符前缀，统一收敛成 vault 内路径。 */
	function vaultRelativePath(displayPath) {
		const normalized = displayPath.replace(/\\/g, "/");
		for (const prefix of [
			currentVaultPath().replace(/\\/g, "/") + "/",
			currentVaultPath() + "/",
			"vault/"
		]) if (normalized.startsWith(prefix)) return normalized.slice(prefix.length);
		const idx = normalized.indexOf("/vault/");
		if (idx >= 0) return normalized.slice(idx + 7);
		return normalized.replace(/^\/+/, "");
	}
	/**
	* 索引快照：给大脑检索用的 `BrainNote` 列表（惰性、零拷贝引用）。
	* 路径统一为 vault 相对路径，才能被 `02-Projects/...` 这类分层规则识别。
	*/
	function snapshotBrainNotes() {
		const notes = [];
		for (const entry of index.values()) {
			const path = vaultRelativePath(entry.displayPath);
			notes.push({
				path,
				displayPath: entry.displayPath,
				tokens: entry.tokens,
				title: path.split("/").pop() ?? path,
				snippet: entry.snippet,
				size: entry.size
			});
		}
		return notes;
	}
	/**
	* 噪声会话判定：身份测试类（"你是谁" / "你是什么模型" / "介绍一下自己" / 冒烟测试）
	* 且摘要很短（≤ 摘要阈值字，近似单轮短会话）→ 不写笔记不进索引。
	*
	* 双重条件避免误杀：标题命中噪声模式 且 摘要长度 ≤ 阈值。
	* 摘要长的"你是谁"类会话（用户有实质讨论）仍正常归档。
	*/
	const NOISE_TITLE_PATTERNS = [
		/^你是谁$/,
		/^你是什么(大)?模型$/,
		/^介绍(一下)?自己$/,
		/^自我(介绍|认识)?$/,
		/^echo\s+\S+$/i,
		/^测试$/
	];
	const NOISE_SUMMARY_MAX_CHARS = 200;
	function isNoiseSession(title, summary) {
		const t = String(title || "").trim();
		if (!NOISE_TITLE_PATTERNS.some((re) => re.test(t))) return false;
		return String(summary || "").trim().length <= NOISE_SUMMARY_MAX_CHARS;
	}
	/** 确保 shortId 恰好 8 位：不足时补 SHA-1 前缀 hash。 */
	function normalizeShortId(sessionId) {
		const stripped = sessionId.replace(/^session-/i, "");
		let s = stripped.replace(/[^A-Za-z0-9]/g, "");
		if (s.length >= 8) return s.slice(0, 8);
		let hash = 0;
		for (let i = 0; i < stripped.length; i++) hash = (hash << 5) - hash + stripped.charCodeAt(i) | 0;
		s = s + Math.abs(hash).toString(16).slice(0, 8);
		return s.slice(0, 8);
	}
	/** vault 在 workspace 之外，写入需按调用抬升到 danger-full-access。 */
	const widePolicy = {
		mode: "danger-full-access",
		workspaceRoot: currentVaultPath()
	};
	/**
	* 每日 22:00 复盘沉淀节律：
	* - 汇总当天 04-Archive 归档（按日期前缀统计笔记数与主题关键词）
	* - 把当天要点追加到 02-Projects/ 下匹配项目的"近期演进"段（幂等：当天已追加则跳过）
	* - git commit + push
	*
	* 实现：60s 轮询，发现跨过当天 22:00 且尚未执行过 → 执行一次。
	*/
	let lastReviewDate = "";
	async function dailyReview() {
		const now = /* @__PURE__ */ new Date();
		const dateStr = now.toISOString().slice(0, 10);
		if (now.getHours() < 22 || lastReviewDate === dateStr) return;
		lastReviewDate = dateStr;
		try {
			await ensureIndex();
			const todayFiles = [];
			for (const entry of index.values()) {
				if (!entry.displayPath.includes("04-Archive/")) continue;
				const m = entry.displayPath.match(/* @__PURE__ */ new RegExp("^.*?(\\d{4}-\\d{2}-\\d{2})"));
				if (m && m[1] === dateStr) todayFiles.push({
					file: entry.displayPath,
					date: dateStr,
					snippet: entry.snippet
				});
			}
			if (todayFiles.length === 0) return;
			for (const proj of [
				"02-Projects/dsh-obsidian-sync.md",
				"02-Projects/dsh-tool-agnes.md",
				"02-Projects/dsh-plugin-manager.md",
				"02-Projects/dsh-conversation-language.md"
			]) try {
				const target = await fs.resolve(currentVaultPath() + "/" + proj);
				let content = String(await fs.readText(target));
				const markerPos = content.indexOf("## 近期演进");
				if (markerPos === -1) continue;
				if (content.indexOf(dateStr) !== -1 && content.indexOf(dateStr) > markerPos) continue;
				const todayLines = todayFiles.map((f) => "- [[04-Archive/" + f.file.replace(/^04-Archive\//, "") + "]] — " + f.snippet.slice(0, 80).replace(/\n/g, " ")).join("\n");
				content = content.slice(0, content.length) + "\n" + dateStr + " 归档：\n" + todayLines + "\n";
				await fs.writeText(target, content, void 0, void 0, widePolicy);
			} catch (_e) {}
			dirty = true;
			try {
				const { execSync } = await import("node:child_process");
				if (execSync("git add -A && git status --porcelain", {
					cwd: currentVaultPath(),
					timeout: 15e3,
					encoding: "utf-8"
				}).trim().length > 0) execSync("git commit -m \"daily-review: " + dateStr + " 归档沉淀（" + todayFiles.length + " 篇）\" && git push", {
					cwd: currentVaultPath(),
					timeout: 6e4,
					encoding: "utf-8"
				});
			} catch (_e) {}
		} catch (_e) {}
	}
	ctx.effect(() => {
		const handle = setInterval(() => {
			dailyReview();
		}, 6e4);
		return () => {
			clearInterval(handle);
		};
	}, "obsidian-sync: daily review at 22:00");
	/**
	* 每周复盘沉淀节律（补齐决策习惯页"周复盘尚未建立"的开放问题）：
	* - 每周日 22:30 触发（本地时区），汇总本 ISO 周（周一~周日）04-Archive 归档
	* - 写入/更新 03-Areas/周复盘-<ISO 周>.md（主题分布 + 归档清单 + 待收敛项）
	* - 幂等：同 ISO 周已生成则跳过；git commit + push
	*/
	let lastWeeklyKey = "";
	function isoWeekKey(d) {
		const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
		const day = t.getUTCDay() || 7;
		t.setUTCDate(t.getUTCDate() + 4 - day);
		const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
		const week = Math.ceil(((+t - +yearStart) / 864e5 + 1) / 7);
		return t.getUTCFullYear() + "-W" + String(week).padStart(2, "0");
	}
	async function weeklyReview() {
		const now = /* @__PURE__ */ new Date();
		if (now.getDay() !== 0 || now.getHours() < 22) return;
		const weekKey = isoWeekKey(now);
		if (lastWeeklyKey === weekKey) return;
		lastWeeklyKey = weekKey;
		try {
			await ensureIndex();
			const weekDate = new Date(now);
			weekDate.setDate(now.getDate() - 6);
			const monday = weekDate.toISOString().slice(0, 10);
			const weekFiles = [];
			for (const entry of index.values()) {
				if (!entry.displayPath.includes("04-Archive/")) continue;
				const m = entry.displayPath.match(/(\d{4}-\d{2}-\d{2})/);
				if (m && m[1] >= monday && m[1] <= now.toISOString().slice(0, 10)) weekFiles.push({
					file: entry.displayPath,
					date: m[1],
					snippet: entry.snippet
				});
			}
			weekFiles.sort((a, b) => a.date.localeCompare(b.date));
			if (weekFiles.length === 0) return;
			const lines = weekFiles.map((f) => "- [[04-Archive/" + f.file.replace(/^04-Archive\//, "") + "]]（" + f.date + "）— " + f.snippet.slice(0, 60).replace(/\n/g, " ")).join("\n");
			const note = "---\ndate: " + now.toISOString().slice(0, 10) + "\nstatus: active\ntags: [area, 周复盘]\n---\n\n# 周复盘 " + weekKey + "\n\n> 自动汇总 " + monday + " ~ " + now.toISOString().slice(0, 10) + " 的 04-Archive 归档（" + weekFiles.length + " 篇）。\n\n## 本周归档\n\n" + lines + "\n\n## 待收敛\n\n- [ ] 人工审阅：识别本周新增的长期 Area / Resource 沉淀点\n\n";
			const target = await fs.resolve(currentVaultPath() + "/03-Areas/周复盘-" + weekKey + ".md");
			let skipped = false;
			try {
				if (String(await fs.readText(target)).includes(weekKey)) skipped = true;
			} catch (_e) {}
			if (!skipped) await fs.writeText(target, note, void 0, void 0, widePolicy);
			dirty = true;
			try {
				const { execSync } = await import("node:child_process");
				if (execSync("git add -A && git status --porcelain", {
					cwd: currentVaultPath(),
					timeout: 15e3,
					encoding: "utf-8"
				}).trim().length > 0) execSync("git commit -m \"weekly-review: " + weekKey + " 归档沉淀（" + weekFiles.length + " 篇）\" && git push", {
					cwd: currentVaultPath(),
					timeout: 6e4,
					encoding: "utf-8"
				});
			} catch (_e) {}
		} catch (_e) {}
	}
	ctx.effect(() => {
		const handle = setInterval(() => {
			weeklyReview();
		}, 6e4);
		return () => {
			clearInterval(handle);
		};
	}, "obsidian-sync: weekly review at Sunday 22:30");
	/**
	* 更新索引文件（DSH-会话归档-索引.md）的按日期段。
	* - 找到当天段落（### YYYY-MM-DD）
	* - 边界：下一个 `### ` 或 `## `（两个井号终止条件）
	* - 同 shortId 已有条目 → 替换该行（幂等去重）
	* - 否则追加到当天段落末尾
	*/
	async function updateIndexFile(entryRelPath, title, sessionId, dateStr) {
		try {
			const idxTarget = await fs.resolve(currentVaultPath() + "/DSH-会话归档-索引.md");
			const idxContent = String(await fs.readText(idxTarget));
			const dayAnchor = "### " + dateStr;
			const line = "\n- [[" + entryRelPath + "|" + title + "]] (" + dateStr + ", " + sessionId + ")\n";
			const dayPos = idxContent.indexOf(dayAnchor);
			if (dayPos === -1) {
				const dayHeader = "\n### " + dateStr + "\n" + line;
				const tailPos = idxContent.indexOf("\n## 主题分类");
				const updated = tailPos === -1 ? idxContent + dayHeader : idxContent.slice(0, tailPos) + dayHeader + idxContent.slice(tailPos);
				await fs.writeText(idxTarget, updated, void 0, void 0, widePolicy);
				return true;
			}
			const afterAnchor = dayPos + dayAnchor.length;
			const nextH3 = idxContent.indexOf("\n### ", afterAnchor);
			const nextH2 = idxContent.indexOf("\n## ", afterAnchor);
			let dayEnd = -1;
			if (nextH3 !== -1 && nextH2 !== -1) dayEnd = Math.min(nextH3, nextH2);
			else if (nextH3 !== -1) dayEnd = nextH3;
			else if (nextH2 !== -1) dayEnd = nextH2;
			else dayEnd = idxContent.length;
			const daySection = idxContent.slice(afterAnchor, dayEnd);
			const shortId = normalizeShortId(sessionId);
			const dedupePattern = new RegExp("^- \\[\\[[^\\]]*" + dateStr + "-" + shortId + "-[^\\]]*\\]\\]\\s*\\([^\\)]*\\)$", "m");
			const existingMatch = daySection.match(dedupePattern);
			let updated;
			if (existingMatch !== null) {
				const absPos = afterAnchor + daySection.indexOf(existingMatch[0]);
				updated = idxContent.slice(0, absPos) + line.trimStart() + "\n" + idxContent.slice(absPos + existingMatch[0].length);
			} else updated = idxContent.slice(0, dayEnd) + line + idxContent.slice(dayEnd);
			await fs.writeText(idxTarget, updated, void 0, void 0, widePolicy);
			return true;
		} catch (_e) {
			return false;
		}
	}
	/** 从索引中按目录前缀过滤 + 按 task 相关性取 top N 提炼页。 */
	function topDistilled(task, limit) {
		const distilledDirs = [
			"02-Projects/",
			"03-Areas/",
			"05-Resources/"
		];
		const taskTokens = task.trim().length > 0 ? tokenize(task) : /* @__PURE__ */ new Set();
		const results = [];
		for (const entry of index.values()) {
			if (!distilledDirs.some((d) => entry.displayPath.includes(d))) continue;
			let score = 0;
			for (const t of taskTokens) if (entry.tokens.has(t)) score += idfTable.get(t) ?? 1;
			const title = entry.displayPath.split("/").pop() ?? entry.displayPath;
			results.push({
				file: entry.displayPath,
				title,
				score: taskTokens.size > 0 ? Math.round(score * 100) / 100 : 0,
				snippet: entry.snippet
			});
		}
		results.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
		return results.slice(0, limit);
	}
	/** 从 04-Archive/ 取最近 N 篇（按文件名日期倒序）。 */
	function recentArchives(limit) {
		const results = [];
		for (const entry of index.values()) {
			if (!entry.displayPath.includes("04-Archive/")) continue;
			const dateMatch = entry.displayPath.match(/(\d{4}-\d{2}-\d{2})/);
			results.push({
				file: entry.displayPath,
				date: dateMatch ? dateMatch[1] : "unknown",
				snippet: entry.snippet
			});
		}
		results.sort((a, b) => b.date.localeCompare(a.date));
		return results.slice(0, limit);
	}
	/** 读取指定相对路径的文件内容。 */
	async function readFileContent(relPath) {
		try {
			const target = await fs.resolve(currentVaultPath() + "/" + relPath);
			return String(await fs.readText(target));
		} catch (_e) {
			return "";
		}
	}
	/**
	* v4.0.0 活大脑：每轮检索注入 + 实时沉淀。
	*
	* 监听器全部经 `brain.capture()` 挂到 `ctx.effect`，插件卸载或 HMR 重载时
	* 随 fiber 一起解绑；本调用只注册监听器，不做任何 IO。
	*/
	const brain = installBrain({
		ctx,
		fs,
		options: readBrainOptions,
		vaultPath: currentVaultPath,
		ensureIndexReady: async (timeoutMs) => {
			let timer;
			try {
				return await Promise.race([ensureIndex().then(() => true), new Promise((resolve) => {
					timer = setTimeout(() => resolve(!dirty && !refreshing), Math.max(50, timeoutMs));
				})]);
			} catch (_e) {
				return false;
			} finally {
				if (timer !== void 0) clearTimeout(timer);
			}
		},
		snapshotNotes: snapshotBrainNotes,
		readNotes: async (paths) => {
			const out = /* @__PURE__ */ new Map();
			for (const relPath of paths) {
				const content = await readFileContent(relPath);
				if (content.length > 0) out.set(relPath, content);
			}
			return out;
		},
		tokenize,
		markDirty: () => {
			dirty = true;
		},
		writePolicy: () => widePolicy,
		currentRoute: () => {
			try {
				const agents = ctx.get("agents");
				const first = (agents?.list?.() ?? [])[0] ?? agents?.roots?.()[0];
				return {
					provider: first?.options?.provider,
					model: first?.options?.model
				};
			} catch (_e) {
				return {};
			}
		}
	});
	if (searchEnabled) {
		ctx.tools.register(defineTool({
			name: "obsidian_search",
			description: "在 Obsidian 知识库中按关键词搜索相关笔记，返回最多 5 条匹配（文件相对路径、命中片段、命中关键词）。按需调用，平时不产生任何 token 成本。",
			parameters: {
				topic: {
					type: "string",
					required: true,
					description: "搜索关键词，可含多个词（中英文均可，自动做 CJK bigram 分词）"
				},
				limit: {
					type: "number",
					description: "返回结果上限，默认 3，最大 5"
				}
			},
			output: {
				schema: { type: "json" },
				render: (_args, value) => [{
					type: "text",
					text: JSON.stringify(value, null, 2)
				}]
			},
			isConcurrencySafe: () => true,
			async execute(args) {
				const topic = String(args.topic ?? "");
				if (topic.trim().length === 0) return asJsonValue({
					ok: false,
					error: "topic must not be empty"
				});
				const limit = Math.min(Math.max(1, Number(args.limit) || 3), 5);
				await ensureIndex();
				const matches = searchMatches(topic, limit);
				return asJsonValue({
					ok: true,
					matches,
					count: matches.length,
					vaultPath: currentVaultPath()
				});
			}
		}));
		ctx.tools.register(defineTool({
			name: "obsidian_brief",
			description: "每日简报：返回与当前任务最相关的提炼页（02-Projects/03-Areas/05-Resources）top 3 + 最近 3 条归档摘要 + 用户决策习惯与偏好页内容。低成本\"开机记忆\"入口，建议任务开始前调用一次。",
			parameters: { task: {
				type: "string",
				description: "当前任务描述（可选），用于相关性排序；省略则返回全部提炼页按名称排序的 top 3"
			} },
			output: {
				schema: { type: "json" },
				render: (_args, value) => [{
					type: "text",
					text: JSON.stringify(value, null, 2)
				}]
			},
			isConcurrencySafe: () => true,
			async execute(args) {
				const task = String(args.task ?? "").trim();
				await ensureIndex();
				const distilled = topDistilled(task, 3);
				const recent = recentArchives(3);
				let userProfile = "";
				const profileRelPath = "03-Areas/决策习惯与偏好.md";
				if ([...index.values()].some((e) => e.displayPath === profileRelPath)) userProfile = await readFileContent(profileRelPath);
				return asJsonValue({
					ok: true,
					task: task || "(未指定)",
					distilled,
					recent,
					userProfile: userProfile.length > 0 ? userProfile.slice(0, 2e3) : "",
					vaultPath: currentVaultPath()
				});
			}
		}));
		ctx.tools.register(defineTool({
			name: "obsidian_read_note",
			description: "按相对路径读取 Obsidian 笔记的 frontmatter 与正文，补全 obsidian_search 的\"搜索→阅读\"闭环。路径相对 vault 根（如 02-Projects/dsh-obsidian-sync.md），自动解析 YAML frontmatter（key: value / [list] / 数值 / 布尔）。按需调用，零 token 成本。",
			parameters: { path: {
				type: "string",
				required: true,
				description: "笔记相对 vault 的路径（如 02-Projects/dsh-obsidian-sync.md 或 04-Archive/xxx.md）"
			} },
			output: {
				schema: { type: "json" },
				render: (_args, value) => [{
					type: "text",
					text: JSON.stringify(value, null, 2)
				}]
			},
			isConcurrencySafe: () => true,
			async execute(args) {
				const rel = String(args.path ?? "").replace(/^\/+/, "").replace(/\\/g, "/").trim();
				if (rel.length === 0) return asJsonValue({
					ok: false,
					error: "path must not be empty",
					code: "EMPTY_PATH"
				});
				const content = await readFileContent(rel);
				if (content.length === 0) return asJsonValue({
					ok: false,
					error: "note not found or unreadable: " + rel,
					code: "NOT_FOUND"
				});
				const frontmatter = {};
				let body = content;
				const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
				if (fmMatch !== null) {
					body = content.slice(fmMatch[0].length);
					for (const line of fmMatch[1].split("\n")) {
						const kv = line.match(/^([A-Za-z0-9_\-]+):\s*(.*)$/);
						if (kv === null) continue;
						const key = kv[1];
						let raw = kv[2].trim();
						let val;
						if (raw.startsWith("[") && raw.endsWith("]")) {
							const inner = raw.slice(1, -1).trim();
							val = inner.length === 0 ? [] : inner.split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
						} else if (raw === "null") val = null;
						else if (raw === "true") val = true;
						else if (raw === "false") val = false;
						else if (/^\d+$/.test(raw)) val = Number(raw);
						else val = raw.replace(/^["']|["']$/g, "");
						frontmatter[key] = val;
					}
				}
				const titleLine = body.match(/^#\s+(.+)$/m);
				return asJsonValue({
					ok: true,
					path: rel,
					frontmatter,
					title: titleLine ? titleLine[1].trim() : rel.split("/").pop() ?? rel,
					body
				});
			}
		}));
		ctx.tools.register(defineTool({
			name: "obsidian_brain",
			description: "查看活大脑状态并手动检索：返回每轮自动注入是否开启、本轮检索策略（topK/字数上限/阈值）、进程内注入与沉淀计数，以及按查询检索到的命中笔记。系统已在本轮开始时自动注入相关记忆，此工具用于核对或二次检索。",
			parameters: { query: {
				type: "string",
				description: "要检索的内容（省略则只返回状态，不检索）"
			} },
			output: {
				schema: { type: "json" },
				render: (_args, value) => [{
					type: "text",
					text: JSON.stringify(value, null, 2)
				}]
			},
			isConcurrencySafe: () => true,
			async execute(args) {
				const options = readBrainOptions();
				const query = String(args.query ?? "").trim();
				const stats = readBrainStats();
				if (query.length === 0) return asJsonValue({
					ok: true,
					vaultPath: currentVaultPath(),
					retrieval: {
						enabled: options.retrieval,
						topK: options.topK,
						maxChars: options.maxChars,
						minScore: options.minScore,
						timeoutMs: options.timeoutMs
					},
					autoUpdate: {
						enabled: options.autoUpdate,
						provider: options.memoryProvider || "(跟随当前模型)",
						model: options.memoryModel || "(跟随当前模型)"
					},
					stats: stats ?? null,
					indexedNotes: index.size
				});
				const result = await brain.retrieve(query);
				return asJsonValue({
					ok: true,
					query,
					hits: result.hits.map((hit) => ({
						path: hit.path,
						score: hit.score,
						tier: hit.tier,
						matched: hit.matched
					})),
					injectText: result.text,
					stats: stats ?? null,
					vaultPath: currentVaultPath()
				});
			}
		}));
	}
	ctx.tools.register(defineTool({
		name: "obsidian_sync_session",
		description: "把当前 DSH 会话按 Obsidian vault 的 PARA 结构与用户既有命名/索引规则，以 Markdown 笔记形式幂等写入 vault/04-Archive/，并自动把新条目挂到 DSH-会话归档-索引.md 的按日期段。摘要未变则跳过。幂等键 = date + shortId（标题变更不影响去重）。",
		parameters: {
			session_id: {
				type: "string",
				required: true,
				description: "当前会话的完整 SessionId（UUID 或短 ID），原样存入 frontmatter 与正文"
			},
			title: {
				type: "string",
				required: true,
				description: "会话主题标题（写入 frontmatter 与正文 # 标题；文件名仅取前 40 字符做安全截断）"
			},
			summary: {
				type: "string",
				required: true,
				description: "会话结论/摘要（纯文本，建议 200-800 字，包含用户需求、过程要点、交付物）"
			},
			tags: {
				type: "array",
				items: { type: "string" },
				description: "主题标签数组，最多 10 个，将写入 frontmatter tags 字段（Obsidian 原生标签）"
			},
			related: {
				type: "array",
				items: { type: "string" },
				description: "关联笔记完整文件名（含 .md 扩展名，如 2026-09-11-a9095879-xxx.md），将生成为 [[全路径双链]]"
			},
			raw_log: {
				type: "string",
				description: "原始会话日志绝对路径，格式 ~/.dsh/sessions/<project-dir>/session-<uuid>/session.v3.jsonl.zstd，将写入落款以便追溯"
			},
			date: {
				type: "string",
				description: "归档日期（YYYY-MM-DD），回填历史会话时使用；省略则取当前 UTC 日期。仅匹配该格式时采用，否则回退当前 UTC 日期"
			}
		},
		output: {
			schema: { type: "json" },
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value, null, 2)
			}]
		},
		async execute(args) {
			const sessionId = String(args.session_id ?? "unknown");
			const title = String(args.title ?? "");
			const safeTitle = sanitizeTitleForFilename(title);
			const summary = String(args.summary ?? "");
			const tags = Array.isArray(args.tags) ? args.tags.map(String).slice(0, 10) : [];
			const related = Array.isArray(args.related) ? args.related.map(String).slice(0, 10) : [];
			const rawLog = String(args.raw_log ?? "");
			if (isNoiseSession(title, summary)) return asJsonValue({
				ok: true,
				skipped: true,
				noise: true,
				reason: "identity-test noise session filtered out (short title + short summary)",
				index: "unchanged"
			});
			const rawDate = String(args.date ?? "").trim();
			const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
			const shortId = normalizeShortId(sessionId);
			const entryPrefix = dateStr + "-" + shortId + "-";
			let entryRelPath;
			try {
				const archiveDir = await fs.resolve(currentVaultPath() + "/04-Archive");
				const existing = (await fs.listDir(archiveDir)).find((e) => e.type === "file" && e.name?.startsWith(entryPrefix));
				if (existing !== void 0 && existing.name !== void 0) entryRelPath = "04-Archive/" + existing.name;
				else entryRelPath = "04-Archive/" + entryPrefix + safeTitle + ".md";
			} catch (_e) {
				entryRelPath = "04-Archive/" + entryPrefix + safeTitle + ".md";
			}
			const relatedLines = [];
			for (const r of related) {
				const rFull = r.endsWith(".md") ? r : r + ".md";
				const rRel = "04-Archive/" + rFull;
				try {
					await fs.stat(await fs.resolve(currentVaultPath() + "/" + rRel));
					relatedLines.push("- [[" + rRel + "|" + rFull.replace(/^.*\//, "").replace(/\.md$/, "") + "]]");
				} catch (_e) {
					relatedLines.push("- " + rFull + "（未找到，降级为文字引用）");
				}
			}
			const fmDate = dateStr;
			const fmSessionId = sessionId.replace(/[^A-Za-z0-9-]/g, "").slice(0, 8);
			const fmTags = tags.length > 0 ? tags : [];
			const frontmatter = [
				"---",
				"session_id: " + fmSessionId,
				"full_session_id: " + sessionId,
				"date: " + fmDate,
				"tags: [" + fmTags.join(", ") + "]",
				"---",
				""
			].join("\n");
			const logLine = rawLog.trim().length > 0 ? "> 📎 原始日志: `" + rawLog.trim() + "`\n\n> 由 DSH Obsidian Sync 自动同步\n" : "> 由 DSH Obsidian Sync 自动同步\n";
			const content = frontmatter + "# DSH 会话: " + title + "\n\n## 基本信息\n\n| 属性 | 值 |\n|------|-----|\n| **日期** | " + dateStr + " |\n| **会话ID** | `" + sessionId + "` |\n| **状态** | ✅ 已归档 |\n| **分类** | " + (tags.length > 0 ? tags.join(" ") : "通用") + " |\n\n---\n\n## 摘要\n\n" + summary + "\n\n" + (relatedLines.length > 0 ? "## 关联\n\n" + relatedLines.join("\n") + "\n\n---\n" : "") + logLine;
			let target;
			try {
				target = await fs.resolve(currentVaultPath() + "/" + entryRelPath);
			} catch (_e) {
				const winPath = currentVaultPath() + "\\" + entryRelPath.split("/").join("\\");
				try {
					target = await fs.resolve(winPath);
				} catch (_e2) {
					return asJsonValue({
						ok: false,
						error: "cannot resolve vault entry path",
						code: "RESOLVE_FAILED"
					});
				}
			}
			let skipped = false;
			try {
				const prev = String(await fs.readText(target));
				const pos = prev.indexOf("## 摘要");
				if (pos >= 0) {
					const bodyStart = pos + 5;
					const boundaries = [
						"\n## ",
						"\n---\n",
						"\n\n> "
					].map((sep) => prev.indexOf(sep, bodyStart)).filter((i) => i !== -1);
					const bodyEnd = boundaries.length > 0 ? Math.min(...boundaries) : prev.length;
					if (prev.slice(bodyStart, bodyEnd).trim() === summary.trim()) skipped = true;
				}
			} catch (_e) {}
			if (skipped) return asJsonValue({
				ok: true,
				skipped: true,
				file: entryRelPath,
				reason: "summary unchanged",
				index: "unchanged"
			});
			try {
				await fs.writeText(target, content, void 0, void 0, widePolicy);
			} catch (writeErr) {
				return asJsonValue({
					ok: false,
					error: "writeText failed: " + String(writeErr instanceof Error ? writeErr.message : writeErr),
					code: "WRITE_FAILED"
				});
			}
			const indexOk = await updateIndexFile(entryRelPath, title, sessionId, dateStr);
			dirty = true;
			let gitStatus = "skipped";
			try {
				const { execSync } = await import("node:child_process");
				if (execSync("git add -A && git status --porcelain", {
					cwd: currentVaultPath(),
					timeout: 15e3,
					encoding: "utf-8"
				}).trim().length > 0) {
					execSync("git commit -m \"" + ("archive: " + entryRelPath.replace(/^04-Archive\//, "")).replace(/"/g, "\\\"") + "\" && git push", {
						cwd: currentVaultPath(),
						timeout: 6e4,
						encoding: "utf-8"
					});
					gitStatus = "pushed";
				} else gitStatus = "no changes";
			} catch (gitErr) {
				gitStatus = "failed: " + String(gitErr instanceof Error ? gitErr.message : gitErr);
			}
			return asJsonValue({
				ok: true,
				skipped: false,
				file: entryRelPath,
				index: indexOk ? "updated" : "skipped",
				git: gitStatus
			});
		}
	}));
}
//#endregion
export { Config, apply, inject, name };

//# sourceMappingURL=index.js.map