import assert from "node:assert/strict";
import test from "node:test";

import {
  KIND_FACTORY_JOB_FEEDBACK,
  KIND_FACTORY_JOB_RESULT,
  KIND_JOB_ACCEPTED,
  KIND_JOB_PROGRESS,
  KIND_JOB_RESULT,
} from "@/shared/constants/kinds";
import { slotForFeedKind } from "./sound.ts";

test("slotForFeedKind maps the legacy job-result kind to job_result", () => {
  assert.equal(
    slotForFeedKind(KIND_JOB_RESULT, "agent_activity"),
    "job_result",
  );
});

test("slotForFeedKind maps the legacy job-progress kind to job_progress", () => {
  assert.equal(
    slotForFeedKind(KIND_JOB_PROGRESS, "agent_activity"),
    "job_progress",
  );
});

test("slotForFeedKind maps the NIP-90 factory job result kind to job_result", () => {
  assert.equal(
    slotForFeedKind(KIND_FACTORY_JOB_RESULT, "agent_activity"),
    "job_result",
  );
});

test("slotForFeedKind maps the NIP-90 factory job feedback kind to job_progress", () => {
  // kind:7000 covers the RFQ quote, increment offer, and free narration
  // (disambiguated by a `status` tag this rendering-only ticket does not
  // inspect) — the closest single legacy analog is the in-flight
  // job_progress slot, matching KIND_JOB_ACCEPTED/PROGRESS's old behavior.
  assert.equal(
    slotForFeedKind(KIND_FACTORY_JOB_FEEDBACK, "agent_activity"),
    "job_progress",
  );
});

test("mention category still wins over any job kind", () => {
  assert.equal(slotForFeedKind(KIND_JOB_ACCEPTED, "mention"), "mention");
  assert.equal(
    slotForFeedKind(KIND_FACTORY_JOB_FEEDBACK, "mention"),
    "mention",
  );
});
