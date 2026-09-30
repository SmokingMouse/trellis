import { isValidHash, materializeAttachments, resolveBlobPath } from "@/lib/server/blobs";

// Herdr 输入框的附件：文件先经现有 /api/uploads 落进 blob 库，这里再按原文件名物化到
// ~/.trellis/uploads/herdr/<hash 前 16 位>/<文件名>，返回绝对路径 —— 输入框把路径插进消息
// 文本，窗格里的 Claude Code 按路径读图 / 读文件。按 hash 分目录：同名不同内容互不覆盖。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { hash?: unknown; filename?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const hash = typeof body.hash === "string" ? body.hash.toLowerCase() : "";
  if (!isValidHash(hash)) return Response.json({ error: "invalid hash" }, { status: 400 });
  const blob = resolveBlobPath(hash);
  if (!blob) return Response.json({ error: "blob not found" }, { status: 404 });
  const filename = typeof body.filename === "string" ? body.filename : null;
  const [staged] = materializeAttachments(`herdr/${hash.slice(0, 16)}`, [
    { hash, mime: blob.mime, size: 0, filename },
  ]);
  if (!staged) return Response.json({ error: "blob not found" }, { status: 404 });
  return Response.json({ path: staged.path, mime: blob.mime });
}
