import { baseStyles, css, escapeText } from './shared.js'
import './markdown-block.js'
import './thinking-block.js'
import './tool-call.js'

const styles = css(`
  :host {
    display: block;
    margin-bottom: 12px;
  }

  .entry {
    padding: 9px 11px;
    border-radius: 8px;
    overflow-wrap: anywhere;
  }

  .assistant {
    background: #1a1c20;
    border-left: 2px solid #46698c;
  }

  .user {
    background: #1e2832;
    border-left: 2px solid #7a8a99;
  }

  .cancelled {
    border-color: #d7a86e;
  }

  .role {
    margin-bottom: 5px;
    color: #7a8a99;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
  }

  .plain {
    white-space: pre-wrap;
  }
`)

export class SgEntry extends HTMLElement {
  constructor () {
    super()
    this.attachShadow({ mode: 'open' })
    this.shadowRoot.adoptedStyleSheets = [baseStyles, styles]
    this._entry = null
    this._tools = {}
    this._blockElements = new Map()
  }

  set data (value) {
    this._entry = value?.entry || null
    this._tools = value?.tools || {}
    this.render()
  }

  connectedCallback () {
    this.render()
  }

  render () {
    const entry = this._entry
    if (!entry) {
      this.shadowRoot.innerHTML = ''
      return
    }

    let shell = this.shadowRoot.querySelector('.entry')
    if (!shell) {
      this.shadowRoot.innerHTML = `
        <div class="entry">
          <div class="role"></div>
          <div class="blocks"></div>
        </div>
      `
      shell = this.shadowRoot.querySelector('.entry')
    }

    shell.className = `entry ${entry.role} ${entry.status === 'cancelled' ? 'cancelled' : ''}`
    this.shadowRoot.querySelector('.role').textContent = entry.role === 'user' ? 'you' : 'claude'
    const container = this.shadowRoot.querySelector('.blocks')
    const seen = new Set()

    for (const block of entry.blocks) {
      const key = block.id
      seen.add(key)
      let element = this._blockElements.get(key)
      if (!element || element.localName !== tagFor(block)) {
        element = document.createElement(tagFor(block))
        this._blockElements.set(key, element)
      }
      updateBlockElement(element, block, this._tools)
      if (element.parentElement !== container) container.appendChild(element)
    }

    for (const [key, element] of this._blockElements.entries()) {
      if (!seen.has(key)) {
        element.remove()
        this._blockElements.delete(key)
      }
    }
  }
}

function tagFor (block) {
  if (block.kind === 'thinking') return 'sg-thinking-block'
  if (block.kind === 'tool_use') return 'sg-tool-call'
  if (block.kind === 'text') return 'sg-markdown-block'
  return 'div'
}

function updateBlockElement (element, block, tools) {
  if (element.localName === 'sg-markdown-block' || element.localName === 'sg-thinking-block') {
    element.block = block
  } else if (element.localName === 'sg-tool-call') {
    element.tool = tools[block.toolKey]
  } else {
    element.className = 'plain'
    element.innerHTML = escapeText(block.text || JSON.stringify(block.data, null, 2))
  }
}

customElements.define('sg-entry', SgEntry)
