import "server-only";
import {
  readModelConfigState,
  upsertProvider,
  deleteProvider,
  setDefaultModel,
  type UpsertProviderInput,
} from "@/lib/server/model-config";

// Model-config editor API. Sits behind the same proxy.ts auth gate as every
// other route. Responses only ever carry hasKey booleans — raw key values go
// in (POST body) but never come back out.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(readModelConfigState());
}

export async function PATCH(req: Request) {
  let body: { defaultModel?: string };
  try {
    body = (await req.json()) as { defaultModel?: string };
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (typeof body?.defaultModel !== "string" || !body.defaultModel.trim()) {
    return Response.json({ error: "缺 defaultModel" }, { status: 400 });
  }
  try {
    return Response.json(setDefaultModel(body.defaultModel.trim()));
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "update default failed" },
      { status: 400 },
    );
  }
}

export async function POST(req: Request) {
  let body: UpsertProviderInput;
  try {
    body = (await req.json()) as UpsertProviderInput;
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (typeof body?.name !== "string" || !Array.isArray(body?.models)) {
    return Response.json({ error: "缺 name / models" }, { status: 400 });
  }
  try {
    return Response.json(upsertProvider(body));
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "save failed" },
      { status: 400 },
    );
  }
}

export async function DELETE(req: Request) {
  const name = new URL(req.url).searchParams.get("name");
  if (!name) return Response.json({ error: "缺 name" }, { status: 400 });
  try {
    return Response.json(deleteProvider(name));
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "delete failed" },
      { status: 400 },
    );
  }
}
