# Presign and the S3 POST policy

Guests upload straight from the browser to S3. The presign Lambda doesn't handle a single byte of
the file; it hands out a **presigned POST**, a signed policy that tells S3 exactly which upload to
accept. S3 checks the policy itself, so even a guest who edits the page's JavaScript can only do
what the policy allows.

## Why a presigned POST

|                                      | Through Lambda                 | Presigned PUT                    | **Presigned POST**                   |
| ------------------------------------ | ------------------------------ | -------------------------------- | ------------------------------------ |
| File size                            | 6 MB payload limit             | up to 5 GB                       | up to 5 GB                           |
| Lambda time and cost per byte        | yes                            | none                             | none                                 |
| Size enforced by S3                  | n/a                            | not reliably                     | **yes**, `content-length-range`      |
| Content type enforced by S3          | n/a                            | if signed                        | **yes**, a policy condition          |
| Progress in the browser              | yes                            | yes                              | yes (XHR)                            |

The POST policy is the only option where S3 itself refuses a file of the wrong size. The cost is
no resumable uploads: a phone that drops off mid-file starts that file again. That's fine for
photos and phone videos of a few hundred MB.

## The request

The page sends `POST /api/presign` with a JSON body and the session as a Bearer token
([upload.ts:200](../../web/src/upload.ts#L200)):

```json
{ "filename": "IMG_0412.HEIC", "contentType": "image/heic", "size": 2481530, "guestName": "Zoë O'Brien" }
```

[`validateUploadRequest`](../../api/src/lib/upload-policy.ts#L82) checks it and answers `400` with
the rule it broke:

- `filename`: a string of 1 to 255 characters. It's never used in the key.
- `contentType`: one of the allow-list below, in any letter case (stored lowercase).
- `size`: a whole number of bytes from 1 to the per-file cap, 1 GiB by default
  (`uploads.maxFileGb` in the config, at most 5 GiB, the single-POST limit).
- `guestName`: optional, at most 80 characters.

### The content-type allow-list

An explicit list ([upload-policy.ts:15](../../api/src/lib/upload-policy.ts#L15)), not a prefix
like `image/*`, which would also admit `image/svg+xml`, a format that can carry script.

| Kind         | Content types                                                                          |
| ------------ | -------------------------------------------------------------------------------------- |
| Photos       | `image/jpeg`, `image/png`, `image/heic`, `image/heif`, `image/webp`, `image/gif`        |
| Videos       | `video/mp4`, `video/quicktime`, `video/webm`, `video/3gpp`                              |
| Camera RAW   | `image/x-adobe-dng`, `image/x-canon-cr2`, `image/x-canon-cr3`, `image/x-nikon-nef`, `image/x-sony-arw`, `image/x-fuji-raf`, `image/x-olympus-orf`, `image/x-panasonic-rw2` |

Browsers often report RAW files as an empty type or `application/octet-stream`, so the page
resolves the type from the extension and sends one canonical type per format
([mime.ts:71](../../web/src/mime.ts#L71)).

## The key

The server chooses every part of the key ([upload-policy.ts:115](../../api/src/lib/upload-policy.ts#L115)):

```text
uploads/<eventId>/<guest-slug>/<uuid>.<ext>
uploads/summer-party-2026/zoe-o-brien/0b8e3f0a-6c1d-4f3e-9a52-1d4c7e2b9f10.heic
```

- `eventId` comes from the session's event, never from the request.
- `guest-slug` is the guest's name, accents stripped, lowercased, anything else turned into `-`,
  at most 40 characters ([upload-policy.ts:55](../../api/src/lib/upload-policy.ts#L55)). No name,
  or nothing usable, gives `anonymous`.
- `uuid` is random, so two uploads never collide and no one can aim at an existing key.
- `ext` comes from the **content type**, not the file name, so `photo.exe` declared as
  `image/jpeg` is stored as `.jpg`.

A guest can't write outside their own folder, overwrite another file, or choose a path.

## The policy

[`createPresignedPost`](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-s3-presigned-post/)
signs a policy with these conditions ([presign.ts:93](../../api/src/handlers/presign.ts#L93)):

```json
{
  "expiration": "<now + 10 minutes>",
  "conditions": [
    { "bucket": "<media bucket>" },
    { "key": "uploads/summer-party-2026/zoe-o-brien/0b8e…f10.heic" },
    ["content-length-range", 2481530, 2481530],
    ["eq", "$Content-Type", "image/heic"],
    { "x-amz-algorithm": "AWS4-HMAC-SHA256" },
    { "x-amz-credential": "…" },
    { "x-amz-date": "…" },
    { "x-amz-security-token": "…" }
  ]
}
```

| Condition                          | S3 refuses                                                    |
| ---------------------------------- | ------------------------------------------------------------- |
| `key` (exact)                      | Any other key                                                 |
| `content-length-range` [n, n]      | A body even one byte larger or smaller than the declared size |
| `eq $Content-Type`                 | Any other content type                                        |
| `expiration` (600 s)               | Starting the upload after 10 minutes                          |

The byte range is pinned to the **exact** size, not a range up to the cap
([upload-policy.ts:125](../../api/src/lib/upload-policy.ts#L125)). That's what makes the quotas
honest: the size the quota reserved is the size that gets stored.

The Lambda answers `{ url, fields, key }`. The page builds a `multipart/form-data` body with every
field first and the file last, as S3 requires ([upload.ts:129](../../web/src/upload.ts#L129)).

### What the signature can grant

A presigned POST carries the signer's authority and nothing more. The presign Lambda's role may
only `s3:PutObject` on `uploads/*` in the media bucket
([template.yaml:129](../../infra/app/template.yaml#L129)). So even a bug that signed the wrong key
couldn't grant a write to `accepted/`, or anywhere else.

## The media bucket

The bucket's own settings back the policy up ([data template.yaml:40](../../infra/data/template.yaml#L40)):

- **Block Public Access**, all four settings, and **bucket-owner-enforced** ownership (no ACLs).
- **Encrypted** at rest with SSE-S3, and a bucket policy that refuses any request not over TLS.
- **CORS** allows only `POST`, and only from the stage's site origin, plus `http://localhost:5173`
  for `npm start` on stages with `localDev` (dev by default)
  ([deploy-params.ts:50](../../scripts/lib/deploy-params.ts#L50)). Changing the origins is an
  in-place update.
- **Versioning**, with old versions expiring after 30 days, so a mistaken delete can be undone for
  a month.

Nothing in the bucket is public. Guests can write one object per link, and only the organizer's
credentials can read.

## When S3 refuses

S3 answers with an XML error, which the page reads ([upload.ts:219](../../web/src/upload.ts#L219)):

| S3 error                                   | Cause                                      | The page                        |
| ------------------------------------------ | ------------------------------------------ | ------------------------------- |
| `AccessDenied`, "Policy expired"           | The upload started after 10 minutes        | Retries with a new link         |
| `EntityTooLarge` / `EntityTooSmall`        | The body isn't the declared size           | Fails the file                  |
| `AccessDenied`, policy condition failed    | Another content type or key                | Fails the file                  |
| `RequestTimeout`, `5xx`, network failure   | The connection or S3                       | Retries                         |

## AWS references

- [Browser-based uploads using POST (Signature Version 4)](https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-UsingHTTPPOST.html)
- [Creating a POST policy](https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-HTTPPOSTConstructPolicy.html)
- [Blocking public access to S3 storage](https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-control-block-public-access.html)
- [Using CORS with S3](https://docs.aws.amazon.com/AmazonS3/latest/userguide/cors.html)
