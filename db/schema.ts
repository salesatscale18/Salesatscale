import { boolean, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

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

// ---------------------------------------------------------------------------
// Leads and consent (implementation plan P2, migration M2)
// ---------------------------------------------------------------------------

/** Lead status words come from the design system status table. */
export const leadStatus = pgEnum("lead_status", [
  "new",
  "waiting_for_reply",
  "agent_handling",
  "human_handling",
  "meeting_booked",
  "won",
  "lost",
  "opted_out",
]);

/** How a lead reached us. */
export const leadOrigin = pgEnum("lead_origin", ["manual", "csv", "webhook"]);

export const leads = pgTable(
  "leads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => sellerAccounts.id, { onDelete: "cascade" }),
    fullName: text("full_name").notNull(),
    company: text("company"),
    /** E.164, e.g. +972525550193. Unique per account (dedupe key). */
    phone: text("phone").notNull(),
    /** Conversation language: "en" or "he". */
    language: text("language").notNull(),
    origin: leadOrigin("origin").notNull(),
    /** Seller's own label for where the lead came from, e.g. "Trade show". */
    sourceLabel: text("source_label"),
    /** ID in the seller's system (webhook/CSV); second dedupe key. */
    sourceRef: text("source_ref"),
    status: leadStatus("status").notNull().default("new"),
    /** Null = the agent owns the lead; otherwise the person on the seller's team. */
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    optedOutAt: timestamp("opted_out_at", { withTimezone: true }),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("leads_account_phone_uq").on(t.accountId, t.phone),
    uniqueIndex("leads_account_source_ref_uq").on(t.accountId, t.sourceRef).where(sql`${t.sourceRef} is not null`),
    index("leads_account_status_idx").on(t.accountId, t.status),
    index("leads_account_activity_idx").on(t.accountId, t.lastActivityAt),
  ],
);

/**
 * Proof that a lead asked to be contacted (mvp-plan 3.7). A lead without a
 * consent record cannot enter the sales flow. Append-only.
 */
export const consentRecords = pgTable(
  "consent_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => sellerAccounts.id, { onDelete: "cascade" }),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    /** Channel the person agreed to be contacted on. */
    channel: text("channel").notNull().default("whatsapp"),
    /** Exact wording the person agreed to. */
    wording: text("wording").notNull(),
    /** Where and how they agreed, e.g. "Signed contact sheet at HoReCa Expo". */
    source: text("source").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    ip: text("ip"),
    pageUrl: text("page_url"),
    recordedByUserId: uuid("recorded_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("consent_records_lead_idx").on(t.leadId)],
);

/** The lead's unified timeline. Messages, quotes and payments add their own event types later. */
export const leadEvents = pgTable(
  "lead_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => sellerAccounts.id, { onDelete: "cascade" }),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    /** buyer | agent | human | system */
    actor: text("actor").notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    data: jsonb("data").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("lead_events_lead_created_idx").on(t.leadId, t.createdAt)],
);

/** Keys for the lead intake webhook (website form). Only a SHA-256 hash is stored. */
export const leadIntakeKeys = pgTable(
  "lead_intake_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => sellerAccounts.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** First characters of the key, shown so people can tell keys apart. */
    keyPrefix: text("key_prefix").notNull(),
    keyHash: text("key_hash").notNull().unique(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("lead_intake_keys_account_idx").on(t.accountId)],
);

export type Lead = typeof leads.$inferSelect;
export type LeadStatus = (typeof leadStatus.enumValues)[number];
export type LeadOrigin = (typeof leadOrigin.enumValues)[number];
export type ConsentRecord = typeof consentRecords.$inferSelect;
export type LeadEvent = typeof leadEvents.$inferSelect;
export type LeadIntakeKey = typeof leadIntakeKeys.$inferSelect;
