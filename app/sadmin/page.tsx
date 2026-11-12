import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { desc } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { ensureUser } from "@/lib/ensure-user";
import { AuthBar } from "../auth-bar";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Super Admin — Sales at Scale",
  robots: { index: false, follow: false },
};

const dateFmt = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

export default async function SuperAdminPage() {
  // proxy.ts already requires sign-in; this is the authorization check.
  const me = await ensureUser();
  if (!me || me.role !== "super_admin") notFound();

  const allUsers = await db.select().from(users).orderBy(desc(users.createdAt));

  return (
    <>
      <AuthBar />
      <main className="admin">
        <div className="container">
          <h1>Super Admin</h1>
          <p className="muted">
            {allUsers.length} user{allUsers.length === 1 ? "" : "s"}
          </p>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Name</th>
                  <th>Role</th>
                  <th>Joined (UTC)</th>
                </tr>
              </thead>
              <tbody>
                {allUsers.map((u) => (
                  <tr key={u.id}>
                    <td>{u.email ?? "—"}</td>
                    <td>{[u.firstName, u.lastName].filter(Boolean).join(" ") || "—"}</td>
                    <td>{u.role}</td>
                    <td>{dateFmt.format(u.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </>
  );
}
