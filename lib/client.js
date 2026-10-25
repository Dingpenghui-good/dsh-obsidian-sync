window.__ModuleLoader__.load({
	id: "@dingpenghui/dsh-obsidian-sync",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/plugin-detail-controller.ts
		/** vaultPath 字段的 format/parse 规范：非空绝对/相对路径，空串清除回默认。 */
		function vaultPathFieldSpec() {
			return {
				field: "vaultPath",
				format: (value) => typeof value === "string" ? value : "",
				parse: (text) => {
					const trimmed = text.trim();
					if (trimmed === "") return { kind: "clear" };
					return {
						kind: "set",
						value: trimmed
					};
				}
			};
		}
		/** indexRefreshMs 字段的 format/parse 规范：≥5000 的正整数毫秒。 */
		function indexRefreshMsFieldSpec() {
			return {
				field: "indexRefreshMs",
				format: (value) => typeof value === "number" ? String(value) : "",
				parse: (text) => {
					const trimmed = text.trim();
					if (trimmed === "") return { kind: "clear" };
					const n = Number(trimmed);
					if (!Number.isFinite(n) || n < 5e3 || !Number.isInteger(n)) return void 0;
					return {
						kind: "set",
						value: n
					};
				}
			};
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
				field: "searchEnabled",
				format: (value) => typeof value === "boolean" ? String(value) : "",
				parse: (text) => {
					const trimmed = text.trim().toLowerCase();
					if (trimmed === "true") return {
						kind: "set",
						value: true
					};
					if (trimmed === "false") return {
						kind: "set",
						value: false
					};
					if (trimmed === "") return { kind: "clear" };
				}
			};
		}
		/** 把一个宿主 settings 命名空间桥接到详情页的 staged form。 */
		function asFormScope(scope) {
			return {
				getSnapshot: () => {
					const s = scope.getSnapshot();
					return {
						status: s.status,
						value: s.value,
						base: s.base,
						user: s.user,
						writable: s.writable,
						revision: s.revision
					};
				},
				subscribe: (listener) => scope.subscribe(listener),
				mutate: (ops, expectedRevision) => scope.mutate(ops, expectedRevision)
			};
		}
		/** 把命名空间的 `ConfigForm` 适配为详情页的 staged form。 */
		var ObsidianSyncPageController = class {
			form;
			store;
			/** @param scope - 共享配置表单（命名空间的 ConfigForm）。 */
			constructor(scope) {
				this.form = new _deepseek_ai_dsh_client_ui_primitives.SettingsFormModel(asFormScope(scope), [
					vaultPathFieldSpec(),
					searchEnabledFieldSpec(),
					indexRefreshMsFieldSpec()
				]);
				this.store = this.form.bind(() => this.projection());
			}
			projection() {
				return {
					...this.form.shell(),
					vaultPath: this.form.field("vaultPath"),
					searchEnabled: this.form.field("searchEnabled"),
					indexRefreshMs: this.form.field("indexRefreshMs")
				};
			}
			/** 构建详情页 slot 注册注入的面。 */
			inject() {
				return {
					hooks: { obsidianSyncPage: this.store },
					...this.form.actions()
				};
			}
			/** 释放表单订阅。 */
			dispose() {
				this.form.dispose();
			}
		};
		//#endregion
		//#region \0dsh-css:E:\dsh-workspace\dsh-obsidian-sync\src\client\PluginDetailPage.module.css.mjs
		const css = ".jWPSbW_page{flex-direction:column;gap:8px;padding-bottom:16px;display:flex}.jWPSbW_field{border-bottom:1px solid var(--dsw-alias-border-l2);flex-direction:column;gap:8px;padding:16px 0;display:flex}.jWPSbW_fieldText{flex-direction:column;gap:4px;display:flex}.jWPSbW_title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}.jWPSbW_subHint{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:400;line-height:18px}.jWPSbW_hint{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));padding:8px 0 0;font-size:12px;font-weight:400;line-height:18px}.jWPSbW_gitHint{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));border-top:1px dashed var(--dsw-alias-border-l2);margin-top:8px;padding:8px 0 0;font-size:12px;font-weight:400;line-height:18px}.jWPSbW_input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-l1);width:100%;color:var(--dsw-alias-label-primary);border-radius:6px;outline:none;padding:8px 12px;font-family:inherit;font-size:13px;transition:border-color .15s}.jWPSbW_input:focus{border-color:var(--dsw-alias-accent-l1)}.jWPSbW_input:disabled{opacity:.5;cursor:not-allowed}.jWPSbW_inputSmall{width:120px;}";
		const tagId = "@dingpenghui/dsh-obsidian-sync/PluginDetailPage.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@dingpenghui/dsh-obsidian-sync";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var PluginDetailPage_module_css_default = {
			"gitHint": "jWPSbW_gitHint",
			"field": "jWPSbW_field",
			"page": "jWPSbW_page",
			"input": "jWPSbW_input",
			"fieldText": "jWPSbW_fieldText",
			"subHint": "jWPSbW_subHint",
			"hint": "jWPSbW_hint",
			"inputSmall": "jWPSbW_inputSmall",
			"title": "jWPSbW_title"
		};
		//#endregion
		//#region src/client/plugin-detail-page.tsx
		/** 从 locale 字典派生 SettingsForm 的标签文案。 */
		function formLabels(t) {
			return {
				unavailable: t("form.unavailable"),
				readOnly: t("form.readOnly"),
				saveFailed: t("form.saveFailed"),
				save: t("form.save"),
				saving: t("form.saving")
			};
		}
		/**
		* 渲染详情页：一行摘要（`view: 'summary'`）或前提条件表单（`view: 'page'`）。
		* @param props - 视图、locale 文案、表单快照与动作。
		* @returns 摘要文字，或带保存控件的前提条件表单。
		*/
		function ObsidianSyncDetailPage(props) {
			const { t } = props;
			const state = props.useObsidianSyncPage((snapshot) => snapshot);
			if (props.view === "summary") return t("description");
			const disabled = !state.writable;
			const vaultPath = state.vaultPath;
			const searchEnabled = state.searchEnabled;
			const indexRefreshMs = state.indexRefreshMs;
			const searchOn = searchEnabled.text !== "" ? searchEnabled.text === "true" : true;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.SettingsForm, {
				labels: formLabels(t),
				state,
				onSave: props.save,
				onDiscard: props.discard,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: PluginDetailPage_module_css_default.page,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: PluginDetailPage_module_css_default.hint,
							children: t("page.vaultPath.hint")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: PluginDetailPage_module_css_default.field,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: PluginDetailPage_module_css_default.fieldText,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: PluginDetailPage_module_css_default.title,
									children: t("page.vaultPath.label")
								})
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "text",
								className: PluginDetailPage_module_css_default.input,
								value: vaultPath.text,
								placeholder: "E:/dsh-workspace/obsidian-vault",
								onChange: (e) => {
									props.edit("vaultPath", e.target.value);
								},
								disabled
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: PluginDetailPage_module_css_default.field,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: PluginDetailPage_module_css_default.fieldText,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: PluginDetailPage_module_css_default.title,
									children: t("page.searchEnabled.label")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: PluginDetailPage_module_css_default.subHint,
									children: t("page.searchEnabled.hint")
								})]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Switch, {
								checked: searchOn,
								onChange: (next) => {
									props.edit("searchEnabled", String(next));
								},
								label: t("page.searchEnabled.label"),
								disabled
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: PluginDetailPage_module_css_default.field,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: PluginDetailPage_module_css_default.fieldText,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: PluginDetailPage_module_css_default.title,
									children: t("page.indexRefreshMs.label")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: PluginDetailPage_module_css_default.subHint,
									children: t("page.indexRefreshMs.hint")
								})]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "text",
								inputMode: "numeric",
								className: PluginDetailPage_module_css_default.inputSmall,
								value: indexRefreshMs.text,
								placeholder: "60000",
								onChange: (e) => {
									props.edit("indexRefreshMs", e.target.value);
								},
								disabled
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: PluginDetailPage_module_css_default.gitHint,
							children: t("page.gitHint")
						})
					]
				})
			});
		}
		//#endregion
		//#region src/locales/index.ts
		/** Localization dictionaries (detail page prerequisites form) */
		const zh = {
			"title": "Obsidian Sync 前提条件",
			"description": "配置 Obsidian vault 路径与索引参数，保存后插件按新值运行。",
			"page.vaultPath.label": "Obsidian vault 路径",
			"page.vaultPath.hint": "必须指向已存在的 Obsidian vault 目录（PARA 结构，含 02-Projects / 03-Areas / 04-Archive 与 DSH-会话归档-索引.md）。路径错误将导致搜索与归档全部失败。",
			"page.searchEnabled.label": "启用按需搜索索引",
			"page.searchEnabled.hint": "开启后注册 obsidian_search / obsidian_brief 倒排索引搜索；关闭后仅保留 read_note 与 sync_session。",
			"page.indexRefreshMs.label": "索引重建间隔（毫秒）",
			"page.indexRefreshMs.hint": "倒排索引增量重建 / vault 外部变更感知的间隔，下限 5000ms，默认 60000ms。",
			"page.gitHint": "git 自动推送前提：vault 为 git 仓库且配置了 remote。不满足时归档笔记仍正常写入，git 步骤自动降级并在结果中提示。",
			"form.unavailable": "该插件当前未加载，暂时无法配置。",
			"form.readOnly": "本部署的设置为只读。",
			"form.saveFailed": "保存未被接受，已保留供你修改。",
			"form.save": "保存",
			"form.saving": "保存中…",
			"form.overridden": "已覆盖",
			"form.reset": "恢复默认",
			"form.invalid": "无效值"
		};
		const en = {
			"title": "Obsidian Sync prerequisites",
			"description": "Configure the Obsidian vault path and index settings. The plugin runs with the new values after saving.",
			"page.vaultPath.label": "Obsidian vault path",
			"page.vaultPath.hint": "Must point to an existing Obsidian vault (PARA layout with 02-Projects / 03-Areas / 04-Archive and DSH-会话归档-索引.md). A wrong path breaks all search and archiving.",
			"page.searchEnabled.label": "Enable on-demand search index",
			"page.searchEnabled.hint": "When on, obsidian_search / obsidian_brief inverted-index search is registered; when off only read_note and sync_session remain.",
			"page.indexRefreshMs.label": "Index refresh interval (ms)",
			"page.indexRefreshMs.hint": "Interval for incremental index rebuilds and external vault change detection. Minimum 5000ms, default 60000ms.",
			"page.gitHint": "Auto git push requires the vault to be a git repo with a remote. Without it, archive notes are still written; the git step degrades gracefully and reports the failure in the result.",
			"form.unavailable": "This plugin is not loaded, so it cannot be configured right now.",
			"form.readOnly": "This deployment stores settings read-only.",
			"form.saveFailed": "The deployment did not accept these values; they were left for you to correct.",
			"form.save": "Save",
			"form.saving": "Saving…",
			"form.overridden": "Overridden",
			"form.reset": "Reset to default",
			"form.invalid": "Invalid value"
		};
		//#endregion
		//#region src/shared.ts
		/**
		* Shared constants usable by both the Host bundle and the Client bundle.
		* The client reads the settings namespace through this barrel so it never
		* value-imports a Host-only package such as `@deepseek-ai/dsh-fs`.
		*/
		/** The settings namespace is the profile entry id of this plugin row (cordis.yml `id`). */
		const OBSIDIAN_SYNC_NAMESPACE = "dsh-obsidian-sync";
		/** npm 包名：`plugins.bundle.config` slot 的 key。 */
		const PLUGIN_PACKAGE_NAME = "@dingpenghui/dsh-obsidian-sync";
		/** `plugins.row.config` slot 的 key：`<package>#<row id>`。 */
		const PLUGIN_ROW_CONFIG_KEY = `${PLUGIN_PACKAGE_NAME}#${OBSIDIAN_SYNC_NAMESPACE}`;
		//#endregion
		//#region src/client/index.ts
		const DICT_NS = "settings.dsh-obsidian-sync";
		/**
		* 占位 ConfigForm：宿主未提供 settings 传输（configForms 服务缺失）时，
		* 详情页以只读「不可用」快照呈现，保存控件随之禁用 —— 条目永不因缺失
		* 而抛错。所有 getter 为惰性 thunk（与真实 scope 的快照模型一致）。
		*/
		function unavailableForm() {
			const snapshot = () => ({
				status: "unavailable",
				value: void 0,
				base: void 0,
				user: void 0,
				writable: false,
				revision: 0,
				mode: "host"
			});
			return {
				getSnapshot: snapshot,
				subscribe: (listener) => {
					listener();
					return () => {};
				},
				set: () => Promise.resolve(false),
				unset: () => Promise.resolve(false),
				mutate: () => Promise.resolve(false)
			};
		}
		const inject = ["slots", "locale"];
		function apply(ctx) {
			const slots = ctx.get("slots");
			const locale = ctx.get("locale");
			ctx.effect(() => locale.register(DICT_NS, {
				zh,
				en
			}), "obsidian-sync: dictionaries");
			const configForms = ctx.get("configForms");
			const detailPage = new ObsidianSyncPageController(configForms ? configForms.get(OBSIDIAN_SYNC_NAMESPACE) : unavailableForm());
			ctx.effect(() => () => {
				detailPage.dispose();
			}, "obsidian-sync: detail form subscriptions");
			ctx.effect(() => {
				if (configForms === void 0) return () => {};
				const bundleDisposer = slots.inject("plugins.bundle.config", () => slots.register({
					name: "plugins.bundle.config",
					key: PLUGIN_PACKAGE_NAME,
					locale: DICT_NS,
					inject: () => detailPage.inject()
				}, ObsidianSyncDetailPage));
				const rowDisposer = slots.inject("plugins.row.config", () => slots.register({
					name: "plugins.row.config",
					key: PLUGIN_ROW_CONFIG_KEY,
					locale: DICT_NS,
					inject: () => detailPage.inject()
				}, ObsidianSyncDetailPage));
				return () => {
					rowDisposer();
					bundleDisposer();
				};
			}, "obsidian-sync: detail page");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map