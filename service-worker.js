// Shotgun service worker — WebSocket connection to Easement on port 6502.
//
// Registers as who=shotgun, where=localhost. Tools are declared at connect
// time. Easement dispatches tool calls directly to our socket — no
// broadcast, no claims.
//
// Six tools: screenshot, javascript, tabs_context, tabs_create, navigate,
// read_page. Tab groups are per-slug, persisted in chrome.storage.local.
//
// Screenshot pipeline ported from Claude Web 1.0.72
// (mcpPermissions-CUBzZeeG.js). Reference at ~/code/reference/claude-web/.
// Claude Web's output sanitizer was removed — it blocked page content
// that looked like credentials. We own the pipe. The operator sees
// the transcript.

const GROUP_COLOR = 'yellow'
const STORAGE_KEY_PREFIX = 'shotgun_tab_group_'

// -- Screenshot constants from Claude Web --

const RESIZE_PARAMS = { pxPerToken: 28, maxTargetPx: 1568, maxTargetTokens: 1568 }
const MAX_BASE64_CHARS = 1398100
const INITIAL_JPEG_QUALITY = 0.75
const JPEG_QUALITY_STEP = 0.05
const MIN_JPEG_QUALITY = 0.10

// -- Per-tab state --

const attachedTabs = new Set()
const screenshotContexts = new Map()

function utf8ToBase64 (str) {
  // btoa chokes on non-Latin1. Page content has unicode.
  const bytes = new TextEncoder().encode(str)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

// -- Tab group management (per slug) --
//
// Tab groups survive across context windows — they belong to the collaboration
// (slug), not the session (timestamp). Chrome deletes the group when the last
// tab in it closes. We persist the group ID in chrome.storage.local and
// validate it on each use because Chrome may have cleaned it up behind our
// back.

const tabGroups = {}

async function loadTabGroupForSlug (slug) {
  if (!slug) return null
  if (tabGroups[slug]) return tabGroups[slug]
  const key = STORAGE_KEY_PREFIX + slug
  const data = await chrome.storage.local.get(key)
  const id = data[key]
  if (id == null) return null
  try {
    await chrome.tabGroups.get(id)
    tabGroups[slug] = id
    return id
  } catch {
    await chrome.storage.local.remove(key)
    return null
  }
}

async function saveTabGroupForSlug (slug, groupId) {
  tabGroups[slug] = groupId
  const key = STORAGE_KEY_PREFIX + slug
  await chrome.storage.local.set({ [key]: groupId })
}

async function ensureGroupCharacteristics (slug, groupId) {
  try {
    const group = await chrome.tabGroups.get(groupId)
    if (group.title !== slug || group.color !== GROUP_COLOR) {
      await chrome.tabGroups.update(groupId, { title: slug, color: GROUP_COLOR })
    }
  } catch (e) {}
}

async function getTabContext (slug) {
  const groupId = await loadTabGroupForSlug(slug)
  if (!groupId) {
    return { currentTabId: null, availableTabs: [], tabCount: 0, tabGroupId: null }
  }
  try {
    await chrome.tabGroups.get(groupId)
    await ensureGroupCharacteristics(slug, groupId)
  } catch {
    delete tabGroups[slug]
    const key = STORAGE_KEY_PREFIX + slug
    await chrome.storage.local.remove(key)
    return { currentTabId: null, availableTabs: [], tabCount: 0, tabGroupId: null }
  }
  const tabs = (await chrome.tabs.query({ groupId }))
    .filter(t => t.id !== undefined)
    .map(t => ({ id: t.id, title: t.title || '', url: t.url || '' }))
  return {
    currentTabId: tabs.length > 0 ? tabs[0].id : null,
    availableTabs: tabs,
    tabCount: tabs.length,
    tabGroupId: groupId
  }
}

async function createTabInGroup (slug, url) {
  const tab = await chrome.tabs.create({ url: url || 'chrome://newtab', active: true })
  if (!tab.id) return { error: 'Failed to create tab.' }
  let groupId = await loadTabGroupForSlug(slug)
  if (!groupId) {
    groupId = await chrome.tabs.group({ tabIds: [tab.id] })
    await chrome.tabGroups.update(groupId, { title: slug, color: GROUP_COLOR, collapsed: false })
    await saveTabGroupForSlug(slug, groupId)
  } else {
    await chrome.tabs.group({ tabIds: tab.id, groupId })
  }
  const context = await getTabContext(slug)
  return {
    output: `Created tab ${tab.id}${url ? ' at ' + url : ''}`,
    tabContext: context
  }
}

async function navigateTab (tabId, url) {
  try {
    await chrome.tabs.update(tabId, { url })
    return { output: `Navigated tab ${tabId} to ${url}` }
  } catch (e) {
    return { error: `Failed to navigate: ${e.message}` }
  }
}

// -- Side panel and action --

chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ tabId: tab.id })
})

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })

// -- WebSocket connection to Easement --
//
// On open, register with who=shotgun, where=browser, and declare our tools.
// Easement dispatches calls directly to our socket. The heartbeat keeps the
// service worker alive. The chrome.alarms keepalive restarts the connection
// if the worker dies.

let ws = null
let heartbeatInterval = null

// Shotgun binds to one slug and always the latest transcript. Easement resolves
// the intent "latest" to a timestamped transcript on its side; we learn the
// resolved name from the broadcasts it sends back and use it when starting a
// turn, because Turn::Start keys its window on the raw transcript string and
// will not resolve "latest" the way history replay does.
const SLUG = 'shotgun'
const TRANSCRIPT_INTENT = 'latest'
let resolvedTranscript = null
let activeTurnId = null
let pendingHistory = false

// Replay this slug's latest transcript. Driven by the panel's connect message
// so a listener exists; wsSend is a no-op until the socket is open, so when the
// panel connects before the socket opens we defer via pendingHistory.
function requestHistory () {
  wsSend({ what: 'history', why: 'replay', slug: SLUG, transcript: TRANSCRIPT_INTENT, replay_id: crypto.randomUUID() })
}

const TOOLS = [
  { f: 'screenshot', description: 'Capture a screenshot of a browser tab. Args: tabId (int, optional).' },
  { f: 'javascript', description: 'Execute JavaScript in a browser tab. Args: code (string), tabId (int, optional).' },
  { f: 'tabs_context', description: 'List tabs in the browser tab group for this slug.' },
  { f: 'tabs_create', description: 'Open a new tab. Args: url (string, optional).' },
  { f: 'navigate', description: 'Navigate a tab to a URL. Args: tabId (int), url (string).' },
  { f: 'read_page', description: 'Read page text through the isolated world content script. Invisible to the page. Args: selector (string, optional CSS selector to scope the read), maxChars (int, optional, default 50000), tabId (int, optional), frameId (int, optional, default 0 for top frame).' },
]

function forward (msg) {
  chrome.runtime.sendMessage({ type: 'envelope', envelope: msg }).catch(() => {})
}

function wsSend (obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj))
  }
}

function ensureConnection () {
  if (ws && ws.readyState === WebSocket.OPEN) return
  if (ws && ws.readyState === WebSocket.CONNECTING) return

  ws = new WebSocket('ws://127.0.0.1:6502')

  ws.addEventListener('open', () => {
    // Register with Easement. Tools declared here, not via tools_query.
    wsSend({ what: 'socket', why: 'connect', who: 'shotgun', where: 'localhost', tools: TOOLS })

    // The socket opens on the worker's lifecycle, which can precede the panel
    // mounting. Replaying history here would forward the transcript into a
    // sendMessage with no listening panel, and it would be dropped. The replay
    // is driven by the panel's connect message instead. If the panel asked
    // while the socket was still connecting, honor that request now.
    if (pendingHistory) {
      pendingHistory = false
      requestHistory()
    }

    if (heartbeatInterval) clearInterval(heartbeatInterval)
    heartbeatInterval = setInterval(() => {
      wsSend({ stream: 'heartbeat', data: {} })
    }, 20000)
    forward({ stream: 'connected', data: {} })
  })

  ws.addEventListener('message', (event) => {
    try {
      const msg = JSON.parse(event.data)

      // Tool dispatch from Easement. Tagged with what=tool, why=run.
      if (msg.what === 'tool' && msg.why === 'run') {
        handleToolRun(msg)
        return
      }

      // Broadcasts go to every connected client and carry their slug. Ignore
      // traffic for other slugs so the panel only sees its own transcript.
      if (typeof msg.slug === 'string' && msg.slug !== SLUG) return

      // Learn the transcript Easement resolved "latest" to, for turn routing.
      if (typeof msg.transcript === 'string' && msg.transcript !== TRANSCRIPT_INTENT) {
        resolvedTranscript = msg.transcript
      }

      // Everything else forwards to the side panel.
      forward(msg)
    } catch (e) {}
  })

  ws.addEventListener('close', () => {
    ws = null
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null }
    forward({ stream: 'disconnect', data: {} })
  })

  ws.addEventListener('error', () => {
    if (ws) { ws.close(); ws = null }
  })
}

// -- Side panel messages --

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'connect') {
    ensureConnection()
    // Request history now if the socket is already open, otherwise let the
    // open handler send it once the socket comes up. Either way the panel's
    // listener is live, because it registers before sending connect.
    if (ws && ws.readyState === WebSocket.OPEN) requestHistory()
    else pendingHistory = true
    return
  }
  if (message.type === 'send') {
    ensureConnection()
    activeTurnId = crypto.randomUUID()
    wsSend({
      what: 'turn',
      why: 'start',
      slug: SLUG,
      transcript: resolvedTranscript || TRANSCRIPT_INTENT,
      turn_id: activeTurnId,
      message: message.text
    })
    return
  }
  if (message.type === 'approve') {
    wsSend({ stream: 'approval', data: message.data })
    return
  }
  if (message.type === 'interrupt') {
    wsSend({
      what: 'turn',
      why: 'interrupt',
      slug: SLUG,
      transcript: resolvedTranscript || TRANSCRIPT_INTENT,
      turn_id: activeTurnId
    })
    return
  }
})

// -- Debugger lifecycle --
//
// Attach once per tab, stay attached. Chrome detaches automatically when the
// tab closes or navigates to a chrome:// URL. The yellow "is being debugged"
// bar is the cost of CDP access.

async function ensureDebugger (tabId) {
  if (attachedTabs.has(tabId)) return
  await chrome.debugger.attach({ tabId }, '1.3')
  attachedTabs.add(tabId)
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) attachedTabs.delete(source.tabId)
})

chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId)
  screenshotContexts.delete(tabId)
})

// -- Token budget resize (from Claude Web) --
//
// Anthropic's API charges ~(w*h)/750 tokens per image. The sweet spot is both
// dimensions within 1568px. fitDimensions binary-searches for the largest size
// that stays under the token cap. If the CDP capture is still too large after
// scaling, resizeInContentScript does JPEG quality stepping in a canvas
// element on the page.

function tokensForDimensions (w, h, pxPerToken) {
  return Math.ceil(w / pxPerToken) * Math.ceil(h / pxPerToken)
}

function fitDimensions (w, h, params) {
  const { pxPerToken, maxTargetPx, maxTargetTokens } = params
  if (w <= maxTargetPx && h <= maxTargetPx && tokensForDimensions(w, h, pxPerToken) <= maxTargetTokens) {
    return [w, h]
  }
  if (h > w) {
    const [fh, fw] = fitDimensions(h, w, params)
    return [fw, fh]
  }
  const aspect = w / h
  let lo = 1
  let hi = w
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2)
    const midH = Math.max(Math.round(mid / aspect), 1)
    if (mid <= maxTargetPx && tokensForDimensions(mid, midH, pxPerToken) <= maxTargetTokens) {
      lo = mid
    } else {
      hi = mid
    }
  }
  return [lo, Math.max(Math.round(lo / aspect), 1)]
}

// -- Tool dispatch --
//
// Easement sends { what: "tool", why: "run", slug, transcript, call_id, f, ...args }.
// We dispatch by f, do the work, send { what: "tool", why: "response", call_id, output, exit_code }.

let currentSlug = null

function handleToolRun (msg) {
  const callId = msg.call_id || ''
  const f = msg.f || ''
  currentSlug = msg.slug || null

  switch (f) {
    case 'screenshot':
      captureScreenshot(callId, msg.tabId)
      break
    case 'javascript':
      executeJavascript(callId, msg.code, msg.tabId)
      break
    case 'tabs_context':
      handleTabsContext(callId, currentSlug)
      break
    case 'tabs_create':
      handleTabsCreate(callId, currentSlug, msg.url)
      break
    case 'navigate':
      handleNavigate(callId, msg.tabId, msg.url)
      break
    case 'read_page':
      handleReadPage(callId, msg.selector, msg.maxChars, msg.tabId, msg.frameId)
      break
    default:
      sendToolResponse(callId, 'unknown function: ' + f, 1)
  }
}

function sendToolResponse (callId, output, exitCode) {
  wsSend({ what: 'tool', why: 'response', call_id: callId, output, exit_code: exitCode || 0 })
}

function sendToolResult (callId, result) {
  const output = JSON.stringify(result)
  sendToolResponse(callId, output, result.error ? 1 : 0)
}

function sendToolError (callId, message) {
  sendToolResponse(callId, message, 1)
}

// -- Tab tools --

async function handleTabsContext (callId, slug) {
  try {
    const context = await getTabContext(slug)
    sendToolResult(callId, { output: JSON.stringify(context, null, 2), tabContext: context })
  } catch (e) {
    sendToolError(callId, e.message || 'tabs_context failed')
  }
}

async function handleTabsCreate (callId, slug, url) {
  try {
    const result = await createTabInGroup(slug, url)
    sendToolResult(callId, result)
  } catch (e) {
    sendToolError(callId, e.message || 'tabs_create failed')
  }
}

async function handleNavigate (callId, tabId, url) {
  if (!tabId || !url) {
    sendToolError(callId, 'tabId and url are required')
    return
  }
  try {
    const result = await navigateTab(tabId, url)
    sendToolResult(callId, result)
  } catch (e) {
    sendToolError(callId, e.message || 'navigate failed')
  }
}

// -- Page reading (isolated world content script) --
//
// Reads the DOM through the content script, not through Runtime.evaluate.
// The page cannot see this. No CDP, no debugger, no page-world execution.

async function handleReadPage (callId, selector, maxChars, tabId, frameId) {
  try {
    const resolvedTabId = await resolveTabId(tabId)
    if (!resolvedTabId) {
      sendToolError(callId, 'No tab found')
      return
    }
    // frameId 0 = top frame. Content script is in all frames but we
    // default to top. Pass frameId to read a specific iframe.
    const targetFrame = frameId != null ? frameId : 0
    const response = await chrome.tabs.sendMessage(resolvedTabId, {
      type: 'read_page',
      selector: selector || null,
      maxChars: maxChars || 50000
    }, { frameId: targetFrame })
    if (response.error) {
      sendToolError(callId, response.error)
    } else {
      sendToolResult(callId, { output: response.text, title: response.title, url: response.url, selector: response.selector, length: response.length })
    }
  } catch (e) {
    sendToolError(callId, e.message || 'read_page failed')
  }
}

// -- Screenshot capture (ported from Claude Web) --

async function resolveTabId (tabId) {
  if (tabId) return tabId
  if (currentSlug) {
    const context = await getTabContext(currentSlug)
    if (context && context.currentTabId) return context.currentTabId
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab ? tab.id : null
}

async function captureScreenshot (callId, tabId) {
  try {
    const resolvedTabId = await resolveTabId(tabId)
    if (!resolvedTabId) {
      sendToolError(callId, 'no tab to capture')
      return
    }

    await ensureDebugger(resolvedTabId)

    const [probeResult] = await chrome.scripting.executeScript({
      target: { tabId: resolvedTabId },
      injectImmediately: true,
      func: () => ({
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
        scrollX: window.scrollX,
        scrollY: window.scrollY
      })
    })

    if (!probeResult || !probeResult.result) {
      sendToolError(callId, 'failed to get viewport information')
      return
    }

    const { width, height, devicePixelRatio, scrollX, scrollY } = probeResult.result
    const dpr = devicePixelRatio || 1
    const captureW = Math.round(width * dpr)
    const captureH = Math.round(height * dpr)
    const [targetW, targetH] = fitDimensions(captureW, captureH, RESIZE_PARAMS)
    const scale = Math.min(1, targetW / captureW)

    const cdpParams = {
      format: 'jpeg',
      quality: Math.round(INITIAL_JPEG_QUALITY * 100),
      captureBeyondViewport: false,
      fromSurface: true,
      clip: { x: scrollX, y: scrollY, width, height, scale }
    }

    const result = await chrome.debugger.sendCommand({ tabId: resolvedTabId }, 'Page.captureScreenshot', cdpParams)
    if (!result || !result.data) {
      sendToolError(callId, 'CDP capture returned no data')
      return
    }

    let base64 = result.data

    if (base64.length > MAX_BASE64_CHARS) {
      base64 = await resizeInContentScript(resolvedTabId, base64, width, height, dpr, scale)
    }

    screenshotContexts.set(resolvedTabId, {
      viewportWidth: width,
      viewportHeight: height,
      screenshotWidth: targetW,
      screenshotHeight: targetH
    })

    // Screenshot returns image content blocks, not plain output.
    const content = JSON.stringify([
      { type: 'text', text: `screenshot (image/jpeg)` },
      { type: 'image', data: base64, mimeType: 'image/jpeg' }
    ])
    sendToolResponse(callId, content, 0)
  } catch (e) {
    sendToolError(callId, e.message || 'screenshot failed')
  }
}

async function resizeInContentScript (tabId, base64, viewportW, viewportH, dpr, clipScale) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    injectImmediately: true,
    func: (b64, format, vpW, vpH, devicePixelRatio, params, maxChars, initialQuality, qualityStep, minQuality) => {
      const dataUrl = `data:image/${format};base64,${b64}`
      return new Promise((resolve, reject) => {
        const img = new Image()
        img.onload = () => {
          let w = img.width
          let h = img.height
          if (devicePixelRatio > 1) {
            w = Math.round(img.width / devicePixelRatio)
            h = Math.round(img.height / devicePixelRatio)
          }

          const aspect = w / h
          const pxPerToken = params.pxPerToken || 28
          const maxTokens = params.maxTargetTokens || 1568
          const maxPx = params.maxTargetPx || 1568
          const currentTokens = Math.ceil(w / pxPerToken) * Math.ceil(h / pxPerToken)

          let targetW = w
          let targetH = h
          if (currentTokens > maxTokens) {
            const scale = Math.sqrt(maxTokens / currentTokens)
            targetW = Math.round(w * scale)
            targetH = Math.round(targetW / aspect)
          }
          const maxDim = Math.max(targetW, targetH)
          if (maxDim > maxPx) {
            const scale = maxPx / maxDim
            targetW = Math.round(targetW * scale)
            targetH = Math.round(targetH * scale)
          }

          const stepDown = (canvas) => {
            let quality = initialQuality
            let result = canvas.toDataURL('image/jpeg', quality).split(',')[1]
            while (result.length > maxChars && quality > minQuality) {
              quality -= qualityStep
              result = canvas.toDataURL('image/jpeg', quality).split(',')[1]
            }
            return result
          }

          const source = document.createElement('canvas')
          source.width = w
          source.height = h
          const sCtx = source.getContext('2d')
          if (!sCtx) { reject(new Error('canvas context failed')); return }
          if (devicePixelRatio > 1) {
            sCtx.drawImage(img, 0, 0, img.width, img.height, 0, 0, w, h)
          } else {
            sCtx.drawImage(img, 0, 0)
          }

          if (targetW >= w && targetH >= h) {
            resolve({
              base64: stepDown(source),
              width: w, height: h,
              viewportWidth: vpW, viewportHeight: vpH
            })
            return
          }

          const target = document.createElement('canvas')
          target.width = targetW
          target.height = targetH
          const tCtx = target.getContext('2d')
          if (!tCtx) { reject(new Error('target canvas context failed')); return }
          tCtx.drawImage(source, 0, 0, w, h, 0, 0, targetW, targetH)

          resolve({
            base64: stepDown(target),
            width: targetW, height: targetH,
            viewportWidth: vpW, viewportHeight: vpH
          })
        }
        img.onerror = () => reject(new Error('failed to load screenshot image'))
        img.src = dataUrl
      })
    },
    args: [
      base64, 'jpeg', viewportW, viewportH,
      clipScale === 1 ? 1 : dpr,
      RESIZE_PARAMS, MAX_BASE64_CHARS,
      INITIAL_JPEG_QUALITY, JPEG_QUALITY_STEP, MIN_JPEG_QUALITY
    ]
  })

  if (!result || !result.result) {
    throw new Error('content script resize failed')
  }

  const r = result.result
  screenshotContexts.set(tabId, {
    viewportWidth: r.viewportWidth,
    viewportHeight: r.viewportHeight,
    screenshotWidth: r.width,
    screenshotHeight: r.height
  })

  return r.base64
}

// -- JavaScript execution --
//
// Runtime.evaluate in the page world via CDP. The CDP call uses .then()
// instead of await so the service worker stays responsive while synchronous
// JS (alert, confirm) freezes the renderer.

const JS_TIMEOUT = 10000
const JS_MAX_OUTPUT = 51200

function formatResult (cdpResult) {
  if (cdpResult.exceptionDetails) {
    const ex = cdpResult.exceptionDetails.exception
    const isTimeout = ex?.description?.includes('execution was terminated')
    const message = isTimeout
      ? `Execution timeout: Code exceeded ${JS_TIMEOUT / 1000}-second limit`
      : ex?.description || ex?.value || 'Unknown error'
    return { error: `JavaScript execution error: ${message}` }
  }

  if (!cdpResult.result) return { output: 'undefined' }

  const r = cdpResult.result
  let output = ''

  if (r.type === 'undefined') {
    output = 'undefined'
  } else if (r.type === 'object' && r.subtype === 'null') {
    output = 'null'
  } else if (r.type === 'function') {
    output = r.description || '[Function]'
  } else if (r.type === 'object') {
    if (r.subtype === 'node') {
      output = r.description || '[DOM Node]'
    } else if (r.subtype === 'array') {
      output = r.description || '[Array]'
    } else {
      output = r.description || JSON.stringify(r.value || {}, null, 2)
    }
  } else if (r.value !== undefined) {
    output = typeof r.value === 'string' ? r.value : JSON.stringify(r.value, null, 2)
  } else {
    output = r.description || String(r.value)
  }

  if (output.length > JS_MAX_OUTPUT) {
    output = output.substring(0, JS_MAX_OUTPUT) + '\n[OUTPUT TRUNCATED: Exceeded 50KB limit]'
  }

  return { output }
}

async function executeJavascript (callId, code, tabId) {
  try {
    if (!code) {
      sendToolError(callId, 'Code parameter is required')
      return
    }

    const resolvedTabId = await resolveTabId(tabId)
    if (!resolvedTabId) {
      sendToolError(callId, 'No tab found')
      return
    }

    await ensureDebugger(resolvedTabId)

    const expression = `
      (function() {
        'use strict';
        // This code throws and we know it.
        try {
          return eval(${JSON.stringify(code)});
        } catch (e) {
          throw e;
        }
      })()`

    chrome.debugger.sendCommand(
      { tabId: resolvedTabId },
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true, timeout: JS_TIMEOUT }
    ).then(
      result => sendToolResult(callId, formatResult(result)),
      err => sendToolError(callId, `Failed to execute JavaScript: ${err.message || 'Unknown error'}`)
    )
  } catch (e) {
    sendToolError(callId, `Failed to execute JavaScript: ${e.message || 'Unknown error'}`)
  }
}

// -- Connect on startup --
//
// Manifest V3 kills service workers after 30s idle. The alarm wakes us even
// after Chrome terminates the worker. 15 seconds is frequent enough that tool
// calls rarely hit a dead worker.

ensureConnection()

chrome.alarms.create('keepalive', { periodInMinutes: 0.25 })
chrome.alarms.onAlarm.addListener(() => ensureConnection())
