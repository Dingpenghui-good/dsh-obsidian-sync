---
type: topic
created: "2026-09-03"
aliases: ["dsh-conversation-language", "对话语言", "语言切换"]
related: ["插件安装", "兼容性", "DSH"]
conversationCount: 1
lastUpdated: "2026-09-03"
---

# 📂 dsh-conversation-language

> 主题分类笔记 - 最后更新: 2026-09-03
> 相关对话数: 1

## 概述

DSH 插件，用于切换对话语言（中文/英文）。

## 功能

- 切换 AI 思考过程和回复语言
- 通过设置界面或 `settings.yaml` 配置
- 注册 `get_conversation_language` Tool

## 版本历史

| 版本 | 变更 |
|------|------|
| v1.2.2 | 初始版本 |
| v1.2.4 | 正式适配 DSH 0.1.2-alpha.4；更新所有可发布 alpha.4 的依赖；新增 `dsh-client-ui-settings` 和 `typescript` 依赖 |
| v1.2.3 | 修复与 `dsh-settings@0.1.2-alpha.x` 的兼容性问题 |

## 安装

```bash
# 从 npm registry 安装
dsh plugin --profile web add dsh-conversation-language

# 从本地路径安装
dsh plugin --profile web add <path-to-plugin>
```

## 配置

在 `settings.yaml` 中添加：

```yaml
conversation-language:
  conversationLanguage: zh  # 或 en
```

## 源码仓库

https://github.com/Dingpenghui-good/dsh-conversation-language

## 相关对话

- [[2026-09-03|2026-09-03 插件安装专题]]

---
*此笔记由 AI 自动整理生成*
