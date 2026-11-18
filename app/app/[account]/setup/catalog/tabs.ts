/**
 * The item sheet's tabs (canvas: CatalogItemSheet, CatalogItemTabs). A plain module, not the
 * "use client" forms file: a server page that imports a value from a client module gets a client
 * reference, not the array (that broke /setup/catalog with "ITEM_TABS.includes is not a function").
 */
export const ITEM_TABS = ["details", "chat", "prices"] as const;
export type ItemTab = (typeof ITEM_TABS)[number];
