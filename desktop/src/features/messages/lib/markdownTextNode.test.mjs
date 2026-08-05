import assert from "node:assert/strict";
import test from "node:test";

import { MarkdownTextWithoutHtmlEscaping } from "./markdownTextNode.ts";

/**
 * buzz#123 AC3: UI-composed content must equal CLI-read content byte for byte.
 *
 * The bug was that tiptap-markdown's text serializer HTML-escapes `<` and `>`
 * (`escapeHTML` in its `src/util/dom.js`), so those characters reached the
 * wire as `&lt;`/`&gt;` and every non-desktop reader saw literal entities.
 *
 * These tests drive the serializer this module installs, through the same
 * `state.text(...)` contract tiptap-markdown's `MarkdownSerializer` uses, and
 * assert the round trip is lossless. The case that matters most is the last
 * one: reversing the escaping downstream instead of preventing it here made a
 * user who literally typed `&lt;` receive `<`, which is a corruption the
 * original bug did NOT have.
 */

/** The serializer tiptap-markdown resolves for the `text` node. */
const serialize =
  MarkdownTextWithoutHtmlEscaping.config.addStorage().markdown.serialize;

/** Minimal stand-in for prosemirror-markdown's serializer state. */
function serializeText(text) {
  let out = "";
  serialize({ text: (value) => (out += value) }, { text });
  return out;
}

test("angle brackets reach the wire verbatim, not as HTML entities", () => {
  assert.equal(serializeText("a > b"), "a > b");
  assert.equal(serializeText("x < y"), "x < y");
  assert.equal(serializeText("a > b & x < y"), "a > b & x < y");
});

test("ampersands are untouched — tiptap-markdown never escaped them", () => {
  assert.equal(serializeText("AT&T, Q&A"), "AT&T, Q&A");
});

test("text that is itself an HTML entity survives unchanged (the un-escape bug)", () => {
  // Reversing the escaping downstream turned each of these into a bare
  // character, because by then an entity the serializer produced and one the
  // user typed are indistinguishable. Not escaping in the first place keeps
  // them intact.
  assert.equal(serializeText("&lt;"), "&lt;");
  assert.equal(serializeText("&gt;"), "&gt;");
  assert.equal(serializeText("&amp;"), "&amp;");
  assert.equal(
    serializeText("I typed &lt; literally"),
    "I typed &lt; literally",
  );
});

test("markup-looking text stays inert text", () => {
  assert.equal(serializeText("<script>"), "<script>");
});

test("an empty or absent text node serializes to nothing rather than throwing", () => {
  assert.equal(serializeText(""), "");
  let out = "";
  serialize({ text: (value) => (out += value) }, {});
  assert.equal(out, "");
});

test("the node keeps tiptap's own text-node identity", () => {
  assert.equal(MarkdownTextWithoutHtmlEscaping.name, "text");
  assert.equal(MarkdownTextWithoutHtmlEscaping.config.group, "inline");
});
