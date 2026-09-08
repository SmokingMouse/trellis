# CLI 启动补齐阻塞 HTTP

- 根因：`startCliSyncWatcher` 在 instrumentation 中同步重导全部 attached 会话；独立计时 watcher 从 859ms 跑到 14484ms，事件循环 gap 14477ms。不是 listSessions 谓词扩大了 watcher 集合：watcher 独立查 origin，波 1 前后未改。
- 隔离 release + smoke.db 逐秒测量：c182e0a 首个 /login 16962ms；波 1 之前 45d4189 也有 10340ms（其镜像会话更少），证明旧问题已存在。两个 gate 都约 0.23s 报 ready。
- 修复：先建立文件监听，将离线补齐改为异步、每个会话前 yield；保留 cli-import/herdr 范围与逐会话失败隔离。不改 deploy 判据。单个超大转录仍同步处理，尚未改为 worker。
- 修复版同规模快照：首个 /login 919ms、60 个逐秒请求中的最大耗时 2510ms（59 个 200，首次为端口尚未启动）。tsc=0，280 tests=0，build=0；新增 HTTP 回归旧码 exit 1、新码 exit 0，确认请求能在离线补齐完成前响应，后续镜像仍全部补齐。
- 原始证据：`.fenjue/tasks/fj-as-adopt-ship-184a/out/` 的 smoke-new/old/fixed-timings.json、对应 server.log、startup-timing.log 与 startup-test-before.log。
- Next：小 PR 合 main，按已获授权再次 make deploy，成功后继续收编生产验活；排查期间生产 current/ADOPT 未改。
