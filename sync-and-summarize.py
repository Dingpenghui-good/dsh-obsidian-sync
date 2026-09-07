# -*- coding: utf-8 -*-
"""
DSH Activity Summary Generator v3
从会话 Markdown 文件提取关键事件，按主题归类，生成结构化活动日志。
每次运行自动更新 00-汇总-活动日志.md，保持与最新内容同步。
"""

import re
import json
from pathlib import Path
from datetime import datetime
from collections import defaultdict

KB_ROOT = Path(r"D:\DSH\workspace\knowledge-base")
DAILY_DIR = KB_ROOT / "01-Daily"
SUMMARY_FILE = KB_ROOT / "00-汇总-活动日志.md"
MOI_FILE = KB_ROOT / "00-索引-MOC.md"

# 主题关键词
TOPIC_RULES = {
    "知识库搭建": ["知识库", "obsidian", "MOC", "索引", "daily-log", "kb-maintain"],
    "插件安装调试": ["插件", "plugin", "cordis", "dsh-conversation-language", "session-5019", "session-07f6"],
    "npm发布": ["npm", "release", "github release", "版本发布", "package.json", "session-30a9"],
    "同步自动化": ["同步", "sync", "自动化", "定时任务", "schtasks", "vbs", "hourly", "cron"],
    "Agent/Preset": ["agent", "preset", "agent preset", "对话语言", "conversation language"],
    "问题排查": ["错误", "error", "bug", "排查", "故障", "duplicate", "bom", "syntaxerror", "乱码"],
    "会话管理": ["会话", "session", "对话记录"],
}

# 问题关键词 → 归类标签
PROBLEM_PATTERNS = [
    (r"duplicate\s+loader\s+entry", "插件配置重复注册"),
    (r"SyntaxError.*BOM|bom.*json|Byte\s*Order\s*Mark", "JSON文件BOM编码问题"),
    (r"release.*乱码|garbled|encoding", "GitHub Release中文编码问题"),
    (r"settings.*menu|菜单|设置.*不.*出现", "插件设置菜单缺失"),
    (r"install.*plugin|安装.*插件|compat", "插件兼容性/安装问题"),
    (r"定时.*任务|schtasks|vbs|cron", "定时任务/自动维护问题"),
    (r"sandbox|权限|approval", "沙箱/权限问题"),
    (r"path.*not found|找不到|路径", "路径/依赖缺失问题"),
]

def detect_topics(file_content, file_name):
    topics = []
    combined = (file_content + " " + file_name).lower()
    for topic, keywords in TOPIC_RULES.items():
        if any(kw.lower() in combined for kw in keywords):
            topics.append(topic)
    return topics if topics else ["其他"]

def extract_time_range(file_content):
    start_m = re.search(r'created:\s*"([^"]+)"', file_content)
    times = re.findall(r'time":(\d+)', file_content)
    end_str = datetime.fromtimestamp(max(int(t) for t in times) / 1000).strftime("%Y-%m-%d %H:%M") if times else ""
    start_str = datetime.fromisoformat(start_m.group(1)).strftime("%Y-%m-%d %H:%M") if start_m else ""
    return start_str, end_str

def extract_problems_and_solutions(file_content):
    """从对话文本中提取问题和解决方案"""
    problems = []
    lines = file_content.split('\n')
    
    # 找到所有 Q/N 块
    qa_blocks = re.split(r'###\s*Q(\d+):', file_content)
    # qa_blocks[0] is before first Q, then pairs of (num, content)
    i = 1
    while i < len(qa_blocks):
        q_num = qa_blocks[i]
        q_and_a = qa_blocks[i + 1] if i + 1 < len(qa_blocks) else ""
        i += 2
        
        # Split into Q part and A part
        a_match = re.search(r'\*\*A\d+\*\*:\s*(.*)', q_and_a, re.DOTALL)
        if not a_match:
            continue
        q_text = q_and_a[:a_match.start()].strip()
        a_text = a_match.group(1).strip()
        combined = q_text + " " + a_text
        
        # Detect problems in this Q&A
        detected = []
        for pattern, label in PROBLEM_PATTERNS:
            if re.search(pattern, combined, re.IGNORECASE):
                # Extract the actual error/problem description from Q
                problem_desc = q_text.split('\n')[0][:120]
                # Extract solution from A
                solution = a_text.split('\n')[0][:200]
                # Clean up
                problem_desc = re.sub(r'\s+', ' ', problem_desc).strip()
                solution = re.sub(r'\s+', ' ', solution).strip()
                detected.append({
                    "label": label,
                    "problem": problem_desc,
                    "solution": solution[:300],
                })
        
        if detected:
            problems.extend(detected)
    
    # Also look for ⚠️ 错误 markers
    for m in re.finditer(r'⚠️\s*\*\*错误\*\*:\s*([^\n]+)', file_content):
        err = m.group(1).strip()
        if err and '[object Object]' not in err and len(err) > 3:
            # Check if already captured
            existing = [p["problem"] for p in problems]
            if err not in existing:
                problems.append({
                    "label": "运行时错误",
                    "problem": err[:150],
                    "solution": "see conversation",
                })
    
    return problems

def extract_key_actions(file_content):
    """提取关键行动"""
    actions = []
    # re.split with capturing group: [..., marker1, q_text1, marker2, q_text2, ...]
    parts = re.split(r'(###\s*Q\d+:)', file_content)
    i = 0
    while i < len(parts):
        if parts[i].startswith('### Q'):
            q_text = parts[i+1] if i+1 < len(parts) else ""
            # Search for **A\d+:** in the remaining content after q_text
            rest = parts[i+1] if i+1 < len(parts) else ""
            for j in range(i+2, min(i+6, len(parts))):
                if '**A' in parts[j]:
                    rest = parts[j]
                    break
            a_match = re.search(r'\*\*A\d+\*\*:\s*(.*)', rest, re.DOTALL)
            if a_match:
                q_clean = re.sub(r'\s+', ' ', q_text.strip())[:300]
                a_clean = re.sub(r'\s+', ' ', a_match.group(1).strip())[:600]
                actions.append({"q": q_clean, "a": a_clean})
            i += 2
        else:
            i += 1
    return actions[:6]

def classify_action(action):
    q = action["q"].lower()
    a = action["a"].lower()
    combined = q + " " + a
    tags = []
    if any(k in combined for k in ["检查", "check", "分析", "analyze", "原因", "why", "是否", "适用"]):
        tags.append("诊断")
    if any(k in combined for k in ["安装", "install", "clone", "添加", "下载"]):
        tags.append("安装")
    if any(k in combined for k in ["错误", "error", "bug", "修复", "fix", "解决", "resolve", "乱码", "分析.*原因"]):
        tags.append("修复")
    if any(k in combined for k in ["发布", "publish", "release", "npm publish", "tag", "commit"]):
        tags.append("发布")
    if any(k in combined for k in ["同步", "sync", "整理", "organize", "维护", "记录"]):
        tags.append("同步")
    if any(k in combined for k in ["设计", "搭建", "build", "创建", "create", "实现", "implement", "写", "generate"]):
        tags.append("开发")
    if not tags:
        tags.append("对话")
    return "、".join(tags)

def summarize_outcome(actions, problems):
    outcomes = []
    for act in actions:
        q = act["q"]
        a = act["a"]
        combined = q + " " + a
        if any(k in combined.lower() for k in ["check", "是否", "分析", "原因"]):
            outcomes.append(("需求确认", q[:80]))
        elif any(k in combined.lower() for k in ["安装", "install", "clone"]):
            outcomes.append(("安装插件", q[:80]))
        elif any(k in combined.lower() for k in ["错误", "error", "bug", "修复", "解决", "乱码", "分析.*原因"]):
            outcomes.append(("解决问题", q[:80]))
        elif any(k in combined.lower() for k in ["发布", "publish", "release"]):
            outcomes.append(("发布版本", q[:80]))
        elif any(k in combined.lower() for k in ["同步", "sync", "整理", "维护"]):
            outcomes.append(("同步数据", q[:80]))
        elif any(k in combined.lower() for k in ["设计", "搭建", "创建", "实现"]):
            outcomes.append(("开发建设", q[:80]))
    # Add problem resolutions
    for p in problems[:2]:
        outcomes.append(("解决问题", p["problem"][:80]))
    return outcomes[:4]

def scan_session_files():
    sessions = []
    if not DAILY_DIR.exists():
        return sessions
    for f in sorted(DAILY_DIR.rglob("*.md")):
        if f.name.startswith("."):
            continue
        content = f.read_text(encoding="utf-8", errors="replace")
        if "type: session-summary" not in content:
            continue
        topics = detect_topics(content, f.name)
        start_time, end_time = extract_time_range(content)
        actions = extract_key_actions(content)
        problems = extract_problems_and_solutions(content)
        conv_m = re.search(r'conversationCount:\s*(\d+)', content)
        msg_m = re.search(r'messageCount:\s*(\d+)', content)
        tool_m = re.search(r'toolCalls:\s*(\d+)', content)
        sessions.append({
            "file": f.name,
            "short_name": f.name.replace("2026-09-03-DSH-session-", "").replace(".md", ""),
            "topics": topics,
            "start_time": start_time,
            "end_time": end_time,
            "actions": actions,
            "problems": problems,
            "conversation_count": int(conv_m.group(1)) if conv_m else 0,
            "message_count": int(msg_m.group(1)) if msg_m else 0,
            "tool_calls": int(tool_m.group(1)) if tool_m else 0,
            "raw_content": content,
        })
    return sessions

def group_by_topic(sessions):
    groups = defaultdict(list)
    for s in sessions:
        for t in s["topics"]:
            groups[t].append(s)
    return dict(groups)

def generate_summary_md(sessions, topic_groups):
    lines = []
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M")
    total_turns = sum(s["conversation_count"] for s in sessions)
    total_msgs = sum(s["message_count"] for s in sessions)
    total_tools = sum(s["tool_calls"] for s in sessions)
    all_problems = []

    lines.append("# 📋 DSH 活动日志")
    lines.append("")
    lines.append(f"> 最后更新: {now_str} | 会话总数: {len(sessions)} | 主题分类: {len(topic_groups)} 类")
    lines.append("")
    lines.append("---")
    lines.append("")

    TOPIC_ORDER = ["知识库搭建", "插件安装调试", "npm发布", "同步自动化", "Agent/Preset", "问题排查", "会话管理", "其他"]

    # ── 一、按主题归类 ───────────────────────────────────────────────────
    lines.append("## 一、按主题归类的活动记录")
    lines.append("")

    for topic in TOPIC_ORDER:
        if topic not in topic_groups:
            continue
        items = topic_groups[topic]
        lines.append(f"### {topic}")
        lines.append("")

        for item in items:
            time_range = item["start_time"] or "未知时间"
            short_name = item["short_name"]

            lines.append(f"#### [{time_range}] {short_name}")
            lines.append("")
            lines.append(f"- **对话**: {item['conversation_count']} 轮 | **消息**: {item['message_count']} 条 | **工具调用**: {item['tool_calls']} 次")
            lines.append("")

            # 行动与结果
            outcomes = summarize_outcome(item["actions"], item["problems"])
            if outcomes:
                lines.append("**行动与结果：**")
                lines.append("")
                for label, desc in outcomes:
                    lines.append(f"- ✅ **{label}**: {desc}")
                lines.append("")

            # 遇到的问题及解决
            if item["problems"]:
                all_problems.extend(item["problems"])
                lines.append("**遇到的问题及解决：**")
                lines.append("")
                for p in item["problems"][:3]:
                    lines.append(f"- ⚠️ **{p['label']}**: {p['problem']}")
                    lines.append(f"  → 解决: {p['solution']}")
                lines.append("")

            lines.append(f"→ 详细: [[{item['file'].replace('.md', '')}]]")
            lines.append("")

        lines.append("---")
        lines.append("")

    # ── 二、时间线总览 ───────────────────────────────────────────────────
    lines.append("## 二、时间线总览")
    lines.append("")
    lines.append("| 时间 | 会话 | 主题 | 对话 | 问题 | 结果 |")
    lines.append("|------|------|------|------|------|------|")
    for s in sorted(sessions, key=lambda x: x["start_time"] or ""):
        t = s["start_time"] or "?"
        name = s["short_name"]
        topics_str = "、".join(s["topics"][:2])
        turns = s["conversation_count"]
        errs = len(s["problems"])
        result = "✅ 完成" if errs == 0 else f"⚠️ {errs}个问题已解决"
        lines.append(f"| {t} | {name} | {topics_str} | {turns}轮 | {errs}个 | {result} |")
    lines.append("")
    lines.append("---")
    lines.append("")

    # ── 三、常见问题归类 ──────────────────────────────────────────────────
    if all_problems:
        lines.append("## 三、常见问题归类")
        lines.append("")
        clusters = defaultdict(list)
        for p in all_problems:
            clusters[p["label"]].append(p)
        for label, ps in sorted(clusters.items()):
            lines.append(f"#### {label}（{len(ps)}次）")
            lines.append("")
            seen = set()
            for p in ps[:3]:
                key = p["problem"][:60]
                if key not in seen:
                    seen.add(key)
                    lines.append(f"- {p['problem'][:120]}")
                    lines.append(f"  解决: {p['solution'][:200]}")
            lines.append("")
        lines.append("---")
        lines.append("")

    # ── 四、统计概览 ─────────────────────────────────────────────────────
    lines.append("## 四、统计概览")
    lines.append("")
    lines.append("| 指标 | 数值 |")
    lines.append("|------|------|")
    lines.append(f"| 会话总数 | {len(sessions)} |")
    lines.append(f"| 总对话轮数 | {total_turns} |")
    lines.append(f"| 总消息数 | {total_msgs:,} |")
    lines.append(f"| 总工具调用 | {total_tools:,} |")
    lines.append(f"| 发现问题 | {len(all_problems)} 个 |")
    lines.append(f"| 涉及主题 | {len(topic_groups)} 类 |")
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append(f"*上次同步: {now_str} · 运行 `python sync-and-summarize.py` 自动更新*")

    return "\n".join(lines)

def update_moc(sessions):
    if not MOI_FILE.exists():
        return
    content = MOI_FILE.read_text(encoding="utf-8")
    if "活动日志" not in content:
        insert_pos = content.find("## 每日日志")
        if insert_pos > 0:
            new_section = """## 活动日志

- [[00-汇总-活动日志|DSH 活动日志]] — 按主题归类的完整活动记录，含问题发现与解决方案

"""
            content = content[:insert_pos] + new_section + content[insert_pos:]
    total_turns = sum(s["conversation_count"] for s in sessions)
    m = re.search(r'对话数: \d+', content)
    if m:
        content = re.sub(r'对话数: \d+', f'对话数: {total_turns}', content)
    MOI_FILE.write_text(content, encoding="utf-8")
    print("  ✓ MOC 已更新")

def main():
    print("[*] 扫描 DSH 会话文件...")
    sessions = scan_session_files()
    print(f"  找到 {len(sessions)} 个会话笔记")
    if not sessions:
        print("  没有发现会话笔记，退出")
        return

    print("[*] 按主题分组...")
    topic_groups = group_by_topic(sessions)
    for topic, items in topic_groups.items():
        print(f"  {topic}: {len(items)} 个会话")

    print("[*] 生成活动日志...")
    md_content = generate_summary_md(sessions, topic_groups)
    SUMMARY_FILE.parent.mkdir(parents=True, exist_ok=True)
    SUMMARY_FILE.write_text(md_content, encoding="utf-8")
    print(f"  ✓ 已写入: {SUMMARY_FILE}")

    print("[*] 更新 MOC...")
    update_moc(sessions)

    stats_file = KB_ROOT / "_meta" / "stats.json"
    try:
        stats = json.loads(stats_file.read_text()) if stats_file.exists() else []
    except:
        stats = []
    stats.append({
        "time": datetime.now().isoformat(),
        "action": "generate_activity_summary",
        "total_sessions": len(sessions),
        "total_topics": len(topic_groups),
        "total_turns": sum(s["conversation_count"] for s in sessions),
        "total_messages": sum(s["message_count"] for s in sessions),
        "summary_file": str(SUMMARY_FILE),
    })
    stats_file.write_text(json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8")
    print("  ✓ 统计已更新")
    print(f"\n[✓] 完成！活动日志: {SUMMARY_FILE}")

if __name__ == "__main__":
    main()
