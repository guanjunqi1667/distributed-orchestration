#!/usr/bin/env python3
"""Handoff Server — 权威任务存储 + dashboard (SSR/JSON) + REST API.

存储模式（环境变量 HANDOFF_STORE，默认 files）：
  files  回滚 / 当前 v1 行为。文件目录为权威，SQLite 仅作后台任务日志。
         trigger-cc.sh 不经 claim，CC 仍用本地原子 mv 认领。
  dual   SQLite 为单一权威 + 单向文件投影（INBOX/IN_PROGRESS/DONE/INBOX_ARCHIVE
         由 SQLite 驱动，绝不反向回灌）。trigger-cc.sh 先 POST /api/claim 再 spawn。
         dashboard 仍读投影后的文件目录（/ 与 /api 行为不变）。
  db     SQLite 为单一权威，不做文件投影（所有消费方已迁离文件后的终态）。

认领互斥（dual/db）：POST /api/claim 在单条 SQLite 事务（BEGIN IMMEDIATE）内串行
选取最高优先级 pending 任务并置为 in_progress —— 服务器串行化即天然互斥，无需自建
lease（设计 §4「中继/中心服务器」路线的正确性优势）。reserve-before-execute 由服务器
串行化满足：claim 成功者才执行，无并发输家，副作用只发生在 claim 之后（见
docs/handoff-final-design.md §3.1、§4）。in_progress 的崩溃回收沿用 v1 语义：投影把
in_progress 映回 IN_PROGRESS/，现有 SessionStart stale-hook（>30min→ALERT，老板介入）
继续生效，不做会引发重复执行的自动 reclaim。

环境覆盖（便于测试 / 多实例）：
  HANDOFF_STORE, HANDOFF_DIR (默认 ~/.openclaw/workspace/shared/cc-handoff),
  HANDOFF_DB (默认 <DIR>/handoff.db), PORT (默认 8377)
"""
import http.server, json, os, glob, re, sqlite3, tempfile, pathlib
from datetime import datetime, timedelta, timezone

HD = os.path.expanduser(os.environ.get("HANDOFF_DIR", "~/.openclaw/workspace/shared/cc-handoff"))
DB_PATH = os.environ.get("HANDOFF_DB", os.path.join(HD, "handoff.db"))
PORT = int(os.environ.get("PORT", "8377"))
TPL_PATH = os.path.join(HD, "dashboard", "index.html")
MAX_BODY = 1 << 20                                 # 1 MiB POST 上限
SAFE_ID = re.compile(r"^[A-Za-z0-9._-]+$")         # 防 path traversal
STORE = (os.environ.get("HANDOFF_STORE", "files") or "files").strip().lower()
if STORE not in ("files", "dual", "db"):
    raise SystemExit(f"HANDOFF_STORE must be files|dual|db (got {STORE!r})")
AUTHORITY = STORE in ("dual", "db")                # SQLite 是否为权威
PROJECT = STORE == "dual"                          # 是否单向投影到文件目录

# status → 投影目录（dual 模式）
STATUS_DIR = {
    "pending": "INBOX",
    "claimed": "IN_PROGRESS",
    "in_progress": "IN_PROGRESS",
    "done": "DONE",
    "archived": "INBOX_ARCHIVE",
}
TASK_DIRS = ["INBOX", "IN_PROGRESS", "DONE", "INBOX_ARCHIVE"]

# ── 文件目录读取（dashboard 在所有模式下都走这里；dual 模式下读的是投影文件） ──

def read_hb(path):
    try:
        with open(path) as f:
            d = json.load(f)
            return d.get("status", "unknown"), d.get("last_seen", "")
    except Exception:
        return "unknown", ""

def list_md(dirname):
    files = []
    for f in sorted(glob.glob(os.path.join(HD, dirname, "*.md"))):
        bn = os.path.basename(f)
        if bn == "README.md":
            continue
        mtime = os.path.getmtime(f)
        desc = ""
        assignee = ""
        to_field = ""
        from_field = ""
        tokens = ""
        by_override = ""
        try:
            with open(f) as fh:
                all_lines = fh.readlines()
            sec = {}
            for i, l in enumerate(all_lines):
                s = l.strip()
                if s.startswith("**Tokens**") or s.startswith("**Tokens"):
                    tokens = s.split(":", 1)[-1].strip().strip("*").strip()
                    tokens = tokens.replace("{tokens}", "").strip()
                if s.startswith("> by:"):
                    by_override = s.split(":", 1)[-1].strip()
                if s.startswith("**To**"):
                    to_field = s.split(":", 1)[-1].strip().strip("*").strip()
                if s.startswith("**From**") and not to_field:
                    from_field = s.split(":", 1)[-1].strip().strip("*").strip()
                for t in ["## Objective", "## Summary", "## Context"]:
                    if s.startswith(t):
                        sec[t] = i
            if dirname == "IN_PROGRESS":
                assignee = by_override or to_field or from_field or "Claude Code"
            elif dirname == "DONE":
                assignee = by_override or from_field or "Claude Code"
            else:
                assignee = from_field or ""
            if assignee == "Claude Code (GLM-5.2)":
                assignee = "Claude Code"
            for t in ["## Objective", "## Summary", "## Context"]:
                if t in sec:
                    for j in range(sec[t]+1, min(sec[t]+5, len(all_lines))):
                        r2 = all_lines[j].strip()
                        if r2 and not r2.startswith("#") and not r2.startswith("**") and not r2.startswith("-"):
                            desc = r2[:300]
                            break
                if desc:
                    break
        except Exception:
            pass
        files.append({"name": bn, "mtime": datetime.fromtimestamp(mtime).isoformat(),
                      "desc": desc, "tokens": tokens, "by": assignee})
    files.sort(key=lambda x: x["mtime"], reverse=True)
    return files

def ago(iso):
    if not iso:
        return "--"
    try:
        s = (datetime.now() - datetime.fromisoformat(iso)).total_seconds()
    except Exception:
        return "--"
    if s < 60:
        return "刚刚"
    if s < 3600:
        return str(round(s / 60)) + "分"
    if s < 86400:
        return str(round(s / 3600)) + "小时"
    return str(round(s / 86400)) + "天"

def render_cards(items, empty_text):
    h = ""
    for t in items:
        prio = "p0" if t["name"].startswith("P0") else "p1" if t["name"].startswith("P1") else "p2"
        h += '<div class="card ' + prio + '"><span class="nm">' + t["name"] + '</span><span class="tm">' + ago(t["mtime"]) + '</span></div>'
    if not h:
        h = '<div class="emp">' + empty_text + '</div>'
    return h

def render():
    if AUTHORITY:
        project()  # 渲染前同步 SQLite → 文件
    inbox = list_md("INBOX")
    ip = list_md("IN_PROGRESS")
    done = list_md("DONE")
    now_aware = datetime.now(timezone.utc).astimezone()
    now = now_aware.strftime("%H:%M")
    done_show = done[-8:][::-1]

    # 动态扫描所有心跳文件
    hb_dir = os.path.join(HD, "STATE")
    # 节点名映射：从 nodes.json 读取
    NODE_NAMES = {}
    try:
        import json as _j
        npath = os.path.join(HD, "nodes.json")
        with open(npath) as _f:
            reg = _j.load(_f)
        for n in reg.get("nodes", []):
            nid = n["id"]
            disp = n.get("display", nid)
            NODE_NAMES[nid] = disp
            for a in n.get("aliases", []):
                NODE_NAMES[a] = disp
    except Exception:
        pass
    nodes_html = ""
    for hb_path in sorted(glob.glob(os.path.join(hb_dir, "*.heartbeat"))):
        name = os.path.basename(hb_path).replace(".heartbeat", "")
        status, last_seen = read_hb(hb_path)
        # 使用映射表中的展示名，找不到则用文件名
        display = NODE_NAMES.get(name, name)
        stale = False
        if last_seen:
            try:
                last = datetime.fromisoformat(last_seen)
                if (now_aware - last).total_seconds() > 300:
                    stale = True
            except Exception:
                pass
        if status == "alive" and not stale:
            css = "alive"
            label = "alive"
        elif status == "alive" and stale:
            css = "busy"
            label = "STALE"
        else:
            css = "offline"
            label = "offline"
        nodes_html += f'<span><span class="dt {css}"></span><span class="sl">{display}</span><span class="{css}">{label}</span></span>'

    page = open(TPL_PATH).read()
    page = page.replace("{{NOW}}", now)
    page = page.replace("{{NODES}}", nodes_html)
    page = page.replace("{{QCNT}}", str(len(inbox)))
    page = page.replace("{{IPCNT}}", str(len(ip)))
    page = page.replace("{{DONECNT}}", str(len(done)))
    page = page.replace("{{QUEUE}}", render_cards(inbox, "队列为空"))
    page = page.replace("{{PROGRESS}}", render_cards(ip, "暂无处理"))
    page = page.replace("{{DONE}}", render_cards(done_show, "暂无"))
    return page

# ── DB（权威 in dual/db；日志 in files） ──────────────────────────────────────

def db_conn():
    c = sqlite3.connect(DB_PATH, timeout=5.0)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA busy_timeout=5000")
    return c

def init_db():
    c = db_conn()
    try:
        # 后台任务日志（所有模式都有；审计/历史）
        c.execute("""CREATE TABLE IF NOT EXISTS task_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id TEXT NOT NULL,
            event TEXT NOT NULL,
            priority TEXT,
            source TEXT,
            meta TEXT,
            ts TEXT NOT NULL
        )""")
        # 权威任务表（dual/db）
        c.execute("""CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            priority TEXT,
            status TEXT NOT NULL,
            version INTEGER NOT NULL DEFAULT 1,
            node_id TEXT,
            title TEXT,
            objective TEXT,
            context TEXT,
            ac TEXT,
            constraints TEXT,
            source TEXT,
            lease_until TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            done_report TEXT
        )""")
        c.execute("CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)")
        c.commit()
    finally:
        c.close()

def log_event(tid, event, priority=None, source="api", meta=None):
    c = db_conn()
    try:
        c.execute(
            "INSERT INTO task_log (task_id, event, priority, source, meta, ts) VALUES (?,?,?,?,?,?)",
            (tid, event, priority, source, json.dumps(meta or {}, ensure_ascii=False), now_iso()),
        )
        c.commit()
    finally:
        c.close()

def now_iso():
    return datetime.now().astimezone().isoformat(timespec="minutes")

def today_str():
    return datetime.now().strftime("%Y%m%d")

def prio_rank(name):
    """CC 取任务顺序：REWORK → P0 → P1 → P2 → 其余。值小者优先。"""
    up = name.upper()
    if "REWORK" in up:
        return 0
    if up.startswith("P0"):
        return 1
    if up.startswith("P1"):
        return 2
    if up.startswith("P2"):
        return 3
    return 4

def slugify(text, maxlen=28):
    s = re.sub(r"[^A-Za-z0-9]+", "-", str(text)).strip("-").lower()
    return (s or "task")[:maxlen]

def gen_task_id(priority, body):
    tid = str(body.get("id") or "").strip()
    if tid:
        return tid
    return f"{priority}-{today_str()}-{slugify(body.get('title') or body.get('objective') or 'task')}"

def parse_priority(body, default="P2"):
    p = str(body.get("priority") or default).strip().upper()
    if p not in ("P0", "P1", "P2"):
        p = default
    return p

def build_task_md(tid, body, priority, created, status="NEW"):
    objective = (body.get("objective") or body.get("title") or tid).strip()
    context = str(body.get("context") or "").strip()
    acs = body.get("acceptance_criteria") or body.get("ac") or []
    constraints = body.get("constraints") or []
    if isinstance(acs, str):
        acs = [acs]
    if isinstance(constraints, str):
        constraints = [constraints]
    L = [f"# Task: {tid}", "",
         "**From**: Handoff Server (API)", "**To**: Claude Code",
         f"**Priority**: {priority}", f"**Created**: {created}",
         f"**Status**: {status}", ""]
    if context:
        L += ["## Context", "", context, ""]
    L += ["## Objective", "", objective, "", "## Acceptance Criteria", ""]
    L += [f"- [ ] {a}" for a in acs] or ["- [ ] (未指定)"]
    L.append("")
    if constraints:
        L += ["## Constraints", ""] + [f"- {c}" for c in constraints] + [""]
    store_note = ("SQLite 权威 + 文件投影" if AUTHORITY else "文件目录为权威")
    L += ["## Notes", "",
          f"由 Handoff Server 创建（HANDOFF_STORE={STORE}, {store_note}）。"
          + ("认领经 POST /api/claim（服务器串行化互斥）。" if AUTHORITY
             else "认领/执行仍走文件协议（mv）。"), ""]
    return "\n".join(L)

def atomic_write(path, content):
    d = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".tmp-", suffix=".md")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(content)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise

def read_file_safe(path):
    try:
        with open(path) as f:
            return f.read()
    except OSError:
        return None

# ── 权威操作（dual/db） ──────────────────────────────────────────────────────

def db_create_task(tid, body, priority, source="api"):
    """在 SQLite 创建 pending 任务。已存在且非 overwrite → 冲突。返回 (ok, err)。"""
    created = now_iso()
    objective = (body.get("objective") or body.get("title") or tid).strip()
    context = str(body.get("context") or "").strip()
    acs = body.get("acceptance_criteria") or body.get("ac") or []
    cons = body.get("constraints") or []
    markdown = body.get("markdown")  # import 路径：原文 md 作为投影内容
    c = db_conn()
    try:
        exists = c.execute("SELECT id FROM tasks WHERE id=?", (tid,)).fetchone()
        if exists and not body.get("overwrite"):
            return False, "task id exists"
        if exists:
            c.execute("""UPDATE tasks SET priority=?,status='pending',version=version+1,
                title=?,objective=?,context=?,ac=?,constraints=?,source=?,
                lease_until=NULL,updated_at=?,done_report=NULL WHERE id=?""",
                (priority, body.get("title") or objective, objective, context,
                 json.dumps(acs, ensure_ascii=False), json.dumps(cons, ensure_ascii=False),
                 source, created, tid))
        else:
            c.execute("""INSERT INTO tasks
                (id,priority,status,version,node_id,title,objective,context,ac,constraints,
                 source,lease_until,created_at,updated_at,done_report)
                VALUES (?,?,?,?,NULL,?,?,?,?,?,?,NULL,?,?,NULL)""",
                (tid, priority, "pending", 1, body.get("title") or objective, objective,
                 context, json.dumps(acs, ensure_ascii=False), json.dumps(cons, ensure_ascii=False),
                 source, created, created))
        c.commit()
    finally:
        c.close()
    if markdown:
        # 保留 OC 原文用于投影（优先于生成）
        _set_task_markdown_cache(tid, markdown)
    log_event(tid, "created", priority=priority, source=source,
              meta={"title": body.get("title"), "objective": objective})
    return True, None

_MD_CACHE = {}  # tid → 原文 md（仅 import 路径用；进程内）

def _set_task_markdown_cache(tid, md):
    _MD_CACHE[tid] = md

def task_body_md(row):
    """根据权威行生成投影用的任务 md（pending/claimed/in_progress）。"""
    if row["id"] in _MD_CACHE:
        return _MD_CACHE[row["id"]]
    body = {
        "title": row["title"], "objective": row["objective"], "context": row["context"],
        "acceptance_criteria": json.loads(row["ac"] or "[]"),
        "constraints": json.loads(row["constraints"] or "[]"),
    }
    md = build_task_md(row["id"], body, row["priority"], row["created_at"], status="NEW")
    # 附加 node_id 到投影，让 dashboard 显示实际执行节点
    if row.get("node_id"):
        md += "\n> by: " + row["node_id"]
    return md

def db_claim(node_id):
    """原子认领最高优先级 pending 任务 → in_progress。服务器串行化 = 天然互斥。
    返回认领到的任务 dict 或 None。"""
    c = db_conn()
    try:
        c.execute("BEGIN IMMEDIATE")
        rows = c.execute("SELECT * FROM tasks WHERE status='pending'").fetchall()
        if not rows:
            c.execute("COMMIT")
            return None
        rows = sorted(rows, key=lambda r: (prio_rank(r["id"]), r["created_at"], r["id"]))
        winner = rows[0]
        now = now_iso()
        lease = (datetime.now().astimezone() + timedelta(minutes=30)).isoformat(timespec="minutes")
        c.execute("""UPDATE tasks SET status='in_progress', node_id=?, version=version+1,
                     lease_until=?, updated_at=? WHERE id=?""",
                  (node_id, lease, now, winner["id"]))
        c.execute("COMMIT")
        winner = dict(winner)
        winner["status"] = "in_progress"
        winner["updated_at"] = now
        return winner
    except Exception:
        try:
            c.execute("ROLLBACK")
        except Exception:
            pass
        raise
    finally:
        c.close()

def db_done(tid, report):
    """标记完成：存 done_report，status=done，version bump。返回 (ok, err, row)。"""
    c = db_conn()
    try:
        row = c.execute("SELECT * FROM tasks WHERE id=?", (tid,)).fetchone()
        if not row:
            return False, "task not found", None
        now = now_iso()
        c.execute("""UPDATE tasks SET status='done', version=version+1, done_report=?,
                     updated_at=? WHERE id=?""",
                  (report if report is not None else "", now, tid))
        c.commit()
        row = dict(row); row["status"] = "done"; row["updated_at"] = now
        row["done_report"] = report if report is not None else ""
        return True, None, row
    finally:
        c.close()

def db_get(tid):
    c = db_conn()
    try:
        row = c.execute("SELECT * FROM tasks WHERE id=?", (tid,)).fetchone()
        return dict(row) if row else None
    finally:
        c.close()

def db_all_tasks():
    c = db_conn()
    try:
        return [dict(r) for r in c.execute("SELECT * FROM tasks").fetchall()]
    finally:
        c.close()

# ── 单向投影（仅 dual）：SQLite → 文件目录。幂等，内容不变不重写（保 mtime / 保 stale 检测） ──

def project():
    """把 SQLite 权威状态单向、幂等地反映到文件目录。dual/db 模式均可。"""
    if not AUTHORITY:
        return 0
    moved = 0
    for row in db_all_tasks():
        tid = row["id"]
        status = row["status"]
        target_rel = STATUS_DIR.get(status)
        # 该任务应存在的（目录, 内容）
        if target_rel and status in ("pending", "claimed", "in_progress"):
            content = task_body_md(row)
        elif target_rel and status == "done":
            dr = row["done_report"] or ""
            # done_report 可能是 JSON → 解析成可读 markdown
            try:
                drj = json.loads(dr)
                summary = drj.get("summary", "(no summary)")
                changes = drj.get("changes", [])
                content = "# Done: " + tid + "\n\n## Summary\n" + summary
                if changes:
                    content += "\n\n## Changes\n" + "\n".join("- " + c for c in changes)
            except (json.JSONDecodeError, TypeError):
                content = dr or f"# Done: {tid}\n"
        elif target_rel and status == "archived":
            content = read_file_safe(os.path.join(HD, target_rel, tid + ".md")) or task_body_md(row)
        else:
            content = None  # cancelled 等无投影
        # 从所有目录清除该 id，再按需写入目标
        # 附加 node_id 到投影文件末尾
        by_line = "> by: " + (row["node_id"] or "unknown") if row.get("node_id") else ""
        if content and by_line and by_line not in content:
            content += "\n" + by_line
        for d in TASK_DIRS:
            p = os.path.join(HD, d, tid + ".md")
            if target_rel and d == target_rel:
                if content is not None:
                    if read_file_safe(p) != content:
                        atomic_write(p, content)
                        moved += 1
                else:
                    if os.path.exists(p):
                        try: os.remove(p); moved += 1
                        except OSError: pass
            else:
                if os.path.exists(p):
                    try: os.remove(p); moved += 1
                    except OSError: pass
    return moved

def get_pending():
    """GET /api/tasks/pending 的统一实现。dual/db 读 SQLite；files 读 INBOX 目录。"""
    if AUTHORITY:
        rows = sorted(
            [r for r in db_all_tasks() if r["status"] == "pending"],
            key=lambda r: (prio_rank(r["id"]), r["created_at"], r["id"]),
        )
        items = []
        for r in rows:
            items.append({
                "name": r["id"] + ".md",
                "mtime": r["updated_at"] or r["created_at"],
                "desc": r["objective"] or r["title"] or "",
                "tokens": "",
                "by": r["source"] or "",
                "status": r["status"],
                "priority": r["priority"],
            })
        return items
    items = list_md("INBOX")
    items.sort(key=lambda t: (prio_rank(t["name"]), t["name"]))
    return items

# ── HTTP helpers ─────────────────────────────────────────────────────────────

def send_json(self, code, obj):
    self.send_response(code)
    self.send_header("Content-Type", "application/json; charset=utf-8")
    self.send_header("Access-Control-Allow-Origin", "*")
    self.end_headers()
    self.wfile.write(json.dumps(obj, ensure_ascii=False).encode())

def read_body(self):
    length = int(self.headers.get("Content-Length") or 0)
    if length <= 0:
        return {}, None
    if length > MAX_BODY:
        return None, "body too large"
    raw = self.rfile.read(length)
    try:
        return json.loads(raw.decode("utf-8") or "{}"), None
    except (ValueError, UnicodeDecodeError) as e:
        return None, "invalid JSON: " + str(e)

def handle_create_task(self):
    """POST /api/tasks — 创建任务。
    files: 写 INBOX/{id}.md + 日志（当前行为）。
    dual/db: 写 SQLite pending + 投影 INBOX + 日志。"""
    body, err = read_body(self)
    if err:
        return send_json(self, 400, {"error": err})
    priority = parse_priority(body)
    tid = gen_task_id(priority, body)
    if not SAFE_ID.match(tid):
        return send_json(self, 400, {"error": "invalid task id (use [A-Za-z0-9._-])"})
    created = now_iso()
    if AUTHORITY:
        ok, err = db_create_task(tid, body, priority, source="api")
        if not ok:
            return send_json(self, 409, {"error": err, "id": tid})
        project()
        path = os.path.join(HD, "INBOX", tid + ".md")
        return send_json(self, 201, {"id": tid, "path": os.path.relpath(path, HD),
                                     "priority": priority, "status": "pending", "created": created,
                                     "store": STORE})
    # files 模式：写文件（与原 server.py 行为一致）
    path = os.path.join(HD, "INBOX", tid + ".md")
    if os.path.exists(path) and not body.get("overwrite"):
        return send_json(self, 409, {"error": "task id exists", "id": tid})
    try:
        atomic_write(path, build_task_md(tid, body, priority, created))
    except OSError as e:
        return send_json(self, 500, {"error": "write failed: " + str(e)})
    log_event(tid, "created", priority=priority, source="api",
              meta={"title": body.get("title"), "objective": body.get("objective")})
    return send_json(self, 201, {"id": tid, "path": os.path.relpath(path, HD),
                                 "priority": priority, "status": "NEW", "created": created,
                                 "store": STORE})

def handle_import_task(self, tid):
    """POST /api/tasks/import — OC 以原文 md 注册任务到权威（dual/db 创建入口，非反向回灌）。
    body: {id?, priority?, markdown}. 文件名/显式 id 决定 tid。"""
    if not AUTHORITY:
        return send_json(self, 400, {"error": "import requires HANDOFF_STORE=dual|db"})
    body, err = read_body(self)
    if err:
        return send_json(self, 400, {"error": err})
    tid = (body.get("id") or tid or "").strip()
    if not tid or not SAFE_ID.match(tid):
        return send_json(self, 400, {"error": "invalid task id"})
    priority = parse_priority(body)
    body.setdefault("markdown", body.get("markdown"))
    # 从 markdown 抽个 title/objective（首行 # Task: ... 或第一段）
    md = body.get("markdown") or ""
    body.setdefault("title", tid)
    body.setdefault("objective", md.split("\n\n", 1)[0].replace("#", "").strip()[:200] or tid)
    ok, err = db_create_task(tid, body, priority, source="import")
    if not ok:
        return send_json(self, 409, {"error": err, "id": tid})
    project()
    log_event(tid, "imported", priority=priority, source="import")
    return send_json(self, 201, {"id": tid, "priority": priority, "status": "pending", "store": STORE})

def handle_claim(self):
    """POST /api/claim — 原子认领最高优先级 pending 任务（dual/db）。"""
    if not AUTHORITY:
        return send_json(self, 400, {"error": "claim requires HANDOFF_STORE=dual|db",
                                     "hint": "files 模式由 CC 本地 mv 认领"})
    body, _ = read_body(self)
    body = body or {}
    node_id = (body.get("node_id") or os.environ.get("HANDOFF_NODE_ID") or "guanj_node").strip()
    winner = db_claim(node_id)
    if not winner:
        return send_json(self, 200, {"claimed": None, "task": None, "node_id": node_id})
    project()
    log_event(winner["id"], "claimed", priority=winner["priority"], source="api",
              meta={"node_id": node_id})
    winner["claimed"] = True
    return send_json(self, 200, {"claimed": True, "task": winner, "node_id": node_id})

def handle_done(self, tid):
    """POST /api/tasks/{id}/done — 记录完成报告，status=done（dual/db）。"""
    if not AUTHORITY:
        return send_json(self, 400, {"error": "done requires HANDOFF_STORE=dual|db"})
    if not SAFE_ID.match(tid):
        return send_json(self, 400, {"error": "invalid task id"})
    body, err = read_body(self)
    if err:
        return send_json(self, 400, {"error": err})
    body = body or {}
    report = body.get("report")
    if report is None:
        # 也接受结构化字段，拼成 md
        parts = [f"# Done: {tid}"]
        if body.get("summary"):
            parts += ["", "## Summary", "", body["summary"]]
        if body.get("changes"):
            parts += ["", "## Changes"] + [f"- {c}" for c in body["changes"]]
        if body.get("verification"):
            parts += ["", "## Verification", "", body["verification"]]
        report = "\n".join(parts)
    ok, err, row = db_done(tid, report)
    if not ok:
        return send_json(self, 404, {"error": err})
    project()
    log_event(tid, "done", priority=row.get("priority"), source="api",
              meta={"node_id": row.get("node_id")})
    return send_json(self, 200, {"id": tid, "status": "done", "store": STORE})

def handle_get_task(self, tid):
    """GET /api/tasks/{id} — 读单个任务（dual/db）。"""
    if not AUTHORITY:
        return send_json(self, 400, {"error": "get-task requires HANDOFF_STORE=dual|db"})
    if not SAFE_ID.match(tid):
        return send_json(self, 400, {"error": "invalid task id"})
    row = db_get(tid)
    if not row:
        return send_json(self, 404, {"error": "task not found", "id": tid})
    row["ac"] = json.loads(row.get("ac") or "[]")
    row["constraints"] = json.loads(row.get("constraints") or "[]")
    return send_json(self, 200, {"task": row, "store": STORE})

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):  # 安静日志
        pass

    def do_GET(self):
        if self.path == "/api/nodes":
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            try:
                npath = os.path.join(HD, "nodes.json")
                with open(npath) as _f:
                    reg = json.load(_f)
                self.wfile.write(json.dumps(reg, ensure_ascii=False).encode())
            except Exception:
                self.wfile.write(b'{"nodes":[]}')
        elif self.path == "/api/templates":
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            # 扫描 shared/cc-handoff/ 下的模板文件
            tpl_dir = pathlib.Path(HD)
            templates = []
            for f in sorted(tpl_dir.glob("*-template.md")):
                name = f.stem.replace("-template", "")
                content = f.read_text(encoding="utf-8")
                # 从 frontmatter 提取 id 示例做简短说明
                desc = ""
                for line in content.split("\n"):
                    if line.strip().startswith("# "):
                        desc = line.strip("# ").strip()
                        break
                templates.append({
                    "name": name,
                    "file": f.name,
                    "description": desc,
                    "content": content
                })
            self.wfile.write(json.dumps({
                "count": len(templates),
                "templates": templates
            }, ensure_ascii=False, indent=2).encode())
        elif self.path == "/":
            if PROJECT:
                project()  # 投影幂等；渲染前确保文件在同步（内容不变不重写）
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(render().encode())
        elif self.path == "/api/tasks/pending":
            pending = get_pending()
            send_json(self, 200, {"pending": pending, "count": len(pending), "store": STORE})
        elif self.path.startswith("/api/tasks/") and self.path != "/api/tasks/":
            tid = self.path.rstrip("/").split("/")[-1]
            handle_get_task(self, tid)
        elif self.path == "/api":
            if AUTHORITY:
                project()
            inbox = list_md("INBOX")
            ip = list_md("IN_PROGRESS")
            done = list_md("DONE")
            # db 模式：用 SQLite 的 updated_at 覆盖文件 mtime
            if AUTHORITY:
                ts_map = {}
                for r in db_all_tasks():
                    ts_map[r["id"] + ".md"] = r["updated_at"]
                for lst in [inbox, ip, done]:
                    for item in lst:
                        if item["name"] in ts_map and ts_map[item["name"]]:
                            item["mtime"] = ts_map[item["name"]]
            cc_st, cc_ts = read_hb(os.path.join(HD, "STATE", "cc.heartbeat"))
            oc_st, oc_ts = read_hb(os.path.join(HD, "STATE", "openclaw.heartbeat"))
            data = {"inbox": inbox, "in_progress": ip, "done": done[:10],
                    "cc": {"status": cc_st, "last_seen": cc_ts},
                    "oc": {"status": oc_st, "last_seen": oc_ts},
                    "store": STORE}
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(data, ensure_ascii=False).encode())
        else:
            jspath = os.path.join(HD, "dashboard", os.path.basename(self.path))
            if self.path.endswith('.js') and os.path.exists(jspath):
                self.send_response(200)
                self.send_header('Content-Type', 'application/javascript')
                self.end_headers()
                with open(jspath) as _f:
                    self.wfile.write(_f.read().encode())
            else:
                self.send_response(404)
                self.end_headers()

    def do_POST(self):
        p = self.path.rstrip("/")
        if p == "/api/tasks":
            handle_create_task(self)
        elif p == "/api/claim":
            handle_claim(self)
        elif p == "/api/tasks/import":
            handle_import_task(self, "")
        elif p.startswith("/api/tasks/") and p.endswith("/done"):
            tid = p[len("/api/tasks/"):-len("/done")]
            handle_done(self, tid)
        elif p.startswith("/api/tasks/") and p.endswith("/import"):
            tid = p[len("/api/tasks/"):-len("/import")]
            handle_import_task(self, tid)
        else:
            send_json(self, 404, {"error": "not found"})

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

if __name__ == "__main__":
    for d in TASK_DIRS + ["STATE", "ALERT", "dashboard"]:
        os.makedirs(os.path.join(HD, d), exist_ok=True)
    init_db()
    if PROJECT:
        project()
    print("  Handoff Server -> http://localhost:" + str(PORT))
    print("    HANDOFF_STORE=" + STORE + (" (SQLite 权威)" if AUTHORITY else " (文件权威)")
          + (" + 文件投影" if PROJECT else ""))
    print("    GET  /            (dashboard)")
    print("    GET  /api         (board JSON)")
    print("    GET  /api/tasks/pending")
    print("    GET  /api/tasks/{id}" + ("          [dual/db]" if AUTHORITY else ""))
    print("    POST /api/tasks")
    print("    POST /api/tasks/import" + ("         [dual/db]" if AUTHORITY else ""))
    print("    POST /api/claim" + ("              [dual/db]" if AUTHORITY else ""))
    print("    POST /api/tasks/{id}/done" + ("    [dual/db]" if AUTHORITY else ""))
    BIND = os.environ.get("HANDOFF_BIND", "0.0.0.0" if AUTHORITY else "127.0.0.1")
    print(f"  Listening on {BIND}:{PORT}")
    http.server.ThreadingHTTPServer((BIND, PORT), Handler).serve_forever()
