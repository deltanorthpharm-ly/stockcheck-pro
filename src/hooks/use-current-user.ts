import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type CurrentUser = {
  id: string;
  username: string;
  display_name: string;
  role: "admin" | "employee" | null;
};

async function fetchCurrentUser(): Promise<CurrentUser | null> {
  const { data: userRes } = await supabase.auth.getUser();
  const user = userRes.user;
  if (!user) return null;
  const [{ data: profile }, { data: roles }] = await Promise.all([
    supabase.from("profiles").select("username, display_name").eq("id", user.id).maybeSingle(),
    supabase.from("user_roles").select("role").eq("user_id", user.id),
  ]);
  const role =
    roles?.some((r) => r.role === "admin")
      ? "admin"
      : roles?.some((r) => r.role === "employee")
        ? "employee"
        : null;
  return {
    id: user.id,
    username: profile?.username ?? user.email?.split("@")[0] ?? "",
    display_name: profile?.display_name ?? profile?.username ?? "",
    role,
  };
}

export function useCurrentUser() {
  const qc = useQueryClient();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(true);
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_IN" || event === "SIGNED_OUT" || event === "USER_UPDATED") {
        qc.invalidateQueries({ queryKey: ["current-user"] });
      }
    });
    return () => sub.subscription.unsubscribe();
  }, [qc]);
  return useQuery({
    queryKey: ["current-user"],
    queryFn: fetchCurrentUser,
    enabled: ready,
    staleTime: 30_000,
  });
}

export function usernameToEmail(username: string): string {
  return `${username.trim().toLowerCase()}@stockcount.local`;
}