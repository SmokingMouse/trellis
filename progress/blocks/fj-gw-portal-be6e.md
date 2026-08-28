# fj-gw-portal-be6e · 统一门户控制面

## 状态

- [x] additive-only `users.role`、`invites`、共享池表迁移；gateway.db 权限收紧为 0600。
- [x] 自助注册、异步 tenantctl provision、注册状态、role 两级鉴权、admin users/invites/disable/enable/restart 基础 API。
- [x] 共享池 CRUD、订阅编排、endpoint 标记块；endpoint schema 已回写 API.md。
- [x] selftest 扩展为 21 项，覆盖注册/role/admin/共享池/fake tenantctl/标记块/旧库迁移。
- [x] D1/D2/D3 最终复跑全绿，待发送 result 上行。

## 边界与取舍

- 只改 `tenancy/**` 与本文件；trellis 本体 schema 文件只读。
- 外部容器操作统一经 `TRELLIS_GW_TENANTCTL` 可替换前缀执行。

## Next

主控 settle 复跑并合并本单 5 个小步 commit。

## 验证

- `bun tenancy/gateway/selftest.ts` → exit 0，21/21 PASS，`SELFTEST_PASS`。
- `bun --bun run build` → exit 0，production build + TypeScript + static pages 完成。
- `bun tenancy/tenantctl.ts` → exit 0，usage 完整打印。
