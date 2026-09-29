import { redirect } from "next/navigation";

// 管家入口的可收藏地址。工作台是单页 store 驱动的，管家就是其中一条会话，
// 所以这里只做跳转，真正的「打开最近管家会话 / 落草稿首页」在 app/page.tsx。
export default function ButlerRoute() {
  redirect("/?butler=1");
}
