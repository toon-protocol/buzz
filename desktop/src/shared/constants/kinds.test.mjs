import assert from "node:assert/strict";
import test from "node:test";

import {
  isConversationalUnreadKind,
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_V2,
  KIND_STREAM_MESSAGE_DIFF,
  KIND_SYSTEM_MESSAGE,
  KIND_JOB_REQUEST,
  KIND_JOB_ACCEPTED,
  KIND_JOB_PROGRESS,
  KIND_JOB_RESULT,
  KIND_JOB_CANCEL,
  KIND_JOB_ERROR,
  KIND_FACTORY_JOB_REQUEST,
  KIND_FACTORY_JOB_FEEDBACK,
  KIND_FACTORY_JOB_RESULT,
  KIND_MESH_COMPUTE_JOB_REQUEST,
  KIND_MESH_COMPUTE_JOB_RESULT,
  KIND_MESH_COMPUTE_JOB_FEEDBACK,
  KIND_HUDDLE_STARTED,
  KIND_HUDDLE_PARTICIPANT_JOINED,
  KIND_HUDDLE_PARTICIPANT_LEFT,
  KIND_HUDDLE_ENDED,
} from "./kinds.ts";

test("isConversationalUnreadKind_streamMessage_counts", () => {
  assert.equal(isConversationalUnreadKind(KIND_STREAM_MESSAGE), true);
});

test("isConversationalUnreadKind_streamMessageV2_counts", () => {
  // 40002 is a real message edit/v2 — must stay counted.
  assert.equal(isConversationalUnreadKind(KIND_STREAM_MESSAGE_V2), true);
});

test("isConversationalUnreadKind_streamMessageDiff_counts", () => {
  // 40008 is a real message diff — must stay counted.
  assert.equal(isConversationalUnreadKind(KIND_STREAM_MESSAGE_DIFF), true);
});

test("isConversationalUnreadKind_systemMessage_excluded", () => {
  // 40099 channel_created / member_joined rows must not inflate the pill.
  assert.equal(isConversationalUnreadKind(KIND_SYSTEM_MESSAGE), false);
});

test("isConversationalUnreadKind_allJobKinds_excluded", () => {
  for (const kind of [
    KIND_JOB_REQUEST,
    KIND_JOB_ACCEPTED,
    KIND_JOB_PROGRESS,
    KIND_JOB_RESULT,
    KIND_JOB_CANCEL,
    KIND_JOB_ERROR,
  ]) {
    assert.equal(isConversationalUnreadKind(kind), false, `kind ${kind}`);
  }
});

test("isConversationalUnreadKind_allFactoryJobKinds_excluded", () => {
  // NIP-90 factory job kinds (5097/7000/6097) are the parallel allocation for
  // 43001-43006 (toon-meta#262 decision 4) and must render the same way.
  for (const kind of [
    KIND_FACTORY_JOB_REQUEST,
    KIND_FACTORY_JOB_FEEDBACK,
    KIND_FACTORY_JOB_RESULT,
  ]) {
    assert.equal(isConversationalUnreadKind(kind), false, `kind ${kind}`);
  }
});

test("meshComputeJobResult_is_request_plus_1000", () => {
  assert.equal(
    KIND_MESH_COMPUTE_JOB_RESULT,
    KIND_MESH_COMPUTE_JOB_REQUEST + 1000,
  );
});

test("meshComputeJobFeedback_shares_the_factory_feedback_kind", () => {
  // docs/mesh-compute-job-protocol.md §1.2: kind:7000 is shared across both
  // DVM products, disambiguated by the `status` tag, not a second kind.
  assert.equal(KIND_MESH_COMPUTE_JOB_FEEDBACK, KIND_FACTORY_JOB_FEEDBACK);
});

test("isConversationalUnreadKind_huddleLifecycle_excluded", () => {
  for (const kind of [
    KIND_HUDDLE_STARTED,
    KIND_HUDDLE_PARTICIPANT_JOINED,
    KIND_HUDDLE_PARTICIPANT_LEFT,
    KIND_HUDDLE_ENDED,
  ]) {
    assert.equal(isConversationalUnreadKind(kind), false, `kind ${kind}`);
  }
});

test("isConversationalUnreadKind_undefinedKind_countsAsConversational", () => {
  // Optimistic/pending rows whose kind has not populated must not be dropped.
  assert.equal(isConversationalUnreadKind(undefined), true);
});

test("isConversationalUnreadKind_unknownKind_countsAsConversational", () => {
  // An exclude-list, not an include-list: anything not explicitly excluded
  // (e.g. a future conversational kind) is kept.
  assert.equal(isConversationalUnreadKind(12345), true);
});
