import z from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";
//#region src/index.d.ts
/** Cordis 插件名。 */
declare const name = "obsidian-sync";
/** 本插件需要的 Service（`tools`/`fs` 为硬依赖，缺失时等待 Cordis 重激活）。
 *  仅保留真实消费的 Service：settings / llm / credentials 是可选增强
 *  （未组合时对应能力降级：设置读默认值、实时蒸馏不启用）。 */
declare const inject: string[];
/** 插件配置。schema 字段标记 `.volatile()`：宿主 settings 框架投影到浏览器
 *  设置页，详情页保存后经 profile Cordis patch + volatile HMR 即时生效，无需重启。
 *  接口本身保留普通类型（与已验证的 conversation-language 插件一致），
 *  volatile 语义由 schema 与 Loader 承担。 */
interface Config {
  /** Obsidian vault 绝对路径；缺省 `E:/dsh-workspace/obsidian-vault`。 */
  vaultPath: string;
  /** 是否注册 obsidian_search（倒排索引 + 定时增量重建）。 */
  searchEnabled: boolean;
  /** 索引增量重建间隔（毫秒，下限 5000）。 */
  indexRefreshMs: number;
  /** 每轮对话前自动检索并注入相关知识（v4.0.0）。 */
  brainRetrieval: boolean;
  /** 每次注入的笔记条数上限（1..8）。 */
  brainRetrievalTopK: number;
  /** 注入文本字数上限（400..8000）。 */
  brainRetrievalMaxChars: number;
  /** 相关性阈值（低于即视为无命中，0..100）。 */
  brainRetrievalMinScore: number;
  /** 检索与索引等待超时（毫秒，200..10000）。 */
  brainRetrievalTimeoutMs: number;
  /** 每轮结束实时蒸馏更新大脑（会额外调用小模型）。 */
  brainAutoUpdate: boolean;
  /** 蒸馏所用 provider（留空跟随当前 agent 路由）。 */
  brainMemoryProvider: string;
  /** 蒸馏所用 model（留空跟随当前 agent 路由）。 */
  brainMemoryModel: string;
  /** 蒸馏直连时的凭据引用名（经 credentials 解析，配置中不落密钥）。 */
  brainMemoryApiKeyEnv: string;
  /** 单进程蒸馏调用预算（防费用失控）。 */
  brainMemoryMaxCalls: number;
  /** 每轮最多钉住几篇沉淀层笔记。 */
  brainPinnedBudget: number;
  /** 实时沉淀写入后是否 git commit + push。 */
  brainAutoCommit: boolean;
  /** 流水页单节大小上限（字节，8192..2000000）。 */
  brainLogCapBytes: number;
}
/**
 * Schemastery 配置 schema：加载器用它解析行 `config` 并补默认值。
 *
 * 注意 Schemastery 的 API 与 zod 不同：没有 `.optional()` / `.int()`。
 * 对象属性默认即可选（不调用 `.required()` 时，缺失键不会写入解析结果），
 * 整数约束通过 `.step(1)` 表达。
 */
/** 运行时 schema：volatile 标记 + 默认值。Loader 据此解析行 config 并补默认。 */
declare const Config: z<Schemastery.ObjectS<NoInfer<{
  vaultPath: z<string, string, "volatile-defined">;
  searchEnabled: z<boolean, boolean, "volatile-defined">;
  indexRefreshMs: z<number, number, "volatile-defined">;
  brainRetrieval: z<boolean, boolean, "volatile-defined">;
  brainRetrievalTopK: z<number, number, "volatile-defined">;
  brainRetrievalMaxChars: z<number, number, "volatile-defined">;
  brainRetrievalMinScore: z<number, number, "volatile-defined">;
  brainRetrievalTimeoutMs: z<number, number, "volatile-defined">;
  brainAutoUpdate: z<boolean, boolean, "volatile-defined">;
  brainMemoryProvider: z<string, string, "volatile-defined">;
  brainMemoryModel: z<string, string, "volatile-defined">;
  brainMemoryApiKeyEnv: z<string, string, "volatile-defined">;
  brainMemoryMaxCalls: z<number, number, "volatile-defined">;
  brainPinnedBudget: z<number, number, "volatile-defined">;
  brainAutoCommit: z<boolean, boolean, "volatile-defined">;
  brainLogCapBytes: z<number, number, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
  vaultPath: z<string, string, "volatile-defined">;
  searchEnabled: z<boolean, boolean, "volatile-defined">;
  indexRefreshMs: z<number, number, "volatile-defined">;
  brainRetrieval: z<boolean, boolean, "volatile-defined">;
  brainRetrievalTopK: z<number, number, "volatile-defined">;
  brainRetrievalMaxChars: z<number, number, "volatile-defined">;
  brainRetrievalMinScore: z<number, number, "volatile-defined">;
  brainRetrievalTimeoutMs: z<number, number, "volatile-defined">;
  brainAutoUpdate: z<boolean, boolean, "volatile-defined">;
  brainMemoryProvider: z<string, string, "volatile-defined">;
  brainMemoryModel: z<string, string, "volatile-defined">;
  brainMemoryApiKeyEnv: z<string, string, "volatile-defined">;
  brainMemoryMaxCalls: z<number, number, "volatile-defined">;
  brainPinnedBudget: z<number, number, "volatile-defined">;
  brainAutoCommit: z<boolean, boolean, "volatile-defined">;
  brainLogCapBytes: z<number, number, "volatile-defined">;
}>>, "plain">;
declare function apply(ctx: Context): void;
//#endregion
export { Config, apply, inject, name };
//# sourceMappingURL=index.d.ts.map