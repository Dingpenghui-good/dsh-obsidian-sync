# 发布说明 v3.4.7

**日期：** 2026-10-03

## 修复 / Fixes

- **依赖模型重构**：`@deepseek-ai/schemastery` 和 `react` 从运行时 `dependencies` 移到 `peerDependencies`（标 `optional: true`），仅保留已有宿主模块 peer 不变。
  - 根因：本插件是 DSH 宿主扩展，运行时在宿主进程内执行。宿主已经把 `schemastery` 加载进同一进程作为宿主模块。本插件若再以 `dependencies` 携带同版本包，pnpm 会在插件树里**再实例化一份**，与宿主单实例不一致。
  - 影响：插件自身代码行为不变，只改变了"谁提供这些包"——现在统一由 DSH 宿主提供，单实例。

## 不变 / Unchanged

- `dsh-tools` / `dsh-fs` / `dsh-sandbox` / `dsh-util-values` 等宿主模块 peer 全部保持不变（`>=0.2.0-rc.1`，`optional`）。
- Obsidian 知识库搜索、会话归档、PARA 规则匹配等核心功能全部不变。
- `smoke-test` 不变。

## 升级指引 / Upgrade

- 从 3.4.6 升到 3.4.7 无 breaking change，直接 `pnpm update @dingpenghui/dsh-obsidian-sync` 即可。
- 插件安装后宿主行为不变，但不再在插件树里携带 `schemastery` 副本。
