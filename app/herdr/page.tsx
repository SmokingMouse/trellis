import { redirect } from "next/navigation";

// Herdr 操作台的可收藏地址。工作台是单页 store 驱动的（同 /butler），总览是主区的
// 一个视图：这里只跳转，app/page.tsx 读 ?view=herdr 打开总览，并在总览期间保留该参数。
export default function HerdrRoute() {
  redirect("/?view=herdr");
}
