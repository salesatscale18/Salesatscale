/**
 * The no-cost harness bundles client components with esbuild, which (unlike Next.js) would pull a "use server"
 * module's server code into the browser bundle. The chat page's server actions resolve to this stub instead:
 * the harness never submits them.
 */
export async function resumeSmsAction(_form: FormData): Promise<void> {}

// app/chat/[token]/reach-actions.ts (Reach RB): the harness never books; the zone is not stored.
export async function rememberZoneAction(_token: string, _zone: string): Promise<{ ok: boolean }> {
  return { ok: true };
}
export async function bookCallAction(): Promise<never> {
  throw new Error("not in the harness");
}
export async function cancelCallAction(): Promise<never> {
  throw new Error("not in the harness");
}
export async function rescheduleAction(): Promise<never> {
  throw new Error("not in the harness");
}
