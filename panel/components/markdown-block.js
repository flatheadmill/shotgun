import { applyFinalMarkdownEnhancements, markdownToSafeHtml } from '../rendering.js'

const template = document.createElement('template')
template.innerHTML = `
  <style>
    :host { display: block; color: #d0d0ca; font-size: 13px; line-height: 1.55; overflow-wrap: anywhere; }
    .markdown > *:first-child { margin-top: 0; }
    .markdown > *:last-child { margin-bottom: 0; }
    p, ul, ol, pre, table, blockquote { margin: 0 0 10px; }
    h1, h2, h3 { margin: 12px 0 8px; color: #e0e0db; line-height: 1.2; }
    h1 { font-size: 18px; } h2 { font-size: 16px; } h3 { font-size: 14px; }
    ul, ol { padding-left: 20px; }
    a { color: #8ab4f8; text-decoration: none; }
    code { font: 12px/1.4 "SF Mono", Menlo, Consolas, monospace; background: #11161c; border: 1px solid #2d3748; border-radius: 4px; padding: 1px 4px; }
    pre { background: #11161c; border: 1px solid #2d3748; border-radius: 6px; overflow: auto; padding: 10px; }
    pre code { background: transparent; border: 0; padding: 0; white-space: pre; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { border: 1px solid #2d3748; padding: 5px 7px; text-align: left; vertical-align: top; }
    th { background: #202936; color: #e0e0db; }
    blockquote { border-left: 2px solid #46698c; padding-left: 10px; color: #aeb6bd; }
    .hljs-keyword, .hljs-selector-tag, .hljs-title.function_ { color: #8ab4f8; }
    .hljs-string, .hljs-attr { color: #a8c792; }
    .hljs-number, .hljs-literal { color: #d7a86e; }
    .hljs-comment { color: #7a8a99; }
    .hljs-built_in, .hljs-type { color: #7cc7b2; }
    :host([cancelled]) { opacity: 0.86; }
  </style>
  <div class="markdown"></div>
`

export class SgMarkdownBlock extends HTMLElement {
  constructor () {
    super()
    this.attachShadow({ mode: 'open' }).append(template.content.cloneNode(true))
    this.markdownEl = this.shadowRoot.querySelector('.markdown')
    this.pending = false
    this.lastVersion = -1
  }

  set block (block) {
    this._block = block
    this.toggleAttribute('cancelled', block?.status === 'cancelled')
    if (this.pending) return
    this.pending = true
    requestAnimationFrame(() => {
      this.pending = false
      this.render()
    })
  }

  render () {
    const block = this._block
    if (!block || block.version === this.lastVersion) return
    this.lastVersion = block.version
    this.markdownEl.innerHTML = markdownToSafeHtml(block.text || '')
    for (const link of this.markdownEl.querySelectorAll('a[href]')) {
      link.target = '_blank'
      link.rel = 'noreferrer noopener'
    }
    if (!block.streaming) applyFinalMarkdownEnhancements(this.markdownEl, block.text || '')
  }
}

customElements.define('sg-markdown-block', SgMarkdownBlock)
