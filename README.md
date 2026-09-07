# 🤖 AI 知识库系统

> 由 DeepSeek Harness AI 自动维护的 Obsidian 知识库
> 创建时间: 2026-09-02 | 最后整理: 每小时自动执行

## 快速开始

### 1. 在 Obsidian 中打开知识库

```
文件 → 打开文件夹作为仓库 → 选择以下路径：
D:\DSH\workspace\knowledge-base
```

### 2. 安装推荐插件（可选但推荐）

在 Obsidian 设置 → 第三方插件 中安装：
- **Dataview** — 增强索引页的数据查询能力
- **Templater** — 更强大的模板引擎
- **Calendar** — 日历视图查看每日日志

### 3. 配置自动运行（二选一）

#### 方式 A：开机自启动（推荐，无需管理员）

双击运行以下文件即可在后台每小时自动整理：
```
D:\DSH\workspace\knowledge-base\kb-maintain.vbs
```

或者将启动快捷方式放到启动文件夹：
```
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\KB-Maintain.lnk
```

#### 方式 B：Windows 计划任务（精确每小时）

以**管理员身份**打开 PowerShell，运行：
```powershell
schtasks /create /tn "KB-Maintain" /tr "cmd /c D:\DSH\workspace\knowledge-base\run-maintenance.bat" /sc hourly /mo 1 /st 00:00 /rl highest /f
```

验证是否成功：
```powershell
schtasks /query /tn "KB-Maintain"
```

## 工作流程

```
┌─────────────┐     实时      ┌──────────┐     每小时      ┌──────────────┐
│  AI 对话    │ ──────────→ │ 00-Inbox │ ──────────→ │  01-Daily    │
│  (本会话)   │             │          │             │  02-Topics   │
└─────────────┘             └──────────┘             └──────────────┘
                                                        ↓ 周日/月末
                                               ┌──────────────┐
                                               │  04-Archive  │
                                               └──────────────┘
```

## 目录说明

| 路径 | 说明 |
|------|------|
| `00-Inbox` | 新对话实时写入区，整理前暂存 |
| `01-Daily/YYYY-MM/` | 每日对话日志，按月份分目录 |
| `02-Topics/` | 自动提取的主题笔记 |
| `03-Projects/` | 项目相关笔记 |
| `04-Archive/` | 归档历史内容 |
| `templates/` | 笔记模板 |
| `_meta/` | 配置、统计、日志 |
| `assets/` | 图片等资源附件 |
| `.obsidian/` | Obsidian 仓库配置 |

## 核心脚本

| 文件 | 用途 |
|------|------|
| `maintain.py` | 主整理脚本，支持 log/maintain/init 三个命令 |
| `kb-maintain.vbs` | 后台启动器（双击运行） |
| `kb-maintain.ps1` | PowerShell 维护脚本 |
| `run-maintenance.bat` | 批量文件，供定时任务调用 |
| `record-conversation.ps1` | PowerShell 便捷记录对话 |
| `schedule-maintenance.ps1` | Windows 定时任务入口 |
| `task_manager.py` | 任务管理辅助脚本 |

## 常用命令

```bash
# 初始化知识库（首次运行）
python maintain.py init

# 记录一条对话
python maintain.py log "会话ID" "user/assistant" "内容.md" "模型名"

# 手动执行整理
python maintain.py maintain
```

## 技术细节

- **语言**: Python 3.12 + PowerShell
- **编码**: 所有文件使用 UTF-8 编码
- **调度**: Windows 计划任务 / VBS 后台运行
- **标签提取**: 基于关键词权重表 `TAG_WEIGHTS`
- **去重**: 基于内容 MD5 + 文件名
- **统计**: 每次整理后更新 `_meta/stats.json`

## 扩展标签

编辑 `maintain.py` 中的 `TAG_WEIGHTS` 字典可添加新标签：

```python
TAG_WEIGHTS = {
    "你的新标签": 2,
    # ...
}
```

## 故障排查

**问题：定时任务不运行？**
- 确认以管理员身份注册了计划任务
- 或双击运行 `kb-maintain.vbs` 手动测试

**问题：中文显示乱码？**
- 确保 Python 输出编码为 UTF-8（脚本已内置处理）

**问题：Obsidian 打不开？**
- 确认路径：`D:\DSH\workspace\knowledge-base`
- 需要重启 Obsidian 让它识别新仓库

---
*本系统由 DeepSeek Harness AI 自动创建和维护*
