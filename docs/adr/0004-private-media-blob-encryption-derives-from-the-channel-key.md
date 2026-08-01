---
status: accepted
---

# Private media blob encryption derives the file key from the channel key

ADR 0002 settled that private-channel media is encrypted with the current channel key before the paid store upload, one key domain for messages and media. It did not settle *how*, and the obvious answer does not work: messages are sealed with NIP-44 v2, which caps a payload at 65535 bytes of plaintext, and files are bigger.

The construction is one AEAD pass over the whole file with a key derived from the channel key:

```
salt       = 32 random bytes, fresh per blob
blobKey    = HKDF-SHA256(ikm = channelKey, salt, info = "buzz/channel-media/v1")
ciphertext = AES-256-GCM(blobKey, iv = 12 random bytes, plaintext)
```

Everything a reader needs — scheme, `keyId` of the epoch, `salt`, `iv`, the plaintext's MIME, size, dimensions and filename, and the SHA-256 of the *ciphertext* — travels as a `<!--buzz:media/v1 …-->` record inside the message `content`, which a keyed channel seals. The clear-text `imeta` tag carries only facts about the ciphertext: its Arweave URL, its length, `application/octet-stream`, and the ciphertext hash that a `["x", …]` tombstone names.

## Considered options

- **Chunked NIP-44 over the file**: keeps one primitive for messages and media, but requires inventing a chunk framing — length prefix, ordering rule, per-chunk and whole-file MACs to stop reordering and truncation. That is a new cryptographic construction, and it would be the only hand-rolled crypto in the app. Rejected.
- **A random per-file key, NIP-44-sealed into the referencing message**: the standard file-encryption pattern, and the one ADR 0002 already rejected for v1. A wrapped key is a *separable* grant: unwrap it once and the file can be handed to someone who was never in the channel, at which point the channel key is no longer what gates it. A derived key has no such object. Rejected, consistent with 0002.
- **Plaintext MIME/size/filename in the `imeta` tag**: simpler, and how public media already works. Tags are not sealed — the relay serves every reader — so "a 2.4 MB `image/png` named `q3-revenue.png`" would be broadcast alongside the unreadable bytes. Rejected.
- **Plaintext SHA-256 as the `imeta x` value**: would keep the hash meaning what it means for public media. It also hands every observer a confirmation oracle for content they cannot read. Rejected; `x` is the ciphertext's hash, which keeps the tombstone path identical for both.

## Consequences

Rotation semantics fall out of the derivation rather than being restated. The envelope names the epoch, resolution goes through the same key ring as messages, and so a member holding the ring reads media from every epoch in it while a removed member — who holds the pre-rotation ring and nothing after — can never open post-rotation media. That last property is only true because the file key is a function of the channel key; a wrapped per-file key would have handed them the file regardless.

The disclosure is unchanged: one dialog for public and encrypted channels, because the store node has no delete either way. Encryption changes who can read the file, not whether it can ever be withdrawn — the ciphertext is permanent and public, and anyone who ever obtains the channel key can read every file posted under it, retroactively.

The Blossom/relay media backend is untouched and still uploads plaintext. It sniffs and transcodes by MIME and would reject opaque bytes, and a Blossom blob is authenticated and operator-removable, so the irreversibility that makes encryption mandatory on the permaweb does not apply. A keyed channel on the relay transport therefore still posts attachments in the clear to its own community's relay; that gap closes with Blossom itself.
