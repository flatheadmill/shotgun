import { baseStyles, css } from './shared.js'

const styles = css(`
  :host { display: block; }
  button { display: block; padding: 0; border: 1px solid #2d3748; border-radius: 6px; background: #11161c; cursor: zoom-in; overflow: hidden; }
  img { display: block; width: 100%; max-width: 220px; height: auto; }
  :host([expanded]) button { cursor: zoom-out; }
  :host([expanded]) img { max-width: 100%; }
`)

export class SgImagePreview extends HTMLElement {
  constructor () {
    super()
    this.attachShadow({ mode: 'open' })
    this.shadowRoot.adoptedStyleSheets = [baseStyles, styles]
    this._image = null
  }

  set image (image) {
    this._image = image
    this.render()
  }

  connectedCallback () {
    this.render()
  }

  render () {
    if (!this._image) {
      this.shadowRoot.innerHTML = ''
      return
    }
    const src = `data:${this._image.mimeType};base64,${this._image.data}`
    this.shadowRoot.innerHTML = '<button type="button" title="Toggle image preview"><img alt="Tool result image"></button>'
    this.shadowRoot.querySelector('img').src = src
    this.shadowRoot.querySelector('button').addEventListener('click', () => this.toggleAttribute('expanded'))
  }
}

customElements.define('sg-image-preview', SgImagePreview)
