#!/usr/bin/env python3
"""Handoff Server — dashboard (SSR + JSON) + task REST API.

权威存储仍是文件目录（INBOX/DONE，见 ../README.md）。SQLite 仅作后台任务
日志（审计/历史），不参与认领裁决——认领互斥仍由 CC 的本地原子 `mv` 提供
（reserve-before-execute 的单机退化形式，见 ../docs/handoff-final-design.md §3.1）。
"""
import http.server, json, os, glob, re, sqlite3, tempfile
from datetime import datetime

HD = os.path.expanduser("~/.openclaw/workspace/shared/cc-handoff")
PORT = 8377
TPL_PATH = os.path.join(os.path.dirname(__file__), "index.html")
DB_PATH = os.path.join(HD, "handoff.db")          # 后台任务日志（非权威）
MAX_BODY = 1 << 20                                 # 1 MiB POST 上限
SAFE_ID = re.compile(r"^[A-Za-z0-9._-]+$")         # 防 path traversal

def read_hb(path):
    try:
        with open(path) as f:
            d = json.load(f)
            return d.get("status", "unknown"), d.get("last_seen", "")
    except:
        return "unknown", ""

def parse_frontmatter(text):
    """Parse a flat YAML frontmatter block (--- ... ---) at the very start of text.
    Returns dict[str,str]. No frontmatter → {} (旧文件兼容：调用方回退到 **From**/**To**)."""
    if not text.startswith("---"):
        return {}
    lines = text.splitlines()
    end = None
    for j in range(1, min(len(lines), 200)):
        if lines[j].strip() == "---":
            end = j
            break
    if end is None:
        return {}
    fm = {}
    for line in lines[1:end]:
        s = line.strip()
        if not s or s.startswith("#") or ":" not in s:
            continue
        k, _, v = s.partition(":")
        v = v.strip()
        if len(v) >= 2 and v[0] == '"' and v[-1] == '"':
            v = v[1:-1]
        fm[k.strip()] = v
    return fm

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
        fm = {}                       # YAML frontmatter（新规范）；旧文件为空 → 回退到 **From**/**To**
        fm_node = ""
        try:
            with open(f) as fh:
                all_lines = fh.readlines()
            fm = parse_frontmatter("".join(all_lines[:64]))
            fm_node = fm.get("node", "")
            sec = {}
            for i, l in enumerate(all_lines):
                s = l.strip()
                if s.startswith("**Tokens**") or s.startswith("**Tokens"):
                    tokens = s.split(":", 1)[-1].strip().strip("*").strip()
                    tokens = tokens.replace("{tokens}", "").strip()
                if s.startswith("**To**"):
                    to_field = s.split(":", 1)[-1].strip().strip("*").strip()
                if s.startswith("**From**") and not to_field:
                    from_field = s.split(":", 1)[-1].strip().strip("*").strip()
                for t in ["## Objective", "## Summary", "## Context"]:
                    if s.startswith(t):
                        sec[t] = i
            if dirname == "IN_PROGRESS":
                assignee = fm.get("claimed_by") or fm_node or to_field or from_field or "Claude Code"
            elif dirname == "DONE":
                assignee = fm.get("claimed_by") or fm.get("created_by") or from_field or "Claude Code"
            else:
                assignee = fm.get("created_by") or fm_node or from_field or ""
            # Map names for consistency
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
        except:
            pass
        files.append({"name": bn, "mtime": datetime.fromtimestamp(mtime).isoformat(), "desc": desc, "tokens": tokens, "by": assignee, "node": fm_node})
    files.sort(key=lambda x: x["mtime"], reverse=True)
    return files

def ago(iso):
    if not iso:
        return "--"
    try:
        s = (datetime.now() - datetime.fromisoformat(iso)).total_seconds()
    except:
        return "--"
    if s < 60:
        return "\u521a\u521a"
    if s < 3600:
        return str(round(s / 60)) + "\u5206"
    if s < 86400:
        return str(round(s / 3600)) + "\u5c0f\u65f6"
    return str(round(s / 86400)) + "\u5929"

def render_cards(items, empty_text):
    h = ""
    for t in items:
        prio = "p0" if t["name"].startswith("P0") else "p1" if t["name"].startswith("P1") else "p2"
        h += '<div class="card ' + prio + '"><span class="nm">' + t["name"] + '</span><span class="tm">' + ago(t["mtime"]) + '</span></div>'
    if not h:
        h = '<div class="emp">' + empty_text + '</div>'
    return h


def _take_next(lines, idx):
    for i in range(idx+1, min(idx+5, len(lines))):
        r = lines[i].strip()
        if r and not r.startswith("#") and not r.startswith("**") and not r.startswith("-") and not r.startswith("[") and not r.startswith("|"):
            return r[:300]
    return ""

def render():
    inbox = list_md("INBOX")
    ip = list_md("IN_PROGRESS")
    done = list_md("DONE")
    cc_st, _ = read_hb(os.path.join(HD, "STATE", "cc.heartbeat"))
    oc_st, _ = read_hb(os.path.join(HD, "STATE", "openclaw.heartbeat"))
    now = datetime.now().strftime("%H:%M")
    done_show = done[-8:][::-1]
    page = open(TPL_PATH).read()
    page = page.replace("{{NOW}}", now)
    page = page.replace("{{OC_STAT}}", oc_st)
    page = page.replace("{{CC_STAT}}", cc_st)
    page = page.replace("{{QCNT}}", str(len(inbox)))
    page = page.replace("{{IPCNT}}", str(len(ip)))
    page = page.replace("{{DONECNT}}", str(len(done)))
    page = page.replace("{{QUEUE}}", render_cards(inbox, "\u961f\u5217\u4e3a\u7a7a"))
    page = page.replace("{{PROGRESS}}", render_cards(ip, "\u6682\u65e0\u5904\u7406"))
    page = page.replace("{{DONE}}", render_cards(done_show, "\u6682\u65e0"))
    return page

# ── Handoff Server: task REST API（文件目录为权威，SQLite 仅日志） ──────────────

def init_db():
    """后台任务日志，幂等建表。不参与认领裁决。"""
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS task_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id TEXT NOT NULL,
                event TEXT NOT NULL,        -- created | ...
                priority TEXT,
                source TEXT,                -- api | file
                meta TEXT,                  -- JSON
                ts TEXT NOT NULL
            )"""
        )
        conn.commit()
    finally:
        conn.close()

def log_event(tid, event, priority=None, source="api", meta=None):
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute(
            "INSERT INTO task_log (task_id, event, priority, source, meta, ts) VALUES (?,?,?,?,?,?)",
            (tid, event, priority, source, json.dumps(meta or {}, ensure_ascii=False), now_iso()),
        )
        conn.commit()
    finally:
        conn.close()

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

def get_pending():
    """读 INBOX/（权威文件目录），按 CC 认领优先级排序。"""
    items = list_md("INBOX")
    items.sort(key=lambda t: (prio_rank(t["name"]), t["name"]))
    return items

def slugify(text, maxlen=28):
    s = re.sub(r"[^A-Za-z0-9]+", "-", str(text)).strip("-").lower()
    return (s or "task")[:maxlen]

def gen_task_id(priority, body):
    tid = str(body.get("id") or "").strip()
    if tid:
        return tid
    node = slugify(str(body.get("node") or os.environ.get("HANDOFF_NODE", "cc-main")), maxlen=16)
    slug = slugify(body.get("title") or body.get("objective") or "task")
    return f"{priority}-{today_str()}-{node}-{slug}"

def build_task_md(tid, body, priority, created):
    """按 task-template.md 格式生成任务文件（含 YAML frontmatter），CC 现有 ls/mv/DONE 流程无需改动。"""
    objective = (body.get("objective") or body.get("title") or tid).strip()
    context = str(body.get("context") or "").strip()
    acs = body.get("acceptance_criteria") or body.get("ac") or []
    constraints = body.get("constraints") or []
    if isinstance(acs, str):
        acs = [acs]
    if isinstance(constraints, str):
        constraints = [constraints]
    node = str(body.get("node") or os.environ.get("HANDOFF_NODE", "cc-main")).strip()
    created_by = str(body.get("created_by") or os.environ.get("HANDOFF_NODE", "oc-main")).strip()
    fm = ["---",
          f"id: {tid}",
          f"priority: {priority}",
          "status: pending",
          f"created_by: {created_by}",
          f"created_at: {created}",
          "claimed_by:", "claimed_at:", "done_at:",
          f"node: {node}",
          "---", ""]
    L = fm + [f"# Task: {tid}", "",
         "**From**: Handoff Server (API)", "**To**: Claude Code",
         f"**Priority**: {priority}", f"**Created**: {created}",
         "**Status**: NEW", ""]
    if context:
        L += ["## Context", "", context, ""]
    L += ["## Objective", "", objective, "",
          "## Acceptance Criteria", ""]
    L += [f"- [ ] {a}" for a in acs] or ["- [ ] (未指定)"]
    L.append("")
    if constraints:
        L += ["## Constraints", ""] + [f"- {c}" for c in constraints] + [""]
    L += ["## Notes", "",
          "由 Handoff Server `POST /api/tasks` 创建；认领/执行仍走文件协议。", ""]
    return "\n".join(L)

def atomic_write(path, content):
    d = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".tmp-", suffix=".md")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(content)
        os.replace(tmp, path)            # 原子提交
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise

def send_json(self, code, obj):
    self.send_response(code)
    self.send_header("Content-Type", "application/json; charset=utf-8")
    self.send_header("Access-Control-Allow-Origin", "*")
    self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
    self.end_headers()
    self.wfile.write(json.dumps(obj, ensure_ascii=False).encode())

def read_body(self):
    length = int(self.headers.get("Content-Length") or 0)
    if length <= 0:
        return None, "empty body"
    if length > MAX_BODY:
        return None, "body too large"
    raw = self.rfile.read(length)
    try:
        return json.loads(raw.decode("utf-8") or "{}"), None
    except (ValueError, UnicodeDecodeError) as e:
        return None, "invalid JSON: " + str(e)

def handle_create_task(self):
    """POST /api/tasks — 写入 INBOX/{id}.md + 记 SQLite 日志。不认领、不触发。"""
    body, err = read_body(self)
    if err:
        return send_json(self, 400, {"error": err})
    priority = str(body.get("priority") or "P2").strip().upper()
    if priority not in ("P0", "P1", "P2"):
        return send_json(self, 400, {"error": "priority must be P0|P1|P2"})
    tid = gen_task_id(priority, body)
    if not SAFE_ID.match(tid):
        return send_json(self, 400, {"error": "invalid task id (use [A-Za-z0-9._-])"})
    created = now_iso()
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
                                 "priority": priority, "status": "NEW", "created": created})

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/":
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(render().encode())
        elif self.path == "/api/tasks/pending":
            pending = get_pending()
            send_json(self, 200, {"pending": pending, "count": len(pending)})
        elif self.path == "/api":
            inbox = list_md("INBOX")
            ip = list_md("IN_PROGRESS")
            done = list_md("DONE")
            cc_st, cc_ts = read_hb(os.path.join(HD, "STATE", "cc.heartbeat"))
            oc_st, oc_ts = read_hb(os.path.join(HD, "STATE", "openclaw.heartbeat"))
            data = {"inbox": inbox, "in_progress": ip, "done": done,
                    "cc": {"status": cc_st, "last_seen": cc_ts},
                    "oc": {"status": oc_st, "last_seen": oc_ts}}
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self.end_headers()
            self.wfile.write(json.dumps(data).encode())
        else:
            jspath = os.path.join(os.path.dirname(__file__), os.path.basename(self.path))
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
        if self.path.rstrip("/") == "/api/tasks":
            handle_create_task(self)
        else:
            send_json(self, 404, {"error": "not found"})

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

if __name__ == "__main__":
    init_db()
    print("  Handoff Server -> http://localhost:" + str(PORT))
    print("    GET  /            (dashboard)")
    print("    GET  /api         (board JSON)")
    print("    GET  /api/tasks/pending")
    print("    POST /api/tasks")
    http.server.HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
