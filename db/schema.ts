import { bigint, boolean, date, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
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
/** Who the agent contacts first once the account is live (canvas: GoLive). */
export const rolloutMode = pgEnum("rollout_mode", ["test_only", "half", "all"]);

/** One weekday's contact hours, "HH:MM" local time in the account's time zone. */
export type ContactHoursDay = { on: boolean; from: string; to: string };
/** Seven entries, index 0 = Sunday … 6 = Saturday. */
export type ContactHours = ContactHoursDay[];

export const NOTIFICATION_EVENTS = ["handoff", "approval", "payment_failed", "order_paid"] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];
/** Per-event channels the seller wants to be told on. Only email for now. */
export type NotificationPrefs = Partial<Record<NotificationEvent, { email: boolean }>>;

/** Delivery lead time range, e.g. 3 to 5 business days (account default; a market may override). */
export type DeliveryLeadTime = { minDays: number; maxDays: number; businessDays: boolean };

/** A seller account (tenant). Every seller-side table carries account_id. */
export const sellerAccounts = pgTable(
  "seller_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull().unique(),
    tradeName: text("trade_name").notNull(),
    /** Optional trade name per buyer language, e.g. { he: "פולאר" }. Empty for a language = use `tradeName` (P11 follow-up). */
    tradeNameLocal: jsonb("trade_name_local").$type<Partial<Record<string, string>>>(),
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
    /** Business address shown on the order form (Setup › Company). */
    address: text("address"),
    /** Free text shown to buyers under "Reply to us in the chat". */
    supportContact: text("support_contact"),
    /** Member who takes handoffs. Must be a member of this account (checked on save). */
    salesRepUserId: uuid("sales_rep_user_id").references(() => users.id, { onDelete: "set null" }),
    /** Null = defaults (lib/accounts/contact-hours.ts). */
    contactHours: jsonb("contact_hours").$type<ContactHours>(),
    /** Null = defaults (email on for every event). */
    notifications: jsonb("notifications").$type<NotificationPrefs>(),
    /** Null = not set. Used for the delivery ETA on quotes and the order form. */
    deliveryLeadTime: jsonb("delivery_lead_time").$type<DeliveryLeadTime>(),
    /**
     * Buyer simulator (channel "simulator"): when true, simulated chats follow
     * WhatsApp's 24-hour window and opener-template rules. Off by default.
     */
    simulateWhatsappRules: boolean("simulate_whatsapp_rules").notNull().default(false),
    /** Buyer simulator: "Add simulated buyer" is offered (and allowed on the server). On by default. */
    allowSimulatedBuyers: boolean("allow_simulated_buyers").notNull().default(true),
    rollout: rolloutMode("rollout").notNull().default("test_only"),
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
  (t) => [
    index("audit_log_account_created_idx").on(t.accountId, t.createdAt),
    index("audit_log_created_id_idx").on(t.createdAt, t.id),
  ],
);

export type SellerAccount = typeof sellerAccounts.$inferSelect;
export type NewSellerAccount = typeof sellerAccounts.$inferInsert;
export type AccountMember = typeof accountMembers.$inferSelect;
export type AccountInvite = typeof accountInvites.$inferSelect;
export type AuditEntry = typeof auditLog.$inferSelect;
export type AccountStatus = (typeof accountStatus.enumValues)[number];
export type MemberRole = (typeof memberRole.enumValues)[number];
export type RolloutMode = (typeof rolloutMode.enumValues)[number];

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
    /** Market assigned at intake (mvp-plan 3.13). Null = the home market. */
    marketId: uuid("market_id").references((): AnyPgColumn => markets.id, { onDelete: "set null" }),
    /**
     * Simulated buyers (buyer simulator): the buyer ID, e.g. "SIM-0001". Such a
     * lead has a non-dialable `phone` placeholder ("sim:SIM-0001") and is never
     * sent anything on WhatsApp. Null for every real lead.
     */
    buyerRef: text("buyer_ref"),
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
    uniqueIndex("leads_account_buyer_ref_uq").on(t.accountId, t.buyerRef).where(sql`${t.buyerRef} is not null`),
    index("leads_account_status_idx").on(t.accountId, t.status),
    index("leads_account_activity_idx").on(t.accountId, t.lastActivityAt),
    index("leads_account_created_idx").on(t.accountId, t.createdAt),
    index("leads_account_market_idx").on(t.accountId, t.marketId),
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
  (t) => [
    index("lead_events_lead_created_idx").on(t.leadId, t.createdAt),
    index("lead_events_account_created_idx").on(t.accountId, t.createdAt),
  ],
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
    /** Leads delivered with this key go to this market. Null = no market of its own. */
    marketId: uuid("market_id").references((): AnyPgColumn => markets.id, { onDelete: "set null" }),
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

/** Product or Service (mvp-plan 3.13). */
export const itemKind = pgEnum("item_kind", ["product", "service"]);
/** A custom unit's singular ("one") and plural ("other") per language, e.g. { en: { one: "crate", other: "crates" } }. */
export type UnitCustom = Record<string, { one: string; other: string }>;

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
    /** Null on items made before kinds existed: treat as "product". */
    kind: itemKind("kind"),
    /** Custom unit names per language, used when `unit` is "custom" (lib/pricing/units.ts). */
    unitCustom: jsonb("unit_custom").$type<UnitCustom>(),
    /** What the agent calls the item in chat ("wireless fridge sensor"); the SKU and name stay for the quote. Null = use `name`. */
    plainName: text("plain_name"),
    /** One sentence on what the buyer gets from the item. Null = the agent uses `description`. */
    valueLine: text("value_line"),
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
    /** Null = the home market (and every quote made before markets existed). */
    marketId: uuid("market_id").references((): AnyPgColumn => markets.id, { onDelete: "set null" }),
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
    index("quotes_account_created_idx").on(t.accountId, t.createdAt),
  ],
);

export type ApprovalReason =
  | { kind: "price_missing"; sku: string }
  | { kind: "custom_pricing_qty"; sku: string; qty: number; from: number }
  | { kind: "discount_over_limit"; requestedBp: number; limitBp: number }
  /** The agent used an approved exception from the playbook (create_quote `exception`). */
  | { kind: "exception"; id: string; text: string };

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
    /** Null = the home market. */
    marketId: uuid("market_id").references((): AnyPgColumn => markets.id, { onDelete: "set null" }),
    /** The price list version this quote was priced from (frozen). Null on quotes priced from catalog prices. */
    priceListId: uuid("price_list_id").references((): AnyPgColumn => priceLists.id),
    /**
     * SKUs of auto-added lines removed at the buyer's request (removable rules
     * only). A new version inherits them unless its input says otherwise.
     */
    removedAutoAdd: text("removed_auto_add").array().notNull().default(sql`'{}'::text[]`),
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
  /** How the agent might ask for it (optional; adapted to the buyer and language). */
  example?: string;
};

/**
 * A limit from the seller's sources that no structured setting covers (e.g.
 * "Installation is free from 3 sites"), approved by the seller. The agent may
 * offer it; a quote that uses it waits for the seller's approval.
 */
export type PlaybookException = {
  id: string;
  text: string;
  /** Where it was heard or read. */
  evidence?: { sourceId: string; locator: string; quote: string };
  approvedAt: string;
  approvedBy: string | null;
};

export type Playbook = {
  agentName: string;
  /** The agent's name per buyer language, e.g. { he: "מאיה" }. Missing = `agentName` (P11 follow-up). */
  agentNameLocal?: Partial<Record<string, string>>;
  /**
   * Automatic versions of `agentName` per buyer language (C2, 18 Nov): the name
   * transliterated into the language's script by the light pipeline model, made
   * once when the name or the market languages change (lib/agent/names-auto.ts),
   * never per message. `source` is the name they were made from: when it differs
   * from `agentName` they are stale and not used. `asWritten` lists languages the
   * model could not do for this source (buyers then see the name as written).
   * The seller's own version (`agentNameLocal`) always wins. Optional: older
   * playbooks have none.
   */
  agentNameAuto?: { source: string; values: Partial<Record<string, string>>; asWritten?: string[] };
  /** Grammatical gender the agent uses for itself (Hebrew and other gendered languages). Missing = "neutral". */
  agentGender?: "female" | "male" | "neutral";
  /**
   * Most questions the agent starts before it recommends (B2, 18 Nov), 2 to 6.
   * Missing = 3. Only questions the agent records as asked count
   * (lib/agent/core/stage.ts); the app's ceiling is 6 whatever the setting.
   */
  questionBudget?: number;
  goal: string;
  tone: string;
  outcomes: { orderForm: boolean; bankTransfer: boolean; meeting: boolean };
  fields: PlaybookField[];
  objections: { objection: string; answer: string; source?: string }[];
  /** Discount the agent may offer without approval, in basis points. */
  maxDiscountBp: number;
  offerMeetingWhen: string;
  handOffWhen: string;
  neverDo: string[];
  /** Approved exceptions (optional: older playbooks have none). */
  exceptions?: PlaybookException[];
  /**
   * Opener inputs (P11): what leads usually ask about, and the first question. All optional.
   * Written now: `topics` (up to 6, one the default) and `question`, each with an English and
   * an optional Hebrew version. Read for older playbooks: `leadsAskAbout` and `openingQuestion`
   * (one text each), used as the English default topic and question when the new parts are absent
   * (lib/agent/core/opener.ts readOpener).
   */
  opener?: {
    topics?: OpenerText[];
    /** Index into `topics`: the topic for leads that did not pick one. */
    defaultTopic?: number;
    question?: OpenerText;
    /** Older playbooks only. */
    leadsAskAbout?: string;
    /** Older playbooks only. */
    openingQuestion?: string;
  };
  /**
   * Per-situation sales plays (P11). `facts` are the seller's facts for the
   * play, each with an optional source; `own` is the seller's own card, used
   * instead of the default. Older playbooks store the facts as one `content`
   * text, read as a single fact (lib/agent/core/plays.ts playFacts).
   */
  plays?: Partial<Record<PlayKey, { facts?: PlayFact[]; content?: string; own?: PlayCard }>>;
};

/** A seller text with an English and an optional Hebrew version (P11 opener inputs). */
export type OpenerText = { en: string; he?: string };
/** One of the seller's facts for a sales play, with where it comes from (optional). */
export type PlayFact = { text: string; source?: string };

/** The selling situations the platform has a default play for (lib/agent/core/plays.ts). */
export const PLAY_KEYS = [
  "need", "fit", "value", "price_early", "too_expensive", "existing_solution", "competitor",
  "proof", "need_to_think", "send_info", "not_now", "right_size", "handoff",
] as const;
export type PlayKey = (typeof PLAY_KEYS)[number];
/** One play card: when it applies, the moves in order, a good reply and a reply to avoid. */
export type PlayCard = { when: string; do: string[]; example: string; notThis: string };

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

// ---------------------------------------------------------------------------
// Knowledge sources (mvp-plan 3.14, P8): what the seller uploads, as text.
// ---------------------------------------------------------------------------

export const sourceKind = pgEnum("source_kind", ["website", "file", "text", "call"]);
export const sourceStatus = pgEnum("source_status", ["processing", "ready", "needs_input", "partly_failed", "failed"]);

/** Where a source came from. Only the fields of its kind are set. Uploaded files are not kept, only their name and size. */
export type SourceOrigin = {
  /** website */
  url?: string;
  allowedPaths?: string[];
  /** file (and call transcripts uploaded as a file) */
  fileName?: string;
  mime?: string;
  size?: number;
  /** call */
  rep?: string;
  durationSec?: number;
  callDate?: string;
  consentConfirmed?: boolean;
  consentConfirmedAt?: string;
};

export type SourceStats = { pages?: number; pagesRead?: number; chars?: number; rows?: number; sections?: number };

/** A problem found while reading a source, with what the seller can do about it. */
export type SourceProblem = { where: string; message: string; fix: string };

/** One uploaded or fetched source. The whole cleaned text is stored here (no blob storage). */
export const sources = pgTable(
  "sources",
  {
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => sellerAccounts.id, { onDelete: "cascade" }),
    kind: sourceKind("kind").notNull(),
    title: text("title").notNull(),
    language: text("language"),
    status: sourceStatus("status").notNull().default("processing"),
    origin: jsonb("origin").$type<SourceOrigin>().notNull().default({}),
    extractedText: text("extracted_text").notNull().default(""),
    /** sha256 of extracted_text; null = needs (re-)analysis. */
    textHash: text("text_hash"),
    stats: jsonb("stats").$type<SourceStats>().notNull().default({}),
    problems: jsonb("problems").$type<SourceProblem[]>().notNull().default([]),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("sources_account_created_idx").on(t.accountId, t.createdAt)],
);

/** A source split into sections (a page, a web page, a heading, a call turn), each with a locator. */
export const sourceSections = pgTable(
  "source_sections",
  {
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => sellerAccounts.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    /** Where in the source, e.g. "p.5", "/faq", "06:12". */
    locator: text("locator").notNull(),
    heading: text("heading"),
    text: text("text").notNull(),
    tokenEstimate: integer("token_estimate").notNull().default(0),
  },
  (t) => [
    uniqueIndex("source_sections_source_position_uq").on(t.sourceId, t.position),
    index("source_sections_account_idx").on(t.accountId),
  ],
);

export const pipelineRunKind = pgEnum("pipeline_run_kind", ["facts", "playbook"]);
export const pipelineRunStatus = pgEnum("pipeline_run_status", ["queued", "running", "done", "failed"]);

/** Token counts of one run. */
export type PipelineUsage = { input: number; output: number; cacheRead: number; cacheWrite: number };

/** One AI pipeline run over sources (facts or playbook draft). Written by the pipeline lane. */
export const pipelineRuns = pgTable(
  "pipeline_runs",
  {
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => sellerAccounts.id, { onDelete: "cascade" }),
    kind: pipelineRunKind("kind").notNull(),
    status: pipelineRunStatus("status").notNull().default("queued"),
    model: text("model"),
    sourceIds: uuid("source_ids").array().notNull().default(sql`'{}'::uuid[]`),
    inputHash: text("input_hash"),
    usage: jsonb("usage").$type<PipelineUsage>(),
    costEstimateMicros: bigint("cost_estimate_micros", { mode: "number" }),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("pipeline_runs_account_created_idx").on(t.accountId, t.createdAt)],
);

export const playbookSuggestionKind = pgEnum("playbook_suggestion_kind", ["goal", "field", "objection", "limit", "tone", "never", "discovery_question"]);
export const playbookSuggestionStatus = pgEnum("playbook_suggestion_status", ["suggested", "accepted", "edited", "rejected"]);

/** Where a suggestion came from: a quote at a locator in a source. */
export type SuggestionEvidence = { sourceId: string; locator: string; quote: string };

/** A playbook item suggested from sources, waiting for the seller (accept, edit or reject). */
export const playbookSuggestions = pgTable(
  "playbook_suggestions",
  {
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => sellerAccounts.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => pipelineRuns.id, { onDelete: "set null" }),
    kind: playbookSuggestionKind("kind").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    evidence: jsonb("evidence").$type<SuggestionEvidence[]>().notNull().default([]),
    status: playbookSuggestionStatus("status").notNull().default("suggested"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedByUserId: uuid("decided_by_user_id").references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (t) => [index("playbook_suggestions_account_status_idx").on(t.accountId, t.status)],
);

export type Source = typeof sources.$inferSelect;
export type NewSource = typeof sources.$inferInsert;
export type SourceSection = typeof sourceSections.$inferSelect;
export type SourceKind = (typeof sourceKind.enumValues)[number];
export type SourceStatus = (typeof sourceStatus.enumValues)[number];
export type PipelineRun = typeof pipelineRuns.$inferSelect;
export type PlaybookSuggestion = typeof playbookSuggestions.$inferSelect;

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
    /** The source this fact was found in (P8); null for facts added by hand. */
    sourceId: uuid("source_id").references(() => sources.id, { onDelete: "set null" }),
    /** Where in the source, e.g. "p.5" or "06:12". */
    sourceLocator: text("source_locator"),
    language: text("language"),
    status: factStatus("status").notNull().default("approved"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("knowledge_facts_account_idx").on(t.accountId, t.status),
    index("knowledge_facts_account_topic_idx").on(t.accountId, t.topic),
    index("knowledge_facts_source_idx").on(t.sourceId),
  ],
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
    /**
     * The buyer's address on the channel when it is not the lead's phone:
     * WhatsApp test-lab chats with a tester's phone (the test lead keeps a fake number).
     */
    channelAddress: text("channel_address"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("conversations_account_lead_idx").on(t.accountId, t.leadId),
    index("conversations_account_updated_idx").on(t.accountId, t.updatedAt),
    index("conversations_account_agent_version_created_idx").on(t.accountId, t.agentVersionId, t.createdAt),
  ],
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
    /** Provider id of the message on a real channel (Twilio message SID). Null in the test lab. */
    channelMessageId: text("channel_message_id"),
    /** Outgoing messages on a real channel: queued | sent | delivered | read | failed | undelivered | not_sent. */
    deliveryStatus: text("delivery_status"),
    /** Provider error code and text when the message failed or was not sent. */
    deliveryError: text("delivery_error"),
    /** The approved template this message was sent with (outside the 24-hour window). */
    templateId: uuid("template_id").references((): AnyPgColumn => messageTemplates.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("messages_conversation_created_idx").on(t.conversationId, t.createdAt),
    uniqueIndex("messages_channel_message_id_uq").on(t.channelMessageId).where(sql`${t.channelMessageId} is not null`),
  ],
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
  (t) => [
    index("tool_calls_conversation_idx").on(t.conversationId, t.createdAt),
    index("tool_calls_message_idx").on(t.messageId),
    index("tool_calls_account_name_created_idx").on(t.accountId, t.name, t.createdAt),
  ],
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

// ---------------------------------------------------------------------------
// Order form, signature and payment (implementation plan P5, migration 0006)
// ---------------------------------------------------------------------------

/** Buyer fields a seller can ask for on the order form. Company name and signatory name are always on. */
export const ORDER_FORM_FIELDS = ["company_name", "company_id", "billing_address", "delivery_address", "signatory_role", "po_number", "invoice_email"] as const;
export type OrderFormField = (typeof ORDER_FORM_FIELDS)[number];

/** Per-account order form settings (canvas: Setup 6 · Order form). */
export const orderFormSettings = pgTable("order_form_settings", {
  accountId: uuid("account_id")
    .primaryKey()
    .references(() => sellerAccounts.id, { onDelete: "cascade" }),
  fields: jsonb("fields").$type<OrderFormField[]>().notNull(),
  card: boolean("card").notNull().default(true),
  bankTransfer: boolean("bank_transfer").notNull().default(true),
  /** Shown on the bank-transfer step. */
  bankDetails: text("bank_details"),
  linkValidDays: integer("link_valid_days").notNull().default(7),
  /** Seller brand color for buyer pages (logo tile, pay button). */
  brandColor: text("brand_color").notNull().default("#0f6b5a"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * Legal text, versioned per section and language. Rows are never edited: a
 * change inserts the next version. A signature records the versions agreed to.
 */
export const legalSections = pgTable(
  "legal_sections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => sellerAccounts.id, { onDelete: "cascade" }),
    /** Stable key, e.g. "sales_terms". */
    sectionKey: text("section_key").notNull(),
    title: text("title").notNull(),
    language: text("language").notNull(),
    version: integer("version").notNull(),
    body: text("body").notNull(),
    /** False when the seller removed the section (as a new version). */
    active: boolean("active").notNull().default(true),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * Null = the account default. Set = this market's own text for the section,
     * replacing the default in that market (lib/markets/legal.ts). Version
     * numbers stay one sequence per (account, section, language).
     */
    marketId: uuid("market_id").references((): AnyPgColumn => markets.id, { onDelete: "cascade" }),
  },
  (t) => [uniqueIndex("legal_sections_version_uq").on(t.accountId, t.sectionKey, t.language, t.version)],
);

export const orderFormStatus = pgEnum("order_form_status", ["sent", "opened", "signed", "link_expired"]);

export type OrderSnapshot = {
  seller: { tradeName: string; legalName: string | null; brandColor: string };
  quote: { number: number; version: number; catalogVersion: number };
  currency: string;
  pricesIncludeTax: boolean;
  lines: { sku: string; name: string; qty: number; unitPriceMinor: number; lineTotalMinor: number; recurring: boolean }[];
  oneTime: { subtotalMinor: number; discountMinor: number; taxMinor: number; totalMinor: number };
  recurring: { subtotalMinor: number; discountMinor: number; taxMinor: number; totalMinor: number };
  validUntil: string;
  legal: { key: string; title: string; version: number; body: string }[];
  fields: OrderFormField[];
  prefill: Partial<Record<OrderFormField | "signatory_name", string>>;
  paymentMethods: { card: boolean; bankTransfer: boolean };
  bankDetails: string | null;
  /** Seller's support contact shown to buyers. Missing on snapshots made before it existed. */
  supportContact?: string | null;
};

/**
 * The buyer's progress through the three-step order form (P11): what was
 * entered so far and the step to resume at. Saved on Continue / Back; never
 * a signature (the signature row is written only when step 3 completes).
 */
export type OrderFormDraft = {
  /** The step to resume at (1 order, 2 company, 3 delivery, sign and pay). */
  step: 1 | 2 | 3;
  /** Company fields as typed (keys from ORDER_FORM_FIELDS). */
  fields?: Partial<Record<OrderFormField, string>>;
  fullName?: string;
  role?: string;
  /** Delivery address "same as billing" (step 3). */
  deliverySame?: boolean;
  /** Preferred delivery: as soon as possible, or a chosen business day (YYYY-MM-DD). */
  delivery?: { kind: "asap" } | { kind: "date"; date: string | null };
  /** The last sign attempt's agreement tick (only to show the error; never pre-ticked). */
  agreed?: boolean;
};

/** The buyer's delivery preference frozen on an order: a preference, never a promise. */
export const DELIVERY_PREFERENCES = ["asap", "date"] as const;
export type DeliveryPreference = (typeof DELIVERY_PREFERENCES)[number];

/**
 * A personal order-form link for one quote version. The token is shown once
 * and stored only as a hash. The snapshot is written at creation and never changed.
 */
export const orderForms = pgTable(
  "order_forms",
  {
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => sellerAccounts.id, { onDelete: "cascade" }),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    quoteId: uuid("quote_id")
      .notNull()
      .references(() => quotes.id, { onDelete: "cascade" }),
    quoteVersionId: uuid("quote_version_id")
      .notNull()
      .references(() => quoteVersions.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    language: text("language").notNull(),
    status: orderFormStatus("status").notNull().default("sent"),
    snapshot: jsonb("snapshot").$type<OrderSnapshot>().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Set when a newer offer replaced this one ("Offer updated"). */
    supersededById: uuid("superseded_by_id"),
    /** Null = the home market. */
    marketId: uuid("market_id").references((): AnyPgColumn => markets.id, { onDelete: "set null" }),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    signedAt: timestamp("signed_at", { withTimezone: true }),
    /** The buyer's unsigned progress through the steps (null until the first Continue). */
    draft: jsonb("draft").$type<OrderFormDraft>(),
    createdBy: text("created_by").notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("order_forms_quote_idx").on(t.accountId, t.quoteId),
    index("order_forms_account_status_idx").on(t.accountId, t.status),
    index("order_forms_account_created_idx").on(t.accountId, t.createdAt),
    index("order_forms_quote_created_idx").on(t.quoteId, t.createdAt),
    index("order_forms_lead_created_idx").on(t.leadId, t.createdAt),
  ],
);

/** Checkbox plus typed name (mvp-plan open question 4: enough for the pilot). Write-once. */
export const signatures = pgTable("signatures", {
  id: uuid("id").primaryKey(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => sellerAccounts.id, { onDelete: "cascade" }),
  orderFormId: uuid("order_form_id")
    .notNull()
    .unique()
    .references(() => orderForms.id, { onDelete: "cascade" }),
  fullName: text("full_name").notNull(),
  role: text("role"),
  buyerFields: jsonb("buyer_fields").$type<Record<string, string>>().notNull(),
  agreed: boolean("agreed").notNull(),
  legalVersions: jsonb("legal_versions").$type<{ key: string; version: number }[]>().notNull(),
  /** sha256 of the snapshot plus what the buyer entered: proves what was signed. */
  documentHash: text("document_hash").notNull(),
  ip: text("ip"),
  userAgent: text("user_agent"),
  signedAt: timestamp("signed_at", { withTimezone: true }).notNull().defaultNow(),
});

export const paymentStatus = pgEnum("payment_status", ["not_started", "pending", "paid", "failed", "refunded", "bank_transfer_expected"]);

/** A signed order. Paid only when a verified provider event matches it (or a person confirms a bank transfer). */
export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => sellerAccounts.id, { onDelete: "cascade" }),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    quoteId: uuid("quote_id")
      .notNull()
      .references(() => quotes.id, { onDelete: "cascade" }),
    orderFormId: uuid("order_form_id")
      .notNull()
      .unique()
      .references(() => orderForms.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    paymentStatus: paymentStatus("payment_status").notNull().default("not_started"),
    paymentMethod: text("payment_method"),
    currency: text("currency").notNull(),
    amountDueMinor: integer("amount_due_minor").notNull(),
    recurringMinor: integer("recurring_minor").notNull(),
    recurringConsent: boolean("recurring_consent").notNull().default(false),
    /**
     * The buyer's delivery preference at signing: "asap" or "date" (then
     * preferred_delivery_date). Null on orders signed before it was asked, or
     * when the form had no delivery estimate. A preference, never a promise.
     */
    deliveryPreference: text("delivery_preference").$type<DeliveryPreference>(),
    preferredDeliveryDate: date("preferred_delivery_date", { mode: "string" }),
    /** Null = the home market. */
    marketId: uuid("market_id").references((): AnyPgColumn => markets.id, { onDelete: "set null" }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    markedPaidByUserId: uuid("marked_paid_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("orders_number_uq").on(t.accountId, t.number),
    index("orders_account_created_idx").on(t.accountId, t.createdAt),
    index("orders_account_payment_status_idx").on(t.accountId, t.paymentStatus),
    index("orders_account_paid_idx").on(t.accountId, t.paidAt),
    index("orders_quote_idx").on(t.quoteId),
    index("orders_lead_created_idx").on(t.leadId, t.createdAt),
  ],
);

export const paymentAttemptStatus = pgEnum("payment_attempt_status", ["pending", "succeeded", "failed"]);

export const paymentAttempts = pgTable("payment_attempts", {
  id: uuid("id").primaryKey(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => sellerAccounts.id, { onDelete: "cascade" }),
  orderId: uuid("order_id")
    .notNull()
    .references(() => orders.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  providerRef: text("provider_ref").notNull().unique(),
  amountMinor: integer("amount_minor").notNull(),
  currency: text("currency").notNull(),
  status: paymentAttemptStatus("status").notNull().default("pending"),
  failureReason: text("failure_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (t) => [index("payment_attempts_order_created_idx").on(t.orderId, t.createdAt)]);

/** Every inbound provider event, verified or not. The dedupe key makes processing happen once. */
export const providerEvents = pgTable("provider_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  provider: text("provider").notNull(),
  dedupeKey: text("dedupe_key").notNull(),
  signatureValid: boolean("signature_valid").notNull(),
  raw: jsonb("raw").$type<Record<string, unknown>>().notNull(),
  /** What processing concluded: "paid", "failed", "rejected: amount mismatch", "duplicate", ... */
  result: text("result").notNull(),
  accountId: uuid("account_id").references(() => sellerAccounts.id, { onDelete: "cascade" }),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("provider_events_dedupe_uq").on(t.provider, t.dedupeKey)]);

export type OrderFormSettings = typeof orderFormSettings.$inferSelect;
export type LegalSection = typeof legalSections.$inferSelect;
export type OrderForm = typeof orderForms.$inferSelect;
export type Signature = typeof signatures.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type PaymentAttempt = typeof paymentAttempts.$inferSelect;

/**
 * Fixed-window rate-limit counters (lib/security/rate-limit.ts). One row per
 * key and window; old windows are deleted opportunistically.
 */
export const rateLimits = pgTable(
  "rate_limits",
  {
    key: text("key").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(1),
  },
  (t) => [primaryKey({ name: "rate_limits_pk", columns: [t.key, t.windowStart] }), index("rate_limits_window_idx").on(t.windowStart)],
);

// ---------------------------------------------------------------------------
// Markets and price lists (mvp-plan 3.13)
// ---------------------------------------------------------------------------

export const marketStatus = pgEnum("market_status", ["setting_up", "live", "paused"]);

export type PaymentMethods = { card: boolean; bankTransfer: boolean };

/**
 * What a market sets differently from its account. A missing key means
 * "Same as account"; lib/markets/settings.ts resolves the effective values.
 */
export type MarketOverrides = {
  /** Selling languages, e.g. ["en"]. */
  languages?: string[];
  /** IANA time zone. */
  timezone?: string;
  contactHours?: ContactHours;
  paymentMethods?: PaymentMethods;
  bankDetails?: string | null;
  /** ISO dates (YYYY-MM-DD) when the agent starts no conversations. */
  holidays?: string[];
  /** Delivery lead time in this market (type only; resolved by the delivery lane). */
  leadTime?: DeliveryLeadTime;
};

/**
 * Where and how a seller sells. Every account has exactly one home market
 * (created lazily by lib/markets/service.ts ensureHomeMarket); leads that match
 * no other market belong to it.
 */
export const markets = pgTable(
  "markets",
  {
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => sellerAccounts.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    isHome: boolean("is_home").notNull().default(false),
    status: marketStatus("status").notNull().default("setting_up"),
    /** ISO 3166-1 alpha-2 codes, e.g. ["GB"]. */
    countries: text("countries").array().notNull().default(sql`'{}'::text[]`),
    /** Lead phone prefixes, e.g. ["+44"]. The longest matching prefix wins. */
    phonePrefixes: text("phone_prefixes").array().notNull().default(sql`'{}'::text[]`),
    /** Values of the intake form's country field that mean this market, e.g. ["GB", "United Kingdom"]. */
    formCountryValues: text("form_country_values").array().notNull().default(sql`'{}'::text[]`),
    /** Intake keys whose leads always come here (kept in sync with lead_intake_keys.market_id). */
    intakeKeyIds: uuid("intake_key_ids").array().notNull().default(sql`'{}'::uuid[]`),
    /** The price list (lineage) this market sells from. Several markets may share one. */
    priceListLineageId: uuid("price_list_lineage_id"),
    overrides: jsonb("overrides").$type<MarketOverrides>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("markets_account_idx").on(t.accountId),
    uniqueIndex("markets_one_home_uq").on(t.accountId).where(sql`${t.isHome}`),
  ],
);

export const priceListStatus = pgEnum("price_list_status", ["draft", "live", "archived"]);

/**
 * One row per price list VERSION. `lineage_id` is the stable id of the price
 * list across versions; each lineage has at most one draft and one live
 * version. Quotes keep the version they were priced from.
 */
export const priceLists = pgTable(
  "price_lists",
  {
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => sellerAccounts.id, { onDelete: "cascade" }),
    lineageId: uuid("lineage_id").notNull(),
    name: text("name").notNull(),
    /** ISO 4217. */
    currency: text("currency").notNull(),
    /** True when listed prices already include tax (VAT). */
    pricesIncludeTax: boolean("prices_include_tax").notNull().default(true),
    /** Tax rate in basis points, e.g. 1800 = 18%. */
    taxRateBp: integer("tax_rate_bp").notNull().default(0),
    validFrom: date("valid_from", { mode: "string" }),
    version: integer("version").notNull(),
    status: priceListStatus("status").notNull().default("draft"),
    /** The version this one was copied from (the previous version, or the source of "Copy and adjust"). */
    copiedFromId: uuid("copied_from_id").references((): AnyPgColumn => priceLists.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedByUserId: uuid("published_by_user_id").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    index("price_lists_account_idx").on(t.accountId),
    uniqueIndex("price_lists_lineage_version_uq").on(t.lineageId, t.version),
    uniqueIndex("price_lists_one_draft_uq").on(t.lineageId).where(sql`${t.status} = 'draft'`),
    uniqueIndex("price_lists_one_live_uq").on(t.lineageId).where(sql`${t.status} = 'live'`),
  ],
);

export type RecurringPeriod = "month" | "year";

/**
 * A SKU's prices in one price list version. No row = "Not sold" in that list.
 * Per part (one-time, recurring): charged=false means the part is not
 * charged; charged=true with a null price means "Price missing", which blocks
 * publishing.
 */
export const priceListEntries = pgTable(
  "price_list_entries",
  {
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => sellerAccounts.id, { onDelete: "cascade" }),
    priceListId: uuid("price_list_id")
      .notNull()
      .references(() => priceLists.id, { onDelete: "cascade" }),
    sku: text("sku").notNull(),
    oneTimeCharged: boolean("one_time_charged").notNull().default(false),
    oneTimeMinor: integer("one_time_minor"),
    oneTimeTiers: jsonb("one_time_tiers").$type<VolumeTier[]>().notNull().default([]),
    recurringCharged: boolean("recurring_charged").notNull().default(false),
    recurringMinor: integer("recurring_minor"),
    /** "month" | "year"; set when the recurring part is charged. */
    recurringPeriod: text("recurring_period").$type<RecurringPeriod>(),
    recurringTiers: jsonb("recurring_tiers").$type<VolumeTier[]>().notNull().default([]),
    /** From this quantity the seller prices the item by hand. */
    customPricingFromQty: integer("custom_pricing_from_qty"),
  },
  (t) => [uniqueIndex("price_list_entries_list_sku_uq").on(t.priceListId, t.sku)],
);

export type Market = typeof markets.$inferSelect;
export type MarketStatus = (typeof marketStatus.enumValues)[number];
export type PriceList = typeof priceLists.$inferSelect;
export type PriceListStatus = (typeof priceListStatus.enumValues)[number];
export type PriceListEntry = typeof priceListEntries.$inferSelect;
export type ItemKind = (typeof itemKind.enumValues)[number];

// ---------------------------------------------------------------------------
// WhatsApp channel (implementation plan P6, migration M6). Provider: Twilio (D2).
// The Twilio account SID and auth token live in env vars, never in the database.
// ---------------------------------------------------------------------------

export const channelConnectionStatus = pgEnum("channel_connection_status", ["active", "disabled"]);

/**
 * A seller's WhatsApp sender: a number registered as a WhatsApp sender in the
 * platform's Twilio account. Inbound messages are routed to the account by the
 * number they were sent to, so a number belongs to one account only.
 */
export const channelConnections = pgTable(
  "channel_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => sellerAccounts.id, { onDelete: "cascade" }),
    /** "whatsapp" */
    channel: text("channel").notNull().default("whatsapp"),
    /** "twilio" */
    provider: text("provider").notNull().default("twilio"),
    /** Sender number, E.164 (e.g. +14155238886). */
    senderNumber: text("sender_number").notNull(),
    displayName: text("display_name"),
    /** Optional Twilio Messaging Service SID (MG...); when set, sends go through it. */
    messagingServiceSid: text("messaging_service_sid"),
    /** The market this number serves. Null = every market without its own number. */
    marketId: uuid("market_id").references((): AnyPgColumn => markets.id, { onDelete: "set null" }),
    status: channelConnectionStatus("status").notNull().default("active"),
    /**
     * Team phones (E.164) that may test the draft agent on this number. Their
     * messages open test-lab conversations, never touch real leads, and work
     * before the account is live.
     */
    testerNumbers: text("tester_numbers").array().notNull().default(sql`'{}'::text[]`),
    lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }),
    lastOutboundAt: timestamp("last_outbound_at", { withTimezone: true }),
    /** The latest send error, cleared by the next successful send. */
    lastError: text("last_error"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("channel_connections_channel_sender_uq").on(t.channel, t.senderNumber),
    index("channel_connections_account_idx").on(t.accountId),
  ],
);

export const templatePurpose = pgEnum("template_purpose", ["opener", "follow_up"]);
export const templateStatus = pgEnum("template_status", ["pending", "approved", "rejected"]);

/**
 * WhatsApp message templates (Twilio Content templates, HX...). The only
 * messages allowed outside the 24-hour window. Variables: {{1}} = the lead's
 * first name, {{2}} = the seller's trade name.
 */
export const messageTemplates = pgTable(
  "message_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => sellerAccounts.id, { onDelete: "cascade" }),
    /** Twilio Content SID (HX...). */
    contentSid: text("content_sid").notNull(),
    name: text("name").notNull(),
    language: text("language").notNull(),
    purpose: templatePurpose("purpose").notNull(),
    /** Template text with {{n}} placeholders, shown in the app and stored on sent messages. */
    body: text("body").notNull(),
    /** WhatsApp category, e.g. MARKETING or UTILITY. */
    category: text("category"),
    status: templateStatus("status").notNull().default("pending"),
    rejectionReason: text("rejection_reason"),
    statusCheckedAt: timestamp("status_checked_at", { withTimezone: true }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("message_templates_account_content_uq").on(t.accountId, t.contentSid),
    index("message_templates_account_purpose_idx").on(t.accountId, t.purpose, t.language),
  ],
);

export type ChannelConnection = typeof channelConnections.$inferSelect;
export type MessageTemplate = typeof messageTemplates.$inferSelect;
export type TemplatePurpose = (typeof templatePurpose.enumValues)[number];
export type TemplateStatus = (typeof templateStatus.enumValues)[number];

/**
 * Buyer simulator links (`/chat/<token>`): a login-free, WhatsApp-like chat
 * page for one lead. The token is "<link id>.<HMAC>" (lib/simulator/token.ts);
 * only its sha256 is stored. Reset revokes the row and issues a new one, so the
 * old link stops working at once. At most one active link per lead.
 */
export const simulatorLinks = pgTable(
  "simulator_links",
  {
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => sellerAccounts.id, { onDelete: "cascade" }),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("simulator_links_account_lead_idx").on(t.accountId, t.leadId),
    uniqueIndex("simulator_links_one_active_uq").on(t.leadId).where(sql`${t.revokedAt} is null`),
  ],
);

export type SimulatorLink = typeof simulatorLinks.$inferSelect;


// ---------------------------------------------------------------------------
// Follow-ups (P11 follow-up, decision D6: one platform scheduler, Vercel Cron)
// ---------------------------------------------------------------------------

export const followUpStatus = pgEnum("follow_up_status", ["scheduled", "sent", "cancelled", "failed"]);

/**
 * A time the agent agreed with the buyer to come back. One platform-wide
 * scheduler (app/api/cron/follow-ups) sends due rows as a fixed template
 * message (no model call), within the account's contact hours.
 */
export const followUps = pgTable(
  "follow_ups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => sellerAccounts.id, { onDelete: "cascade" }),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    /** What the buyer and agent agreed to talk about, in the buyer's words where possible. */
    topic: text("topic"),
    language: text("language").notNull(),
    status: followUpStatus("status").notNull().default("scheduled"),
    /** Why it was cancelled or failed (buyer replied first, opted out, paid, outside window…). */
    reason: text("reason"),
    sentMessageId: uuid("sent_message_id"),
    attempts: integer("attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("follow_ups_due_idx").on(t.status, t.dueAt),
    index("follow_ups_lead_idx").on(t.accountId, t.leadId),
  ],
);

export type FollowUp = typeof followUps.$inferSelect;
