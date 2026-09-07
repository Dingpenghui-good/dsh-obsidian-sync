---
type: daily-log
date: "2026-09-03"
month: "2026-09"
created: "2026-09-03T12:30:00"
conversationCount: 18
topics: ["插件安装", "dsh-conversation-language", "兼容性", "npm发布", "GitHub Release"]
tags: ["插件安装", "dsh-conversation-language", "兼容性", "npm发布", "GitHub Release", "DSH"]
---

# 📅 每日日志 2026-09-03（插件安装专题）

> 生成时间: 2026-09-03 12:30
> 对话数量: 18（来自 session-5019ee38）

## 插件安装过程

### 1. 插件评估
- **插件名称**: dsh-conversation-language
- **功能**: 切换对话语言（中文/英文），修改 system prompt 语言指令
- **安全性**: ✅ 无恶意代码，无外部网络请求
- **结论**: 可以安全安装

### 2. 安装过程与问题修复

#### 问题 1: duplicate loader entry id
- **原因**: `dsh plugin add` 已自动注册，我又手动编辑了 `cordis.patch.yml`，导致重复
- **修复**: 清空 `~/.dsh/profiles/web/cordis.patch.yml` 为 `[]`

#### 问题 2: JSON BOM 错误
- **原因**: PowerShell `Set-Content -Encoding UTF8` 写入 BOM 头
- **修复**: 使用 `ConvertTo-Json` 重写文件，去掉 BOM

#### 问题 3: settingsNamespace export 不存在
- **原因**: 插件依赖 `@deepseek-ai/dsh-settings@0.1.1-rc.2`，但 DSH 实际安装的是 `0.1.2-alpha.4`
- **API 变更**: `settingsNamespace()` 函数在新版本中被移除
- **修复**: 
  - 删除 `import { settingsNamespace } from '@deepseek-ai/dsh-settings'`
  - 将 `settingsNamespace(CONVERSATION_LANGUAGE_NAMESPACE)` 改为直接传字符串
- **责任**: 插件的兼容性问题（作者未跟进 API 变更）

#### 问题 4: 客户端依赖缺失
- **原因**: 插件依赖三个未包含在 DSH 种子表中的包
- **缺失包**:
  - `@deepseek-ai/dsh-client-ui-primitives`
  - `@deepseek-ai/dsh-client-runtime`
  - `@deepseek-ai/dsh-client-ui-slots`
- **修复**: 将这些包添加到 `package.json` 的 dependencies 和 bundles

### 3. 源码修改记录

修改文件: `src/index.ts`

```diff
-import { settingsNamespace } from '@deepseek-ai/dsh-settings'
-
 const CONVERSATION_LANGUAGE_NAMESPACE = 'tool-conversation-language'

 export default definePlugin({
   // ...
   apply(ctx) {
     const scope = ctx.get('settings')?.register(
-      settingsNamespace(CONVERSATION_LANGUAGE_NAMESPACE),
+      CONVERSATION_LANGUAGE_NAMESPACE,
       {
         type: 'string',
         default: 'zh',
         // ...
       }
     )
   }
 })
```

### 4. 版本发布

- **版本号**: v1.2.3
- **Commit**: afdae35
- **GitHub**: https://github.com/Dingpenghui-good/dsh-conversation-language
- **状态**: git push 成功，npm publish 需要 npm Access Token

### 5. Release 说明（v1.2.3）

#### 中文
- **修复**: 解决与 `@deepseek-ai/dsh-settings@0.1.2-alpha.x` 的兼容性问题
- **原因**: `settingsNamespace` 导出在新版本中被移除
- **方案**: 移除包装调用，直接传递 namespace 字符串

#### English
- **Fix**: Resolve compatibility with `@deepseek-ai/dsh-settings@0.1.2-alpha.x`
- **Root Cause**: The `settingsNamespace` export was removed in 0.1.2-alpha
- **Solution**: Pass namespace string directly to `register()`

## 今日主题

[[插件安装]], [[dsh-conversation-language]], [[兼容性]], [[npm发布]], [[GitHub Release]], [[DSH]]

## 经验总结

| 问题类型 | 原因 | 解决方案 |
|---------|------|---------|
| duplicate id | 重复注册 | dsh plugin add 已自动处理，无需手动编辑 patch |
| JSON BOM | PowerShell 编码 | 使用 ConvertTo-Json 或 UTF-8 without BOM |
| API 不兼容 | 依赖版本差异 | 修改源码适配新版本 API |
| 客户端依赖缺失 | 未加入种子表 | 添加到 package.json dependencies |

---
*由 AI 知识库系统自动生成*
