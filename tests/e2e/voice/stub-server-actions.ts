/**
 * The no-cost harness bundles client components with esbuild, which (unlike Next.js) would pull a "use server"
 * module's server code into the browser bundle. The chat page's server actions resolve to this stub instead:
 * the harness never submits them.
 */
export async function resumeSmsAction(_form: FormData): Promise<void> {}
