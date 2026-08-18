import { listSkills, type SkillProvider } from "@/lib/server/skills";

// Discovery/autocomplete only. Execution remains native to the selected CLI:
// Claude receives `/name`, Codex receives `$name`.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const provider: SkillProvider =
    url.searchParams.get("provider") === "codex" ? "codex" : "claude";
  return Response.json({
    skills: listSkills(provider, url.searchParams.get("workspace")).map(
      ({ name, dir, description }) => ({ name, dir, description }),
    ),
  });
}
