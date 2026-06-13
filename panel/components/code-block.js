import { hljs } from '../highlight.js'

const template = document.createElement('template')
template.innerHTML = `
  <style>
    :host { display: block; margin: 10px 0; }
    .frame { border: 1px solid #2d3748; background: #11161c; border-radius: 6px; overflow: hidden; }
    .bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 8px; color: #9b9b96; background: #181f27; font: 11px/1.3 Inter, -apple-system, BlinkMacSystemFont, sans-serif; }
    button { color: #c8c8c3; background: transparent; border: 1px solid #3a4655; border-radius: 5px; padding: 3px 7px; font: inherit; cursor: pointer; }
    pre { margin: 0; padding: 10px; overflow: auto; white-space: pre; }
    code { font: 12px/1.45 "SF Mono", Menlo, Consolas, monospace; color: #d7d7d1; }
  </style>
  <div class="frame">
    <div class="bar"><span class="language"></span><button type="button">Copy</button></div>
    <pre><code></code></pre>
  </div>
`

export class SgCodeBlock extends HTMLElement {
  constructor () {
    super()
    this.attachShadow({ mode: 'open' }).append(template.content.cloneNode(true))
    this.languageEl = this.shadowRoot.querySelector('.language')
    this.codeEl = this.shadowRoot.querySelector('code')
    this.button = this.shadowRoot.querySelector('button')
    this.button.addEventListener('click', () => this.copy())
    this._code = ''
    this._language = ''
  }

  set data (value) {
    this._code = value?.code || ''
    this._language = value?.language || ''
    this.render()
  }

  set code (value) {
    this._code = value || ''
    this.render()
  }

  set language (value) {
    this._language = value || ''
    this.render()
  }

  render () {
    this.languageEl.textContent = this._language || 'text'
    this.codeEl.textContent = this._code || ''
    try {
      this.codeEl.innerHTML = this._language && hljs.getLanguage(this._language)
        ? hljs.highlight(this._code || '', { language: this._language }).value
        : hljs.highlightAuto(this._code || '').value
    } catch {
      this.codeEl.textContent = this._code || ''
    }
  }

  async copy () {
    await navigator.clipboard.writeText(this._code || '')
  }
}

customElements.define('sg-code-block', SgCodeBlock)
