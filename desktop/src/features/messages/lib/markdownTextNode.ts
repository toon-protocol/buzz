import { Node } from "@tiptap/core";

/**
 * tiptap's `text` node, declared locally rather than imported: the app does
 * not depend on `@tiptap/extension-text` directly (it arrives inside
 * StarterKit), and this is its whole definition — the same two lines
 * tiptap-markdown itself writes in `src/extensions/nodes/text.js` before
 * extending it.
 */
const BaseText = Node.create({
  name: "text",
  group: "inline",
});

/**
 * The `text` node with tiptap-markdown's HTML escaping removed (buzz#123).
 *
 * tiptap-markdown's own text serializer is
 * `state.text(escapeHTML(node.text))` (`src/extensions/nodes/text.js`), and
 * its `escapeHTML` replaces `<` and `>` — but not `&` — regardless of the
 * `html: false` option. It is guarding against the markdown being re-parsed
 * as HTML, not against how buzz stores or publishes it. Since buzz messages
 * are chat content on a shared NIP wire, that escaping made every other
 * reader (CLI, agents) see literal `&lt;`/`&gt;` entities instead of the
 * characters the user typed.
 *
 * Fixing it HERE rather than by un-escaping the serialized string is what
 * makes it lossless: an un-escape downstream cannot tell an entity the
 * serializer produced from one the user literally typed, so a message
 * containing the text `&lt;` would arrive as `<`. Nothing is escaped now, so
 * nothing needs un-escaping.
 *
 * `getMarkdownSpec` (tiptap-markdown `src/util/extensions.js`) resolves a
 * node's spec as `{...defaultMarkdownSpec, ...extension.storage.markdown}` —
 * the extension's own storage wins over the packaged default — which is the
 * same supported override `spoilerMark.ts` uses for its mark.
 *
 * `state.text(node.text)` keeps prosemirror-markdown's ordinary markdown
 * escaping (the second argument defaults to `true`), so `getMarkdownFromEditor`'s
 * existing `\\([`*\\~[\]_])` unescape still sees exactly what it saw before.
 * Only the HTML-entity layer is gone.
 */
export const MarkdownTextWithoutHtmlEscaping = BaseText.extend({
  addStorage() {
    return {
      markdown: {
        serialize(
          state: { text: (value: string) => void },
          node: { text?: string },
        ) {
          state.text(node.text ?? "");
        },
      },
    };
  },
});
