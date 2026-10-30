import { parseKinds } from "@/lib/config-sync";
import { exportConfig } from "@/lib/server/config-sync";

// GET /api/export/config?kinds=skills,agents,approval-rules,models,settings
//   &skills=a,b        只导这些技能（应用前按勾选名单取内容用）
//   &skillContent=0    技能只给清单与哈希、不带文件内容（预览用，省流量）
// → ConfigPackage（带 format / version）。密钥一律已剔除 / 打码，见 lib/server/config-sync*.ts。
//
// 挂在 /api/export/ 下是联动底座的约定：网关对 shareOut 关闭的机器一律 403。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const kinds = parseKinds(url.searchParams.get("kinds"));
  const skillsParam = url.searchParams.get("skills");
  const skillNames = skillsParam ? skillsParam.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 500) : null;
  try {
    const pkg = exportConfig({
      kinds,
      skillNames,
      skillContent: url.searchParams.get("skillContent") !== "0",
    });
    return Response.json(pkg, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "导出失败" }, { status: 500 });
  }
}
