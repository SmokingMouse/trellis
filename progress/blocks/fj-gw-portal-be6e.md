# fj-gw-portal-be6e · 统一门户控制面

## 状态

- [x] additive-only `users.role`、`invites`、共享池表迁移；gateway.db 权限收紧为 0600。
- [x] 自助注册、异步 tenantctl provision、注册状态、role 两级鉴权、admin users/invites/disable/enable/restart 基础 API。
- [ ] 共享池 CRUD、订阅编排、endpoint 标记块。
- [ ] 扩展 selftest、更新 API.md、完成 D1/D2/D3 验收。

## 边界与取舍

- 只改 `tenancy/**` 与本文件；trellis 本体 schema 文件只读。
- 外部容器操作统一经 `TRELLIS_GW_TENANTCTL` 可替换前缀执行。

## Next

实现共享池和纯函数 endpoint 注入器，再用 fake tenantctl 扩展单命令 selftest。
