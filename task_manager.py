#!/usr/bin/env python3
"""
知识库里在途任务管理
监听并维护所有待处理任务
"""
import json
from pathlib import Path
from datetime import datetime

TASKS_DIR = Path(r"D:\DSH\workspace\knowledge-base\_meta\tasks")
TASKS_DIR.mkdir(parents=True, exist_ok=True)

def save_task(task_id: str, task_data: dict):
    path = TASKS_DIR / f"{task_id}.json"
    task_data["id"] = task_id
    task_data["created_at"] = datetime.now().isoformat()
    path.write_text(json.dumps(task_data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"SAVED_TASK:{task_id}")

def list_tasks():
    tasks = []
    for f in sorted(TASKS_DIR.glob("*.json"), key=lambda x: x.stat().st_mtime, reverse=True):
        tasks.append(json.loads(f.read_text()))
    return tasks

if __name__ == "__main__":
    import sys
    if len(sys.argv) > 2:
        save_task(sys.argv[1], json.loads(sys.argv[2]))
    else:
        for t in list_tasks():
            print(json.dumps(t, ensure_ascii=False))
