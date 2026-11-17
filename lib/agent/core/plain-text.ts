/**
 * Agent replies are chat messages, shown as plain text (WhatsApp and the
 * buyer chat). The model sometimes writes Markdown; this strips the marks a
 * buyer would see literally (scored round, 17 Nov: "**Sensors:**"), and keeps
 * the words, line breaks and list dashes.
 */
export function plainChatText(text: string): string {
  return text
    .replace(/\*\*(\S(?:[^*\n]*\S)?)\*\*/g, "$1")
    .replace(/__(\S(?:[^_\n]*\S)?)__/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[*•]\s+/gm, "- ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
