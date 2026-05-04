import { getNode, refreshReferenceNode } from "@/lib/server/repo";
import { fetchByUrl } from "@/lib/server/fetch-url";
import { isProviderId, DEFAULT_PROVIDER, type ProviderId } from "@/lib/llm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const node = getNode(id);
  if (!node) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  if (node.kind !== "reference" || !node.reference) {
    return Response.json(
      { error: "not a reference node" },
      { status: 400 },
    );
  }

  // Only URL-backed references support refresh — pastes have no remote
  // source to revisit.
  if (node.reference.sourceType !== "url") {
    return Response.json(
      { error: `${node.reference.sourceType} 类型不支持刷新` },
      { status: 400 },
    );
  }
  const sourceUri = node.reference.sourceUri;
  if (!sourceUri) {
    return Response.json({ error: "missing source uri" }, { status: 400 });
  }

  // Provider may come from query string (?provider=codex) or JSON body.
  // Both are optional; fall back to DEFAULT_PROVIDER.
  let provider: ProviderId = DEFAULT_PROVIDER;
  const url = new URL(req.url);
  const fromQuery = url.searchParams.get("provider");
  if (isProviderId(fromQuery)) {
    provider = fromQuery;
  } else {
    try {
      const body = (await req.json().catch(() => null)) as
        | { provider?: unknown }
        | null;
      if (body && isProviderId(body.provider)) provider = body.provider;
    } catch {
      // best-effort
    }
  }

  const fetched = await fetchByUrl(sourceUri, provider);
  const updated = refreshReferenceNode({
    nodeId: id,
    contentMd: fetched.contentMd,
    meta: fetched.meta,
    now: Date.now(),
  });
  if (!updated) {
    return Response.json({ error: "refresh failed" }, { status: 500 });
  }
  return Response.json({ node: updated });
}
