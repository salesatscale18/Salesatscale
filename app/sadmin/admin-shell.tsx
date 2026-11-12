import type { ReactNode } from "react";
import type { User } from "@/db/schema";
import { SasRoot } from "@/components/sas/root";
import { SideNavForPath } from "@/components/sas/side-nav-client";
import { displayName, initials } from "@/lib/auth/display";

/** Platform admin shell. Callers must have checked super_admin already. */
export function AdminShell({ me, children }: { me: User; children: ReactNode }) {
  return (
    <SasRoot>
      <div className="sas-shell">
        <SideNavForPath mode="admin" basePath="/sadmin" user={{ name: displayName(me), initials: initials(me) }} />
        <div className="sas-shell__main">{children}</div>
      </div>
    </SasRoot>
  );
}
