#!/usr/bin/env python3
"""
AI Knowledge Base Maintainer
每小时自动整理知识库：去重、归类、生成摘要、更新索引
"""

import os
import sys
import json
import re
import shutil
from pathlib import Path
from datetime import datetime, timedelta
from collections import Counter, defaultdict
import hashlib

# Fix Windows console encoding for Chinese output
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

# ============== 配置 ==============
KB_ROOT = Path(r"D:\DSH\workspace\knowledge-base")
INBOX = KB_ROOT / "00-Inbox"
DAILY = KB_ROOT / "01-Daily"
TOPICS = KB_ROOT / "02-Topics"
PROJECTS = KB_ROOT / "03-Projects"
ARCHIVE = KB_ROOT / "04-Archive"
META = KB_ROOT / "_meta"
TEMPLATES = KB_ROOT / "templates"
ASSETS = KB_ROOT / "assets"

# 标签权重表：用于从对话内容提取主题
TAG_WEIGHTS = {
    "ai": 3, "人工智能": 3, "llm": 2, "大模型": 3,
    "coding": 2, "编程": 2, "python": 2, "javascript": 2, "node": 2,
    "obsidian": 2, "笔记": 2, "知识管理": 2,
    "deepseek": 2, "dsh": 2, "harness": 1,
    "plugin": 2, "cordis": 2, "agent": 2,
    "design": 1, "架构": 2, "系统": 2,
    "question": 1, "问题": 1, "求助": 1,
    "project": 2, "项目": 2,
    "daily": 1, "日常": 1, "记录": 1,
    "meeting": 1, "会议": 1,
    "learning": 2, "学习": 2,
    "productivity": 1, "效率": 1,
}

def get_today_dir() -> Path:
    """获取今日目录 01-Daily/YYYY-MM"""
    month_str = datetime.now().strftime("%Y-%m")
    month_dir = DAILY / month_str
    month_dir.mkdir(parents=True, exist_ok=True)
    return month_dir

def get_today_file() -> Path:
    """获取今日日志文件"""
    today = datetime.now().strftime("%Y-%m-%d")
    return DAILY / get_today_dir() / f"{today}.md"

def read_frontmatter(filepath: Path) -> dict:
    """读取 YAML frontmatter"""
    try:
        content = filepath.read_text(encoding="utf-8")
    except:
        try:
            content = filepath.read_text(encoding="utf-8-sig")
        except:
            content = filepath.read_text(encoding="latin-1")
    if not content.startswith("---"):
        return {}
    parts = content.split("---", 2)
    if len(parts) < 3:
        return {}
    try:
        import yaml
        return yaml.safe_load(parts[1]) or {}
    except:
        # 简单解析
        fm = {}
        for line in parts[1].strip().split("\n"):
            if ":" in line:
                k, v = line.split(":", 1)
                fm[k.strip()] = v.strip().strip('"').strip("'")
        return fm

def extract_content(filepath: Path) -> str:
    """提取文件正文（去掉 frontmatter）"""
    try:
        content = filepath.read_text(encoding="utf-8")
    except:
        try:
            content = filepath.read_text(encoding="utf-8-sig")
        except:
            content = filepath.read_text(encoding="latin-1")
    if content.startswith("---"):
        parts = content.split("---", 2)
        if len(parts) >= 3:
            return parts[2].strip()
    return content.strip()

def extract_tags_from_text(text: str) -> list[str]:
    """从文本中提取标签"""
    found = []
    text_lower = text.lower()
    for tag, weight in TAG_WEIGHTS.items():
        if tag.lower() in text_lower:
            if tag not in found:
                found.append(tag)
    return found

def slugify(name: str) -> str:
    """生成安全的文件名 slug"""
    s = name.strip()
    s = re.sub(r'[\\/:*?"<>|]', "-", s)
    s = re.sub(r"\s+", "-", s)
    return s[:80]

def dedup_key(filepath: Path, content: str) -> str:
    """生成去重 key"""
    return hashlib.md5(f"{filepath.name}:{content[:500]}".encode()).hexdigest()[:12]

# ============== 步骤 1: 记录对话到 Inbox ==============
def log_conversation_to_inbox(session_id: str, role: str, content: str, model: str = "agts-devflash"):
    """将单条对话记录写入 Inbox"""
    now = datetime.now()
    date_str = now.strftime("%Y-%m-%d")
    time_str = now.strftime("%H:%M")
    
    # 检测是否需要新建月份目录
    month_dir = get_today_dir()
    
    file_path = INBOX / f"{date_str}_{time_str.replace(':','')}-{role}.md"
    
    tags = extract_tags_from_text(content)
    slug = slugify(tags[0] if tags else f"conversation-{date_str}")
    
    content_preview = content[:500].replace("\n", " ").strip()
    
    fm = {
        "type": "conversation",
        "created": date_str,
        "tags": tags,
        "source": "deepseek-harness",
        "session_id": session_id,
        "model": model,
        "role": role,
        "time": time_str,
    }
    
    # 写 frontmatter
    lines = ["---"]
    for k, v in fm.items():
        if isinstance(v, list):
            lines.append(f"{k}: {', '.join(f'"{x}"' for x in v)}")
        else:
            lines.append(f"{k}: {v}")
    lines.append("---")
    
    body = f"""# 📝 {role} · {date_str} {time_str}

> 会话: {session_id} | 模型: {model}

## 内容

{content}

## 摘要

{content_preview}

## 标签

{', '.join(f'[[{t}]]' for t in tags)}

---
> 由 AI 知识库系统自动记录，待整理时归入主题。
"""
    
    file_path.write_text("\n".join(lines) + "\n\n" + body, encoding="utf-8")
    return file_path

# ============== 步骤 2: 每小时整理 ==============
def hourly_maintenance():
    """执行完整的知识库整理流程"""
    print(f"[{datetime.now()}] 开始知识库整理...")
    stats = {
        "processed": 0, "created_topics": 0,
        "moved_to_daily": 0, "merged": 0, "errors": 0
    }
    
    # 2.1 扫描 Inbox
    inbox_files = sorted(INBOX.glob("*.md"), key=lambda x: x.stat().st_mtime)
    print(f"  Inbox 待处理文件: {len(inbox_files)}")
    
    # 2.2 按日期分组，合并为每日日志
    by_date = defaultdict(list)
    for f in inbox_files:
        name = f.stem
        date_part = name.split("_")[0]
        by_date[date_part].append(f)
    
    today_str = datetime.now().strftime("%Y-%m-%d")
    
    for date_str, files in by_date.items():
        print(f"  处理日期 {date_str}: {len(files)} 条记录")
        
        # 合并内容
        all_content = []
        all_tags = Counter()
        conversations = []
        
        for f in files:
            fm = read_frontmatter(f)
            body = extract_content(f)
            tags = fm.get("tags", [])
            if isinstance(tags, str):
                tags = [tags]
            all_tags.update(tags)
            conversations.append({
                "role": fm.get("role", "unknown"),
                "content": body,
                "time": fm.get("time", "??:??"),
                "session": fm.get("session_id", "unknown"),
            })
            all_content.append(f"[{fm.get('role','')}] {body[:200]}")
        
        # 生成今日日志
        month_dir = get_today_dir()
        log_path = month_dir / f"{date_str}.md"
        
        top_tags = [t for t, _ in all_tags.most_common(10)]
        
        log_fm = {
            "type": "daily-log",
            "date": date_str,
            "month": date_str[:7],
            "created": datetime.now().isoformat(),
            "conversationCount": len(conversations),
            "topics": top_tags,
            "tags": top_tags,
        }
        
        lines = ["---"]
        for k, v in log_fm.items():
            if isinstance(v, list):
                lines.append(f"{k}: {', '.join(f'"{x}"' for x in v)}")
            else:
                lines.append(f"{k}: {v}")
        lines.append("---")
        
        conv_lines = []
        for c in conversations:
            preview = c["content"][:300].replace("\n", " ")
            conv_lines.append(f"- **{c['role']}** ({c['time']}): {preview}")
        
        log_body = f"""# 📅 每日日志 {date_str}

> 生成时间: {datetime.now().strftime('%Y-%m-%d %H:%M')}
> 对话数量: {len(conversations)}

## 对话记录

{chr(10).join(conv_lines)}

## 今日主题 (Top {len(top_tags)})

{', '.join(f'[[{t}]]' for t in top_tags)}

## 自动整理标记

- [x] 已提取主题标签
- [x] 已创建主题关联
- [ ] 待归档检查

---
*由 AI 知识库系统自动生成*
"""
        log_path.write_text("\n".join(lines) + "\n\n" + log_body, encoding="utf-8")
        stats["moved_to_daily"] += len(files)
        
        # 2.3 为 Top 标签创建/更新主题笔记
        for tag in top_tags[:5]:
            tag_slug = slugify(tag)
            topic_path = TOPICS / f"{tag_slug}.md"
            
            existing_fm = read_frontmatter(topic_path) if topic_path.exists() else {}
            
            new_related_count = existing_fm.get("conversationCount", 0) + 1
            
            topic_fm = {
                "type": "topic",
                "created": existing_fm.get("created", date_str),
                "aliases": [tag],
                "related": existing_fm.get("related", []),
                "conversationCount": new_related_count,
                "lastUpdated": datetime.now().strftime("%Y-%m-%d"),
            }
            
            t_lines = ["---"]
            for k, v in topic_fm.items():
                if isinstance(v, list):
                    t_lines.append(f"{k}: {', '.join(f'\"{x}\"' for x in v)}")
                else:
                    t_lines.append(f"{k}: {v}")
            t_lines.append("---")
            
            topic_body = f"""# 📂 {tag}

> 主题分类笔记 - 最后更新: {datetime.now().strftime('%Y-%m-%d %H:%M')}
> 相关对话数: {new_related_count}

## 概述

这是关于 **{tag}** 的知识积累，来自 DeepSeek Harness 对话记录。

## 关键要点

- 每日对话中涉及此主题的内容被自动归类
- 关联日记: [{date_str}](../01-Daily/{date_str}.md)
- 更多对话可通过[[{tag}|主题索引]]查询

## 相关日记

- [{date_str}](../01-Daily/{date_str}.md)

## 关联资源

-

---
*此笔记由 AI 自动整理生成*
"""
            topic_path.write_text("\n".join(t_lines) + "\n\n" + topic_body, encoding="utf-8")
            stats["created_topics"] += 1 if not existing_fm else 0
        
        # 2.4 归档已处理的 Inbox 文件
        for f in files:
            archive_date = ARCHIVE / "inbox" / datetime.now().strftime("%Y-%m")
            archive_date.mkdir(parents=True, exist_ok=True)
            dest = archive_date / f.name
            if not dest.exists():
                shutil.move(str(f), str(dest))
            stats["processed"] += 1
    
    # 2.5 更新总索引
    update_moc(stats)
    
    # 2.6 更新统计
    update_stats(stats)
    
    print(f"  ✓ 整理完成: {stats}")
    return stats

def update_moc(stats: dict):
    """更新 MOC 总索引"""
    moc_path = KB_ROOT / "00-索引-MOC.md"
    daily_files = list(DAILY.rglob("*.md"))
    
    today_str = datetime.now().strftime("%Y-%m-%d")
    
    # 收集今日话题
    today_entries = []
    for f in sorted(daily_files, key=lambda x: x.stat().st_mtime, reverse=True)[:20]:
        fm = read_frontmatter(f)
        date = fm.get("date", f.stem)
        count = fm.get("conversationCount", "?")
        topics_raw = fm.get("topics", [])
        if isinstance(topics_raw, str):
            topics = topics_raw[:60]
        elif isinstance(topics_raw, list):
            topics = ", ".join(topics_raw)[:60]
        else:
            topics = ""
        today_entries.append(f"- [[{date}|{date}]] — {count}条对话 | {topics}")
    
    # 活跃主题
    topic_files = list(TOPICS.glob("*.md"))
    topic_entries = []
    for f in sorted(topic_files, key=lambda x: x.stat().st_mtime, reverse=True)[:10]:
        name = f.stem.replace("-", " ")
        topic_entries.append(f"- [[{name}|{name}]]")
    
    body = f"""# 知识库总索引 (MOC)

> 最后整理: {datetime.now().strftime('%Y-%m-%d %H:%M')} | 文件总数: {len(daily_files)+len(topic_files)} | 对话数: {stats.get('moved_to_daily',0)}

## 目录结构

| 文件夹 | 用途 |
|--------|------|
| `00-Inbox` | 待整理的新内容 |
| `01-Daily` | 每日对话日志 |
| `02-Topics` | 主题分类笔记 |
| `03-Projects` | 项目相关笔记 |
| `04-Archive` | 归档内容 |
| `templates` | 笔记模板 |
| `_meta` | 元数据（统计、索引） |
| `assets` | 图片等资源 |

## 今日对话

| 日期 | 对话数 | 主题 |
|------|--------|------|
"""
    for e in today_entries[:10]:
        parts = e.replace("- ", "").split(" — ")
        date = parts[0].replace("[[", "").replace("|", " ").replace("]]", "")
        rest = parts[1] if len(parts) > 1 else ""
        body += f"| {date} | {rest} |\n"
    
    body += f"""
## 最近活跃主题 (Top 10)

{chr(10).join(topic_entries)}

## 统计

- 每日日志: {len(daily_files)} 篇
- 主题笔记: {len(topic_files)} 个
- 本次整理: 处理 {stats.get('processed',0)} 条，创建/更新 {stats.get('created_topics',0)} 个主题

---

**自动整理说明：**
- 每小时自动执行整理任务
- 对话记录实时写入 `00-Inbox`，整理后归入 `01-Daily`
- 主题标签自动提取并创建 `02-Topics` 下的关联笔记
- 每月末尾归档旧内容到 `04-Archive`
"""
    moc_path.write_text(body, encoding="utf-8")

def update_stats(stats: dict):
    """更新统计文件"""
    stat_path = META / "stats.json"
    history = []
    if stat_path.exists():
        try:
            data = json.loads(stat_path.read_text())
            # 兼容旧格式（对象）和新格式（数组）
            if isinstance(data, dict):
                if "stats" in data and isinstance(data["stats"], list):
                    history = data["stats"]
            elif isinstance(data, list):
                history = data
        except:
            history = []
    history.append({
        "time": datetime.now().isoformat(),
        "action": stats.get("action", "maintain"),
        "processed": stats.get("processed", 0),
        "created_topics": stats.get("created_topics", 0),
        "moved_to_daily": stats.get("moved_to_daily", 0),
        "errors": stats.get("errors", 0),
    })
    # 只保留最近30条
    history = history[-30:]
    stat_path.write_text(json.dumps(history, ensure_ascii=False, indent=2), encoding="utf-8")

# ============== 步骤 3: 主入口 ==============
if __name__ == "__main__":
    import sys
    
    action = sys.argv[1] if len(sys.argv) > 1 else "maintain"
    
    if action == "log":
        # log <session_id> <role> <content_file>
        sid = sys.argv[2]
        role = sys.argv[3]
        cfile = sys.argv[4]
        content = Path(cfile).read_text(encoding="utf-8")
        model = sys.argv[5] if len(sys.argv) > 5 else "agts-devflash"
        f = log_conversation_to_inbox(sid, role, content, model)
        print(f"LOGGED:{f}")
    
    elif action == "maintain":
        stats = hourly_maintenance()
        print(f"MAINTENANCE_DONE:{json.dumps(stats)}")
    
    elif action == "init":
        # 初始化空库
        for d in [INBOX, DAILY, TOPICS, PROJECTS, ARCHIVE, META, TEMPLATES, ASSETS]:
            d.mkdir(parents=True, exist_ok=True)
        (ARCHIVE / "inbox").mkdir(parents=True, exist_ok=True)
        (META / "stats.json").write_text("[]", encoding="utf-8")
        print("INITIALIZED")
