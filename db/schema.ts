import { boolean, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const userRole = pgEnum("user_role", ["user", "admin", "super_admin"]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  clerkId: text("clerk_id").notNull().unique(),
  email: text("email"),
  firstName: text("first_name"),
  lastName: text("last_name"),
  imageUrl: text("image_url"),
  role: userRole("role").notNull().default("user"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type UserRole = (typeof userRole.enumValues)[number];

// ---------------------------------------------------------------------------
// Tenancy (implementation plan P1, migration M1)
// ---------------------------------------------------------------------------

export const accountStatus = pgEnum("account_status", ["setting_up", "live", "paused"]);
export const memberRole = pgEnum("member_role", ["seller_admin"]);

/** A seller account (tenant). Every seller-side table carries account_id. */
export const sellerAccounts = pgTable(
  "seller_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull().unique(),
    tradeName: text("trade_name").notNull(),
    legalName: text("legal_name"),
    companyId: text("company_id"),
    /** ISO 3166-1 alpha-2 market, e.g. "IL". */
    market: text("market").notNull(),
    /** Buyer conversation languages, e.g. ["en", "he"]. */
    languages: text("languages").array().notNull(),
    timezone: text("timezone").notNull(),
    /** ISO 4217, e.g. "ILS". */
    currency: text("currency").notNull(),
    plan: text("plan").notNull(),
    /** Monthly spend cap in minor units of `currency`. */
    monthlySpendCapMinor: integer("monthly_spend_cap_minor").notNull(),
    dailyConversationLimit: integer("daily_conversation_limit"),
    retentionMonths: integer("retention_months").notNull().default(24),
    notes: text("notes"),
    status: accountStatus("status").notNull().default("setting_up"),
    wentLiveAt: timestamp("went_live_at", { withTimezone: true }),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("seller_accounts_status_idx").on(t.status)],
);

export const accountMembers = pgTable(
  "account_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => sellerAccounts.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: memberRole("role").notNull().default("seller_admin"),
    isOwner: boolean("is_owner").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("account_members_account_user_uq").on(t.accountId, t.userId),
    index("account_members_user_idx").on(t.userId),
  ],
);

/** Invite links. Only a SHA-256 hash of the token is stored. */
export const accountInvites = pgTable(
  "account_invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => sellerAccounts.id, { onDelete: "cascade" }),
    /** Lower-cased email the invite is for; accepting requires a verified match. */
    email: text("email").notNull(),
    inviteeName: text("invitee_name"),
    role: memberRole("role").notNull().default("seller_admin"),
    isOwner: boolean("is_owner").notNull().default(false),
    tokenHash: text("token_hash").notNull().unique(),
    invitedByUserId: uuid("invited_by_user_id").references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedByUserId: uuid("accepted_by_user_id").references(() => users.id, { onDelete: "set null" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("account_invites_account_idx").on(t.accountId)],
);

/**
 * Append-only audit trail of sensitive actions. account_id is null for
 * platform-level actions. acting_as marks a platform admin acting inside an
 * account they are not a member of.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").references(() => sellerAccounts.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actingAs: boolean("acting_as").notNull().default(false),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    details: jsonb("details").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_log_account_created_idx").on(t.accountId, t.createdAt)],
);

export type SellerAccount = typeof sellerAccounts.$inferSelect;
export type NewSellerAccount = typeof sellerAccounts.$inferInsert;
export type AccountMember = typeof accountMembers.$inferSelect;
export type AccountInvite = typeof accountInvites.$inferSelect;
export type AuditEntry = typeof auditLog.$inferSelect;
export type AccountStatus = (typeof accountStatus.enumValues)[number];
export type MemberRole = (typeof memberRole.enumValues)[number];
