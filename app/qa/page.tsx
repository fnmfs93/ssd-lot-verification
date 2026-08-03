import { redirect } from "next/navigation";
import { QaWorkspace } from "@/components/qa-workspace";
import { getCurrentUser } from "@/lib/auth/session";

export default async function QaPage() {
  const user = await getCurrentUser();

  if (!user) {
    redirect("/login");
  }

  return <QaWorkspace user={user} />;
}
