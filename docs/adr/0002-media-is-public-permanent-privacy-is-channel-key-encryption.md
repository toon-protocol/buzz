---
status: accepted
---

# Media is public-permanent on the store node; privacy is channel-key encryption

Blossom/S3 media (served through the relay's authenticated `/media/*`) is replaced by the TOON store node, which writes blobs to Arweave: world-readable, forever, no delete. Private-channel media is therefore encrypted with the current channel key before upload (one key domain for messages and media); public-channel media uploads plaintext; "delete" is a tombstone event only, and permanence is disclosed in the upload UI.

## Considered options

- **Per-file keys wrapped into the referencing message**: finer-grained grants, but more moving parts in every client's upload/render path; rejected for v1.
- **Private media stays off Arweave** (retain a small authenticated blob service): keeps a server the migration exists to shed and splits the media path; rejected.

## Consequences

Old media stays readable to removed members (they held the key when it was posted) — consistent with message-history semantics. Ciphertext lives on the permaweb permanently; key compromise is retroactive for that channel's media.
