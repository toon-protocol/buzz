import assert from "node:assert/strict";
import test from "node:test";
import { matchClosingKeywordIssueNumber } from "./closing-keyword.mjs";

test("matches Closes #N", () => {
  assert.equal(
    matchClosingKeywordIssueNumber("One-line summary.\n\nCloses #170\n\nMore body."),
    "170",
  );
});

test("matches lowercase closes/fixes/resolves and their inflections, case-insensitively", () => {
  assert.equal(matchClosingKeywordIssueNumber("closes #12"), "12");
  assert.equal(matchClosingKeywordIssueNumber("Fixes #34"), "34");
  assert.equal(matchClosingKeywordIssueNumber("fixed #34"), "34");
  assert.equal(matchClosingKeywordIssueNumber("Resolves #56"), "56");
  assert.equal(matchClosingKeywordIssueNumber("RESOLVED #56"), "56");
  assert.equal(matchClosingKeywordIssueNumber("Fix #78"), "78");
});

test("matches with a colon between the keyword and the reference", () => {
  assert.equal(matchClosingKeywordIssueNumber("Closes: #170"), "170");
});

test("does not match 'Part of #N'", () => {
  assert.equal(matchClosingKeywordIssueNumber("Part of #170"), null);
});

test("does not match a bare issue reference with no keyword", () => {
  assert.equal(matchClosingKeywordIssueNumber("See #170 for context."), null);
});

test("returns null for a body with no keyword at all", () => {
  assert.equal(matchClosingKeywordIssueNumber("Just a plain PR description."), null);
});

test("returns the first match when a body somehow has more than one", () => {
  assert.equal(matchClosingKeywordIssueNumber("Closes #1\n\nAlso fixes #2"), "1");
});
