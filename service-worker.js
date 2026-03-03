// Shotgun service worker — phase 005. Holds a single persistent native
// port to Wicket. No drain gate, no stdout parsing. Wicket sends
// normalized entries and lifecycle events.

chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ tabId: tab.id })
})

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })

const NATIVE_HOST = 'com.flatheadmill.wicket'

let port = null

function ensurePort () {
  if (port) return port

  port = chrome.runtime.connectNative(NATIVE_HOST)

  port.onMessage.addListener((envelope) => {
    // Forward every envelope to the sidepanel.
    chrome.runtime.sendMessage({ type: 'envelope', envelope })
  })

  port.onDisconnect.addListener(() => {
    port = null
    chrome.runtime.sendMessage({
      type: 'envelope',
      envelope: { stream: 'disconnect', data: {} }
    })
  })

  // Send the connect payload.
  port.postMessage({ slug: 'solver' })

  return port
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'connect') {
    ensurePort()
    return
  }

  if (message.type === 'send') {
    const p = ensurePort()
    p.postMessage({ stream: 'claude', data: { message: message.text } })
    return
  }
})
