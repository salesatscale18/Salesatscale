/**
 * Free model availability check for Admin › Operations: asks the Models API
 * (`client.models.retrieve`) about each configured model id. It sends no
 * prompt and uses no tokens. Results are kept in the audit log, which is also
 * the 10-minute cache: a newer check is only made when the last one is older.
 */
import Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "@/db/types";
import { auditLog } from "@/db/schema";
import { writeAudit } from "@/lib/accounts/audit";
import { configuredModels, type ModelRole } from "./models";

export const CHECK_TTL_MS = 10 * 60 * 1000;
export const CHECK_ACTION = "ai.models_checked";

export type ModelCheck = {
  role: ModelRole;
  model: string;
  available: boolean;
  displayName: string | null;
  /** Context window (max_input_tokens), when the API returns it. */
  contextWindow: number | null;
  /** Max output tokens, when the API returns it. */
  maxOutput: number | null;
  /** Why it is not available, in plain words. */
  error: string | null;
};

export type ModelsCheckResult = { checkedAt: string; results: ModelCheck[] };

/** The part of the SDK client the check uses (a fake in tests). */
export type ModelsClient = { models: Pick<Anthropic["models"], "retrieve"> };

function errorText(e: unknown): string {
  if (e instanceof Anthropic.NotFoundError) return "Model not found for this API key";
  if (e instanceof Anthropic.AuthenticationError) return "The API key was rejected";
  if (e instanceof Anthropic.PermissionDeniedError) return "This API key has no access to the model";
  if (e instanceof Anthropic.RateLimitError) return "Rate limited, try again later";
  if (e instanceof Anthropic.APIConnectionError) return "Could not reach the API";
  if (e instanceof Anthropic.APIError) return `API error ${e.status ?? ""}`.trim();
  return "Unexpected error";
}

/** Retrieves each configured model. Never throws: a failure is reported per model. */
export async function checkModels(client: ModelsClient, models = configuredModels()): Promise<ModelCheck[]> {
  return Promise.all(
    models.map(async ({ role, model }): Promise<ModelCheck> => {
      try {
        const m = await client.models.retrieve(model);
        return {
          role, model, available: true, displayName: m.display_name ?? null,
          contextWindow: m.max_input_tokens ?? null, maxOutput: m.max_tokens ?? null, error: null,
        };
      } catch (e) {
        return { role, model, available: false, displayName: null, contextWindow: null, maxOutput: null, error: errorText(e) };
      }
    }),
  );
}

/** The latest stored check, if any (whatever its age). */
export async function lastModelsCheck(db: Db): Promise<ModelsCheckResult | null> {
  const [row] = await db
    .select({ details: auditLog.details, createdAt: auditLog.createdAt })
    .from(auditLog)
    .where(and(isNull(auditLog.accountId), eq(auditLog.action, CHECK_ACTION)))
    .orderBy(desc(auditLog.createdAt))
    .limit(1);
  if (!row?.details || !Array.isArray((row.details as { results?: unknown }).results)) return null;
  return { checkedAt: row.createdAt.toISOString(), results: (row.details as { results: ModelCheck[] }).results };
}

/**
 * Runs the check unless one ran within CHECK_TTL_MS for the same model ids,
 * and audits each real check. Returns whether the result came from the cache.
 */
export async function runModelsCheck(
  db: Db, client: ModelsClient, actorUserId: string, now = new Date(),
): Promise<ModelsCheckResult & { cached: boolean }> {
  const models = configuredModels();
  const [recent] = await db
    .select({ details: auditLog.details, createdAt: auditLog.createdAt })
    .from(auditLog)
    .where(and(isNull(auditLog.accountId), eq(auditLog.action, CHECK_ACTION), gt(auditLog.createdAt, new Date(now.getTime() - CHECK_TTL_MS))))
    .orderBy(desc(auditLog.createdAt))
    .limit(1);
  const cached = recent?.details as { results?: ModelCheck[] } | null | undefined;
  const sameModels = cached?.results && cached.results.length === models.length
    && models.every((m) => cached.results!.some((r) => r.role === m.role && r.model === m.model));
  if (recent && sameModels) return { checkedAt: recent.createdAt.toISOString(), results: cached!.results!, cached: true };

  const results = await checkModels(client, models);
  await writeAudit(db, { userId: actorUserId, actingAs: false }, { accountId: null, action: CHECK_ACTION, details: { results } });
  return { checkedAt: now.toISOString(), results, cached: false };
}
