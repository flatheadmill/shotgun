# Vendored Renderer Libraries

All files in this directory are pinned local browser assets for the MV3 side
panel renderer. They are loaded by extension-relative paths only; no remote
scripts or build step are required.

## Initial Renderer Path

- `marked@18.0.5` (`vendor/marked/marked.esm.js`)
  - License: MIT, see `vendor/marked/LICENSE`.
- `dompurify@3.4.9` (`vendor/dompurify/purify.es.mjs`)
  - License: Apache-2.0 OR MPL-2.0, see `vendor/dompurify/LICENSE` and
    `vendor/dompurify/LICENSE-MPL`.
- `highlight.js@11.11.1` (`vendor/highlight/core.min.js` and
  `vendor/highlight/languages/*.min.js`)
  - License: BSD-3-Clause, see `vendor/highlight/LICENSE`.
  - Vendored core plus JavaScript, TypeScript, JSON, XML/HTML, CSS, bash,
    Markdown, diff, Python, and Rust language modules.

## Lazy Final-Render Assets

- `mermaid@11.15.0` (`vendor/mermaid/dist/mermaid.esm.min.mjs` and its
  minified ESM chunks)
  - License: MIT, see `vendor/mermaid/LICENSE`.
  - Loaded only when finalized markdown contains a Mermaid fence.
- `katex@0.17.0` (`vendor/katex/dist/katex.mjs`, CSS, fonts, auto-render)
  - License: MIT, see `vendor/katex/LICENSE`.
  - Loaded only when finalized markdown appears to contain math.

The initial renderer imports stay separate from Mermaid and KaTeX so ordinary
markdown does not pay the lazy enrichment cost.
