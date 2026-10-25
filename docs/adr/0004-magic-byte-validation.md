# 0004: Validate uploads by their magic bytes after they land

- **Status:** Accepted (2026-09-25, Stage 7)
- **Deciders:** organizer, Claude

## Context

Guests upload straight from the browser to S3 with a presigned POST, so the files never pass
through Lambda (and Lambda's 6 MB payload limit and per-GB-second cost never apply). The presigned
policy pins the key, the content type and the exact byte size, but the **content type is whatever
the browser declares**. Nothing stops a zip renamed `.jpg`.

Options considered:

- Upload through Lambda and inspect the stream: payload limits, slow, and pays for every byte.
- Scan with an antivirus or image-decoding pipeline: heavy, and not free.
- Trust the extension and content type: no protection at all.

## Decision

Uploads land under `uploads/`. An EventBridge `Object Created` rule triggers the `validate`
Lambda, which **range-reads the first 64 bytes** and checks the file signature:

- JPEG, PNG, GIF, WebP, WebM (Matroska with any other doc type is refused);
- ISO-BMFF (`ftyp`) files decided by the **major brand**: HEIC/HEIF, MP4, MOV, 3GP. AVIF, M4A
  audio and unknown brands are refused; `mif1` / `msf1` pass only when a HEIC brand is present.
- Camera RAW (added in Stage 27): TIFF-based DNG, CR2, NEF and ARW (so plain TIFF passes too),
  the ORF and RW2 TIFF variants, Fujifilm RAF, and Canon CR3 by its `crx ` brand.

Real media is copied to `accepted/…` and the exact upload version deleted. Anything else is
deleted and recorded as `REJECT#<event>`. Since Stage 31, a guest's second upload of the same bytes
(the same MD5 ETag in the same guest folder) is deleted instead of copied; see
[how it works: validation](../how-it-works/validation.md#duplicates). Repeat deliveries are no-ops, and
`scripts/reprocess-uploads.sh` re-runs anything left in `uploads/`.

EventBridge is used instead of a direct S3 → Lambda notification because the bucket lives in the
data stack and the Lambda in the app stack: a direct notification would make the stacks depend on
each other ([0001](0001-two-stack-split.md)).

## Consequences

- One small ranged GET per file: fractions of a cent per event.
- It stops wrong file *types*, not hostile *content*. A real JPEG of anything passes; that's for
  the organizer's review, the kill switch and the quotas.
- A file sits in `uploads/` for a few seconds before it's accepted. Organizer tools only read
  `accepted/`.

## Evidence

- Stage 7: a `fake.jpg` (actually a zip) uploaded through the page disappeared within ~10 s,
  logged as `rejected: bad-magic`. Unit fixtures cover renamed zip and text files.
- Stage 15: all 300 load-test files were in `accepted/` 5 s after the last upload.
