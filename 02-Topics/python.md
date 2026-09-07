---
type: topic
created: "2026-09-03"
aliases: ["python", "脚本"]
related: ["自动化", "maintain.py"]
conversationCount: 2
lastUpdated: "2026-09-03"
---

# 📂 Python 脚本

> 主题分类笔记 - 最后更新: 2026-09-03
> 相关对话数: 2

## 概述

知识库维护的核心 Python 脚本。

## 核心脚本

### maintain.py

主整理脚本，支持三个命令：
- `init` — 初始化知识库目录结构
- `log` — 记录单条对话到 Inbox
- `maintain` — 执行完整的整理流程

### 功能特性

1. **对话记录**
   - 实时写入 00-Inbox
   - 自动生成 YAML frontmatter
   - 提取标签和摘要

2. **自动整理**
   - 按日期分组合并
   - 生成每日日志
   - 创建主题笔记
   - 归档旧文件
   - 更新 MOC 索引

3. **编码支持**
   - UTF-8 输出
   - Windows 控制台兼容
   - 错误处理机制

## 相关对话

- [[2026-09-02|2026-09-02 每日日志]]
- [[2026-09-03|2026-09-03 每日日志]]

## 关联资源

- [maintain.py](../maintain.py)
- [README.md](../README.md)

---
*此笔记由 AI 自动整理生成*
