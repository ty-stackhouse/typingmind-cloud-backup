# Security Notes — typingmind-cloud-backup (ty-stackhouse fork)

This fork applies targeted security patches on top of the upstream
[itcon-pty-au/typingmind-cloud-backup](https://github.com/itcon-pty-au/typingmind-cloud-backup)
codebase. The upstream code is excellent; these changes address two
specific vulnerabilities identified in an independent security review.

## Pinned upstream commit

```
26d0f99cdf6af4fa57f9118cdb9089f13d0a67a6  (2026-03-29)
```

When merging future upstream changes, re-apply the patches below and
recompute the SRI hashes for any CDN scripts that changed.

---

## Fix 1 — PBKDF2 Key Derivation (High severity)

### Problem

The original `deriveKey()` method in `CryptoService` hashed the user's
passphrase with a single `SHA-256` call:

```js
// ORIGINAL — vulnerable
const hash = await crypto.subtle.digest("SHA-256", data);
```

A single hash is computed in nanoseconds on a GPU, making offline
brute-force attacks against stolen ciphertext trivial.

### Fix

Replaced with **PBKDF2 + SHA-256 + 100,000 iterations** and a fresh
**random 16-byte salt** generated per encryption operation. The salt is
prepended to the ciphertext so it is available during decryption.

New ciphertext layout:
```
[ 16-byte salt ][ 12-byte IV ][ AES-GCM ciphertext ]
```

Old layout (still decryptable via legacy fallback path):
```
[ 12-byte IV ][ AES-GCM ciphertext ]
```

### Backward compatibility

`decrypt()` and `decryptBytes()` auto-detect the format: they first
attempt the PBKDF2 path; if that raises a `DOMException` they fall back
to the legacy SHA-256 path. Existing cloud data continues to work
transparently and is silently re-encrypted to the stronger format on
the next sync cycle.

---

## Fix 2 — SRI Hashes on CDN Scripts (Medium severity)

### Problem

The AWS SDK and Eruda debugger were loaded at runtime from CDN URLs
with no `integrity` attribute:

```js
// ORIGINAL — no integrity check
script.src = "https://sdk.amazonaws.com/js/aws-sdk-2.1692.0.min.js";
```

A CDN compromise, unexpected version bump, or supply-chain attack could
execute arbitrary JavaScript with full access to TypingMind's data.

### Fix

Both injections now carry `integrity` + `crossOrigin="anonymous"`:

| Script | Pinned version | SRI hash |
|--------|---------------|----------|
| AWS SDK | `aws-sdk-2.1692.0.min.js` | `sha384-bsVTXMkiEcKq19RTnCBVL0C8BoR4wvtdH4dISM+Ufr9VVPFAuoZPJwmyDYbcFe2` |
| Eruda | `eruda@3.0.1/eruda.min.js` | `sha384-w/A/l37lVZcDe8Gez0uMpKrqQN7uZKAAABRKTHRVAZkIl3kEPj7VFa7OOVQM9b6` |

The browser enforces the hash at load time and refuses to execute any
file that doesn't match.

**Note:** If you update the AWS SDK or Eruda to a newer version, you
must recompute the SRI hash:

```bash
curl -sL <cdn-url> | openssl dgst -sha384 -binary | openssl base64 -A
# then prefix the output with "sha384-"
```

---

## Issues not fixed (intentional)

| Issue | Reason left as-is |
|-------|-----------------|
| XOR/PEPPER obfuscation for AWS keys | Low-moderate severity. Requires a migration path for already-stored credentials. Mitigated by restricting IAM permissions to the sync bucket only. |
| Google OAuth token in `localStorage` | Standard browser OAuth trade-off. No better storage mechanism is available in a browser extension context. |
| `metadata.json` uploaded as plaintext | Informational severity. Chat *content* is encrypted; metadata leaks key names and timestamps only. Encrypting it would break the sync engine's server-side comparison logic. |

---

## Reporting vulnerabilities

For issues specific to this fork, open a GitHub issue in this
repository. For issues in the upstream code, please report them to the
[upstream repository](https://github.com/itcon-pty-au/typingmind-cloud-backup).
