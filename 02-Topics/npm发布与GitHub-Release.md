---
type: topic
created: "2026-09-03"
aliases: ["npm发布", "GitHub Release", "版本管理"]
related: ["插件安装", "dsh-conversation-language"]
conversationCount: 1
lastUpdated: "2026-09-03"
---

# 📂 npm 发布与 GitHub Release

> 主题分类笔记 - 最后更新: 2026-09-03
> 相关对话数: 1

## 概述

DSH 插件的版本发布流程。

## 发布步骤

### 1. Git 操作

```bash
# 更新版本号
# package.json: "version": "1.2.3"

# 提交更改
git add .
git commit -m "fix: 修复与 dsh-settings 0.1.2 的兼容性问题"

# 创建 tag
git tag -f v1.2.3

# 推送
git push origin main --tags
```

### 2. GitHub Release

- 在 GitHub 页面创建 Release
- 填写中英文描述
- 关联 tag

### 3. npm 发布

```bash
# 登录（需要 npm Access Token）
npm login

# 发布
npm publish
```

## 注意事项

| 项目 | 说明 |
|------|------|
| GitHub PAT | 用于 git push，不是 npm publish |
| npm Token | 需要在 https://npmjs.com/settings/tokens 生成 |
| Classic Token | 推荐使用 Classic Token 而非 Fine-grained |
| 版本冲突 | 确保 package.json 版本与 git tag 一致 |

## 相关对话

- [[2026-09-03|2026-09-03 插件安装专题]]

---
*此笔记由 AI 自动整理生成*
