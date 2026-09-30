#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
DSH Full Session Sync v2 (multi-root, v2/v3/v4 formats, zstd stream reader)

Scans all configured DSH roots (e.g. C:\\Users\\braindge\\.dsh, .dsh_, .dsh__, .dsh___)
and syncs every session into the knowledge base:
  - 01-Daily/<YYYY-MM>/<date>-DSH-<short_id>.md   (summary + key Q&A)
  - 04-Archive/inbox/<YYYY-MM>/<date>_<short_id>.md (truncated full conversation)

Session files are multi-frame zstd streams; we decompress with the zstandard
stream_reader and parse JSONL events (type: session, user/message,
assistant/message, session/title, ...).
"""

import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

import zstandard as zstd

# ---------------------------------------------------------------- config
SESSION_ROOTS = [
    Path(r"C:\Users\braindge\.dsh\sessions"),
    Path(r"C:\Users\braindge\.dsh_\sessions"),
    Path(r"C:\Users\braindge\.dsh__\sessions"),
    Path(r"C:\Users\braindge\.dsh___\sessions"),
]
KB_ROOT = Path(r"D:\DSH\workspace\knowledge-base")
DAILY_DIR = KB_ROOT / "01-Daily"
ARCHIVE_DIR = KB_ROOT / "04-Archive"
META_DIR = KB_ROOT / "_meta"

# user-facing content truncation limits
QA_USER_MAX = 150
QA_ASSISTANT_MAX = 300
INBOX_MSG_MAX = 800
INBOX_MSG_SKIP_MIN = 5

# synthetic user events to skip (not real user prompts)
SKIP_USER_PATTERNS = [
    re.compile(r"^The approval policy changed"),
    re.compile(r"^The sandbox mode changed"),
    re.compile(r"^The current permission preset"),
]
# secret redaction (GitHub token patterns etc.)
SECRET_RE = re.compile(
    r"(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{12,}"
)
def redact_secret(text: str) -> str:
    return SECRET_RE.sub("[REDACTED-TOKEN]", text)

# topic detection keywords (reuse existing KB convention)
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
    "RPA/自动化开发": ["rpa", "爬虫", "webui", "flow", "excel 自动化"],
    "DeepSeek Harness 开发": ["deepseek harness", "dsh", "hmr", "web gui", "vite"],
}


def read_zstd_stream(fp: Path) -> bytes:
    """Decompress a (possibly multi-frame) zstd file via stream_reader."""
    dctx = zstd.ZstdDecompressor()
    out = b""
    with open(fp, "rb") as f:
        reader = dctx.stream_reader(f, closefd=False)
        while True:
            chunk = reader.read(1 << 16)
            if not chunk:
                break
            out += chunk
    return out


def parse_jsonl(text: str):
    parsed = []
    unparsable = 0
    for line in text.split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            parsed.append(json.loads(line))
        except json.JSONDecodeError:
            unparsable += 1
    return parsed, unparsable


def text_of(content) -> str:
    """Extract plain text from an assistant/user content array (skip reasoning)."""
    if not isinstance(content, list):
        return str(content).strip() if content else ""
    parts = []
    for item in content:
        if isinstance(item, dict):
            t = item.get("type")
            if t == "text" and item.get("text"):
                parts.append(item["text"])
            # tool-call / reasoning / other: skip
        elif isinstance(item, str):
            parts.append(item)
    return " ".join(p.strip() for p in parts if p and p.strip()).strip()


def is_synthetic_user(text: str) -> bool:
    return any(p.search(text) for p in SKIP_USER_PATTERNS)


def session_date(parsed, fallback: str) -> str:
    for j in parsed:
        if j.get("type") == "session":
            ts = j.get("createdAt")
            if isinstance(ts, (int, float)):
                try:
                    return datetime.fromtimestamp(ts / 1000).strftime("%Y-%m-%d")
                except Exception:
                    pass
            break
    return fallback


def extract_session(fp: Path, session_dir_name: str, preset_hint: str = "") -> dict | None:
    """Parse one session file. Returns dict or None."""
    raw = read_zstd_stream(fp)
    parsed, unparsable = parse_jsonl(raw.decode("utf-8", "replace"))
    if not parsed:
        return None

    created = session_date(parsed, datetime.now().strftime("%Y-%m-%d"))

    # title: prefer LLM-generated session/title (non-fallback), then first genuine user message
    title = ""
    title_source = "fallback"
    for j in parsed:
        if j.get("type") == "session/title":
            t = j.get("data", {})
            if isinstance(t, dict):
                cand = t.get("title") or t.get("text") or ""
                src = (t.get("source") or {}).get("kind", "fallback")
            else:
                cand = str(t)
                src = "fallback"
            if cand.strip():
                title = cand.strip()
                title_source = src
                break
    if not title:
        for j in parsed:
            if j.get("type") == "user/message":
                data = j.get("data", {})
                txt = text_of(data.get("content", []))
                if txt and not is_synthetic_user(txt):
                    title = txt
                    title_source = "fallback"
                    break
    if not title:
        title = "(无标题)"
        title_source = "fallback"

    user_msgs = [j for j in parsed if j.get("type") == "user/message"]
    assistant_msgs = [j for j in parsed if j.get("type") == "assistant/message"]
    tool_calls = [j for j in parsed if j.get("type") == "tool/call"]

    # build conversation, skipping synthetic plugin/user-approval lines
    conversation = []
    for j in user_msgs:
        txt = text_of(j.get("data", {}).get("content", []))
        if txt and not is_synthetic_user(txt):
            conversation.append({"role": "user", "content": redact_secret(txt), "time": j.get("time", "")})
    for j in assistant_msgs:
        msg = j.get("data", {}).get("message", {})
        txt = text_of(msg.get("content", []))
        if txt:
            conversation.append({"role": "assistant", "content": redact_secret(txt), "time": j.get("time", "")})

    return {
        "file": fp,
        "session_id": session_dir_name,
        "title": redact_secret(title),
        "title_source": title_source,
        "created": created,
        "conversation": conversation,
        "user_count": len([c for c in conversation if c["role"] == "user"]),
        "assistant_count": len([c for c in conversation if c["role"] == "assistant"]),
        "tool_count": len(tool_calls),
        "unparsable": unparsable,
    }


def detect_topics(conversation) -> list:
    topics = []
    combined = " ".join(c.get("content", "") for c in conversation).lower()
    for topic, kws in TOPIC_RULES.items():
        if any(kw.lower() in combined for kw in kws):
            topics.append(topic)
    return topics or ["其他"]


def clean_filename(s: str, max_len: int = 40) -> str:
    s = re.sub(r'[\\/:*?"<>|]', "_", s).strip()
    s = re.sub(r"\s+", " ", s)
    return (s or "untitled")[:max_len].strip()

def title_display(title: str, preset: str, cwd: str) -> str:
    """Use LLM title when available (source != fallback); else build a clean fallback name."""
    # caller sets data['title_source']; here we just format
    pass


def qa_pairs(conversation, limit: int = 5):
    pairs = []
    i = 0
    while i < len(conversation) - 1 and len(pairs) < limit:
        if conversation[i]["role"] == "user" and conversation[i + 1]["role"] == "assistant":
            pairs.append((conversation[i], conversation[i + 1]))
            i += 2
        else:
            i += 1
    return pairs


def write_summary(session_id: str, data: dict, topics: list, out_path: Path, preset: str, cwd: str, root: str):
    created = data["created"]
    title = clean_filename(redact_secret(data["title"]), 60)
    user_count = data["user_count"]
    assistant_count = data["assistant_count"]
    tool_count = data["tool_count"]
    conversation = data["conversation"]

    now = datetime.now().isoformat()
    lines = [
        "---",
        "type: session-summary",
        f'date: "{created}"',
        f'month: "{created[:7]}"',
        f'created: "{now}"',
        f'session_id: "{session_id}"',
        f'conversationCount: {user_count}',
        f'messageCount: {user_count + assistant_count}',
        f'toolCalls: {tool_count}',
        f'topics: {json.dumps(topics, ensure_ascii=False)}',
        f'synced: true',
        "---",
        "",
        f'# DSH Session {created} - {title}',
        "",
        f'> **Session ID**: `{session_id}`',
        f'> **Created**: {created}',
        f'> **Conversations**: {user_count} turns | **Messages**: {user_count + assistant_count} | **Tools**: {tool_count}',
        f'> **Source**: `{root}` | **CWD**: `{cwd}` | **Preset**: `{preset or "n/a"}`',
        "",
        "## Summary",
        "",
        f"该会话共 {user_count} 轮用户对话、{assistant_count} 条助手消息、{tool_count} 次工具调用。主题：{', '.join(topics)}。",
        "",
        "## 关键对话",
        "",
    ]
    if not conversation:
        lines.append("_（本会话无真实用户对话内容）_")
    for i, (q, a) in enumerate(qa_pairs(conversation, 5), 1):
        qc = q["content"].replace("\n", " ")[:QA_USER_MAX]
        ac = a["content"].replace("\n", " ")[:QA_ASSISTANT_MAX]
        lines.append(f"### Q{i}: {qc}...")
        lines.append("")
        lines.append(f"**A{i}**: {ac}...")
        lines.append("")
    lines.extend([
        "## Statistics",
        "",
        "| 指标 | 值 |",
        "|------|-----|",
        f"| 对话轮数 | {user_count} |",
        f"| 消息数 | {user_count + assistant_count} |",
        f"| 工具调用 | {tool_count} |",
        "",
        "## Topics",
        "",
        " ".join(f"[[{t}]], " for t in topics).rstrip(", "),
        "",
        "---",
        "*Generated by DSH Knowledge Base System*",
    ])
    out_path.write_text("\n".join(lines), encoding="utf-8")


def write_inbox(session_id: str, data: dict, topics: list, out_path: Path, preset: str, cwd: str, root: str):
    created = data["created"]
    conversation = data["conversation"]
    now = datetime.now().isoformat()
    lines = [
        "---",
        "type: conversation",
        f'created: "{created}"',
        f'session_id: "{session_id}"',
        f'topics: {json.dumps(topics, ensure_ascii=False)}',
        f'synced: true',
        "---",
        "",
        f'# Conversation {created} - {clean_filename(redact_secret(data["title"]), 40)}',
        "",
        f"> 来源：`{root}` | CWD：`{cwd}` | Preset：`{preset or 'n/a'}`",
        "",
    ]
    tu = data.get("token_usage")
    if isinstance(tu, dict) and tu.get("totals"):
        tot = tu["totals"]
        lines.append(f"> 累计 Token：输入 {tot.get('uncachedInputTokens', 0):,} / 输出 {tot.get('outputTokens', 0):,} / 缓存读 {tot.get('cacheReadTokens', 0):,}")
        lines.append("")
    for msg in conversation:
        content = msg["content"].strip()
        if not content or len(content) < INBOX_MSG_SKIP_MIN:
            continue
        if len(content) > INBOX_MSG_MAX:
            content = content[:INBOX_MSG_MAX] + "..."
        content = content.replace("\n", " ")
        if msg["role"] == "user":
            lines.append(f"**User**: {content}")
        else:
            lines.append(f"**Assistant**: {content}")
        lines.append("")
    out_path.write_text("\n".join(lines), encoding="utf-8")


def collect_sessions():
    """Yield (session_dir, session_file, root) tuples."""
    for root in SESSION_ROOTS:
        if not root.is_dir():
            print(f"[!] root not found: {root}")
            continue
        for proj_dir in sorted(root.iterdir()):
            if not proj_dir.is_dir():
                continue
            for sdir in sorted(proj_dir.iterdir()):
                if not sdir.is_dir() or not sdir.name.startswith("session-"):
                    continue
                for candidate in ("session.v4.jsonl.zstd", "session.v3.jsonl.zstd",
                                  "session.v2.jsonl.zstd", "session.jsonl.zstd"):
                    fp = sdir / candidate
                    if fp.exists():
                        yield sdir, fp, root, proj_dir.name
                        break


def main():
    print("=" * 60)
    print("DSH Full Session Sync v2 (multi-root, zstd stream)")
    print("=" * 60)
    for r in SESSION_ROOTS:
        print(f"  root: {r}")
    print()

    stats = {"total": 0, "ok": 0, "no_content": 0, "errors": 0, "skipped": 0,
             "total_messages": 0, "total_tools": 0, "dates": set(), "new_files": []}

    for sdir, fp, root, proj in collect_sessions():
        stats["total"] += 1
        short_id = sdir.name.replace("session-", "")[:8]
        print(f"[*] {root.name}\\{proj}\\{sdir.name} -> {fp.name}")
        try:
            data = extract_session(fp, sdir.name)
        except Exception as e:
            print(f"    ! error: {e}")
            stats["errors"] += 1
            continue
        if data is None:
            print("    ! cannot parse")
            stats["errors"] += 1
            continue

        # preset / cwd from session event
        preset, cwd = "", ""
        try:
            raw = read_zstd_stream(fp)
            first = json.loads(raw.decode("utf-8", "replace").split("\n", 1)[0])
            preset = first.get("agentPreset") or ""
            cwd = first.get("cwd") or ""
        except Exception:
            pass

        # enrich from projcache (LLM session title, token usage)
        cache_dir = root.parent / "storages" / "session_projcache" / "sessions"
        cache_file = cache_dir / f"{sdir.name}.json"
        if cache_file.exists():
            try:
                rec = json.loads(cache_file.read_text(encoding="utf-8"))
                rows = rec.get("record", {}).get("rows", {})
                tv = rows.get("title", {}).get("val")
                if tv and data.get("title_source") == "fallback":
                    data["title"] = tv
                    data["title_source"] = "llm"
                data.setdefault("token_usage", rows.get("tokenUsage", {}).get("val", {}))
            except Exception:
                pass

        created = data["created"]
        stats["dates"].add(created)
        stats["total_messages"] += data["user_count"] + data["assistant_count"]
        stats["total_tools"] += data["tool_count"]

        if not data["conversation"]:
            print("    -> no conversation content, skip")
            stats["no_content"] += 1
            continue

        topics = detect_topics(data["conversation"])

        # summary file
        month_dir = DAILY_DIR / created[:7]
        month_dir.mkdir(parents=True, exist_ok=True)
        out_summary = month_dir / f"{created}-DSH-{short_id}.md"

        # inbox file
        inbox_dir = ARCHIVE_DIR / "inbox" / created[:7]
        inbox_dir.mkdir(parents=True, exist_ok=True)
        out_inbox = inbox_dir / f"{created}_{short_id}.md"

        for path in (out_summary, out_inbox):
            if path.exists():
                if "synced: true" in path.read_text(encoding="utf-8", errors="replace"):
                    print(f"    -> already synced, skip: {path.name}")
                    stats["skipped"] += 1
                    break
                else:
                    # regenerate (older format)
                    write_summary(sdir.name, data, topics, out_summary, preset, cwd, str(root))
                    write_inbox(sdir.name, data, topics, out_inbox, preset, cwd, str(root))
                    print(f"    -> updated: {out_summary.name}")
                    stats["new_files"].append(str(out_summary))
                    stats["new_files"].append(str(out_inbox))
                    stats["ok"] += 1
                    break
            else:
                write_summary(sdir.name, data, topics, out_summary, preset, cwd, str(root))
                write_inbox(sdir.name, data, topics, out_inbox, preset, cwd, str(root))
                print(f"    -> generated: {out_summary.name}")
                stats["new_files"].append(str(out_summary))
                stats["new_files"].append(str(out_inbox))
                stats["ok"] += 1
                break
        else:
            continue

    # stats
    print()
    print("=" * 60)
    print("Sync complete!")
    print(f"  total sessions: {stats['total']}")
    print(f"  synced/updated: {stats['ok']}")
    print(f"  skipped (fresh): {stats['skipped']}")
    print(f"  no content:     {stats['no_content']}")
    print(f"  errors:         {stats['errors']}")
    print(f"  messages:       {stats['total_messages']:,}")
    print(f"  tool calls:     {stats['total_tools']:,}")
    print(f"  dates: {', '.join(sorted(stats['dates']))}")

    # save run stats
    stats_file = META_DIR / "stats.json"
    try:
        existing = json.loads(stats_file.read_text(encoding="utf-8")) if stats_file.exists() else []
        if not isinstance(existing, list):
            existing = [existing]
    except Exception:
        existing = []
    existing.append({
        "time": datetime.now().isoformat(),
        "action": "full_sync_all_sessions_v2",
        "roots": [str(r) for r in SESSION_ROOTS],
        "total_sessions": stats["total"],
        "synced_updated": stats["ok"],
        "skipped": stats["skipped"],
        "no_content": stats["no_content"],
        "errors": stats["errors"],
        "total_messages": stats["total_messages"],
        "total_tools": stats["total_tools"],
        "dates": sorted(stats["dates"]),
    })
    stats_file.write_text(json.dumps(existing, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  stats -> {stats_file}")


if __name__ == "__main__":
    main()
