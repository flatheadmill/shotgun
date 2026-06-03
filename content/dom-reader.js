// Content script — injected at document_start in the isolated world.
//
// The page cannot see this script or its variables. We can read the
// DOM but not the page's JavaScript globals. Communication is through
// chrome.runtime.onMessage from the service worker.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'read_page') {
    const result = readPage(msg.selector, msg.maxChars)
    sendResponse(result)
    return true
  }
})

function readPage (selector, maxChars) {
  const root = selector
    ? document.querySelector(selector)
    : document.body

  if (!root) {
    return { error: 'selector not found: ' + selector }
  }

  const text = extractText(root, maxChars || 50000)

  return {
    title: document.title,
    url: location.href,
    selector: selector || 'body',
    length: text.length,
    text: text
  }
}

function extractText (root, maxChars) {
  const chunks = []
  let total = 0

  walk(root)

  return chunks.join('').replace(/\n{3,}/g, '\n\n')

  function walk (node) {
    if (total >= maxChars) return

    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent.trim()
      if (text) {
        const remaining = maxChars - total
        const chunk = text.length > remaining ? text.substring(0, remaining) : text
        chunks.push(chunk + '\n')
        total += chunk.length + 1
      }
      return
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return

    // Skip invisible elements.
    const style = getComputedStyle(node)
    if (style.display === 'none' || style.visibility === 'hidden') return

    // Skip noise.
    const tag = node.tagName
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'SVG') return

    // Headings get a blank line before.
    if (/^H[1-6]$/.test(tag) && chunks.length > 0) {
      chunks.push('\n')
      total += 1
    }

    for (const child of node.childNodes) {
      walk(child)
    }

    // Block elements get a newline after.
    if (isBlock(tag) && chunks.length > 0 && !chunks[chunks.length - 1].endsWith('\n\n')) {
      chunks.push('\n')
      total += 1
    }
  }
}

function isBlock (tag) {
  return /^(DIV|P|LI|TR|ARTICLE|SECTION|HEADER|FOOTER|NAV|MAIN|BLOCKQUOTE|PRE|UL|OL|DL|DT|DD|FIGURE|FIGCAPTION|TABLE|THEAD|TBODY|TFOOT|H[1-6])$/.test(tag)
}
