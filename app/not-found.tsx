import { ArrowLeft, FileQuestion } from "lucide-react";
import { Button, EmptyState, Icon } from "@/components/ui";

// 全站 404（未匹配的路由 + 各处 notFound()）。html/body 在 globals.css 里是
// overflow:hidden 的（画布要的），所以这里自带 h-dvh 容器。
// 「返回工作台」用 <a> 硬导航：工作台是一整棵画布状态，干净地重新载入最稳。
export default function NotFound() {
  return (
    <main className="grid h-dvh place-items-center bg-surface-canvas px-4 text-ink">
      <EmptyState
        icon={FileQuestion}
        title="找不到这个页面"
        description="链接可能已失效，或者会话已被删除。回到工作台可以从侧栏或搜索重新打开。"
        action={
          <Button asChild variant="primary">
            <a href="/">
              <Icon icon={ArrowLeft} size="sm" />
              返回工作台
            </a>
          </Button>
        }
      />
    </main>
  );
}
