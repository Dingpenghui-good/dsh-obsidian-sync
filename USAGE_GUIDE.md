# DSH Obsidian Sync 使用指南

## 已完成的配置

### 1. 插件位置
- 本地路径: `D:\DSH\workspace\dsh-obsidian-sync`
- GitHub 仓库: https://github.com/Dingpenghui-good/dsh-obsidian-sync

### 2. 配置文件
- Settings: `C:\Users\braindge\.dsh\settings.yaml`
- 已添加 obsidian-sync 配置

### 3. 知识库位置
- Vault: `D:\DSH\workspace\knowledge-base`

## 功能说明

### 会话前（自动）
当用户输入包含关键词时，系统会自动：
1. 搜索 Obsidian 知识库中相关内容
2. 将相关笔记注入到系统提示中
3. 提供上下文参考

### 会话后（自动）
对话结束后，系统会自动：
1. 生成会话摘要
2. 提取主题标签
3. 保存到知识库

### 输出格式
生成的笔记包含：
- Frontmatter（元数据）
- 会话摘要
- 关键对话
- 主题标签
- 统计信息

## 手动使用

### 搜索知识库
```javascript
import { searchKnowledgeBase } from 'dsh-obsidian-sync'
const results = searchKnowledgeBase('obsidian', 5)
```

### 同步会话
```javascript
import { syncSession } from 'dsh-obsidian-sync'
syncSession('session-id', '摘要内容', ['标签1', '标签2'])
```

## 故障排查

### 问题 1: DSH 启动失败
**症状**: `SyntaxError: Unexpected token '﻿'`
**原因**: settings.yaml 有 BOM
**解决**: 已修复，移除 BOM

### 问题 2: 端口 3080 被占用
**症状**: `EADDRINUSE: address already in use`
**解决**: 清理占用进程
```powershell
netstat -ano | findstr :3080
taskkill /F /PID <PID>
```

### 问题 3: 中文显示乱码
**症状**: tagKeywords 显示为乱码
**解决**: 使用 UTF-8 无 BOM 编码保存文件

## 下一步

1. 重启 DSH 使配置生效
2. 在新对话中测试功能
3. 查看生成的会话摘要文件

---
*由 DSH Obsidian Sync 自动生成*
