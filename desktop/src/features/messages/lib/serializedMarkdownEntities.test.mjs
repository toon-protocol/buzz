import assert from "node:assert/strict";
import test from "node:test";

import { unescapeSerializedMarkdownHtmlEntities } from "./serializedMarkdownEntities.ts";

test("reverses tiptap-markdown's HTML entity escaping for < and >", () => {
  assert.equal(
    unescapeSerializedMarkdownHtmlEntities("if (x &gt; 5) { a &lt; b }"),
    "if (x > 5) { a < b }",
  );
});

test("leaves ampersand untouched — tiptap-markdown never escapes it", () => {
  assert.equal(
    unescapeSerializedMarkdownHtmlEntities("AT&T, Q&A &amp; more"),
    "AT&T, Q&A &amp; more",
  );
});

test("is a no-op for content with no angle brackets", () => {
  assert.equal(
    unescapeSerializedMarkdownHtmlEntities("hello world"),
    "hello world",
  );
});

test("round-trips repeated and adjacent entities", () => {
  assert.equal(
    unescapeSerializedMarkdownHtmlEntities("&lt;&gt;&lt;&gt;"),
    "<><>",
  );
});
