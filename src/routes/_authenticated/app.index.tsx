import { createFileRoute } from "@tanstack/react-router";
import { useCurrentUser } from "@/hooks/use-current-user";
import { AdminHome } from "@/components/admin/admin-home";
import { EmployeeHome } from "@/components/employee/employee-home";

export const Route = createFileRoute("/_authenticated/app/")({
  component: AppHome,
});

function AppHome() {
  const { data: user, isLoading } = useCurrentUser();
  if (isLoading || !user) {
    return <div className="p-6 text-center text-muted-foreground">جارٍ التحميل...</div>;
  }
  if (user.role === "admin") return <AdminHome />;
  return <EmployeeHome />;
}