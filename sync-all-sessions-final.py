#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
DSH Full Session Sync Script - Final Version
将DeepSeek Harness中的所有会话同步到Obsidian知识库
支持 v3, v2, 旧版三种格式
"""

import os
import sys
import json
import re
from pathlib import Path
from datetime import datetime
from collections import defaultdict

# Fix Windows console encoding
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

try:
    import zstandard as zstd
except ImportError:
    print("Error: zstandard module not installed", file=sys.stderr)
    sys.exit(1)

# Configuration
SESSION_ROOT = Path(r"C:\Users\braindge\.dsh\sessions\--D-DSH-workspace--")
KB_ROOT = Path(r"D:\DSH\workspace\knowledge-base")
DAILY_DIR = KB_ROOT / "01-Daily"
ARCHIVE_DIR = KB_ROOT / "04-Archive"
META_DIR = KB_ROOT / "_meta"

# Topic detection keywords
TOPIC_RULES = {
    "知识库搭建": ["知识库", "obsidian", "moc", "索引", "daily-log", "kb-maintain", "同步"],
    "插件安装调试": ["插件", "plugin", "cordis", "dsh-conversation-language", "安装"],
    "npm发布": ["npm", "release", "github release", "版本发布", "package.json"],
    "同步自动化": ["同步", "sync", "自动化", "定时任务", "schtasks", "vbs", "hourly"],
    "Agent/Preset": ["agent", "preset", "agent preset", "conversation language"],
    "问题排查": ["错误", "error", "bug", "排查", "故障", "duplicate", "bom", "syntaxerror", "乱码"],
    "会话管理": ["会话", "session", "对话记录", "总结"],
    "系统介绍": ["介绍", "自我介绍", "deepseek harness", "agnes"],
    "版本更新": ["更新", "upgrade", "version", "rc", "alpha"],
}


def decompress_zstd(input_path: Path, output_path: Path) -> bool:
    """Decompress zstd file"""
    try:
        with open(input_path, 'rb') as f_in:
            dctx = zstd.ZstdDecompressor()
            with open(output_path, 'wb') as f_out:
                dctx.copy_stream(f_in, f_out)
        return True
    except Exception as e:
        print(f"  Decompress failed: {e}", file=sys.stderr)
        return False


def parse_jsonl(content: str) -> list:
    """Parse JSONL content"""
    messages = []
    for line in content.strip().split('\n'):
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
            messages.append(msg)
        except json.JSONDecodeError:
            continue
    return messages


def extract_text_from_content(content_list: list) -> str:
    """Extract text from content array (handles v3 format)"""
    if not isinstance(content_list, list):
        return str(content_list) if content_list else ''
    
    texts = []
    for item in content_list:
        if isinstance(item, dict):
            if item.get('type') == 'text':
                texts.append(item.get('text', ''))
            elif item.get('type') == 'reasoning':
                pass  # Skip reasoning for summary
        elif isinstance(item, str):
            texts.append(item)
    return ' '.join(texts).strip()


def get_session_date(messages: list) -> str:
    """Extract session date from messages"""
    for msg in messages:
        if msg.get('type') == 'session':
            created_ts = msg.get('createdAt', '')
            if created_ts:
                try:
                    return datetime.fromtimestamp(int(created_ts) / 1000).strftime('%Y-%m-%d')
                except:
                    pass
        if 'time' in msg:
            ts = msg['time']
            if isinstance(ts, (int, float)) and ts > 1000000000:
                try:
                    return datetime.fromtimestamp(ts / 1000 if ts > 1000000000000 else ts).strftime('%Y-%m-%d')
                except:
                    pass
    return datetime.now().strftime('%Y-%m-%d')


def extract_v3_data(file_path: Path) -> dict:
    """Extract v3 format session data"""
    temp_file = file_path.with_suffix('.jsonl')
    if not decompress_zstd(file_path, temp_file):
        return None

    try:
        content = temp_file.read_text(encoding='utf-8', errors='replace')
        messages = parse_jsonl(content)

        created = get_session_date(messages)

        # Extract user messages
        user_msgs = [m for m in messages if m.get('type') == 'user/message']
        assistant_msgs = [m for m in messages if m.get('type') == 'assistant/message']
        tool_calls = [m for m in messages if m.get('type') == 'tool/call']

        conversation = []
        for msg in user_msgs:
            data = msg.get('data', {})
            content_list = data.get('content', [])
            text = extract_text_from_content(content_list)
            if text:
                conversation.append({'role': 'user', 'content': text, 'time': msg.get('time', '')})

        for msg in assistant_msgs:
            data = msg.get('data', {})
            message_data = data.get('message', {})
            content_list = message_data.get('content', [])
            text = extract_text_from_content(content_list)
            if text:
                conversation.append({'role': 'assistant', 'content': text, 'time': msg.get('time', '')})

        temp_file.unlink(missing_ok=True)
        return {
            'conversation': conversation,
            'created': created,
            'user_count': len(user_msgs),
            'assistant_count': len(assistant_msgs),
            'tool_count': len(tool_calls),
            'title': user_msgs[0].get('data', {}).get('content', [[{}]])[0].get('text', '')[:50] if user_msgs else 'Untitled',
        }
    except Exception as e:
        print(f"  Parse failed: {e}", file=sys.stderr)
        temp_file.unlink(missing_ok=True)
        return None


def extract_v2_data(file_path: Path) -> dict:
    """Extract v2 format session data"""
    temp_file = file_path.with_suffix('.jsonl')
    if not decompress_zstd(file_path, temp_file):
        return None

    try:
        content = temp_file.read_text(encoding='utf-8', errors='replace')
        messages = parse_jsonl(content)

        created = get_session_date(messages)

        # V2 format also uses user/message and assistant/message types
        user_msgs = [m for m in messages if m.get('type') == 'user/message']
        assistant_msgs = [m for m in messages if m.get('type') == 'assistant/message']

        conversation = []
        for msg in user_msgs:
            data = msg.get('data', {})
            content_list = data.get('content', [])
            text = extract_text_from_content(content_list)
            if text:
                conversation.append({'role': 'user', 'content': text, 'time': msg.get('time', '')})

        for msg in assistant_msgs:
            data = msg.get('data', {})
            message_data = data.get('message', {})
            content_list = message_data.get('content', [])
            text = extract_text_from_content(content_list)
            if text:
                conversation.append({'role': 'assistant', 'content': text, 'time': msg.get('time', '')})

        temp_file.unlink(missing_ok=True)
        return {
            'conversation': conversation,
            'created': created,
            'user_count': len(user_msgs),
            'assistant_count': len(assistant_msgs),
            'tool_count': len([m for m in messages if m.get('type') == 'tool/call']),
            'title': user_msgs[0].get('data', {}).get('content', [[{}]])[0].get('text', '')[:50] if user_msgs else 'Untitled',
        }
    except Exception as e:
        print(f"  Parse failed: {e}", file=sys.stderr)
        temp_file.unlink(missing_ok=True)
        return None


def extract_old_data(file_path: Path) -> dict:
    """Extract old format session data"""
    temp_file = file_path.with_suffix('.jsonl')
    if not decompress_zstd(file_path, temp_file):
        return None

    try:
        content = temp_file.read_text(encoding='utf-8', errors='replace')
        messages = parse_jsonl(content)

        created = datetime.now().strftime('%Y-%m-%d')
        for msg in messages:
            ts = msg.get('timestamp', '')
            if ts:
                created = ts[:10]
                break

        user_msgs = [m for m in messages if m.get('role') == 'user']
        assistant_msgs = [m for m in messages if m.get('role') == 'assistant']

        conversation = []
        for msg in user_msgs:
            content = msg.get('message', '') or msg.get('content', '')
            if content:
                conversation.append({'role': 'user', 'content': str(content), 'time': msg.get('timestamp', '')})
        for msg in assistant_msgs:
            content = msg.get('message', '') or msg.get('content', '')
            if content:
                conversation.append({'role': 'assistant', 'content': str(content), 'time': msg.get('timestamp', '')})

        temp_file.unlink(missing_ok=True)
        return {
            'conversation': conversation,
            'created': created,
            'user_count': len(user_msgs),
            'assistant_count': len(assistant_msgs),
            'tool_count': 0,
            'title': user_msgs[0].get('message', '')[:50] if user_msgs else 'Untitled',
        }
    except Exception as e:
        print(f"  Parse failed: {e}", file=sys.stderr)
        temp_file.unlink(missing_ok=True)
        return None


def detect_topics(conversation: list) -> list:
    """Detect topics from conversation content"""
    topics = []
    combined = ' '.join([m.get('content', '') for m in conversation]).lower()

    for topic, keywords in TOPIC_RULES.items():
        if any(kw.lower() in combined for kw in keywords):
            topics.append(topic)

    return topics if topics else ["其他"]


def generate_summary_md(session_id: str, data: dict, topics: list, output_path: Path):
    """Generate session summary Markdown"""
    created = data.get('created', datetime.now().strftime('%Y-%m-%d'))
    title = data.get('title', 'Untitled')[:50]
    user_count = data.get('user_count', 0)
    assistant_count = data.get('assistant_count', 0)
    tool_count = data.get('tool_count', 0)
    conversation = data.get('conversation', [])

    lines = [
        '---',
        'type: session-summary',
        f'date: "{created}"',
        f'month: "{created[:7]}"',
        f'created: "{datetime.now().isoformat()}"',
        f'session_id: "{session_id}"',
        f'conversationCount: {user_count}',
        f'messageCount: {user_count + assistant_count}',
        f'toolCalls: {tool_count}',
        f'topics: {json.dumps(topics, ensure_ascii=False)}',
        '---',
        '',
        f'# DSH Session Summary {created}',
        '',
        f'> **Session ID**: `{session_id}`',
        f'> **Created**: {created}',
        f'> **Conversations**: {user_count} turns | **Messages**: {user_count + assistant_count} | **Tools**: {tool_count}',
        '',
        '## Summary',
        '',
        f'This session contains {user_count} conversation turns. Topics: {", ".join(topics)}.',
        '',
        '## Key Conversations',
        '',
    ]

    # Add key Q&A pairs (limit to first 5 exchanges)
    qa_pairs = []
    for i in range(0, len(conversation) - 1, 2):
        if conversation[i].get('role') == 'user' and conversation[i + 1].get('role') == 'assistant':
            qa_pairs.append((conversation[i], conversation[i + 1]))
    
    for i, (q, a) in enumerate(qa_pairs[:5], 1):
        q_content = q.get('content', '')[:150].replace('\n', ' ')
        a_content = a.get('content', '')[:300].replace('\n', ' ')
        lines.append(f"### Q{i}: {q_content}...")
        lines.append('')
        lines.append(f"**A{i}**: {a_content}...")
        lines.append('')

    lines.extend([
        '## Statistics',
        '',
        '| Metric | Value |',
        '|--------|-------|',
        f"| Conversations | {user_count} |",
        f"| Messages | {user_count + assistant_count} |",
        f"| Tool Calls | {tool_count} |",
        '',
        '## Topics',
        '',
        ''.join([f'[[{t}]], ' for t in topics]),
        '',
        '---',
        '*Generated by DSH Knowledge Base System*',
    ])

    output_path.write_text('\n'.join(lines), encoding='utf-8')


def sync_all_sessions():
    """Sync all sessions to knowledge base"""
    print("=" * 60)
    print("DSH Full Session Sync")
    print("=" * 60)
    print(f"Session directory: {SESSION_ROOT}")
    print(f"Knowledge base: {KB_ROOT}")
    print()

    if not SESSION_ROOT.exists():
        print(f"Error: Session directory not found: {SESSION_ROOT}")
        return

    stats = {
        'total_sessions': 0,
        'total_messages': 0,
        'total_tools': 0,
        'synced_dates': set(),
        'errors': 0,
    }

    session_dirs = sorted(SESSION_ROOT.iterdir(), key=lambda x: x.name)

    for session_dir in session_dirs:
        if not session_dir.is_dir():
            continue

        session_id = session_dir.name
        stats['total_sessions'] += 1

        print(f"\n[*] Processing: {session_id[:20]}...")

        # Find available files
        v3_file = session_dir / "session.v3.jsonl.zstd"
        v2_file = session_dir / "session.v2.jsonl.zstd"
        old_file = session_dir / "session.jsonl.zstd"

        data = None
        fmt = None

        if v3_file.exists():
            fmt = "v3"
            data = extract_v3_data(v3_file)
        elif v2_file.exists():
            fmt = "v2"
            data = extract_v2_data(v2_file)
        elif old_file.exists():
            fmt = "old"
            data = extract_old_data(old_file)

        if data is None:
            print(f"  ! Cannot parse session")
            stats['errors'] += 1
            continue

        print(f"  -> Format: {fmt}")

        conversation = data.get('conversation', [])
        stats['total_messages'] += len(conversation)
        stats['total_tools'] += data.get('tool_count', 0)

        if not conversation:
            print(f"  -> No conversation content")
            continue

        created = data.get('created', datetime.now().strftime('%Y-%m-%d'))
        stats['synced_dates'].add(created)

        # Detect topics
        topics = detect_topics(conversation)

        # Generate summary file
        month_dir = DAILY_DIR / created[:7]
        month_dir.mkdir(parents=True, exist_ok=True)

        short_id = session_id.replace('session-', '')[:8]
        output_file = month_dir / f"{created}-DSH-{short_id}.md"

        # Check if already exists
        if output_file.exists():
            try:
                existing = output_file.read_text(encoding='utf-8')
                if f'session_id: "{session_id}"' in existing:
                    print(f"  -> Already exists, skipping")
                    continue
            except:
                pass

        print(f"  -> Generating: {output_file.name}")
        generate_summary_md(session_id, data, topics, output_file)

        # Write detailed conversation to inbox
        inbox_dir = ARCHIVE_DIR / "inbox" / created[:7]
        inbox_dir.mkdir(parents=True, exist_ok=True)

        inbox_lines = [
            '---',
            'type: conversation',
            f'created: "{created}"',
            f'session_id: "{session_id}"',
            f'topics: {json.dumps(topics, ensure_ascii=False)}',
            '---',
            '',
            f'# Conversation {created} - {data.get("title", "Session")[:40]}',
            '',
        ]

        for msg in conversation:
            role = msg.get('role', 'unknown')
            content = msg.get('content', '')
            if not content or len(content) < 5:
                continue
            if len(content) > 800:
                content = content[:800] + "..."
            content = content.replace('\n', ' ').strip()

            if role == 'user':
                inbox_lines.append(f"**User**: {content}")
            elif role == 'assistant':
                inbox_lines.append(f"**Assistant**: {content}")
            inbox_lines.append('')

        inbox_file = inbox_dir / f"{created}_{short_id}.md"
        inbox_file.write_text('\n'.join(inbox_lines), encoding='utf-8')

        print(f"  -> Inbox: {inbox_file.name}")

    # Print summary
    print("\n" + "=" * 60)
    print("Sync Complete!")
    print("=" * 60)
    print(f"Total sessions: {stats['total_sessions']}")
    print(f"Total messages: {stats['total_messages']:,}")
    print(f"Total tools: {stats['total_tools']:,}")
    print(f"Dates: {', '.join(sorted(stats['synced_dates']))}")
    print(f"Errors: {stats['errors']}")

    # Save stats
    stats_file = META_DIR / "stats.json"
    try:
        existing_stats = json.loads(stats_file.read_text()) if stats_file.exists() else []
    except:
        existing_stats = []

    existing_stats.append({
        "time": datetime.now().isoformat(),
        "action": "full_sync_all_sessions",
        "total_sessions": stats['total_sessions'],
        "total_messages": stats['total_messages'],
        "total_tools": stats['total_tools'],
        "synced_dates": sorted(list(stats['synced_dates'])),
        "errors": stats['errors'],
    })
    stats_file.write_text(json.dumps(existing_stats, ensure_ascii=False, indent=2), encoding='utf-8')

    return stats


if __name__ == "__main__":
    sync_all_sessions()
