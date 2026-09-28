"use client"; // 错误边界必须是客户端组件

import { useEffect } from "react";
import { ArrowLeft, RotateCcw, TriangleAlert } from "lucide-react";
import { Button, EmptyState, Icon } from "@/components/ui";

// 路由段级错误边界（根布局之下的一切）。不展示 error.message 原文 —— 那通常是
// 实现细节；digest 留给排查（服务端日志里能按它找到完整堆栈）。
export default function Error({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="grid h-dvh place-items-center bg-surface-canvas px-4 text-ink">
      <EmptyState
        icon={TriangleAlert}
        title="页面出错了"
        description={
          <>
            这一页渲染时遇到了意外错误。可以先重试；如果反复出现，回到工作台再打开一次。
            {error.digest && (
              <span className="mt-1 block font-mono text-nano text-ink-faint">
                错误编号 {error.digest}
              </span>
            )}
          </>
        }
        action={
          <div className="flex items-center gap-2">
            <Button variant="primary" onClick={() => unstable_retry()}>
              <Icon icon={RotateCcw} size="sm" />
              重试
            </Button>
            <Button asChild>
              <a href="/">
                <Icon icon={ArrowLeft} size="sm" />
                返回工作台
              </a>
            </Button>
          </div>
        }
      />
    </main>
  );
}
