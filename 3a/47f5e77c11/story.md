---
id: 3a47f5e77c11
commit: 
branch: main
timestamp: 2026-08-18T12:36:27+08:00
commit_message: ""
files_modified: ["app/api/sessions/[id]/route.ts", "components/ChatNode.tsx", "components/GeneratedFilesBar.tsx", "components/TurnCard.tsx", "components/tools/ToolTimeline.tsx", "lib/generated-files.ts", "lib/types.ts", "scripts/test-timeline-render.tsx", "stores/sessionStore.ts"]
---

## Prompt

本地的这个「怎么访问我的 boe 机器」tab 好像切换起来还是很慢

## Summary

prod DB 是旧 schema（`cli_session_id`），main 代码期望 `claude_session_id`——这是 main 上既有的迁移缺口，与我的改动无关，但会挡部署。先确认 DB 路径能否用 env 覆盖，以便在副本上验证我的路由：


