# dsh-obsidian-sync v3.4.4

修复一个会让**任何工具调用直接崩溃**的缺陷：插件把宿主包写进了 `dependencies`，在 profile 中装出第二份 `@deepseek-ai/dsh-tools` 副本，破坏了 `Symbol` 身份。

## 修复

### 宿主包出现在 dependencies，导致 tools 服务被"同名副本"覆盖

- **现象**：插件安装后，会话一开始调用工具就整轮失败，报：

  ```
  Cannot read properties of undefined (reading 'prepare')
  ```

  模型能正常看到 `obsidian_search` / `obsidian_brief` / `obsidian_read_note` / `obsidian_sync_session`（说明工具注册本身没问题），但只要执行工具就崩，且**卸载插件后仍然复现**，必须重启 DSH 才能恢复。

- **根因**：`@deepseek-ai/dsh-tools` 被声明在 `dependencies` 中。pnpm 于是在 profile 内额外安装一份 `@deepseek-ai/dsh-tools`（版本与宿主相同，都是 0.2.0-rc.2，但**是两个不同的模块实例**）。

  而工具调度器是通过模块级 Symbol 定位的：

  ```ts
  export const TOOL_RUNTIME_SCHEDULER: unique symbol = Symbol('@deepseek-ai/dsh-tools.scheduler')
  ```

  `Symbol()`（而非 `Symbol.for()`）在不同模块副本之间**不共享身份**。副本被纳入运行时后，`tools` 服务与该 Symbol 来自不同副本，于是 agent-loop 中的

  ```ts
  ctx.tools[TOOL_RUNTIME_SCHEDULER].prepare(call.exec)
  ```

  取到 `undefined`，抛出上述错误。

- **修复**：按 DSH 官方插件的既定做法，把宿主提供的包从 `dependencies` 移入 `peerDependencies`：

  | 包 | v3.4.3 | v3.4.4 |
  | --- | --- | --- |
  | `@deepseek-ai/dsh-tools` | dependencies | **peerDependencies**（+ devDependencies 供本地构建） |
  | `@deepseek-ai/cordis` | dependencies | **peerDependencies**（+ devDependencies） |

  `dependencies` 现在只剩 `@deepseek-ai/schemastery` 与 `react` —— 与官方 `dsh-tool-jobs`、`dsh-web-search-deepseek` 的声明方式一致。

- **对照证据**：官方插件的声明方式（从 app.asar 读取）

  ```
  @deepseek-ai/dsh-tool-cordis   dependencies={}                    peerDependencies={..., dsh-tools}
  @deepseek-ai/dsh-tool-jobs     dependencies={schemastery}         peerDependencies={..., dsh-tools}
  @deepseek-ai/dsh-agent         dependencies={}                    peerDependencies={..., cordis}
  ```

- **重要**：在升级前**必须完全重启 DSH**。旧版本已经污染了当前进程的服务实例，仅卸载插件不会恢复。

## 验证

- 修复后安装产物中**不再包含任何宿主包副本**（实测 `node_modules/@deepseek-ai/` 下只剩 `schemastery` 及其纯库依赖 `cosmokit`）。
- `tsdown` 构建通过、`tsc -p tsconfig.json` 类型检查通过。
- 宿主侧冒烟测试（4 个 tool + 定时 effect）通过。
- 客户端 bundle 冒烟测试、契约测试（ALL PASS）、`SettingsFormModel` 激活复现探针全部通过。
- `scripts/test-tokenize` / `test-idempotent` / `test-index-boundary` 全部通过。

## 升级

```bash
dsh plugin --profile web add @dingpenghui/dsh-obsidian-sync@3.4.4
```

升级后请**完全退出并重启 DSH**。

---

# dsh-obsidian-sync v3.4.4

Fixes a defect that made **every tool call crash**: the plugin listed host packages under `dependencies`, producing a second `@deepseek-ai/dsh-tools` copy in the profile and breaking `Symbol` identity.

## Fixes

### Host packages declared in dependencies caused the tools service to be shadowed by a duplicate

- **Symptom**: after installing the plugin, any session that invoked a tool failed the whole turn with:

  ```
  Cannot read properties of undefined (reading 'prepare')
  ```

  The model could see `obsidian_search` / `obsidian_brief` / `obsidian_read_note` / `obsidian_sync_session` normally (so tool *registration* was fine), but *executing* any tool crashed — and it kept crashing after uninstalling the plugin until DSH was restarted.

- **Root cause**: `@deepseek-ai/dsh-tools` was declared under `dependencies`. pnpm therefore installed an extra `@deepseek-ai/dsh-tools` inside the profile. Same version as the host (0.2.0-rc.2 both), but **a different module instance**.

  The tool scheduler is located through a module-level symbol:

  ```ts
  export const TOOL_RUNTIME_SCHEDULER: unique symbol = Symbol('@deepseek-ai/dsh-tools.scheduler')
  ```

  `Symbol()` — not `Symbol.for()` — has no shared identity across module copies. Once the duplicate entered the runtime, the `tools` service and that symbol came from different copies, so this line in the agent loop

  ```ts
  ctx.tools[TOOL_RUNTIME_SCHEDULER].prepare(call.exec)
  ```

  evaluated to `undefined` and threw.

- **Fix**: following the established convention of DSH's own plugins, host-provided packages moved out of `dependencies` into `peerDependencies`:

  | Package | v3.4.3 | v3.4.4 |
  | --- | --- | --- |
  | `@deepseek-ai/dsh-tools` | dependencies | **peerDependencies** (+ devDependencies for local builds) |
  | `@deepseek-ai/cordis` | dependencies | **peerDependencies** (+ devDependencies) |

  `dependencies` now contains only `@deepseek-ai/schemastery` and `react` — matching official `dsh-tool-jobs` and `dsh-web-search-deepseek`.

- **Reference**: how official plugins declare these (read from app.asar):

  ```
  @deepseek-ai/dsh-tool-cordis   dependencies={}              peerDependencies={..., dsh-tools}
  @deepseek-ai/dsh-tool-jobs     dependencies={schemastery}   peerDependencies={..., dsh-tools}
  @deepseek-ai/dsh-agent         dependencies={}              peerDependencies={..., cordis}
  ```

- **Important**: you **must fully restart DSH** when upgrading. Previous versions already poisoned the running process's service instance; uninstalling alone will not recover it.

## Verification

- The installed artifact **no longer contains any host package copy** (measured: `node_modules/@deepseek-ai/` contains only `schemastery` and its pure-library dependency `cosmokit`).
- `tsdown` build and `tsc -p tsconfig.json` typecheck pass.
- Host smoke test (4 tools + timer effect) passes.
- Client bundle smoke test, contract test (ALL PASS), and the `SettingsFormModel` activation repro probe all pass.
- `scripts/test-tokenize` / `test-idempotent` / `test-index-boundary` all pass.

## Upgrade

```bash
dsh plugin --profile web add @dingpenghui/dsh-obsidian-sync@3.4.4
```

Fully quit and restart DSH after upgrading.
