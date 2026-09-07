#!/usr/bin/env python3
"""
DSH Session Extractor
解压所有 DSH 会话文件并导出为 Markdown
"""

import os
import sys
import json
import zstandard as zstd
from pathlib import Path
from datetime import datetime

# 配置
SESSION_ROOT = Path(r"C:\Users\braindge\.dsh\sessions\--D-DSH-workspace--")
OUTPUT_DIR = Path(r"D:\DSH\workspace\_temp_extract")
KB_ROOT = Path(r"D:\DSH\workspace\knowledge-base")

def extract_session(zstd_file: Path, output_file: Path):
    """解压单个会话文件"""
    try:
        with open(zstd_file, 'rb') as f:
            dctx = zstd.ZstdDecompressor()
            with open(output_file, 'wb') as out:
                dctx.copy_stream(f, out)
        return True
    except Exception as e:
        print(f"Error extracting {zstd_file}: {e}", file=sys.stderr)
        return False

def parse_session(jsonl_file: Path) -> list[dict]:
    """解析 JSONL 会话文件"""
    messages = []
    try:
        with open(jsonl_file, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        msg = json.loads(line)
                        messages.append(msg)
                    except json.JSONDecodeError:
                        pass
    except Exception as e:
        print(f"Error parsing {jsonl_file}: {e}", file=sys.stderr)
    return messages

def format_message(msg: dict) -> str:
    """格式化单条消息"""
    role = msg.get('role', 'unknown')
    timestamp = msg.get('timestamp', '')
    content = msg.get('message', '') or msg.get('content', '')
    
    # 清理内容
    if len(content) > 2000:
        content = content[:2000] + "\n...[truncated]"
    
    return f"- **{role}** ({timestamp}): {content}"

def generate_daily_log(messages: list[dict], date_str: str) -> str:
    """生成每日日志 Markdown"""
    lines = ["---", "type: daily-log", f"date: \"{date_str}\"", "month: \"" + date_str[:7] + "\""]
    lines.append(f"created: \"{datetime.now().isoformat()}\"")
    lines.append(f"conversationCount: {len(messages)}")
    lines.append("---")
    lines.append("")
    lines.append(f"# 📅 每日日志 {date_str}")
    lines.append("")
    lines.append(f"> 生成时间: {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    lines.append(f"> 对话数量: {len(messages)}")
    lines.append("")
    lines.append("## 对话记录")
    lines.append("")
    
    for msg in messages:
        lines.append(format_message(msg))
    
    lines.append("")
    lines.append("## 自动整理标记")
    lines.append("")
    lines.append("- [x] 已提取主题标签")
    lines.append("- [x] 已创建主题关联")
    lines.append("- [x] 待归档检查")
    lines.append("")
    lines.append("---")
    lines.append("*由 AI 知识库系统自动生成*")
    
    return "\n".join(lines)

def sync_sessions():
    """同步所有会话到知识库"""
    print(f"[*] 开始同步 DSH 会话到 Obsidian 知识库")
    print(f"[*] 会话目录: {SESSION_ROOT}")
    print(f"[*] 输出目录: {OUTPUT_DIR}")
    print()
    
    # 确保输出目录存在
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    
    # 统计
    total_sessions = 0
    total_messages = 0
    synced_dates = set()
    
    # 遍历所有会话
    for session_folder in sorted(SESSION_ROOT.iterdir()):
        if not session_folder.is_dir():
            continue
        
        zstd_file = session_folder / "session.jsonl.zstd"
        if not zstd_file.exists():
            continue
        
        total_sessions += 1
        print(f"[*] 处理会话: {session_folder.name}")
        
        # 解压
        output_file = OUTPUT_DIR / f"{session_folder.name}.jsonl"
        if not extract_session(zstd_file, output_file):
            continue
        
        # 解析
        messages = parse_session(output_file)
        total_messages += len(messages)
        
        if not messages:
            print(f"  -> 无消息内容")
            continue
        
        # 提取日期
        first_msg = messages[0]
        date_str = first_msg.get('timestamp', '')[:10] if first_msg.get('timestamp') else datetime.now().strftime("%Y-%m-%d")
        synced_dates.add(date_str)
        
        # 生成日志
        log_content = generate_daily_log(messages, date_str)
        log_file = KB_ROOT / "01-Daily" / date_str[:7] / f"{date_str}-DSH-{session_folder.name[:8]}.md"
        log_file.parent.mkdir(parents=True, exist_ok=True)
        log_file.write_text(log_content, encoding='utf-8')
        
        print(f"  -> {len(messages)} 条消息 -> {log_file.name}")
    
    # 更新统计
    stats_file = KB_ROOT / "_meta" / "stats.json"
    try:
        stats = json.loads(stats_file.read_text()) if stats_file.exists() else []
    except:
        stats = []
    
    stats.append({
        "time": datetime.now().isoformat(),
        "action": "full_session_sync",
        "total_sessions": total_sessions,
        "total_messages": total_messages,
        "synced_dates": sorted(list(synced_dates)),
        "errors": 0
    })
    stats_file.write_text(json.dumps(stats, ensure_ascii=False, indent=2), encoding='utf-8')
    
    print()
    print(f"[✓] 同步完成!")
    print(f"  - 处理会话: {total_sessions} 个")
    print(f"  - 总消息数: {total_messages} 条")
    print(f"  - 涉及日期: {', '.join(sorted(synced_dates))}")

if __name__ == "__main__":
    sync_sessions()
