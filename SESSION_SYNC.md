# DSH 会话自动同步系统

> 自动将所有 DSH 会话内容同步到 Obsidian 知识库

## 功能

- 解压 DSH 会话的 zstd 压缩文件
- 解析 JSONL 格式的消息
- 提取用户和助手的对话内容
- 生成 Markdown 格式的日志文件
- 自动分类和标签提取

## 使用方法

### 手动运行

```bash
node D:\DSH\workspace\knowledge-base\sync-dsh-sessions.js
```

### 定时自动同步

#### 方式一：Windows 计划任务（需要管理员权限）

```powershell
schtasks /create /tn "KB-Sync-Sessions" /tr "node D:\DSH\workspace\knowledge-base\sync-dsh-sessions.js" /sc hourly /mo 1 /f
```

#### 方式二：启动文件夹（推荐，无需管理员）

创建快捷方式到启动文件夹：
```
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\
```

快捷方式目标：
```
C:\Windows\System32\wscript.exe "D:\DSH\workspace\knowledge-base\auto-sync-sessions.vbs"
```

VBS 内容 (`auto-sync-sessions.vbs`)：
```vbscript
Set objShell = CreateObject("WScript.Shell")
objShell.Run "node D:\DSH\workspace\knowledge-base\sync-dsh-sessions.js", 0, False
```

## 输出结构

```
D:\DSH\workspace\knowledge-base\
└── 01-Daily\
    └── 2026-09\
        ├── 2026-09-03-DSH-session-07f63726.md  # 会话1（10轮对话）
        └── 2026-09-03-DSH-session-5019ee38.md  # 会话2（13轮对话）
```

## 技术细节

- **输入**: `C:\Users\<user>\.dsh\sessions\<session-id>\session.jsonl.zstd`
- **格式**: Zstandard 压缩的多帧 JSONL 文件
- **解析**: 使用 Node.js 内置 `zlib.zstdDecompressSync`
- **输出**: Markdown 格式，包含 frontmatter 和对话记录

## 消息类型映射

| DSH 消息类型 | 处理方式 |
|-------------|---------|
| `user/message` | 提取为"user"消息 |
| `assistant/chunk` | 聚合为 assistant 内容 |
| `assistant/message` | 完整 assistant 消息 |
| `reasoning-chunks` | 提取思考过程 |
| `turn/start` | 标记新对话轮次 |

## 相关脚本

- `sync-dsh-sessions.js` - 主同步脚本
- `maintain.py` - 知识库整理脚本
- `auto-maintain.vbs` - 定时维护启动器
