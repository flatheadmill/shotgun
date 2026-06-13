export function css (text) {
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(text)
  return sheet
}

export function escapeText (text) {
  const span = document.createElement('span')
  span.textContent = text || ''
  return span.innerHTML
}

export const baseStyles = css(`
  :host {
    color: #c8c8c3;
    font-family: Inter, -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 13px;
    line-height: 1.5;
  }

  button {
    font: inherit;
  }
`)
