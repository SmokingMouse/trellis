import { Suspense } from "react";
import { RoleSettingsDetail } from "@/components/RoleSettingsDetail";

// Next 16：page 的 params 是 Promise，在服务端 await 后把 id 交给客户端组件。
// 详情组件用 useSearchParams 读 ?tab=，按 Next 的要求包一层 Suspense（不包的话
// 预渲染期会让整棵树退回客户端渲染，生产构建直接报错）。
export default async function RoleSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense>
      <RoleSettingsDetail id={decodeURIComponent(id)} />
    </Suspense>
  );
}
