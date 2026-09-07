---
type: topic
created: "{{date}}"
aliases: ["{{topic}}"]
related: []
---

# 📂 {{topic}}

> 主题分类笔记 - 最后更新: {{lastUpdated}}
> 相关对话数: {{conversationCount}}

## 概述

{{summary}}

## 关键要点

- {{keyPoint1}}
- {{keyPoint2}}
- {{keyPoint3}}

## 相关对话

```dataview
LIST
FROM "01-Daily"
WHERE contains(tags, "{{tag}}")
SORT file.ctime DESC
LIMIT 20
```

## 关联资源

-

---
*此笔记由 AI 自动整理生成*
