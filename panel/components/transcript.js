import { baseStyles, css } from './shared.js'
import './entry.js'

const styles = css(`
  :host {
    display: block;
    height: 100%;
    min-height: 0;
  }

  .scroll {
    height: 100%;
    overflow-y: auto;
    padding: 16px;
  }

  .empty {
    margin: 40px auto;
    max-width: 260px;
    color: #7a8a99;
    text-align: center;
  }

  .banners {
    position: sticky;
    top: 0;
    z-index: 1;
    display: grid;
    gap: 6px;
    margin-bottom: 10px;
    pointer-events: none;
  }

  .banner {
    justify-self: center;
    border: 1px solid #2d3748;
    border-radius: 999px;
    padding: 3px 9px;
    background: #1a2028;
    color: #7a8a99;
    font-size: 12px;
  }

  .banner.warn,
  .banner.warning {
    color: #d7a86e;
  }

  .banner.error {
    color: #f0b8b8;
  }
`)

export class SgTranscript extends HTMLElement {
  constructor () {
    super()
    this.attachShadow({ mode: 'open' })
    this.shadowRoot.adoptedStyleSheets = [baseStyles, styles]
    this._state = { entries: [], lifecycle: [], tools: {} }
    this._entryElements = new Map()
    this._pinned = true
  }

  set state (state) {
    this._state = state || { entries: [], lifecycle: [], tools: {} }
    this.render()
  }

  connectedCallback () {
    this.render()
  }

  render () {
    const wasPinned = this.isPinnedToBottom()
    const previousScrollTop = this.scrollEl?.scrollTop || 0
    if (!this.scrollEl) {
      this.shadowRoot.innerHTML = `
        <div class="scroll">
          <div class="banners"></div>
          <div class="entries"></div>
        </div>
      `
      this.scrollEl.addEventListener('scroll', () => {
        this._pinned = this.isPinnedToBottom()
      })
    }

    this.renderBanners()
    this.renderEntries()

    if (wasPinned || this._pinned) {
      this.scrollEl.scrollTop = this.scrollEl.scrollHeight
    } else {
      this.scrollEl.scrollTop = previousScrollTop
    }
  }

  renderBanners () {
    const banners = this.shadowRoot.querySelector('.banners')
    banners.innerHTML = ''
    for (const item of this._state.lifecycle || []) {
      if (!visibleBanner(item)) continue
      const div = document.createElement('div')
      div.className = `banner ${item.level || 'info'}`
      div.textContent = item.text || item.code || ''
      banners.appendChild(div)
    }
  }

  renderEntries () {
    const container = this.shadowRoot.querySelector('.entries')
    const entries = this._state.entries || []
    if (entries.length === 0) {
      container.innerHTML = '<div class="empty">Connected transcript will appear here.</div>'
      this._entryElements.clear()
      return
    }

    const empty = container.querySelector('.empty')
    if (empty) empty.remove()

    const seen = new Set()
    for (const entry of entries) {
      seen.add(entry.id)
      let element = this._entryElements.get(entry.id)
      if (!element) {
        element = document.createElement('sg-entry')
        this._entryElements.set(entry.id, element)
      }
      element.data = { entry, tools: this._state.tools || {} }
      if (element.parentElement !== container) container.appendChild(element)
    }

    for (const [id, element] of this._entryElements.entries()) {
      if (!seen.has(id)) {
        element.remove()
        this._entryElements.delete(id)
      }
    }
  }

  get scrollEl () {
    return this.shadowRoot.querySelector('.scroll')
  }

  isPinnedToBottom () {
    const el = this.scrollEl
    if (!el) return true
    return el.scrollHeight - el.scrollTop - el.clientHeight < 48
  }
}

function visibleBanner (item) {
  return item.code === 'connected' ||
    item.code === 'disconnected' ||
    item.code === 'round_interrupted' ||
    item.level === 'error'
}

customElements.define('sg-transcript', SgTranscript)
