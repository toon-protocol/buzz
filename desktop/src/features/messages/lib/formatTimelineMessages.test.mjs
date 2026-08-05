import assert from "node:assert/strict";
import test from "node:test";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";

import {
  collectMessageAuthorPubkeys,
  collectReactionActorPubkeys,
  countTopLevelTimelineRows,
  formatTimelineMessages,
  isTimelineContentEvent,
} from "./formatTimelineMessages.ts";
import {
  CHANNEL_AUX_EVENT_KINDS,
  CHANNEL_TIMELINE_CONTENT_KINDS,
  KIND_FACTORY_JOB_FEEDBACK,
  KIND_FACTORY_JOB_REQUEST,
  KIND_FACTORY_JOB_RESULT,
  KIND_HUDDLE_ENDED,
  KIND_HUDDLE_STARTED,
} from "@/shared/constants/kinds";

const HEX64_A =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HEX64_B =
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PUBKEY_A =
  "1111111111111111111111111111111111111111111111111111111111111111";
const PUBKEY_B =
  "2222222222222222222222222222222222222222222222222222222222222222";
const RELAY_SECRET = new Uint8Array(32).fill(3);
const RELAY_PUBKEY = getPublicKey(RELAY_SECRET);
const CHANNEL_ID = "36411e44-0e2d-4cfe-bd6e-567eb169db9f";

function streamMessage(overrides = {}) {
  return {
    id: HEX64_A,
    pubkey: PUBKEY_A,
    kind: 9,
    created_at: 1_700_000_000,
    content: "hello world",
    tags: [["h", CHANNEL_ID]],
    sig: "sig",
    ...overrides,
  };
}

function deletionEvent(kind, targetId, overrides = {}) {
  return {
    id: HEX64_B,
    pubkey: PUBKEY_B,
    kind,
    created_at: 1_700_000_001,
    content: "",
    tags: [
      ["h", CHANNEL_ID],
      ["e", targetId],
    ],
    sig: "sig",
    ...overrides,
  };
}

function streamEdit(targetId, content, overrides = {}) {
  return {
    id: HEX64_B,
    pubkey: PUBKEY_A,
    kind: 40003,
    created_at: 1_700_000_001,
    content,
    tags: [
      ["h", CHANNEL_ID],
      ["e", targetId],
    ],
    sig: "sig",
    ...overrides,
  };
}

function huddleStarted(overrides = {}) {
  return {
    id: HEX64_B,
    pubkey: PUBKEY_A,
    kind: KIND_HUDDLE_STARTED,
    created_at: 1_700_000_001,
    content: JSON.stringify({
      ephemeral_channel_id: "8d764100-fd8f-44cf-9c98-6d8fbd739b8c",
    }),
    tags: [["h", CHANNEL_ID]],
    sig: "sig",
    ...overrides,
  };
}

// buzz#125: NIP-90 factory job events (5097 request / 6097 result / 7000
// feedback) — already timeline content kinds, but with no renderer until this
// ticket. These fixtures cover empty-content events too, since that's the
// real on-wire shape for 5097/6097 (see factoryJob{Request,Result}.ts).
function factoryJobRequest(overrides = {}) {
  return {
    id: HEX64_B,
    pubkey: PUBKEY_A,
    kind: KIND_FACTORY_JOB_REQUEST,
    created_at: 1_700_000_001,
    content: "",
    tags: [
      ["h", CHANNEL_ID],
      ["i", "Refactor the auth module", "text"],
      ["bid", "5000000", "usdc"],
    ],
    sig: "sig",
    ...overrides,
  };
}

function factoryJobResult(overrides = {}) {
  return {
    id: HEX64_B,
    pubkey: PUBKEY_A,
    kind: KIND_FACTORY_JOB_RESULT,
    created_at: 1_700_000_001,
    content: "",
    tags: [
      ["h", CHANNEL_ID],
      ["e", HEX64_A, "", "root"],
      ["outcome", "completed"],
      ["increment", "3", "3"],
    ],
    sig: "sig",
    ...overrides,
  };
}

function factoryJobFeedback(overrides = {}) {
  return {
    id: HEX64_B,
    pubkey: PUBKEY_A,
    kind: KIND_FACTORY_JOB_FEEDBACK,
    created_at: 1_700_000_001,
    content: "Running the test suite now",
    tags: [
      ["h", CHANNEL_ID],
      ["e", HEX64_A, "", "root"],
      ["status", "processing"],
    ],
    sig: "sig",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Keystone regression: aux events (edits/deletions) apply by `#e` reference,
// NOT by time-window overlap. This is the invariant the split-query +
// `#e`-backfill fix depends on: an edit/deletion can be loaded long after the
// message it targets — even with a far-future `created_at` — and must still
// apply. If the reducer ever gated aux application on timestamp proximity, a
// late edit/delete for a visible old message would silently render stale.
// ---------------------------------------------------------------------------

test("a far-future edit still rewrites the body of an old message", () => {
  const old = streamMessage({ created_at: 1_700_000_000 });
  const lateEdit = streamEdit(HEX64_A, "edited body", {
    created_at: 1_900_000_000,
  });
  const out = formatTimelineMessages([old, lateEdit], null, undefined, null);
  assert.equal(out.length, 1, "the message should still render");
  assert.equal(
    out[0].body,
    "edited body",
    "the far-future edit must overlay the old message's body regardless of the time gap",
  );
  assert.equal(out[0].edited, true, "the message must be marked edited");
});

test("a far-future deletion still hides an old message", () => {
  const old = streamMessage({ created_at: 1_700_000_000 });
  const lateDeletion = deletionEvent(9005, HEX64_A, {
    created_at: 1_900_000_000,
  });
  const out = formatTimelineMessages(
    [old, lateDeletion],
    null,
    undefined,
    null,
  );
  assert.equal(
    out.length,
    0,
    "the far-future deletion must filter out the old message regardless of the time gap",
  );
});

test("kind:5 (NIP-09) deletion hides the target message", () => {
  const events = [streamMessage(), deletionEvent(5, HEX64_A)];
  const out = formatTimelineMessages(events, null, undefined, null);
  assert.equal(
    out.length,
    0,
    "the kind:9 message should be filtered out by the kind:5 deletion",
  );
});

test("kind:9005 (NIP-29 / Buzz-native) deletion hides the target message", () => {
  // This is the actual reported bug: agents emit kind:9005 deletes via the
  // CLI. Without recognizing 9005 as a deletion marker the message stayed
  // rendered until manual refresh.
  const events = [streamMessage(), deletionEvent(9005, HEX64_A)];
  const out = formatTimelineMessages(events, null, undefined, null);
  assert.equal(
    out.length,
    0,
    "the kind:9 message should be filtered out by the kind:9005 deletion",
  );
});

test("non-deletion event kinds do NOT hide the target message", () => {
  // Sanity check: only kind:5 and kind:9005 are treated as deletion markers.
  // A kind:7 reaction with the same `e` tag must not erase the target.
  const reaction = {
    id: HEX64_B,
    pubkey: PUBKEY_B,
    kind: 7,
    created_at: 1_700_000_001,
    content: "+",
    tags: [
      ["h", CHANNEL_ID],
      ["e", HEX64_A],
    ],
    sig: "sig",
  };
  const events = [streamMessage(), reaction];
  const out = formatTimelineMessages(events, null, undefined, null);
  assert.equal(out.length, 1, "the kind:9 message should still be visible");
});

test("user-signed actor tag does not affect timeline identity or profile loading", () => {
  const events = [
    streamMessage({
      tags: [
        ["h", CHANNEL_ID],
        ["actor", PUBKEY_B],
      ],
    }),
  ];

  const profiles = {
    [PUBKEY_A]: {
      displayName: "Real signer",
      avatarUrl: "https://example.test/signer.png",
      nip05Handle: null,
      ownerPubkey: null,
    },
    [PUBKEY_B]: {
      displayName: "Spoofed admin",
      avatarUrl: "https://example.test/admin.png",
      nip05Handle: null,
      ownerPubkey: null,
    },
  };
  const members = [
    {
      pubkey: PUBKEY_A,
      role: "member",
      isAgent: false,
      joinedAt: "2026-01-01T00:00:00Z",
      displayName: "Real signer",
    },
    {
      pubkey: PUBKEY_B,
      role: "owner",
      isAgent: false,
      joinedAt: "2026-01-01T00:00:00Z",
      displayName: "Spoofed admin",
    },
  ];

  assert.deepEqual(collectMessageAuthorPubkeys(events, RELAY_PUBKEY), [
    PUBKEY_A,
  ]);

  const [message] = formatTimelineMessages(
    events,
    null,
    undefined,
    null,
    profiles,
    members,
    undefined,
    undefined,
    RELAY_PUBKEY,
  );

  assert.equal(message.pubkey, PUBKEY_A);
  assert.equal(message.signerPubkey, PUBKEY_A);
  assert.equal(message.author, "Real signer");
  assert.equal(message.avatarUrl, "https://example.test/signer.png");
  assert.equal(message.role, "member");
});

test("relay-signed actor tag resolves the delegated timeline author", () => {
  const event = finalizeEvent(
    {
      kind: 9,
      created_at: 1_700_000_000,
      content: "hello world",
      tags: [
        ["h", CHANNEL_ID],
        ["actor", PUBKEY_B],
      ],
    },
    RELAY_SECRET,
  );
  const profiles = {
    [PUBKEY_B]: {
      displayName: "Delegated user",
      avatarUrl: "https://example.test/delegated.png",
      nip05Handle: null,
      ownerPubkey: null,
    },
  };

  const [message] = formatTimelineMessages(
    [event],
    null,
    undefined,
    null,
    profiles,
    undefined,
    undefined,
    undefined,
    RELAY_PUBKEY,
  );

  assert.equal(message.pubkey, PUBKEY_B);
  assert.equal(message.signerPubkey, RELAY_PUBKEY);
  assert.equal(message.author, "Delegated user");
});

test("collectReactionActorPubkeys returns active kind:7 actors only", () => {
  const reactionId = `${"c".repeat(64)}`;
  const deletedReactionId = `${"d".repeat(64)}`;
  const actor = PUBKEY_B.toUpperCase();
  const events = [
    streamMessage(),
    {
      id: reactionId,
      pubkey: actor,
      kind: 7,
      created_at: 1_700_000_001,
      content: "+",
      tags: [
        ["h", CHANNEL_ID],
        ["e", HEX64_A],
      ],
      sig: "sig",
    },
    {
      id: `${"e".repeat(64)}`,
      pubkey: PUBKEY_A,
      kind: 7,
      created_at: 1_700_000_002,
      content: "🎉",
      tags: [
        ["h", CHANNEL_ID],
        ["e", HEX64_A],
        ["actor", actor],
      ],
      sig: "sig",
    },
    {
      id: deletedReactionId,
      pubkey: PUBKEY_A,
      kind: 7,
      created_at: 1_700_000_003,
      content: "👀",
      tags: [
        ["h", CHANNEL_ID],
        ["e", HEX64_A],
      ],
      sig: "sig",
    },
    deletionEvent(5, deletedReactionId, {
      id: `${"f".repeat(64)}`,
    }),
  ];

  assert.deepEqual(collectReactionActorPubkeys(events, RELAY_PUBKEY), [
    PUBKEY_B,
    PUBKEY_A,
  ]);
});

test("huddle start renders as a timeline row", () => {
  const out = formatTimelineMessages([huddleStarted()], null, undefined, null);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, KIND_HUDDLE_STARTED);
});

test("5097 factory job request renders as a timeline row with empty body", () => {
  const out = formatTimelineMessages(
    [factoryJobRequest()],
    null,
    undefined,
    null,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, KIND_FACTORY_JOB_REQUEST);
  assert.equal(out[0].body, "", "the brief lives on tags, not content");
  assert.ok(out[0].tags.some((tag) => tag[0] === "i"));
});

test("6097 factory job result renders as a timeline row with empty body", () => {
  const out = formatTimelineMessages(
    [factoryJobResult()],
    null,
    undefined,
    null,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, KIND_FACTORY_JOB_RESULT);
  assert.equal(out[0].body, "");
  assert.ok(out[0].tags.some((tag) => tag[0] === "outcome"));
});

test("7000 factory job feedback renders as a timeline row carrying its narration", () => {
  const out = formatTimelineMessages(
    [factoryJobFeedback()],
    null,
    undefined,
    null,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, KIND_FACTORY_JOB_FEEDBACK);
  assert.equal(out[0].body, "Running the test suite now");
});

test("6097 factory job result with no tags still renders as a timeline row (empty-content event)", () => {
  const out = formatTimelineMessages(
    [factoryJobResult({ tags: [["h", CHANNEL_ID]], content: "" })],
    null,
    undefined,
    null,
  );
  assert.equal(
    out.length,
    1,
    "a malformed/empty factory-job event must still occupy a visible row",
  );
  assert.equal(out[0].kind, KIND_FACTORY_JOB_RESULT);
});

test("deletion target with non-hex `e` tag value is ignored", () => {
  const bogusDeletion = deletionEvent(9005, HEX64_A, {
    tags: [
      ["h", CHANNEL_ID],
      ["e", "not-hex"],
    ],
  });
  const events = [streamMessage(), bogusDeletion];
  const out = formatTimelineMessages(events, null, undefined, null);
  assert.equal(
    out.length,
    1,
    "malformed deletion tag should not match anything",
  );
});

// ---------------------------------------------------------------------------
// Reaction pill ordering — pills must sort left→right by when each emoji was
// first added (ascending created_at), independent of input event order.
// ---------------------------------------------------------------------------

test("reaction pills sort by earliest created_at ascending", () => {
  const MSG_ID =
    "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
  const message = {
    id: MSG_ID,
    pubkey: PUBKEY_A,
    kind: 9,
    created_at: 1_700_000_000,
    content: "hello",
    tags: [["h", CHANNEL_ID]],
    sig: "sig",
  };

  // 🎉 was added first (t=1001), 👍 was added second (t=1002).
  function reactionEvent(id, emoji, createdAt) {
    return {
      id,
      pubkey: PUBKEY_B,
      kind: 7,
      created_at: createdAt,
      content: emoji,
      tags: [
        ["h", CHANNEL_ID],
        ["e", MSG_ID],
      ],
      sig: "sig",
    };
  }

  const confetti = reactionEvent(`d${"d".repeat(63)}`, "🎉", 1_700_001_001);
  const thumbsUp = reactionEvent(`e${"e".repeat(63)}`, "👍", 1_700_001_002);

  // Feed ascending (🎉 first) — pills should be [🎉, 👍]
  const ascending = formatTimelineMessages(
    [message, confetti, thumbsUp],
    null,
    undefined,
    null,
  );
  assert.deepEqual(
    ascending[0].reactions?.map((r) => r.emoji),
    ["🎉", "👍"],
    "ascending input: 🎉 must come before 👍",
  );

  // Feed descending (👍 first in array) — order must be identical
  const descending = formatTimelineMessages(
    [message, thumbsUp, confetti],
    null,
    undefined,
    null,
  );
  assert.deepEqual(
    descending[0].reactions?.map((r) => r.emoji),
    ["🎉", "👍"],
    "descending input: pill order must be invariant to event array order",
  );
});

test("reaction pills with equal created_at tiebreak deterministically on emoji string", () => {
  const MSG_ID =
    "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
  const message = {
    id: MSG_ID,
    pubkey: PUBKEY_A,
    kind: 9,
    created_at: 1_700_000_000,
    content: "hello",
    tags: [["h", CHANNEL_ID]],
    sig: "sig",
  };
  const SAME_TS = 1_700_001_000;
  const reactionA = {
    id: `f${"f".repeat(63)}`,
    pubkey: PUBKEY_B,
    kind: 7,
    created_at: SAME_TS,
    content: "👍",
    tags: [
      ["h", CHANNEL_ID],
      ["e", MSG_ID],
    ],
    sig: "sig",
  };
  const reactionB = {
    id: `a${"a".repeat(63)}`,
    pubkey: PUBKEY_A,
    kind: 7,
    created_at: SAME_TS,
    content: "🎉",
    tags: [
      ["h", CHANNEL_ID],
      ["e", MSG_ID],
    ],
    sig: "sig",
  };

  const out1 = formatTimelineMessages(
    [message, reactionA, reactionB],
    null,
    undefined,
    null,
  );
  const out2 = formatTimelineMessages(
    [message, reactionB, reactionA],
    null,
    undefined,
    null,
  );

  assert.deepEqual(
    out1[0].reactions?.map((r) => r.emoji),
    out2[0].reactions?.map((r) => r.emoji),
    "equal timestamps: pill order must be identical regardless of input order",
  );
});

test("reaction pill order is invariant to duplicate same-actor same-emoji delivery order", () => {
  // Nostr can deliver the same reaction event twice (or relay redelivery can
  // produce two events with the same target/actor/emoji but different ids/timestamps).
  // The pill sort key must be the EARLIEST createdAt seen, not the last-written.
  const MSG_ID =
    "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  const message = {
    id: MSG_ID,
    pubkey: PUBKEY_A,
    kind: 9,
    created_at: 1_700_000_000,
    content: "hello",
    tags: [["h", CHANNEL_ID]],
    sig: "sig",
  };
  // 🎉 first at t=1001 (the canonical earliest), then a duplicate at t=1005.
  // 👍 arrives at t=1003 — must still be to the right of 🎉.
  const confettiFirst = {
    id: `c${"c".repeat(63)}`,
    pubkey: PUBKEY_B,
    kind: 7,
    created_at: 1_700_001_001,
    content: "🎉",
    tags: [
      ["h", CHANNEL_ID],
      ["e", MSG_ID],
    ],
    sig: "sig",
  };
  const confettiDupe = {
    id: `d${"d".repeat(63)}`,
    pubkey: PUBKEY_B,
    kind: 7,
    created_at: 1_700_001_005,
    content: "🎉",
    tags: [
      ["h", CHANNEL_ID],
      ["e", MSG_ID],
    ],
    sig: "sig",
  };
  const thumbsUp = {
    id: `e${"e".repeat(63)}`,
    pubkey: PUBKEY_B,
    kind: 7,
    created_at: 1_700_001_003,
    content: "👍",
    tags: [
      ["h", CHANNEL_ID],
      ["e", MSG_ID],
    ],
    sig: "sig",
  };

  // Dupe arrives BEFORE canonical — naive last-write-wins would store t=1001
  // (from confettiFirst which comes second), giving correct order by accident.
  const dupeFirst = formatTimelineMessages(
    [message, confettiDupe, confettiFirst, thumbsUp],
    null,
    undefined,
    null,
  );
  // Dupe arrives AFTER canonical — last-write-wins stores t=1005 (the dupe),
  // which would make 🎉's sort key t=1005 > 👍's t=1003, incorrectly reversing order.
  const dupeLast = formatTimelineMessages(
    [message, confettiFirst, thumbsUp, confettiDupe],
    null,
    undefined,
    null,
  );

  assert.deepEqual(
    dupeFirst[0].reactions?.map((r) => r.emoji),
    ["🎉", "👍"],
    "🎉 (earliest at t=1001) must stay left of 👍 (t=1003) when dupe arrives first",
  );
  assert.deepEqual(
    dupeLast[0].reactions?.map((r) => r.emoji),
    ["🎉", "👍"],
    "🎉 (earliest at t=1001) must stay left of 👍 (t=1003) when dupe arrives last",
  );
});

// ---------------------------------------------------------------------------
// countTopLevelTimelineRows — the unit fetch-older pages by. Must match the
// rows `buildMainTimelineEntries` would actually render: top-level content
// events, minus deletions, with thread replies collapsed into their parent.
// ---------------------------------------------------------------------------

function hex64(char) {
  return char.repeat(64);
}

function message(id, overrides = {}) {
  return {
    id,
    pubkey: PUBKEY_A,
    kind: 9,
    created_at: 1_700_000_000,
    content: "hi",
    tags: [["h", CHANNEL_ID]],
    sig: "sig",
    ...overrides,
  };
}

function reply(id, parentId, overrides = {}) {
  return message(id, {
    tags: [
      ["h", CHANNEL_ID],
      ["e", parentId, "", "reply"],
    ],
    ...overrides,
  });
}

test("countTopLevelTimelineRows counts top-level messages", () => {
  const events = [
    message(hex64("1")),
    message(hex64("2")),
    message(hex64("3")),
  ];
  assert.equal(countTopLevelTimelineRows(events), 3);
});

test("countTopLevelTimelineRows ignores collapsed thread replies", () => {
  const root = hex64("1");
  const events = [
    message(root),
    reply(hex64("2"), root),
    reply(hex64("3"), root),
  ];
  // Two replies collapse into the root's summary → one visible row.
  assert.equal(countTopLevelTimelineRows(events), 1);
});

test("countTopLevelTimelineRows counts broadcast replies as top-level", () => {
  const root = hex64("1");
  const broadcast = reply(hex64("2"), root, {
    tags: [
      ["h", CHANNEL_ID],
      ["e", root, "", "reply"],
      ["broadcast", "1"],
    ],
  });
  assert.equal(countTopLevelTimelineRows([message(root), broadcast]), 2);
});

test("countTopLevelTimelineRows excludes deleted messages", () => {
  const target = hex64("1");
  const events = [
    message(target),
    message(hex64("2")),
    deletionEvent(9005, target, { id: hex64("9") }),
  ];
  assert.equal(countTopLevelTimelineRows(events), 1);
});

test("countTopLevelTimelineRows ignores non-content kinds (reactions)", () => {
  const reaction = {
    id: hex64("9"),
    pubkey: PUBKEY_B,
    kind: 7,
    created_at: 1_700_000_001,
    content: "+",
    tags: [
      ["h", CHANNEL_ID],
      ["e", hex64("1")],
    ],
    sig: "sig",
  };
  assert.equal(countTopLevelTimelineRows([message(hex64("1")), reaction]), 1);
});

test("countTopLevelTimelineRows counts huddle start rows", () => {
  assert.equal(countTopLevelTimelineRows([huddleStarted()]), 1);
});

test("huddle ended stays lifecycle-only, not a timeline row", () => {
  assert.equal(isTimelineContentEvent({ kind: KIND_HUDDLE_ENDED }), false);
});

// Guardrail: the history fetch requests exactly CHANNEL_TIMELINE_CONTENT_KINDS,
// so that set must stay in lockstep with isTimelineContentEvent. Drift would
// silently drop a content kind from history (fetched but never rendered) or
// fetch an aux kind as content. Assert parity in both directions.
test("CHANNEL_TIMELINE_CONTENT_KINDS matches isTimelineContentEvent", () => {
  for (const kind of CHANNEL_TIMELINE_CONTENT_KINDS) {
    assert.ok(
      isTimelineContentEvent({ kind }),
      `content kind ${kind} must be a timeline content event`,
    );
  }
  for (const kind of CHANNEL_AUX_EVENT_KINDS) {
    assert.ok(
      !isTimelineContentEvent({ kind }),
      `aux kind ${kind} must not be a timeline content event`,
    );
  }
});

// ── Media tombstones (ADR 0002) ──────────────────────────────────────────────
//
// A media tombstone shares kind:5 with whole-message deletion but means
// something narrower: hide these attachments, keep the message. The
// discriminator is the `x` tag, so these cases guard the boundary between the
// two readings — a mis-classification either resurrects a deleted message or
// vanishes one that only had an attachment withdrawn.

const TOMBSTONE_TX = "hR1kmVIiK4WsRLwGwfCLl1WPdEVGGKtRr8YbQXsq8Xk";
const TOMBSTONE_URL = `https://ar-io.dev/${TOMBSTONE_TX}`;
const TOMBSTONE_SHA = "c".repeat(64);

function messageWithAttachment() {
  return streamMessage({
    content: `look at this\n![image](${TOMBSTONE_URL})`,
    tags: [
      ["h", CHANNEL_ID],
      ["imeta", `url ${TOMBSTONE_URL}`, "m image/png", `x ${TOMBSTONE_SHA}`],
    ],
  });
}

function mediaTombstone(targetId, sha = TOMBSTONE_SHA) {
  return deletionEvent(5, targetId, {
    tags: [
      ["h", CHANNEL_ID],
      ["e", targetId],
      ["x", sha],
    ],
  });
}

test("a media tombstone hides the attachment but keeps the message", () => {
  const events = [messageWithAttachment(), mediaTombstone(HEX64_A)];
  const out = formatTimelineMessages(events, null, undefined, null);

  assert.equal(out.length, 1, "the message itself must survive");
  assert.equal(
    out[0].body.includes(TOMBSTONE_URL),
    false,
    "the attachment's markdown line must be gone",
  );
  assert.equal(
    out[0].tags.some((tag) => tag[0] === "imeta"),
    false,
    "the attachment's imeta tag must be gone, or the gallery still shows it",
  );
  assert.match(out[0].body, /look at this/);
});

test("the placeholder left behind says hidden, not deleted", () => {
  const events = [messageWithAttachment(), mediaTombstone(HEX64_A)];
  const [message] = formatTimelineMessages(events, null, undefined, null);
  assert.match(message.body, /hidden by the author/);
  assert.match(message.body, /permaweb/);
  assert.doesNotMatch(message.body, /delet/i);
});

test("a tombstone for an attachment the message does not carry leaves it alone", () => {
  const events = [
    messageWithAttachment(),
    mediaTombstone(HEX64_A, "d".repeat(64)),
  ];
  const [message] = formatTimelineMessages(events, null, undefined, null);
  assert.match(message.body, new RegExp(TOMBSTONE_TX));
});

test("countTopLevelTimelineRows still counts a message whose media was hidden", () => {
  // The row-count reducer drives history paging. Treating a media tombstone as
  // a deletion there would make the timeline think it had fewer rows than it
  // renders and page too far.
  const events = [messageWithAttachment(), mediaTombstone(HEX64_A)];
  assert.equal(countTopLevelTimelineRows(events), 1);
});

test("a kind:5 with no x tag is still a whole-message deletion", () => {
  // Regression guard for the discriminator: adding media tombstones must not
  // weaken the existing deletion path.
  const events = [messageWithAttachment(), deletionEvent(5, HEX64_A)];
  assert.equal(formatTimelineMessages(events, null, undefined, null).length, 0);
  assert.equal(countTopLevelTimelineRows(events), 0);
});
