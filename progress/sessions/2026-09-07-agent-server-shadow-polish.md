### 影子模式卫生项（fj-as-migrate-1-polish-60a6）

- N1–N4：vendor 排除 map 及其引用，补上上游 LICENSE；依赖键与普通版本范围从上游 runtime dependencies 生成，workspace 依赖使用 vendored manifest 中已有发布精确版本，未配置时明确报错。源码缺省位置改为同级 ../sm-toolkit，SM_TOOLKIT_DIR 可覆盖。仍从上游 94b0255 的临时归档构建，源工作树未写入。
- N5–N6：手机证据默认 out/mobile-as-shadow，可用 AS_SHADOW_OUT 覆盖；README 和 .env.example 说明三个开关/路径变量及服务端鉴权。
- N7–N9：off 优先于 socket；列表请求可在退避期立即尝试重连（1 秒防抖、并发合并）；轻点不关自动跟随，实际向上滚动才停止。P1-3R 按契约保留。
- 验证：tsc exit 0；bun test 110 pass/0 fail；两套 env -i 手机脚本 exit 0，新增轻点/4px 上滚断言通过；干净 clone ignore-scripts 安装和 Bun build exit 0；端口/锁/路径扫描 exit 0 且零输出。vendor 最终同步幂等，154 文件/663234 字节变为 79 文件/390629 字节。
- Next：交付主控独立验收，未 push。D4 原 rm 命令被自动审批拒绝，按本契约使用 scripts/verify-as-clean.ts 安全等价，明确记录未执行原命令。实际日志在本契约 out/result.md 所列路径。
