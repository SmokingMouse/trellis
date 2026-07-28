# Open Failures

## 待查

- **主目录 `next dev` 起的实例前端永远停在「加载中…」，React 从不 hydrate**（S75，:3164 实测）。证据：`document.body.firstElementChild` 上 `__react*` fiber key 数 = 0（纯 SSR HTML）、全部 `_next` chunk 均 200、console 无 error、`/api/sessions` 只有 curl 打的没有浏览器打的（说明 effect 从未跑）、`matchMedia` 正常。**已排除**是 S75 改动引入——`git stash` 回干净 main 后同样复现。**假设**（未验）：Turbopack 那条 `Parsing CSS source code failed`（`app/globals.css` 的 `::highlight(branch-source)` 被判非法伪元素，dev 日志里刷了 7 次）打断了 client bundle 的执行链。**下个 session 先打这个**：临时注释掉该 CSS 规则重起 dev，看 fiber 是否挂上；挂上即坐实，那条规则要么换写法要么加 `@supports` 包一层。prod（`next start`）不受影响，:3088 实测正常。

## 已结案

（暂无）
