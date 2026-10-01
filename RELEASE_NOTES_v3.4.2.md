# dsh-obsidian-sync v3.4.2

测试脚本可移植化：去掉两处硬编码的绝对路径。

## 修复

### 测试脚本硬编码了作者机器的绝对路径

- **`contract-test.mjs`**：`C:/Users/braindge/.dsh/profiles/web/node_modules` → 改为按优先级解析客户端 bundle：`DSH_OBSIDIAN_SYNC_CLIENT` 环境变量 → 本地构建产物 `lib/client.js` → DSH web profile 中的安装副本；全部候选都不存在时打印尝试过的路径并以退出码 1 结束。
- **`repro-client-activation.mjs`**：`D:/DSH/workspace/dsh-obsidian-sync` → 改为以脚本自身所在目录推导（可用 `DSH_OBSIDIAN_SYNC_ROOT` 覆盖）。

两处均**只改路径解析，断言与测试逻辑完全未变**。修复前这两个脚本在非作者机器上都会以 ENOENT 直接崩溃。

## 已知问题（本次未处理）

- `contract-test.mjs` 仍有一条断言与 v3.4.x 的客户端设计不符：它断言"详情页在 namespace 未 serve 前必须隐藏"，而 v3.4.x 已刻意改为"`configForms` 存在即注册、缺失时降级为只读占位表单"（见 `src/client/index.ts`）。该文件是 v3.1.0 时代的产物，本次未改动其断言。最终态断言（slot 数量与 key 正确）是通过的。

## 验证

- `tsdown` 构建通过、`tsc -p tsconfig.json` 类型检查通过。
- 宿主侧冒烟测试（4 个 tool + 3 个定时 effect）、客户端 bundle 冒烟测试通过。
- 真实 `SettingsFormModel` 激活复现探针通过（`repro-client-activation.mjs`）。
- `scripts/test-tokenize` / `test-idempotent` / `test-index-boundary` 全部通过。

## 升级

```bash
dsh plugin --profile web add dsh-obsidian-sync@3.4.2
```

---

# dsh-obsidian-sync v3.4.2

Portable test scripts: two hardcoded absolute paths removed.

## Fixes

### Test scripts hardcoded the author's absolute paths

- **`contract-test.mjs`**: `C:/Users/braindge/.dsh/profiles/web/node_modules` → the client bundle is now resolved in priority order: `DSH_OBSIDIAN_SYNC_CLIENT` → locally built `lib/client.js` → installed copy in a DSH web profile; when none exists it prints the tried paths and exits 1.
- **`repro-client-activation.mjs`**: `D:/DSH/workspace/dsh-obsidian-sync` → now derived from the script's own directory (overridable via `DSH_OBSIDIAN_SYNC_ROOT`).

Both changes touch **path resolution only — assertions and test logic are unchanged**. Before this fix both scripts crashed with ENOENT on any machine other than the author's.

## Known issue (not addressed here)

- `contract-test.mjs` still carries one assertion that contradicts the v3.4.x client design: it expects the detail pages to stay hidden until the namespace is served, whereas v3.4.x deliberately registers them as soon as `configForms` is available (degrading to a read-only placeholder form when it is missing) — see `src/client/index.ts`. That file is a v3.1.0-era artifact and its assertions were left untouched. The final-state assertions (slot count and keys) do pass.

## Verification

- `tsdown` build and `tsc -p tsconfig.json` typecheck pass.
- Host smoke test (4 tools + 3 timer effects) and client bundle smoke test pass.
- Real `SettingsFormModel` activation repro probe passes (`repro-client-activation.mjs`).
- `scripts/test-tokenize` / `test-idempotent` / `test-index-boundary` all pass.

## Upgrade

```bash
dsh plugin --profile web add dsh-obsidian-sync@3.4.2
```
