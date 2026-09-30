# dsh-obsidian-sync v3.4.0

本次发布包含 0.2.0-rc.2 激活修复的全量内容（v3.3.0 依赖声明修复 + v3.3.1 宿主 peer 依赖修复 + 本轮 web-boot 客户端修复）。

## 修复

### web boot 客户端激活失败（`dsh-obsidian-sync: failed`）

- **根因**：`plugin-detail-controller.ts` 的 `projection()` 读取了 `searchEnabled` 字段，但 `SettingsFormModel` 只注册了 `vaultPath` 和 `indexRefreshMs` 两个 spec。真实的 `SettingsFormModel.field(name)` 对未注册 spec 的字段会 `throw new Error('plugin card has no field <name>')`；而 controller 构造函数里 `this.store = this.form.bind(() => this.projection())` 会立即调用一次 `projection()`，导致激活阶段抛错，fiber 标记为 `FAILED`，web boot 报 `dsh-obsidian-sync: failed`，整个应用无法启动。
- **修复**：新增 `searchEnabledFieldSpec()`（布尔开关：`format` 把 `true/false` 映射为 `'true'/'false'` 文本，`parse` 反向解析，空串清除回默认），并注册进 `SettingsFormModel` 的 specs 数组——三个投影字段全部有 spec，不再抛错。

### 激活健壮性双保险

- `configForms` 不再是硬 inject（`inject` 数组只保留 `slots`、`locale`）。宿主未提供 settings 传输时 `ctx.get('configForms')` 为 undefined，降级为只读占位表单（`status: 'unavailable'`，`writable: false`），条目永不因服务缺失而抛错。
- slot 注册本身不读 `configForms`，随页面打开才惰性拉取快照，因此条目永远能激活。

### 宿主半激活失败（v3.3.1 继承修复）

- 把宿主服务包（`dsh-fs`、`dsh-sandbox`、`dsh-util-values` 等）从 `dependencies` 移到 `peerDependencies`，runtime 依赖收敛到 `@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-tools`、`react` 四个，修复 DSH 0.2.0-rc.2 fiber graph 激活时的 peer 依赖解析失败。

### bundle patch 编码损坏（v3.3.0 继承修复）

- `cordis.patch.yml` 注释改纯 ASCII，修复 pnpm 复制 file: 包到 web profile 时中文注释编码损坏导致 YAML 解析失败、settings 行未加载的问题。

## 新增

- `repro-client-activation.mjs`：客户端激活复现探针，从真实的 `@deepseek-ai/dsh-client-ui-primitives` 包提取 `SettingsFormModel` 源码 + 模拟启动期 `configForms` 镜像（`status: 'loading'`），完整跑一遍 `apply()`，可在本地复现/验证 web-boot 激活问题。

## 验证

- 工作区 `lib/client.js` 与安装目录（pnpm junction 同一文件）哈希一致，均为修复后版本。
- 真实 `SettingsFormModel` 激活复现：`APPLY OK`（3 个 effect 全部执行：dictionaries / detail form subscriptions / detail page）。
- 主机侧冒烟测试通过（4 个工具 + 3 个定时 effect）。
- 客户端 bundle 冒烟测试通过。

## 安装 / 升级

```bash
dsh plugin --profile web add dsh-obsidian-sync@3.4.0
```

或从本地：

```bash
cd dsh-obsidian-sync
pnpm install
pnpm build
dsh plugin --profile web add .
```

---

# dsh-obsidian-sync v3.4.0

This release bundles the full 0.2.0-rc.2 activation fix (v3.3.0 dependency-declaration fix + v3.3.1 host peer-dependency fix + this round's web-boot client fix).

## Fixes

### Web-boot client activation failure (`dsh-obsidian-sync: failed`)

- **Root cause**: `plugin-detail-controller.ts`'s `projection()` read the `searchEnabled` field, but `SettingsFormModel` only had specs for `vaultPath` and `indexRefreshMs`. The real `SettingsFormModel.field(name)` throws `Error('plugin card has no field <name>')` for an unregistered spec; and the controller constructor's `this.store = this.form.bind(() => this.projection())` invokes `projection()` immediately, so the throw fired during activation, the fiber was marked `FAILED`, web boot reported `dsh-obsidian-sync: failed`, and the whole app failed to start.
- **Fix**: Added `searchEnabledFieldSpec()` (boolean switch: `format` maps `true`/`false` to the strings `'true'`/`'false'`, `parse` reverses it, empty string clears back to default) and registered it in the `SettingsFormModel` specs array — all three projection fields now have specs, so the throw is gone.

### Activation robustness (belt-and-suspenders)

- `configForms` is no longer a hard inject (`inject` array now only contains `slots` and `locale`). When the host provides no settings transport, `ctx.get('configForms')` is undefined and the entry falls back to a read-only placeholder form (`status: 'unavailable'`, `writable: false`) — the entry never throws due to a missing service.
- Slot registration itself does not read `configForms`; the snapshot is pulled lazily when the page opens, so the entry always activates.

### Host half activation failure (carried from v3.3.1)

- Moved host service packages (`dsh-fs`, `dsh-sandbox`, `dsh-util-values`, etc.) from `dependencies` to `peerDependencies`, converging runtime deps to `@deepseek-ai/cordis`, `@deepseek-ai/schemastery`, `@deepseek-ai/dsh-tools`, and `react`, fixing the peer-dependency resolution failure during DSH 0.2.0-rc.2 fiber-graph activation.

### Bundle patch encoding corruption (carried from v3.3.0)

- `cordis.patch.yml` comments switched to pure ASCII, fixing the pnpm file:-package copy encoding corruption that broke YAML parsing and left the settings line unloaded.

## Additions

- `repro-client-activation.mjs`: client activation reproduction harness that extracts the real `SettingsFormModel` source from `@deepseek-ai/dsh-client-ui-primitives` and runs a full `apply()` against a boot-time `configForms` mirror (`status: 'loading'`), letting you reproduce/verify the web-boot activation issue locally.

## Verification

- Workspace `lib/client.js` and the installed copy (same file via pnpm junction) have matching hashes, both the post-fix build.
- Real `SettingsFormModel` activation repro: `APPLY OK` (all 3 effects ran: dictionaries / detail form subscriptions / detail page).
- Host smoke test passed (4 tools + 3 个 scheduled effects → 3 scheduled effects).
- Client bundle smoke test passed.

## Install / upgrade

```bash
dsh plugin --profile web add dsh-obsidian-sync@3.4.0
```

or from local:

```bash
cd dsh-obsidian-sync
pnpm install
pnpm build
dsh plugin --profile web add .
```
