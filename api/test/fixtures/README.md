# Magic-byte fixtures

First 64 bytes of each file (all `api/src/lib/magic.ts` inspects).

- `photo.jpg`, `photo.png`, `photo.heic`, `photo.gif`: headers of **real** files converted with macOS `sips` from a generated PNG.
- Everything else is constructed from the published container formats (RIFF/WebP, ISO-BMFF `ftyp` boxes for MOV/MP4/3GP/HEIF, EBML for WebM, legacy QuickTime atoms), because no WebP or video encoder was available locally.
- RAW photos (`photo.dng`, `.cr2`, `.nef`, `.arw`, `.orf`, `.rw2`, `.raf`, `.cr3`) are constructed from their published headers too: TIFF (`II*\0` / `MM\0*`, with the CR2 marker), the Olympus `IIRO` and Panasonic `IIU\0` TIFF variants, the Fujifilm `FUJIFILMCCD-RAW` header, and an ISO-BMFF `ftyp` box with the Canon `crx ` brand.
- `*-renamed.jpg`, `text-renamed.dng`, `bigtiff.dng`, `audio-m4a.mp4`, and `avif.jpg` are negatives that must be rejected.
