# dsh-obsidian-sync v3.4.3

修复一个会让**整个 DSH 会话无法对话**的严重缺陷：工具名含点号，被模型 provider 的 function-name 校验直接拒绝。

## 修复

### 工具名违反 provider 命名约束，导致所有请求 400

- **现象**：安装并启用本插件后，任何会话发出的**每一条**消息都立刻失败，模型一个字都吐不出来。会话记录中的报错为：

  ```
  Invalid 'tools[14].name': string does not match pattern.
  Expected a string that matches the pattern '^[a-zA-Z0-9_-]+$'.
  code: INVALID_REQUEST, status: 400
  ```

- **根因**：v3.4.2 及更早版本把工具注册为 `obsidian.search` / `obsidian.brief` / `obsidian.read_note` / `obsidian.sync_session`。点号 `.` **不在** provider 允许的 function-name 字符集 `^[a-zA-Z0-9_-]+$` 内。由于工具表是随每个请求整体上报的，只要插件处于启用状态，请求在模型侧校验阶段就被拒绝，与用户说什么内容无关。

- **修复**：4 个工具名统一改为合法字符集：

  | v3.4.2 及更早 | v3.4.3 |
  | --- | --- |
  | `obsidian.search` | `obsidian_search` |
  | `obsidian.brief` | `obsidian_brief` |
  | `obsidian.read_note` | `obsidian_read_note` |
  | `obsidian.sync_session` | `obsidian_sync_session` |

  同时在 `src/index.ts` 工具注册处留下防回归注释，说明该字符集约束。

- **影响面**：v3.4.2 及更早全部版本。属于“插件一装就坏”级别，请务必升级。
- **不兼容变更**：工具调用名发生变化，请同步更新你自己的提示词、脚本或文档中出现的旧名。

## 其他改动

### 包名 scoped 化

包名由 `dsh-obsidian-sync` 变更为 `@dingpenghui/dsh-obsidian-sync`，插件 id、`plugins.bundle.config` / `plugins.row.config` slot key、安装文档与测试断言已同步更新。

## 验证

- `tsdown` 构建通过、`tsc -p tsconfig.json` 类型检查通过。
- 宿主侧冒烟测试（4 个 tool + 定时 effect，断言新工具名）通过。
- 客户端 bundle 冒烟测试通过。
- 真实 `SettingsFormModel` 激活复现探针通过。
- `scripts/test-tokenize` / `test-idempotent` / `test-index-boundary` 全部通过。
- 契约测试全绿：修正了 v3.1.0 时代遗留、与 v3.4.x 客户端设计相悖的一条断言（旧断言要求“namespace 未 serve 前详情页必须隐藏”，而 v3.4.x 是“`configForms` 存在即注册、缺失时降级为只读占位表单”）。

## 升级

```bash
dsh plugin --profile web add @dingpenghui/dsh-obsidian-sync@3.4.3
```

---

# dsh-obsidian-sync v3.4.3

Fixes a severe defect that made **every DSH session unable to talk to the model**: tool names contained dots, which the provider's function-name validation rejects.

## Fixes

### Tool names violated the provider naming constraint, failing every request with 400

- **Symptom**: with the plugin installed and enabled, *every* message in *any* session failed instantly — the model never produced a single token. The session log showed:

  ```
  Invalid 'tools[14].name': string does not match pattern.
  Expected a string that matches the pattern '^[a-zA-Z0-9_-]+$'.
  code: INVALID_REQUEST, status: 400
  ```

- **Root cause**: v3.4.2 and earlier registered tools as `obsidian.search`, `obsidian.brief`, `obsidian.read_note` and `obsidian.sync_session`. A dot is **not** in the allowed function-name character set `^[a-zA-Z0-9_-]+$`. Because the tool list is sent with every request, the request was rejected during model-side validation whenever the plugin was enabled — regardless of what the user typed.

- **Fix**: all four tool names now use legal characters:

  | v3.4.2 and earlier | v3.4.3 |
  | --- | --- |
  | `obsidian.search` | `obsidian_search` |
  | `obsidian.brief` | `obsidian_brief` |
  | `obsidian.read_note` | `obsidian_read_note` |
  | `obsidian.sync_session` | `obsidian_sync_session` |

  A regression-guard comment documenting the character-set constraint was added at the tool registration site in `src/index.ts`.

- **Affected**: all versions up to and including v3.4.2. This is a "breaks on install" bug — upgrading is strongly recommended.
- **Breaking change**: tool call names changed. Update any prompts, scripts or docs that referenced the old names.

## Other changes

### Scoped package name

The package is now `@dingpenghui/dsh-obsidian-sync` instead of `dsh-obsidian-sync`; the plugin id, `plugins.bundle.config` / `plugins.row.config` slot keys, install docs and test assertions were updated accordingly.

## Verification

- `tsdown` build and `tsc -p tsconfig.json` typecheck pass.
- Host smoke test (4 tools + timer effect, asserting the new names) passes.
- Client bundle smoke test passes.
- Real `SettingsFormModel` activation repro probe passes.
- `scripts/test-tokenize` / `test-idempotent` / `test-index-boundary` all pass.
- Contract test is fully green: one v3.1.0-era assertion that contradicted the v3.4.x client design was corrected (the old assertion required detail pages to stay hidden until the namespace was served, whereas v3.4.x registers them as soon as `configForms` is available and degrades to a read-only placeholder form when it is missing).

## Upgrade

```bash
dsh plugin --profile web add @dingpenghui/dsh-obsidian-sync@3.4.3
```
