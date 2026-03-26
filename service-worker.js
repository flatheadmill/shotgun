// Shotgun service worker — WebSocket connection to Wicket on port 6502.

chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ tabId: tab.id })
})

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })

let ws = null
let heartbeatInterval = null

function forward (envelope) {
  chrome.runtime.sendMessage({ type: 'envelope', envelope }).catch(() => {})
}

function ensureConnection () {
  if (ws && ws.readyState === WebSocket.OPEN) return

  ws = new WebSocket('ws://127.0.0.1:6502')

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ slug: 'solver' }))
    if (heartbeatInterval) clearInterval(heartbeatInterval)
    heartbeatInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ stream: 'heartbeat', data: {} }))
      }
    }, 20000)
  })

  ws.addEventListener('message', (event) => {
    const envelope = JSON.parse(event.data)
    if (envelope.stream === 'request') {
      handleServiceRequest(envelope.data)
    } else {
      forward(envelope)
    }
  })

  ws.addEventListener('close', () => {
    ws = null
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null }
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

function handleServiceRequest (data) {
  if (data.type === 'capture') {
    // Claim immediately.
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ stream: 'claim', data: { id: data.id } }))
    }
    captureActiveTab(data.id)
  }
}

async function captureActiveTab (requestId) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab) {
      sendServiceResponse(requestId, 'text/plain', btoa('no active tab'))
      return
    }

    const tabId = tab.id
    const debuggee = { tabId }

    await chrome.debugger.attach(debuggee, '1.3')

    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => ({
          width: window.innerWidth,
          height: window.innerHeight,
          dpr: window.devicePixelRatio
        })
      })
      const viewport = result.result

      const screenshot = await chrome.debugger.sendCommand(
        debuggee,
        'Page.captureScreenshot',
        { format: 'png', captureBeyondViewport: false, fromSurface: true }
      )

      await chrome.debugger.detach(debuggee)
      sendServiceResponse(requestId, 'image/png', screenshot.data)
    } catch (e) {
      await chrome.debugger.detach(debuggee).catch(() => {})
      sendServiceResponse(requestId, 'text/plain', btoa('capture failed: ' + e.message))
    }
  } catch (e) {
    sendServiceResponse(requestId, 'text/plain', btoa('debugger attach failed: ' + e.message))
  }
}

function sendServiceResponse (requestId, contentType, base64Body) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      stream: 'response',
      data: { id: requestId, content_type: contentType, body: base64Body }
    }))
  }
}
