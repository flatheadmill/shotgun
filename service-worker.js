// Shotgun service worker — WebSocket connection to Wicket on port 6502.

chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ tabId: tab.id })
})

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })

let ws = null

function forward (envelope) {
  chrome.runtime.sendMessage({ type: 'envelope', envelope }).catch(() => {})
}

function ensureConnection () {
  if (ws && ws.readyState === WebSocket.OPEN) return

  ws = new WebSocket('ws://127.0.0.1:6502')

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ slug: 'solver' }))
  })

  ws.addEventListener('message', (event) => {
    forward(JSON.parse(event.data))
  })

  ws.addEventListener('close', () => {
    ws = null
    forward({ stream: 'disconnect', data: {} })
  })

  ws.addEventListener('error', () => {
    ws = null
  })
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'connect') {
    ensureConnection()
    return
  }

  if (message.type === 'send') {
    ensureConnection()
    const envelope = { stream: 'claude', data: { message: message.text } }
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(envelope))
    }
    return
  }

  if (message.type === 'approve') {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ stream: 'approval', data: message.data }))
    }
    return
  }
})
