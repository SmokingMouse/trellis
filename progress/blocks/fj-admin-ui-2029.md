# fj-admin-ui-2029: Trellis 管理页 + 设置页共享区

## 状态
- 状态: 完成交付 (Ready for Review)
- 契约号: fj-admin-ui-2029
- 交付范围:
  - `app/admin/` (管理页: 用户与容器运行态/健康检查/禁用启用/重启, 邀请码生成与作废, 共享池只读总览, 受 `TRELLIS_ADMIN_UI=1` env 闸控制, 未设时 404 notFound)
  - `app/settings/shares/` (设置页共享区: 注册进 `lib/settings-tabs.ts`, 「我发布的」发布表单+撤销, 「可用共享」列表+订阅/退订, 固定明示「共享 = 交出」安全警示, willRestart 重启提示)
  - `components/Header.tsx` (调 `GET /__gw/api/me` 感知 role=admin 露出管理页入口; 404/不可达静默降级)
  - `lib/gw-client.ts` & `lib/gw-types.ts` (基于 `tenancy/gateway/API.md` 的类型与客户端实现)
  - `scripts/selftest-admin-ui.ts` (内置全套 Mock 网关与断言自测)

## 验证结果 (Proof)

1. D1 全仓构建: `bun --bun run build` 通过 (Next 16.2.4 Turbopack 编译成功，包含 `/admin` 及 `/settings/shares` 路由)
2. D2 自动化 Selftest: `bun scripts/selftest-admin-ui.ts` 通过
   - 断言 1: `TRELLIS_ADMIN_UI` 未设时 `/admin` 返回 404
   - 断言 2: `TRELLIS_ADMIN_UI=1` 时 `/admin` 返回 200 且渲染管理界面
   - 断言 3: `/settings/shares` 返回 200 且明示「共享 = 交出」
   - 断言 4: Mock 网关 API 契约自测 (me/users/invites/shares/subscribe) 全部符合 `API.md`
   - 断言 5: 直连 Trellis (网关不可达/单人模式) 时 `/admin` 与 `/settings/shares` 仍 200 优雅渲染降级提示不白屏
3. D3 Lint: `bun x eslint app/admin app/settings/shares lib/gw-types.ts lib/gw-client.ts scripts/selftest-admin-ui.ts` 0 错误 0 警告通过

## API.md 缺口与疑问
- 本单开发过程严格对齐 `tenancy/gateway/API.md`，未发现阻塞性契约缺口。
- 共享池总览页面通过调用 `GET /__gw/api/shares` 读取 published + available 数据，与单租户及多租户网关实现保持一致。
