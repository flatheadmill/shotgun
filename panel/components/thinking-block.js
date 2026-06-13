import { baseStyles, css, escapeText } from './shared.js'

const styles = css(`
  :host { display: block; }
  .thinking { margin: 8px 0; padding: 8px 10px; border-left: 2px solid #46698c; border-radius: 0 6px 6px 0; background: #181a1e; color: #9b9b96; white-space: pre-wrap; overflow-wrap: anywhere; }
  .label { display: block; margin-bottom: 4px; color: #7a8a99; font-size: 11px; text-transform: uppercase; }
`)

export class SgThinkingBlock extends HTMLElement {
  constructor () {
    super()
    this.attachShadow({ mode: 'open' })
    this.shadowRoot.adoptedStyleSheets = [baseStyles, styles]
    this._block = null
    this._scheduled = false
    this._lastVersion = -1
  }

  set block (block) {
    this._block = block
    this.scheduleRender()
  }

  connectedCallback () {
    this.render()
  }

  scheduleRender () {
    if (this._scheduled) return
    this._scheduled = true
    requestAnimationFrame(() => {
      this._scheduled = false
      this.render()
    })
  }

  render () {
    const block = this._block
    if (!block || this._lastVersion === block.version) return
    this._lastVersion = block.version
    this.shadowRoot.innerHTML = `<div class="thinking"><span class="label">thinking</span>${escapeText(block.text || '')}</div>`
  }
}

customElements.define('sg-thinking-block', SgThinkingBlock)
