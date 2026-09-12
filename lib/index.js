import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
//#region src/index.ts
/** Cordis 插件名。 */
const name = "obsidian-sync-v2";
/** 本插件需要的 Service（`tools`/`fs`/`timer` 为硬依赖，缺失时等待 Cordis 重激活）。 */
const inject = [
	"tools",
	"fs",
	"timer"
];
/** Schemastery 配置 schema：加载器用它解析行 `config` 并补默认值。 */
const Config = z.object({
	vaultPath: z.string().optional(),
	searchEnabled: z.boolean().default(true),
	indexRefreshMs: z.number().int().min(5e3).default(6e4)
});
function apply(ctx, config = {}) {
	const settings = ctx.get("settings");
	let vaultPath = config.vaultPath;
	let searchEnabled = config.searchEnabled !== false;
	if (vaultPath === void 0 && settings !== void 0) try {
		const section = settings.get("obsidian-sync");
		if (section && typeof section === "object") {
			if (typeof section.vaultPath === "string") vaultPath = section.vaultPath;
			if (typeof section.searchEnabled === "boolean") searchEnabled = section.searchEnabled;
		}
	} catch (_e) {}
	if (vaultPath === void 0 || vaultPath.length === 0) vaultPath = "E:/dsh-workspace/obsidian-vault";
	const refreshMs = Math.max(config.indexRefreshMs ?? 6e4, 5e3);
	const fs = ctx.fs;
	const timer = ctx.timer;
	const index = /* @__PURE__ */ new Map();
	let dirty = true;
	let refreshing = false;
	function tokenize(text) {
		const parts = String(text).toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/);
		const seen = /* @__PURE__ */ new Set();
		for (const p of parts) {
			if (p.length === 0) continue;
			seen.add(p);
			if (/^[a-z0-9]+$/.test(p) && p.length >= 3) for (let i = 0; i + 3 <= p.length; i += 3) seen.add(p.slice(i, i + 3));
		}
		return seen;
	}
	async function rebuildIndex() {
		refreshing = true;
		try {
			const next = new Map(index);
			try {
				const root = await fs.resolve(vaultPath);
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
							const tokens = tokenize("\n" + entry.name + "\n" + text.slice(0, 600));
							const displayPath = entry.target && typeof entry.target === "object" ? entry.target.displayPath : String(entry.target);
							next.set(displayPath, {
								displayPath,
								tokens,
								snippet: text.slice(0, 240),
								size: entry.size ?? text.length
							});
						}
					}
				}
			} catch (_e) {}
			index.clear();
			for (const kv of next) index.set(kv[0], kv[1]);
			dirty = false;
		} finally {
			refreshing = false;
		}
	}
	async function ensureIndex() {
		if (dirty) await rebuildIndex();
		else while (refreshing) await new Promise((resolve) => setTimeout(resolve, 20));
	}
	if (searchEnabled) ctx.effect(() => {
		const disposer = timer.interval(() => {
			if (!dirty) return;
			rebuildIndex();
		}, refreshMs);
		return () => {
			if (typeof disposer === "function") disposer();
		};
	}, "obsidian-sync-v2: index refresh");
	function searchMatches(topic, limit) {
		const topicTokens = tokenize(topic);
		const results = [];
		for (const entry of index.values()) {
			let score = 0;
			for (const t of topicTokens) if (entry.tokens.has(t)) score++;
			if (score === 0) continue;
			results.push({
				file: entry.displayPath,
				score,
				snippet: entry.snippet,
				size: entry.size
			});
		}
		results.sort((a, b) => b.score - a.score);
		return results.slice(0, limit);
	}
	function sanitizeTitleForFilename(title) {
		const base = String(title || "").replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim();
		return base.length > 0 ? base.slice(0, 60) : "会话";
	}
	/** vault 在 workspace 之外，写入需按调用抬升到 danger-full-access。 */
	const widePolicy = { mode: "danger-full-access" };
	async function updateIndexFile(entryRelPath, title, sessionId, dateStr) {
		try {
			const idxTarget = await fs.resolve(vaultPath + "/DSH-会话归档-索引.md");
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
			const dayEnd = idxContent.indexOf("\n### ", dayPos + 1);
			const insertPos = dayEnd === -1 ? idxContent.length : dayEnd;
			const updated = idxContent.slice(0, insertPos) + line + idxContent.slice(insertPos);
			await fs.writeText(idxTarget, updated, void 0, void 0, widePolicy);
			return true;
		} catch (_e) {
			return false;
		}
	}
	if (searchEnabled) ctx.tools.register(defineTool({
		name: "obsidian.search",
		description: "在 Obsidian 知识库中按关键词搜索相关笔记，返回最多 5 条匹配（文件相对路径、命中片段）。按需调用，平时不产生任何 token 成本。",
		parameters: {
			topic: {
				type: "string",
				required: true,
				description: "搜索关键词，可含多个词"
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
			if (topic.trim().length === 0) return {
				ok: false,
				error: "topic must not be empty"
			};
			const limit = Math.min(Math.max(1, Number(args.limit) || 3), 5);
			await ensureIndex();
			const matches = searchMatches(topic, limit);
			return {
				ok: true,
				matches,
				count: matches.length,
				vaultPath
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "obsidian.sync_session",
		description: "把当前 DSH 会话按 Obsidian vault 的 PARA 结构与用户既有命名/索引规则，以 Markdown 笔记形式幂等写入 vault/04-Archive/，并自动把新条目挂到 DSH-会话归档-索引.md 的按日期段。摘要未变则跳过。建议传入 raw_log 原始日志路径（~/.dsh/sessions/…/session-<id>/session.v3.jsonl.zstd），落款处会生成可追溯指针。",
		parameters: {
			session_id: {
				type: "string",
				required: true,
				description: "当前会话的完整 SessionId（UUID），原样存入基本信息表"
			},
			title: {
				type: "string",
				required: true,
				description: "会话主题标题（将作为笔记文件名的一部分与 # 标题）"
			},
			summary: {
				type: "string",
				required: true,
				description: "会话结论/摘要（纯文本，建议 200-800 字，包含用户需求、过程要点、交付物）"
			},
			tags: {
				type: "array",
				items: { type: "string" },
				description: "主题标签数组，最多 10 个，将进入基本信息表格"
			},
			related: {
				type: "array",
				items: { type: "string" },
				description: "关联笔记文件名（不含 .md），将生成为 [[双链]]"
			},
			raw_log: {
				type: "string",
				description: "原始会话日志的绝对路径（如 C:\\Users\\dph\\.dsh\\sessions\\--E-dsh-workspace--\\session-<id>\\session.v3.jsonl.zstd），将写入落款以便追溯"
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
			const title = sanitizeTitleForFilename(String(args.title ?? ""));
			const summary = String(args.summary ?? "");
			const tags = Array.isArray(args.tags) ? args.tags.map(String).slice(0, 10) : [];
			const related = Array.isArray(args.related) ? args.related.map(String).slice(0, 10) : [];
			const rawLog = String(args.raw_log ?? "");
			const dateStr = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
			const shortId = sessionId.replace(/[^A-Za-z0-9]/g, "").slice(0, 8);
			const entryRelPath = "04-Archive/" + dateStr + "-" + shortId + "-" + title + ".md";
			const relatedLines = related.map((r) => "- [[" + r + "]]").join("\n");
			const tagsLine = tags.length > 0 ? tags.map((t) => "`" + t + "`").join(" ") : "通用";
			const logLine = rawLog.trim().length > 0 ? "> 📎 原始日志: `" + rawLog.trim() + "`\n\n> 由 DSH Obsidian Sync Lite 自动同步\n" : "> 由 DSH Obsidian Sync Lite 自动同步\n";
			const content = "# DSH 会话: " + title + "\n\n## 基本信息\n\n| 属性 | 值 |\n|------|-----|\n| **日期** | " + dateStr + " |\n| **会话ID** | `" + sessionId + "` |\n| **状态** | ✅ 已归档 |\n| **分类** | " + tagsLine + " |\n\n---\n\n## 摘要\n\n" + summary + "\n\n" + (related.length > 0 ? "## 关联\n\n" + relatedLines + "\n\n---\n" : "") + logLine;
			let target;
			try {
				target = await fs.resolve(vaultPath + "/" + entryRelPath);
			} catch (_e) {
				const winPath = vaultPath + "\\" + entryRelPath.split("/").join("\\");
				try {
					target = await fs.resolve(winPath);
				} catch (_e2) {
					return {
						ok: false,
						error: "cannot resolve vault entry path"
					};
				}
			}
			let skipped = false;
			try {
				const prev = String(await fs.readText(target));
				const pos = prev.indexOf("## 摘要");
				if (pos >= 0 && prev.slice(pos + 5).trim() === summary.trim()) skipped = true;
			} catch (_e) {}
			if (skipped) return {
				ok: true,
				skipped: true,
				file: entryRelPath,
				index: "unchanged"
			};
			try {
				await fs.writeText(target, content, void 0, void 0, widePolicy);
			} catch (writeErr) {
				return {
					ok: false,
					error: "writeText failed: " + String(writeErr instanceof Error ? writeErr.message : writeErr)
				};
			}
			const indexOk = await updateIndexFile(entryRelPath, title, sessionId, dateStr);
			dirty = true;
			return {
				ok: true,
				skipped: false,
				file: entryRelPath,
				index: indexOk ? "updated" : "skipped"
			};
		}
	}));
}
//#endregion
export { Config, apply, inject, name };

//# sourceMappingURL=index.js.map