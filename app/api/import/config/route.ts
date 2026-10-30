import {
  ConfigSyncInputError,
  MAX_IMPORT_BYTES,
  applyImport,
  previewImport,
  validatePackage,
  validateSelections,
} from "@/lib/server/config-sync";

// POST /api/import/config
//   { package: ConfigPackage, dryRun: true }               → { items: ConfigDiffItem[] }
//   { package, dryRun: false, items?: ImportSelection[] }  → { results: ImportResultItem[] }
// items 省略 = 只应用新增项、冲突全跳过；给了就只动列出的项，冲突项 overwrite:true 才覆盖。
// 包来自另一台机器，按不可信输入处理：体积上限 + 逐字段校验（lib/server/config-sync.ts）。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_IMPORT_BYTES) {
    return Response.json({ error: "配置包过大" }, { status: 413 });
  }
  const text = await req.text();
  if (text.length > MAX_IMPORT_BYTES) {
    return Response.json({ error: "配置包过大" }, { status: 413 });
  }
  let body: { package?: unknown; dryRun?: unknown; items?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  try {
    const pkg = validatePackage(body?.package);
    if (body.dryRun === true) {
      return Response.json({ items: previewImport(pkg) });
    }
    const selections = validateSelections(body.items);
    return Response.json({ results: applyImport(pkg, selections) });
  } catch (e) {
    if (e instanceof ConfigSyncInputError) return Response.json({ error: e.message }, { status: 400 });
    return Response.json({ error: e instanceof Error ? e.message : "导入失败" }, { status: 500 });
  }
}
