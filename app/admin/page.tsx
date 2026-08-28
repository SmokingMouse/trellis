import { notFound } from "next/navigation";
import { AdminDashboard } from "./AdminDashboard";

export const dynamic = "force-dynamic";

export default function AdminPage() {
  if (process.env.TRELLIS_ADMIN_UI !== "1") {
    notFound();
  }

  return <AdminDashboard />;
}
