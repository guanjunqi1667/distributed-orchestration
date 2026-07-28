#!/usr/bin/env python3
"""Handoff Server 轻量 HTTP 客户端（标准库 urllib，无 curl 依赖）。

供 trigger-cc.sh / dispatch-cc.sh / task-done.sh / CC 直接调用。子命令：

  claim [node-id]                         → POST /api/claim            （认领，原子）
  done  <task-id> [report-file]           → POST /api/tasks/<id>/done  （报告完成；无 file 读 stdin）
  get   <task-id>                         → GET  /api/tasks/<id>
  pending                                → GET  /api/tasks/pending
  import <task-id> <markdown-file> [P0|P1|P2]  → POST /api/tasks/import（OC 注册任务）
  create <json-file>                      → POST /api/tasks            （结构化创建）

服务器地址：环境变量 HANDOFF_SERVER（默认 http://127.0.0.1:8377）。
退出码：成功 0；HTTP 非 2xx 1；用法错误 2；服务器不可达 3。
"""
import sys, os, json, urllib.request, urllib.error

BASE = os.environ.get("HANDOFF_SERVER", "http://127.0.0.1:8377").rstrip("/")


def req(method, path, body=None, raw=None):
    data = None
    headers = {}
    if raw is not None:
        data = raw.encode("utf-8")
        headers["Content-Type"] = "application/json"
    elif body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    r = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(r, timeout=10) as resp:
            txt = resp.read().decode("utf-8") or "{}"
            try:
                return resp.status, json.loads(txt)
            except ValueError:
                return resp.status, {"raw": txt}
    except urllib.error.HTTPError as e:
        try:
            payload = json.loads(e.read().decode("utf-8") or "{}")
        except ValueError:
            payload = {"error": "http %d" % e.code}
        return e.code, payload
    except urllib.error.URLError as e:
        return 0, {"error": "server unreachable: %s" % e.reason}
    except Exception as e:  # noqa
        return 0, {"error": str(e)}


def emit(code, j):
    print(json.dumps(j, ensure_ascii=False))
    if code == 0:
        return 3
    return 0 if 200 <= code < 300 else 1


def main():
    argv = sys.argv[1:]
    if not argv:
        print("usage: handoff_client.py claim|done|get|pending|import|create [...]", file=sys.stderr)
        return 2
    cmd, rest = argv[0], argv[1:]
    if cmd == "claim":
        node = rest[0] if rest else os.environ.get("HANDOFF_NODE_ID", "guanj_node")
        code, j = req("POST", "/api/claim", {"node_id": node})
        return emit(code, j)
    if cmd == "done":
        if not rest:
            print("usage: handoff_client.py done <task-id> [report-file]", file=sys.stderr)
            return 2
        tid = rest[0]
        report = None
        if len(rest) > 1:
            with open(rest[1]) as f:
                report = f.read()
        else:
            report = sys.stdin.read()
        code, j = req("POST", "/api/tasks/%s/done" % tid, {"report": report})
        return emit(code, j)
    if cmd == "get":
        if not rest:
            print("usage: handoff_client.py get <task-id>", file=sys.stderr)
            return 2
        code, j = req("GET", "/api/tasks/%s" % rest[0])
        return emit(code, j)
    if cmd == "pending":
        code, j = req("GET", "/api/tasks/pending")
        return emit(code, j)
    if cmd == "import":
        if len(rest) < 2:
            print("usage: handoff_client.py import <task-id> <markdown-file> [P0|P1|P2]", file=sys.stderr)
            return 2
        tid, mdfile = rest[0], rest[1]
        prio = rest[2] if len(rest) > 2 else "P2"
        with open(mdfile) as f:
            md = f.read()
        code, j = req("POST", "/api/tasks/import", {"id": tid, "priority": prio, "markdown": md})
        return emit(code, j)
    if cmd == "create":
        if not rest:
            print("usage: handoff_client.py create <json-file>", file=sys.stderr)
            return 2
        with open(rest[0]) as f:
            body = json.load(f)
        code, j = req("POST", "/api/tasks", body)
        return emit(code, j)
    print("unknown command: %s" % cmd, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
