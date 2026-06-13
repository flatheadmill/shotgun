import { baseStyles, css, escapeText } from './shared.js'
import './image-preview.js'

const styles = css(`
  :host {
    display: block;
    margin: 8px 0;
  }

  .card {
    border: 1px solid #2d3748;
    border-radius: 7px;
    background: #151a20;
    overflow: hidden;
  }

  .head {
    display: grid;
    grid-template-columns: 22px minmax(0, 1fr) auto;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 10px;
    border: 0;
    color: #c8c8c3;
    background: transparent;
    cursor: pointer;
    text-align: left;
  }

  .icon {
    color: #8ab4f8;
    text-align: center;
  }

  .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
  }

  .meta {
    color: #7a8a99;
    font-size: 12px;
  }

  .status {
    border-radius: 999px;
    padding: 2px 7px;
    background: #202b36;
    color: #9b9b96;
    font-size: 11px;
  }

  .status.pending::before {
    content: "";
    display: inline-block;
    width: 7px;
    height: 7px;
    margin-right: 5px;
    border: 1px solid #7a8a99;
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  .status.error {
    color: #f0b8b8;
    background: #402126;
  }

  .status.cancelled {
    color: #d7a86e;
    background: #352a1b;
  }

  .preview,
  .body {
    border-top: 1px solid #263244;
    padding: 8px 10px;
    color: #aeb0aa;
  }

  pre {
    margin: 0;
    overflow-x: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-family: "SF Mono", Menlo, monospace;
    font-size: 12px;
  }

  .truncated {
    margin-top: 8px;
    color: #d7a86e;
    font-size: 12px;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }
`)

export class SgToolCall extends HTMLElement {
  constructor () {
    super()
    this.attachShadow({ mode: 'open' })
    this.shadowRoot.adoptedStyleSheets = [baseStyles, styles]
    this._tool = null
  }

  set tool (tool) {
    this._tool = tool
    this.render()
  }

  connectedCallback () {
    this.render()
  }

  render () {
    const tool = this._tool
    if (!tool) {
      this.shadowRoot.innerHTML = ''
      return
    }
    const status = tool.status || 'pending'
    const preview = tool.preview || tool.inputSummary || ''
    this.shadowRoot.innerHTML = `
      <div class="card">
        <button class="head" type="button" title="${tool.expanded ? 'Collapse tool result' : 'Expand tool result'}">
          <span class="icon">${iconFor(tool)}</span>
          <span>
            <span class="title">${escapeText(glossFor(tool))}</span>
            ${tool.inputSummary ? `<span class="meta">${escapeText(tool.inputSummary)}</span>` : ''}
          </span>
          <span class="status ${status}">${escapeText(status)}</span>
        </button>
        ${tool.image ? '<div class="preview image"></div>' : `<div class="preview"><pre>${escapeText(preview)}</pre></div>`}
        ${tool.expanded ? expandedBody(tool) : ''}
      </div>
    `
    this.shadowRoot.querySelector('.head').addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('sg-toggle-tool', {
        bubbles: true,
        composed: true,
        detail: { key: tool.key, expanded: !tool.expanded }
      }))
    })
    const imageSlot = this.shadowRoot.querySelector('.preview.image')
    if (imageSlot) {
      const image = document.createElement('sg-image-preview')
      image.image = tool.image
      imageSlot.appendChild(image)
    }
  }
}

function expandedBody (tool) {
  const input = tool.input ? `<h4>Input</h4><pre>${escapeText(tool.input)}</pre>${tool.inputTruncated ? '<div class="truncated">input truncated</div>' : ''}` : ''
  const result = tool.result ? `<h4>Result</h4><pre>${escapeText(tool.result)}</pre>${tool.resultTruncated ? '<div class="truncated">result truncated</div>' : ''}` : ''
  return `<div class="body">${input}${result || '<pre>No result yet.</pre>'}</div>`
}

function glossFor (tool) {
  const name = tool.name || 'tool'
  if (name === 'read_page') return 'read page'
  if (name === 'screenshot') return 'screenshot'
  if (name === 'javascript') return 'run JavaScript'
  if (name === 'navigate') return 'navigate tab'
  return name.replaceAll('_', ' ')
}

function iconFor (tool) {
  const name = tool.name || ''
  if (tool.image || name === 'screenshot') return 'img'
  if (name === 'javascript') return 'js'
  if (name.includes('read') || name.includes('page')) return 'txt'
  return 'run'
}

customElements.define('sg-tool-call', SgToolCall)
