/**
 * The add/edit form's simple checks, shared by the server (parseLeadPageInput in rules.ts, the
 * authority) and the browser (form-shell.tsx checks them before sending, so a refused save shows
 * at once). Pure: no database, no network; safe in a client bundle.
 */
import { normalizeAddress } from "./origin";

/** The server's own messages for these fields (rules.ts uses the same constants). */
export const PAGE_ERRORS = {
  nameEmpty: "Enter a name for the page.",
  addressInvalid: "Enter the page address, like https://example.com/offer.",
  addressRequired: "Enter the address of the page the form is on.",
} as const;

/**
 * Whether a connection needs the page address. "Our form on your page": yes, it is
 * the allowed origin our form runs on. "Your own form": optional but recommended
 * (without it, and with no other addresses, its sends are refused and the first one
 * is shown as "Seen on …, add it?"). "Button or link": optional.
 */
export const addressRequired = (connection: string) => connection === "snippet";

/** The simple cases only (empty name, an empty or invalid address where it is needed or typed); the server checks the rest. */
export function quickPageErrors(f: { name: string; connection: string; address: string }): Partial<Record<"name" | "address", string>> {
  const errors: Partial<Record<"name" | "address", string>> = {};
  if (!f.name.trim()) errors.name = PAGE_ERRORS.nameEmpty;
  const address = f.address.trim();
  if (address && !normalizeAddress(address)) errors.address = PAGE_ERRORS.addressInvalid;
  else if (!address && addressRequired(f.connection)) errors.address = PAGE_ERRORS.addressRequired;
  return errors;
}
