import z from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";
//#region src/index.d.ts
/** Cordis 插件名。 */
declare const name = "obsidian-sync-v2";
/** 本插件需要的 Service（`tools`/`fs`/`timer` 为硬依赖，缺失时等待 Cordis 重激活）。 */
declare const inject: string[];
/** 插件配置。 */
interface Config {
  /** Obsidian vault 绝对路径；缺省读 settings 命名空间 `obsidian-sync`，再缺省 `E:/dsh-workspace/obsidian-vault`。 */
  vaultPath?: string;
  /** 是否注册 obsidian.search（倒排索引 + 定时增量重建）。 */
  searchEnabled?: boolean;
  /** 索引增量重建间隔（毫秒，下限 5000）。 */
  indexRefreshMs?: number;
}
/** Schemastery 配置 schema：加载器用它解析行 `config` 并补默认值。 */
declare const Config: z<Config>;
declare function apply(ctx: Context, config?: Config): void;
//#endregion
export { Config, apply, inject, name };
//# sourceMappingURL=index.d.ts.map