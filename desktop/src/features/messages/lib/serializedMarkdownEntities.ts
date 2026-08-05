// tiptap-markdown's Text node serializer HTML-escapes `<` and `>` in every
// text node (see its `escapeHTML` util) regardless of the `html: false`
// config option — it's guarding against the markdown being re-parsed as
// HTML, not against how buzz stores/publishes it. Since messages are chat
// content, not documents meant to embed raw HTML, that escaping must be
// reversed before the string becomes a Nostr event's `content`: otherwise
// every other NIP-29 client (CLI, agents) sees literal `&gt;`/`&lt;`
// entities instead of the characters the user typed. Rendering stays safe
// either way — react-markdown never parses raw HTML tags without
// rehype-raw, which buzz doesn't use.
export function unescapeSerializedMarkdownHtmlEntities(
  markdown: string,
): string {
  return markdown.replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
