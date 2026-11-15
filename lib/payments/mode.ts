/**
 * Payment mode. "test" (default until a real provider is chosen, decision D3)
 * enables the fake provider: its webhook and the buyer's Simulate buttons.
 * Set PAYMENTS_MODE=live to switch the fake provider off everywhere.
 */
export function fakePaymentsEnabled(): boolean {
  return (process.env.PAYMENTS_MODE ?? "test").trim().toLowerCase() !== "live";
}
