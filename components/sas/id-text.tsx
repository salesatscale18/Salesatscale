/**
 * A sentence with one ID in it ("Order PD-10001", "Q-1001 v1"): the ID is set
 * in the code font as one run, the words around it in the text font (R5-6).
 * `size="inherit"` keeps the ID at the size of a heading. Server-safe.
 */
export function TextWithId({ text, id, size }: { text: string; id: string; size?: "inherit" }) {
  const at = id ? text.indexOf(id) : -1;
  const idSpan = <span className="sas-id" style={size ? { fontSize: "inherit" } : undefined}>{id}</span>;
  if (at < 0) return <>{text}</>;
  return <>{text.slice(0, at)}{idSpan}{text.slice(at + id.length)}</>;
}

/** "Q-1001 v1" (or "Q-1001" with no version): one ID, one code-font run with a plain space. */
export function quoteRef(number: number | string, version?: number | string | null): string {
  return version ? `Q-${number} v${version}` : `Q-${number}`;
}
