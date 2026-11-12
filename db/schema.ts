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
    /** Largest discount the agent may give without approval, in basis points (playbook limit, P4 edits it). */
    maxDiscountBp: integer("max_discount_bp").notNull().default(0),
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
    email: text("email"),
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
    /** Test-lab buyers: never contacted, never counted in reports, hidden from the leads list. */
    isTest: boolean("is_test").notNull().default(false),
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
    /** Last characters of the key, shown as "sas_lead_…kX9d". */
    keyLast4: text("key_last4"),
    keyHash: text("key_hash").notNull().unique(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("lead_intake_keys_account_idx").on(t.accountId)],
);

export const intakeResult = pgEnum("intake_result", ["created", "updated", "rejected"]);

/** Every call to the intake endpoint, for "Recent deliveries" in Settings. */
export const leadIntakeDeliveries = pgTable(
  "lead_intake_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => sellerAccounts.id, { onDelete: "cascade" }),
    keyId: uuid("key_id").references(() => leadIntakeKeys.id, { onDelete: "set null" }),
    result: intakeResult("result").notNull(),
    /** Plain-language reason when rejected. */
    reason: text("reason"),
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
    /** Name as sent, so rejected deliveries can be recognised. */
    leadName: text("lead_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("lead_intake_deliveries_account_created_idx").on(t.accountId, t.createdAt)],
);

export type Lead = typeof leads.$inferSelect;
export type LeadStatus = (typeof leadStatus.enumValues)[number];
export type LeadOrigin = (typeof leadOrigin.enumValues)[number];
export type ConsentRecord = typeof consentRecords.$inferSelect;
export type LeadEvent = typeof leadEvents.$inferSelect;
export type LeadIntakeKey = typeof leadIntakeKeys.$inferSelect;
export type LeadIntakeDelivery = typeof leadIntakeDeliveries.$inferSelect;
export type IntakeResult = (typeof intakeResult.enumValues)[number];

// ---------------------------------------------------------------------------
// Catalog and quotes (implementation plan P3, migration M4)
// ---------------------------------------------------------------------------

export const catalogVersionStatus = pgEnum("catalog_version_status", ["draft", "published", "archived"]);
export const chargeType = pgEnum("charge_type", ["one_time", "recurring"]);

/**
 * A version of a seller's catalog. One draft and one published version at a
 * time; publishing archives the previous one. Quotes keep the version they were
 * priced from, so prices never change under an existing quote.
 */
export const catalogVersions = pgTable(
  "catalog_versions",
  {
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => sellerAccounts.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    status: catalogVersionStatus("status").notNull().default("draft"),
    /** True when listed prices already include tax (VAT). */
    pricesIncludeTax: boolean("prices_include_tax").notNull().default(true),
    /** Tax rate in basis points, e.g. 1800 = 18%. */
    taxRateBp: integer("tax_rate_bp").notNull().default(0),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedByUserId: uuid("published_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("catalog_versions_account_version_uq").on(t.accountId, t.version),
    uniqueIndex("catalog_versions_one_draft_uq").on(t.accountId).where(sql`${t.status} = 'draft'`),
    uniqueIndex("catalog_versions_one_published_uq").on(t.accountId).where(sql`${t.status} = 'published'`),
  ],
);

export type VolumeTier = { minQty: number; priceMinor: number };

export const catalogItems = pgTable(
  "catalog_items",
  {
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => sellerAccounts.id, { onDelete: "cascade" }),
    catalogVersionId: uuid("catalog_version_id")
      .notNull()
      .references(() => catalogVersions.id, { onDelete: "cascade" }),
    sku: text("sku").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    chargeType: chargeType("charge_type").notNull(),
    /** "month" for recurring lines; null for one-time. */
    period: text("period"),
    /** What one unit is: "sensor", "site", "gateway"… */
    unit: text("unit").notNull(),
    /** Null = price missing; such items always need custom pricing. */
    priceMinor: integer("price_minor"),
    volumeTiers: jsonb("volume_tiers").$type<VolumeTier[]>().notNull().default([]),
    /** From this quantity the seller prices the line by hand. */
    customPricingFromQty: integer("custom_pricing_from_qty"),
    active: boolean("active").notNull().default(true),
    availabilityNote: text("availability_note"),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [
    uniqueIndex("catalog_items_version_sku_uq").on(t.catalogVersionId, t.sku),
    index("catalog_items_account_idx").on(t.accountId),
  ],
);

/**
 * Fit rules the agent's fit check uses. `rule` is data, never category-specific
 * code: see lib/catalog/fit.ts for the kinds.
 */
export const fitRules = pgTable(
  "fit_rules",
  {
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => sellerAccounts.id, { onDelete: "cascade" }),
    catalogVersionId: uuid("catalog_version_id")
      .notNull()
      .references(() => catalogVersions.id, { onDelete: "cascade" }),
    rule: jsonb("rule").$type<Record<string, unknown>>().notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [index("fit_rules_version_idx").on(t.catalogVersionId)],
);

export const quoteStatus = pgEnum("quote_status", ["draft", "awaiting_approval", "sent", "replaced", "cancelled"]);

export const quotes = pgTable(
  "quotes",
  {
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => sellerAccounts.id, { onDelete: "cascade" }),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    /** Shown as Q-<number>; unique per account. */
    number: integer("number").notNull(),
    status: quoteStatus("status").notNull().default("draft"),
    currentVersion: integer("current_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("quotes_account_number_uq").on(t.accountId, t.number),
    index("quotes_account_status_idx").on(t.accountId, t.status),
    index("quotes_lead_idx").on(t.leadId),
  ],
);

export type ApprovalReason =
  | { kind: "price_missing"; sku: string }
  | { kind: "custom_pricing_qty"; sku: string; qty: number; from: number }
  | { kind: "discount_over_limit"; requestedBp: number; limitBp: number };

/** One priced version of a quote. Versions are immutable once created. */
export const quoteVersions = pgTable(
  "quote_versions",
  {
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => sellerAccounts.id, { onDelete: "cascade" }),
    quoteId: uuid("quote_id")
      .notNull()
      .references(() => quotes.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    catalogVersionId: uuid("catalog_version_id")
      .notNull()
      .references(() => catalogVersions.id),
    currency: text("currency").notNull(),
    discountBp: integer("discount_bp").notNull().default(0),
    pricesIncludeTax: boolean("prices_include_tax").notNull(),
    taxRateBp: integer("tax_rate_bp").notNull(),
    oneTimeSubtotalMinor: integer("one_time_subtotal_minor").notNull(),
    oneTimeDiscountMinor: integer("one_time_discount_minor").notNull(),
    oneTimeTaxMinor: integer("one_time_tax_minor").notNull(),
    oneTimeTotalMinor: integer("one_time_total_minor").notNull(),
    recurringSubtotalMinor: integer("recurring_subtotal_minor").notNull(),
    recurringDiscountMinor: integer("recurring_discount_minor").notNull(),
    recurringTaxMinor: integer("recurring_tax_minor").notNull(),
    recurringTotalMinor: integer("recurring_total_minor").notNull(),
    /** Period of the recurring total ("month"); null when there are no recurring lines. */
    recurringPeriod: text("recurring_period"),
    approvalReasons: jsonb("approval_reasons").$type<ApprovalReason[]>().notNull().default([]),
    approvedByUserId: uuid("approved_by_user_id").references(() => users.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    validUntil: timestamp("valid_until", { withTimezone: true }).notNull(),
    /** What changed from the previous version, in plain words. */
    changeNote: text("change_note"),
    /** "agent" | "human" | "system" */
    createdByActor: text("created_by_actor").notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    /** Same key twice → the same version (tool retries, double clicks). */
    idempotencyKey: text("idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("quote_versions_quote_version_uq").on(t.quoteId, t.version),
    uniqueIndex("quote_versions_account_idem_uq").on(t.accountId, t.idempotencyKey).where(sql`${t.idempotencyKey} is not null`),
  ],
);

export const quoteLines = pgTable(
  "quote_lines",
  {
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => sellerAccounts.id, { onDelete: "cascade" }),
    quoteVersionId: uuid("quote_version_id")
      .notNull()
      .references(() => quoteVersions.id, { onDelete: "cascade" }),
    catalogItemId: uuid("catalog_item_id").references(() => catalogItems.id, { onDelete: "set null" }),
    sku: text("sku").notNull(),
    name: text("name").notNull(),
    chargeType: chargeType("charge_type").notNull(),
    period: text("period"),
    unit: text("unit").notNull(),
    qty: integer("qty").notNull(),
    /** Null until a person prices a custom line. */
    unitPriceMinor: integer("unit_price_minor"),
    /** "list" | "tier" | "custom" */
    priceSource: text("price_source").notNull(),
    lineTotalMinor: integer("line_total_minor"),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [index("quote_lines_version_idx").on(t.quoteVersionId)],
);

export type CatalogVersion = typeof catalogVersions.$inferSelect;
export type CatalogItem = typeof catalogItems.$inferSelect;
export type FitRuleRow = typeof fitRules.$inferSelect;
export type Quote = typeof quotes.$inferSelect;
export type QuoteVersion = typeof quoteVersions.$inferSelect;
export type QuoteLine = typeof quoteLines.$inferSelect;
export type QuoteStatus = (typeof quoteStatus.enumValues)[number];

// ---------------------------------------------------------------------------
// Agent core (implementation plan P4, migration M5)
// ---------------------------------------------------------------------------

export const agentVersionStatus = pgEnum("agent_version_status", ["draft", "testing", "live", "retired"]);

/** A deal-state field the playbook asks the agent to learn. */
export type PlaybookField = {
  key: string;
  label: string;
  /** Needed before a quote, before the order form, or just useful. */
  stage: "before_quote" | "before_order_form" | "optional";
  hint?: string;
};

export type Playbook = {
  agentName: string;
  goal: string;
  tone: string;
  outcomes: { orderForm: boolean; bankTransfer: boolean; meeting: boolean };
  fields: PlaybookField[];
  objections: { objection: string; answer: string }[];
  /** Discount the agent may offer without approval, in basis points. */
  maxDiscountBp: number;
  offerMeetingWhen: string;
  handOffWhen: string;
  neverDo: string[];
};

/**
 * A version of the seller's agent (mvp-plan 3.10): a frozen package of
 * playbook, model and settings. One draft and one live version per account.
 */
export const agentVersions = pgTable(
  "agent_versions",
  {
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => sellerAccounts.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    status: agentVersionStatus("status").notNull().default("draft"),
    playbook: jsonb("playbook").$type<Playbook>().notNull(),
    model: text("model").notNull(),
    effort: text("effort").notNull().default("medium"),
    changeNote: text("change_note"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedByUserId: uuid("published_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("agent_versions_account_version_uq").on(t.accountId, t.version),
    uniqueIndex("agent_versions_one_draft_uq").on(t.accountId).where(sql`${t.status} = 'draft'`),
    uniqueIndex("agent_versions_one_live_uq").on(t.accountId).where(sql`${t.status} = 'live'`),
  ],
);

export const factStatus = pgEnum("fact_status", ["suggested", "approved", "rejected"]);

/** Approved facts the agent may state, each with where it came from. P8 adds extraction from sources. */
export const knowledgeFacts = pgTable(
  "knowledge_facts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => sellerAccounts.id, { onDelete: "cascade" }),
    topic: text("topic").notNull(),
    statement: text("statement").notNull(),
    sourceLabel: text("source_label"),
    status: factStatus("status").notNull().default("approved"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("knowledge_facts_account_idx").on(t.accountId, t.status)],
);

export const conversationStatus = pgEnum("conversation_status", ["open", "human", "closed"]);

/** One conversation with a lead on one channel. The agent never knows which channel. */
export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => sellerAccounts.id, { onDelete: "cascade" }),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    /** "testlab" now; "whatsapp" in P6. */
    channel: text("channel").notNull(),
    isTest: boolean("is_test").notNull().default(false),
    /** The agent version this conversation runs on. */
    agentVersionId: uuid("agent_version_id")
      .notNull()
      .references(() => agentVersions.id),
    status: conversationStatus("status").notNull().default("open"),
    takenOverByUserId: uuid("taken_over_by_user_id").references(() => users.id, { onDelete: "set null" }),
    language: text("language").notNull(),
    /** Scenario name for test-lab runs. */
    scenario: text("scenario"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("conversations_account_lead_idx").on(t.accountId, t.leadId), index("conversations_account_updated_idx").on(t.accountId, t.updatedAt)],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => sellerAccounts.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    /** buyer | agent | human | system */
    actor: text("actor").notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    body: text("body").notNull(),
    language: text("language"),
    agentVersionId: uuid("agent_version_id").references(() => agentVersions.id, { onDelete: "set null" }),
    /** Model usage for agent messages (cost reporting, P9). */
    usage: jsonb("usage").$type<{ inputTokens: number; outputTokens: number; cacheReadTokens: number; model: string }>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("messages_conversation_created_idx").on(t.conversationId, t.createdAt)],
);

export const toolOutcome = pgEnum("tool_outcome", ["ok", "refused", "failed"]);

/** Every tool the agent called, with its result: the trace shown in the lead card and test lab. */
export const toolCalls = pgTable(
  "tool_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => sellerAccounts.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    /** The agent reply this call led to. */
    messageId: uuid("message_id").references(() => messages.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    name: text("name").notNull(),
    input: jsonb("input").$type<Record<string, unknown>>().notNull(),
    result: jsonb("result").$type<Record<string, unknown>>().notNull(),
    outcome: toolOutcome("outcome").notNull(),
    /** For refusals: the rule that refused, in plain words. */
    rule: text("rule"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("tool_calls_conversation_idx").on(t.conversationId, t.createdAt)],
);

export type DealFieldValue = {
  value: string;
  provenance: "buyer" | "inferred" | "verified";
  updatedAt: string;
  /** User id when a person verified it. */
  verifiedBy?: string;
};

/** The live checklist of what is known about a deal (mvp-plan 3.1). One per lead, across channels. */
export const dealStates = pgTable(
  "deal_states",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => sellerAccounts.id, { onDelete: "cascade" }),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    fields: jsonb("fields").$type<Record<string, DealFieldValue>>().notNull().default({}),
    objections: jsonb("objections").$type<{ text: string; handled: boolean }[]>().notNull().default([]),
    nextStep: text("next_step"),
    summary: text("summary"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("deal_states_lead_uq").on(t.leadId)],
);

export type AgentVersion = typeof agentVersions.$inferSelect;
export type KnowledgeFact = typeof knowledgeFacts.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type ToolCall = typeof toolCalls.$inferSelect;
export type DealState = typeof dealStates.$inferSelect;
