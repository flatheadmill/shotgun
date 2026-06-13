import hljs from '../vendor/highlight/core.min.js'
import javascript from '../vendor/highlight/languages/javascript.min.js'
import typescript from '../vendor/highlight/languages/typescript.min.js'
import json from '../vendor/highlight/languages/json.min.js'
import xml from '../vendor/highlight/languages/xml.min.js'
import css from '../vendor/highlight/languages/css.min.js'
import bash from '../vendor/highlight/languages/bash.min.js'
import markdown from '../vendor/highlight/languages/markdown.min.js'
import diff from '../vendor/highlight/languages/diff.min.js'
import python from '../vendor/highlight/languages/python.min.js'
import rust from '../vendor/highlight/languages/rust.min.js'

// Static ESM imports resolve before this module's body runs, so the language
// definitions are present synchronously. Register them once at import time and
// hand back a ready hljs. Callers use it synchronously; there is no load step.
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('json', json)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('css', css)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('diff', diff)
hljs.registerLanguage('python', python)
hljs.registerLanguage('rust', rust)

export { hljs }

export function highlightCode (code, language) {
  if (!language || !hljs.getLanguage(language)) return ''
  return hljs.highlight(code, { language, ignoreIllegals: true }).value
}
