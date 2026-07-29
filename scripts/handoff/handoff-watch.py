#!/usr/bin/env python3
"""
handoff-watch.py — Handoff 混合模式事件监听器

职责：同时监听本地 + 服务端 handoff 状态变更，即时触发处理。
与 cron 版 handoff-daemon.sh 共存：
  - cron → heartbeat + stale 检测（保底，3min/tick）
  - watch → 文件变更 + 服务端变更即时反应（2s 级别）

监听源：
  1. 本地文件系统: INBOX/DONE/ALERT 目录（files 模式、dual 投影）
  2. 服务端 API:   handoff-server REST API（dual/db 模式的权威来源）

用法：
  # 默认：只监听本地文件系统
  python3 scripts/handoff/handoff-watch.py

  # 同时监听本地 + 服务端
  HANDOFF_SERVER_URL=http://server:8377 python3 scripts/handoff/handoff-watch.py

  # 通过 daemon 自动启动
  HANDOFF_HYBRID=1 HANDOFF_SERVER_URL=http://server:8377 handoff-daemon.sh
"""
import os
import sys
import time
import json
import subprocess
import argparse
import pathlib
import datetime
import urllib.request
import urllib.error

WS = os.environ.get("WS", os.path.expanduser("~/.openclaw/workspace"))
HD = os.environ.get("HD", f"{WS}/shared/cc-handoff")

# Telegram 通知配置
TG_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TG_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "7664719881")

INBOX_DIR = f"{HD}/INBOX"
DONE_DIR = f"{HD}/DONE"
ALERT_DIR = f"{HD}/ALERT"
STATE_DIR = f"{HD}/STATE"
NOTIFY_DIR = f"{WS}/.state"

LOCAL_NODE = os.environ.get("HANDOFF_NODE", "oc-main")

# 服务端 URL（可选，设置后才轮询服务端）
SERVER_URL = os.environ.get("HANDOFF_SERVER_URL", "").rstrip("/")
SERVER_POLL_INTERVAL = int(os.environ.get("HANDOFF_SERVER_POLL", "5"))  # 服务端轮询间隔(s)

# 文件系统轮询间隔
FS_INTERVAL = int(os.environ.get("HANDOFF_WATCH_INTERVAL", "2"))


def log(msg):
    ts = datetime.datetime.now().strftime("%H:%M:%S.%f")[:12]
    print(f"[watch:{LOCAL_NODE}] {ts} {msg}", flush=True)


def tg_notify(text):
    """通过 Telegram Bot API 发送实时通知"""
    if not TG_BOT_TOKEN:
        return
    try:
        data = json.dumps({"chat_id": TG_CHAT_ID, "text": text, "parse_mode": "HTML"}).encode()
        req = urllib.request.Request(
            f"https://api.telegram.org/bot{TG_BOT_TOKEN}/sendMessage",
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=5)
    except Exception as e:
        log(f"tg notify error: {e}")


# ════════════════════════════════════════════════════════════════════
# 本地文件系统监听
# ════════════════════════════════════════════════════════════════════

def snapshot_dir(directory):
    """返回 {(mtime_ns, size): filename} 快照"""
    snap = {}
    try:
        p = pathlib.Path(directory)
        if not p.exists():
            return snap
        for f in sorted(p.iterdir()):
            if not f.is_file() or f.name == "README" or f.name.startswith("."):
                continue
            st = f.stat()
            key = (st.st_mtime_ns, st.st_size)
            snap[key] = f.name
    except Exception as e:
        if not isinstance(e, FileNotFoundError):
            log(f"scan error {directory}: {e}")
    return snap


def scan_and_claim():
    """从本地 INBOX 认领归自己的任务"""
    script = (
        'set -euo pipefail\n'
        f'WS="{WS}"\n'
        f'HD="{HD}"\n'
        f'INBOX_DIR="{INBOX_DIR}"\n'
        f'INPROG_DIR="{HD}/IN_PROGRESS"\n'
        f'ARCHIVE_DIR="{HD}/INBOX_ARCHIVE"\n'
        f'DONE_DIR="{DONE_DIR}"\n'
        f'LOCAL_NODE="{LOCAL_NODE}"\n'
        f'STATE_DIR="{STATE_DIR}"\n'
        '. "$HD/bin/handoff-lock.sh"\n'
        '. "$HD/bin/frontmatter.sh"\n'
        '\n'
        'to_claim=""\n'
        '{\n'
        '  flock -s -w "${HANDOFF_LOCK_WAIT:-30}" 200 || exit 124\n'
        '  for f in "$INBOX_DIR"/*.md; do\n'
        '    [ -f "$f" ] || continue\n'
        '    tn=$(fm_field "$f" node)\n'
        '    if [ -z "$tn" ] || [ "$tn" = "any" ] || [ "$tn" = "$LOCAL_NODE" ]; then\n'
        '      to_claim="$to_claim $(basename "$f" .md)"\n'
        '    elif [ "$tn" = "oc" ] && [ "$LOCAL_NODE" = "oc-main" ]; then\n'
        '      to_claim="$to_claim $(basename "$f" .md)"\n'
        '    elif [ "$tn" = "cc" ] && [ "$LOCAL_NODE" = "cc-main" ]; then\n'
        '      to_claim="$to_claim $(basename "$f" .md)"\n'
        '    fi\n'
        '  done\n'
        '} 200>"$HD/STATE/handoff.lock"\n'
        '\n'
        'for task_name in $to_claim; do\n'
        '  src="$INBOX_DIR/$task_name.md"\n'
        '  dst="$INPROG_DIR/$task_name.md"\n'
        '  [ -f "$src" ] || continue\n'
        '  if [ -f "$DONE_DIR/$task_name.md" ]; then\n'
        '    with_handoff_lock x mv "$src" "$ARCHIVE_DIR/$task_name.md" 2>/dev/null || true\n'
        '    echo "ARCHIVE:$task_name"\n'
        '    continue\n'
        '  fi\n'
        '  [ -f "$dst" ] && continue\n'
        '  if with_handoff_lock x sh -c \'mv "$1" "$2"\' _ "$src" "$dst" 2>/dev/null; then\n'
        '    echo "CLAIMED:$task_name"\n'
        '  fi\n'
        'done\n'
    )
    try:
        result = subprocess.run(
            ["bash", "-c", script],
            capture_output=True, text=True, timeout=15
        )
        for line in result.stdout.strip().split("\n"):
            line = line.strip()
            if not line:
                continue
            if line.startswith("CLAIMED:"):
                log(f"claim {line[8:]}")
            elif line.startswith("ARCHIVE:"):
                log(f"archive stale {line[8:]}")
        if result.returncode == 124:
            log("claim scan lock timeout")
        if result.stderr.strip():
            for err in result.stderr.strip().split("\n"):
                if err.strip():
                    log(f"stderr: {err.strip()}")
    except subprocess.TimeoutExpired:
        log("claim scan timeout")
    except Exception as e:
        log(f"claim error: {e}")


def scan_and_notify():
    """检查本地 DONE/ALERT 新条目，写 notify flag"""
    script = (
        'set -euo pipefail\n'
        f'DONE_DIR="{DONE_DIR}"\n'
        f'ALERT_DIR="{ALERT_DIR}"\n'
        f'STATE_DIR="{STATE_DIR}"\n'
        f'LOCAL_NODE="{LOCAL_NODE}"\n'
        '\n'
        'DONE_FLAG="$STATE_DIR/.${LOCAL_NODE}_done_seen"\n'
        'ALERT_FLAG="$STATE_DIR/.${LOCAL_NODE}_alert_seen"\n'
        'NOTIFY_FLAG="$STATE_DIR/notify.flag"\n'
        '\n'
        'touch "$DONE_FLAG" "$ALERT_FLAG" 2>/dev/null || true\n'
        'new_done=""\n'
        'if [ -d "$DONE_DIR" ]; then\n'
        '  for f in "$DONE_DIR"/*.md; do\n'
        '    [ -f "$f" ] || continue\n'
        '    tid=$(basename "$f" .md)\n'
        '    if ! grep -qFx "$tid" "$DONE_FLAG" 2>/dev/null; then\n'
        '      new_done="$new_done $tid"\n'
        '    fi\n'
        '  done\n'
        'fi\n'
        'new_alerts=""\n'
        'if [ -d "$ALERT_DIR" ]; then\n'
        '  for f in "$ALERT_DIR"/*.md; do\n'
        '    [ -f "$f" ] || continue\n'
        '    aid=$(basename "$f" .md)\n'
        '    [ "$aid" = "README" ] && continue\n'
        '    if ! grep -qFx "$aid" "$ALERT_FLAG" 2>/dev/null; then\n'
        '      new_alerts="$new_alerts $aid"\n'
        '    fi\n'
        '  done\n'
        'fi\n'
        'if [ -n "$new_done" ]; then\n'
        '  for tid in $new_done; do\n'
        '    echo "$tid" >> "$DONE_FLAG"\n'
        '  done\n'
        '  echo "NEW_DONE:$new_done" >> "$NOTIFY_FLAG"\n'
        '  echo "DONE:$new_done"\n'
        'fi\n'
        'if [ -n "$new_alerts" ]; then\n'
        '  for aid in $new_alerts; do\n'
        '    echo "$aid" >> "$ALERT_FLAG"\n'
        '    echo "NEW_ALERT:$new_alerts" >> "$NOTIFY_FLAG"\n'
        '    echo "ALERT:$new_alerts"\n'
        '  done\n'
        'fi\n'
    )
    try:
        result = subprocess.run(
            ["bash", "-c", script],
            capture_output=True, text=True, timeout=10
        )
        for line in result.stdout.strip().split("\n"):
            line = line.strip()
            if not line:
                continue
            if line.startswith("DONE:"):
                log(f"new DONE:{line[5:]}")
            elif line.startswith("ALERT:"):
                log(f"new ALERT:{line[6:]}")
    except Exception as e:
        log(f"notify scan error: {e}")


# ════════════════════════════════════════════════════════════════════
# 服务端 API 监听（可选）
# ════════════════════════════════════════════════════════════════════

def server_tasks():
    """GET /api/tasks — 返回任务列表或 None"""
    if not SERVER_URL:
        return None
    try:
        req = urllib.request.Request(
            f"{SERVER_URL}/api/tasks",
            headers={"Accept": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None  # /api/tasks might not exist on older versions
        log(f"server HTTP {e.code}")
        return None
    except urllib.error.URLError as e:
        log(f"server unreachable: {e.reason}")
        return None
    except Exception as e:
        log(f"server error: {e}")
        return None


def server_claim():
    """POST /api/claim — 原子认领最高优先级 pending 任务。返回认领到的任务或 None。"""
    if not SERVER_URL:
        return None
    try:
        data = json.dumps({"node_id": LOCAL_NODE}).encode("utf-8")
        req = urllib.request.Request(
            f"{SERVER_URL}/api/claim",
            data=data,
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = json.loads(resp.read().decode("utf-8"))
            return body
    except urllib.error.HTTPError as e:
        if e.code in (404, 400):
            return None  # claim not supported or no tasks
        log(f"claim HTTP {e.code}")
        return None
    except urllib.error.URLError as e:
        log(f"claim unreachable: {e.reason}")
        return None
    except Exception as e:
        log(f"claim error: {e}")
        return None


def server_scan_and_claim():
    """从服务端认领 pending 任务（dual/db 模式）"""
    if not SERVER_URL:
        return

    # 先看有没有 pending 任务
    tasks = server_tasks()
    if tasks is None:
        return

    # 找出 pending 任务
    pending = []
    if isinstance(tasks, dict) and "data" in tasks:
        pending = [t for t in tasks["data"] if t.get("status") == "pending"]
    elif isinstance(tasks, list):
        pending = [t for t in tasks if t.get("status") == "pending"]

    if not pending:
        return

    # log(f"server has {len(pending)} pending tasks")

    # 原子认领
    claimed = server_claim()
    if claimed and claimed.get("id"):
        tid = claimed["id"]
        log(f"server claim {tid}")
        # 认领后触发一次本地 DONE/ALERT 扫描（server 写投影后会更新本地文件）
        scan_and_notify()


def server_scan_done():
    """检查服务端新完成 / alert 的任务（通过对比 updated_at）"""
    if not SERVER_URL:
        return [], []

    tasks = server_tasks()
    if tasks is None:
        return [], []

    new_done = []
    new_alert = []
    task_list = []
    if isinstance(tasks, dict) and "data" in tasks:
        task_list = tasks["data"]
    elif isinstance(tasks, list):
        task_list = tasks

    for t in task_list:
        tid = t.get("name", "").replace(".md", "")
        status = t.get("status", "")
        if status == "done":
            new_done.append(tid)
        elif status == "alert":
            new_alert.append(tid)

    return new_done, new_alert


# ════════════════════════════════════════════════════════════════════
# 主循环
# ════════════════════════════════════════════════════════════════════

def _classify_inbox_file(filepath):
    """读取 INBOX 文件 frontmatter，返回 (msg_type, target_node, title)"""
    try:
        with open(filepath) as f:
            content = f.read()
        # 提取 frontmatter
        fm_match = __import__('re').search(r'^---\s*\n(.*?)\n---', content, __import__('re').DOTALL)
        if not fm_match:
            return "task", "", ""
        fm = fm_match.group(1)
        def _get(k):
            m = __import__('re').search(r'^' + k + r':[\s]*(.*?)[\s]*$', fm, __import__('re').MULTILINE)
            return m.group(1).strip() if m else ""
        msg_type = _get('type') or "task"
        target = _get('node') or ""
        title = ""
        for line in content.split('\n'):
            if line.startswith('# '):
                title = line[2:].strip()
                break
        return msg_type, target, title
    except Exception:
        return "task", "", ""


PENDING_TASKS = set()  # 跳过不认领的 task

def _route_new_inbox_items(old_snap, new_snap):
    """路由新 INBOX 消息：note 自动认领+通知，task 仅通知不认领"""
    global PENDING_TASKS
    old_keys = set(old_snap.values())
    new_keys = set(new_snap.values())
    added = new_keys - old_keys

    LOCAL_NODE = os.environ.get("HANDOFF_NODE", "oc-main")
    classified = False

    for fname in sorted(added):
        fpath = os.path.join(INBOX_DIR, fname)
        if not os.path.isfile(fpath):
            continue
        msg_type, target, title = _classify_inbox_file(fpath)

        # 检查是否属于本节点
        is_for_me = (
            not target or target == "any" or target == LOCAL_NODE
            or (target == "oc" and LOCAL_NODE == "oc-main")
            or (target == "guanj_oc" and LOCAL_NODE == "oc-main")
        )
        if not is_for_me:
            continue

        classified = True
        if msg_type == "note":
            log(f"📝 note 自动认领: {fname}")
            _claim_one(fname)
            _write_note_notification(fname, title)
            tg_notify(f"✅ Handoff note 已自动认领:\n📝 {title}\n来自: {fname}")
        else:
            # task：不认领，只通知；加入待确认集合
            log(f"📋 task 待确认: {fname}")
            PENDING_TASKS.add(fname)
            _write_task_notification(fname, title)
            tg_notify(f"📋 新 Handoff task 待确认:\n📄 {title}\n来自: {fname}\n回复: 执行 或 跳过")

    if not classified:
        # 没有新增归属本节点的消息 → 调用原 scan_and_claim 兜底
        scan_and_claim()


def _claim_one(task_name):
    """认领单个任务"""
    script = (
        f'cd {WS} && bash shared/cc-handoff/bin/claim-task.sh {task_name} 2>&1'
    )
    try:
        subprocess.run(["bash", "-c", script], capture_output=True, timeout=10)
    except Exception:
        pass


def _write_note_notification(fname, title):
    """写 note 已确认通知"""
    note_file = os.path.join(NOTIFY_DIR, "note_acknowledged.flag")
    try:
        with open(note_file, "a") as f:
            f.write(f"{fname}|{title}\n")
    except Exception:
        pass


def _write_task_notification(fname, title):
    """写 task 待确认通知"""
    note_file = os.path.join(NOTIFY_DIR, "task_pending.flag")
    try:
        with open(note_file, "a") as f:
            f.write(f"{fname}|{title}\n")
    except Exception:
        pass


def watch_loop():
    """主循环：本地文件 + 可选服务端，双源监听"""
    for d in [INBOX_DIR, DONE_DIR, ALERT_DIR]:
        pathlib.Path(d).mkdir(parents=True, exist_ok=True)

    inbox_snap = snapshot_dir(INBOX_DIR)
    done_snap = snapshot_dir(DONE_DIR)
    alert_snap = snapshot_dir(ALERT_DIR)

    server_tick = 0
    server_pending_prev = set()

    sources = "local"
    if SERVER_URL:
        sources += "+server"
    log(f"started (fs={FS_INTERVAL}s server={SERVER_POLL_INTERVAL}s) sources={sources}")
    log(f"INBOX={len(inbox_snap)} DONE={len(done_snap)} ALERT={len(alert_snap)}")

    while True:
        time.sleep(FS_INTERVAL)
        server_tick += FS_INTERVAL

        # ── 本地文件系统监听 ──
        cur_inbox = snapshot_dir(INBOX_DIR)
        cur_done = snapshot_dir(DONE_DIR)
        cur_alert = snapshot_dir(ALERT_DIR)

        if cur_inbox != inbox_snap:
            log(f"INBOX changed: {len(inbox_snap)}->{len(cur_inbox)}")
            # 跳过已标记为 pending 的 task（不认领）
            cur_filtered = {k: v for k, v in cur_inbox.items() if v not in PENDING_TASKS}
            old_filtered = {k: v for k, v in inbox_snap.items() if v not in PENDING_TASKS}
            _route_new_inbox_items(old_filtered, cur_filtered)
            inbox_snap = cur_inbox

        if cur_done != done_snap:
            log(f"DONE changed: {len(done_snap)}->{len(cur_done)}")
            scan_and_notify()
            done_snap = cur_done

        if cur_alert != alert_snap:
            log(f"ALERT changed: {len(alert_snap)}->{len(cur_alert)}")
            scan_and_notify()
            alert_snap = cur_alert

        # ── 服务端监听（按间隔轮询） ──
        if SERVER_URL and server_tick >= SERVER_POLL_INTERVAL:
            server_tick = 0

            # 1. 扫描并认领 pending 任务
            tasks = server_tasks()
            if tasks is not None:
                task_list = []
                if isinstance(tasks, dict) and "data" in tasks:
                    task_list = tasks["data"]
                elif isinstance(tasks, list):
                    task_list = tasks

                cur_pending = set()
                for t in task_list:
                    tid = t.get("name", "").replace(".md", "")
                    if t.get("status") == "pending":
                        cur_pending.add(tid)

                # 有新 pending 任务 → 尝试认领
                if cur_pending and cur_pending != server_pending_prev:
                    diff = cur_pending - server_pending_prev
                    if diff:
                        log(f"server new pending: {sorted(diff)}")
                    server_scan_and_claim()
                    server_pending_prev = cur_pending

                # 检查服务端 DONE/ALERT
                server_done, server_alert = server_scan_done()
                if server_done:
                    log(f"server done: {server_done}")
                if server_alert:
                    log(f"server alert: {server_alert}")

                # 同步 server_pending_prev 状态（排除已 done 的）
                server_pending_prev = {
                    t.get("name", "").replace(".md", "")
                    for t in task_list
                    if t.get("status") == "pending"
                }


def main():
    global FS_INTERVAL, SERVER_POLL_INTERVAL, SERVER_URL
    parser = argparse.ArgumentParser(description="Handoff 混合模式监听器")
    parser.add_argument("--interval", type=int, default=2,
                        help="本地文件轮询间隔 (默认: 2)")
    parser.add_argument("--server-interval", type=int, default=5,
                        help="服务端轮询间隔 (默认: 5)")
    parser.add_argument("--server", type=str, default="",
                        help="服务端 URL (如 http://localhost:8377)")
    parser.add_argument("--once", action="store_true",
                        help="只扫描一次（用于测试）")
    args = parser.parse_args()

    FS_INTERVAL = args.interval
    SERVER_POLL_INTERVAL = args.server_interval
    if args.server:
        SERVER_URL = args.server.rstrip("/")
    if not args.server and SERVER_URL:
        pass  # 保持环境变量值
    elif not args.server:
        SERVER_URL = ""

    if args.once:
        scan_and_claim()
        scan_and_notify()
        if SERVER_URL:
            server_scan_and_claim()
        return

    try:
        watch_loop()
    except KeyboardInterrupt:
        log("stopped")


if __name__ == "__main__":
    main()
