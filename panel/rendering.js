import { marked } from '../vendor/marked/marked.esm.js'
import DOMPurify from '../vendor/dompurify/purify.es.mjs'
import './components/code-block.js'

const purifier = typeof DOMPurify.sanitize === 'function' ? DOMPurify : DOMPurify(window)

const purifierConfig = {
  ADD_ATTR: ['target', 'rel'],
  FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed'],
  FORBID_ATTR: ['onerror', 'onload', 'onclick']
}

marked.setOptions({ breaks: false, gfm: true })

export function markdownToSafeHtml (markdown) {
  return purifier.sanitize(marked.parse(markdown || ''), purifierConfig)
}

export async function applyFinalMarkdownEnhancements (root, markdown = '') {
  for (const codeEl of root.querySelectorAll('pre code')) {
    if (codeEl.dataset.highlighted || codeEl.classList.contains('language-mermaid')) continue
    const languageClass = Array.from(codeEl.classList).find(name => name.startsWith('language-'))
    const language = normalizeLanguage(languageClass ? languageClass.slice('language-'.length) : '')
    const block = document.createElement('sg-code-block')
    block.language = language
    block.code = codeEl.textContent || ''
    codeEl.closest('pre')?.replaceWith(block)
  }
  if (containsMermaid(markdown)) await renderMermaidBlocks(root, await loadMermaid())
  if (containsMath(markdown)) await renderMath(root, await loadKatex())
}

function normalizeLanguage (language) {
  const lang = (language || '').toLowerCase().trim()
  if (lang === 'sh' || lang === 'shell' || lang === 'zsh') return 'bash'
  if (lang === 'html') return 'xml'
  if (lang === 'js') return 'javascript'
  if (lang === 'ts') return 'typescript'
  if (lang === 'md') return 'markdown'
  return lang
}

function containsMermaid (markdown) {
  return /```mermaid\b/i.test(markdown || '')
}

function containsMath (markdown) {
  return /(^|[^\\])(\$\$[\s\S]+?\$\$|\$[^$\n]+\$|\\\(|\\\[)/.test(markdown || '')
}

async function loadMermaid () {
  const mermaid = await import('../vendor/mermaid/dist/mermaid.esm.min.mjs')
  const api = mermaid.default || mermaid
  api.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'dark' })
  return api
}

async function loadKatex () {
  return import('../vendor/katex/dist/contrib/auto-render.mjs')
}

async function renderMermaidBlocks (root, mermaid) {
  const blocks = Array.from(root.querySelectorAll('pre code.language-mermaid'))
  let index = 0
  for (const codeEl of blocks) {
    const container = document.createElement('div')
    container.className = 'mermaid-render'
    try {
      const result = await mermaid.render(`sg-mermaid-${Date.now()}-${index++}`, codeEl.textContent || '')
      container.innerHTML = DOMPurify.sanitize(result.svg || '', {
        ADD_TAGS: ['svg', 'g', 'path', 'marker', 'defs', 'text', 'tspan', 'line', 'rect', 'circle', 'ellipse', 'polygon', 'polyline'],
        ADD_ATTR: ['viewBox', 'd', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'points', 'marker-end', 'marker-start', 'transform', 'class', 'id', 'style', 'fill', 'stroke', 'font-size', 'text-anchor']
      })
      codeEl.closest('pre')?.replaceWith(container)
    } catch {
      codeEl.closest('pre')?.classList.add('render-failed')
    }
  }
}

function renderMath (root, mod) {
  const renderMathInElement = mod.default || mod.renderMathInElement
  if (!renderMathInElement) return
  renderMathInElement(root, {
    delimiters: [
      { left: '$$', right: '$$', display: true },
      { left: '\\[', right: '\\]', display: true },
      { left: '\\(', right: '\\)', display: false },
      { left: '$', right: '$', display: false }
    ],
    throwOnError: false
  })
}
