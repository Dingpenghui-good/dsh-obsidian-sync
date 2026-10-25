# dsh-obsidian-sync v3.4.1

修复插件详情页保存 vault 路径后不生效的问题。

## 修复

### vault 路径保存后运行中实例仍用旧路径（v3.4.0 遗留问题）

- **现象**：在插件详情页修改 vaultPath 并保存后，`cordis.patch.yml` 已正确写入新路径，但 `obsidian.search` / `obsidian.sync_session` 等工具仍在使用旧路径搜索/归档，必须重启整个应用才能生效。
- **根因**：`src/index.ts` 的 `apply()` 在插件激活时把 vault 路径求值成模块级 `const resolvedVaultPath`，之后所有索引重建、外部变更感知、归档/git 操作闭包引用的都是这个冻结值。设计注释假设"保存后 volatile HMR 会重新挂载本插件"，但 0.2.0-rc.2 实际行为是：保存只写盘 + 更新 settings 镜像，**不会自动重激活运行中的插件 fiber**（重激活只在整应用重启或手动卸载/重载时发生），因此运行中的实例一直拿旧路径在跑。
- **修复**：
  1. 路径改为惰性读取：`resolvedVaultPath`（const）→ `currentVaultPath()`（每次调用重读 settings 镜像），全部使用点替换为函数调用，每次索引重建/感知/归档都拿当前值。
  2. 新增 `markDirtyOnVaultChange()`：在定时器 tick 与 `ensureIndex()` 入口比对当前路径与上次观测值，变更即置 `dirty`，下一周期按新路径全量重建，无需重启。
  3. 顺带修正两个 typecheck 错误：`tsconfig.json` 加 `noEmit`（TS5096：`allowImportingTsExtensions` 需搭配 `noEmit`/`emitDeclarationOnly`）；客户端占位表单 `unavailableForm()` 的 `subscribe` 签名与 `ConfigFormSnapshot` 的 `mode: 'host'` 字段对齐。

## 行为变化

- 保存新 vault 路径后**无需重启**：最多等一个索引周期（默认 60s）或下次调用任意 obsidian 工具时，自动按新路径重建索引。
- 其余功能不变。

## 验证

- `tsc` 类型检查通过、`tsdown` 构建通过。
- 主机侧冒烟测试通过（4 个工具 + 3 个定时 effect）。
- 客户端 bundle 冒烟测试 + 真实 `SettingsFormModel` 激活复现探针通过。
- 安装目录 `lib/index.js` 与工作区哈希一致（pnpm junction 同步）。

## 升级

```bash
dsh plugin --profile web add dsh-obsidian-sync@3.4.1
```

升级后对 dsh-obsidian-sync 执行一次卸载/重新加载即可；之后改路径无需再重启。

---

# dsh-obsidian-sync v3.4.1

Fixes the issue where saving a new vault path in the plugin detail page did not take effect until the whole app was restarted.

## Fixes

### Saved vault path not picked up by the running instance (v3.4.0 regression)

- **Symptom**: after editing `vaultPath` and saving on the plugin detail page, `cordis.patch.yml` was written with the new path, yet the `obsidian.search` / `obsidian.sync_session` tools kept using the old path — a full app restart was required.
- **Root cause**: `apply()` in `src/index.ts` froze the vault path into a module-level `const resolvedVaultPath` at activation time; every index rebuild, external-change scan, and archive/git call closed over that frozen value. The design comment assumed "volatile HMR remounts the plugin after save", but on 0.2.0-rc.2 a save only writes the document and updates the settings mirror — it does **not** re-activate the running plugin fiber (that only happens on full app restart or manual unload/reload), so the live instance kept running with the stale path.
- **Fix**:
  1. Path is now read lazily: `resolvedVaultPath` (const) replaced by `currentVaultPath()` (re-reads the settings mirror on every call); all call sites use the function, so every index rebuild / scan / archive picks up the current value.
  2. Added `markDirtyOnVaultChange()`: called at the timer tick and `ensureIndex()` entry, it compares the current path against the last observed one and marks the index dirty on change, forcing a full rebuild from the new vault on the next cycle — no restart needed.
  3. Also fixed two typecheck errors found along the way: `tsconfig.json` gained `noEmit` (TS5096: `allowImportingTsExtensions` requires `noEmit` or `emitDeclarationOnly`); the client-side `unavailableForm()` placeholder now matches the `ConfigFormSnapshot` `subscribe` signature and includes the required `mode: 'host'` field.

## Behavior change

- Saving a new vault path now takes effect **without restarting**: within one index cycle (default 60 s) or on the next obsidian tool call, the index is automatically rebuilt from the new vault.
- Everything else is unchanged.

## Verification

- `tsc` typecheck and `tsdown` build pass.
- Host smoke test passes (4 tools + 3 scheduled effects).
- Client bundle smoke test + real `SettingsFormModel` activation repro harness pass.
- Installed `lib/index.js` hash matches the workspace build (pnpm junction sync).

## Upgrade

```bash
dsh plugin --profile web add dsh-obsidian-sync@3.4.1
```

After upgrading, do one unload/reload of dsh-obsidian-sync; afterwards, path changes no longer need a restart.
