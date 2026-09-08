import { isAdoptEnabled } from "@/lib/as-config";
import { getDB } from "@/lib/server/sqlite";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  if (!isAdoptEnabled()) return Response.json({enabled:false});
  return Response.json({enabled:true,sessions:getDB().prepare(`SELECT a.session_id AS id,MAX(a.updated_at,s.updated_at) AS revision,a.status,a.backend
    FROM as_adoptions a JOIN sessions s ON s.id=a.session_id`).all()});
}
