---
id: {note-id}                     # NOTE-{DATE}-{NODE}-{SLUG}
type: note                        # note|alert|question|ack
status: pending                   # pending|done
priority: P2                      # P0|P1|P2  (P0=立即 P1=当次 P2=有空)
created_by: guanj_oc
created_at: {YYYY-MM-DDTHH:mm+TZ}
node: any                         # any|oc-main|cc-main|threesky — 目标节点
---

# {一句话标题}

{短消息内容，1-3 行，不用长篇}

---
<!-- 短消息协议：用于快速传递不需要完整任务结构的短消息。
     命名的 INBOX/{note-id}.md → 目标节点收到后处理 → 无 DONE 归档。
     想升级为任务时：改 frontmatter type=task，补充 Objective/AC 后放回 INBOX。 -->
