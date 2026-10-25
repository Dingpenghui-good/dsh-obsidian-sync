# 构建产物来源（lib/ 溯源）

`lib/` 随包发布，由 `src/` 经 tsdown 构建生成。发布前需要能验证「提交的 lib 与 src 一致」。

## 本仓库里 lib/ 的来源

| 项 | 值 |
|----|----|
| 构建时间 | 2026-10-25 |
| 构建命令 | `node node_modules/tsdown/dist/run.mjs`（tsdown 0.22.14 / rolldown 1.2.9 / Node 24.21.0） |
| 源目录 | `E:\dsh-workspace\dsh-obsidian-sync`（v4.0.0 开发所在目录，`src/` 已整体迁入本仓库） |
| `src/` 一致性 | 本仓库 `src/*` 与源目录逐字节相同（迁移时复制，未再改动） |
| `lib/index.js` | SHA256 前缀 `D681E484D1D62FBF`（宿主代码：检索注入 + 实时沉淀 + 工具） |
| `lib/index.d.ts` | 与 `lib/index.js` 同批产出 |
| `lib/client.js` | **原样来自 npm 已发布的 3.4.8 客户端产物**（本次未改客户端，故不重新打包） |

> `client.js` 之所以不重新构建：本地 tsdown 重新打包会把 CSS Modules 的类名顺序改成源码序
> （`page/title/input/...`），与 npm 已发布的哈希序产物产生无意义的 diff。客户端逻辑本次零改动，
> 保持一致反而更安全。将来改客户端时，在能完成 `pnpm install` 的环境重新构建即可。

## 验证「lib 与 src 一致」

```bash
# 1. 类型检查（需要能解析 @deepseek-ai/dsh-* 与 @deepseek-ai/schemastery）
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit

# 2. 重新构建，并与已提交的 lib 对比（无差异即一致）
node node_modules/tsdown/dist/run.mjs
git diff --stat -- lib   # 输出为空 = 一致
```

## 准备 node_modules

### 方式一（推荐）：一次 `pnpm install`

```bash
pnpm install          # 会生成 pnpm-lock.yaml，请一并提交
pnpm build            # = tsdown
pnpm typecheck        # = tsc --noEmit
```

### 方式二：本机离线（本仓库迁移时的实际做法）

本机没有可用的干净 pnpm 环境，迁移时用的是既有依赖目录：

```powershell
# 复用 E:\dsh-workspace\dsh-obsidian-sync\node_modules（含 tsdown/typescript/lightningcss 与 .pnpm 存储）
cmd /c mklink /J .\node_modules E:\dsh-workspace\dsh-obsidian-sync\node_modules

# 运行时包（@deepseek-ai/dsh-tools 等）由 DSH 安装提供 —— 测试时用 NODE_PATH
$env:NODE_PATH = 'C:\Users\dph\.dsh\profiles\desktop\node_modules;C:\Users\dph\.dsh\profiles\node_modules'
```

在此环境下已验证：`tsc --noEmit` 0 错误、`tsdown` 完整打包成功、两套测试全绿
（纯函数 16/16、运行级冒烟 7 组）。

## 已知环境注意点

- `pnpm install` 可能因 `@deepseek-ai/*` 预发版被 `minimumReleaseAge` 拦截：
  在 `pnpm-workspace.yaml` 里把相关包加进 `minimumReleaseAgeExclude`，或设 `minimumReleaseAge: 0`。
- `dsh plugin --profile desktop add .` 目前会在解析 profile 其它 bundle 时失败
  （`@dingpenghui/dsh-defuser-preset` 是悬空链接），与本插件无关；本地验证时用「替换 node_modules 副本 + 重启 DSH」。
