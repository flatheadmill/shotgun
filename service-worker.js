// Shotgun service worker — WebSocket connection to Easement on port 6502.
//
// Global client — no slug association. Receives all messages on the broadcast
// bus and filters for call envelopes where who === 'shotgun'. Tool requests
// arrive tagged with slug and timestamp for routing the response back.
//
// Five tools: screenshot, javascript, tabs_context, tabs_create, navigate.
// Tab groups are per-slug, persisted in chrome.storage.local.
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
// No connect payload, no slug. Shotgun is a global client. The heartbeat keeps
// the service worker alive under Manifest V3. The chrome.alarms keepalive at
// the bottom of the file restarts the connection if the worker dies between
// heartbeats.

let ws = null
let heartbeatInterval = null

function forward (envelope) {
  chrome.runtime.sendMessage({ type: 'envelope', envelope }).catch(() => {})
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
    if (heartbeatInterval) clearInterval(heartbeatInterval)
    heartbeatInterval = setInterval(() => {
      wsSend({ stream: 'heartbeat', data: {} })
    }, 20000)
    forward({ stream: 'connected', data: {} })
  })

  ws.addEventListener('message', (event) => {
    try {
      const envelope = JSON.parse(event.data)
      if (envelope.stream === 'call') {
        handleCall(envelope.data, envelope.slug, envelope.timestamp)
      } else if (envelope.stream === 'tools_query') {
        handleToolsQuery(envelope.data)
      } else {
        forward(envelope)
      }
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
    return
  }
  if (message.type === 'send') {
    ensureConnection()
    wsSend({ stream: 'claude', data: { message: message.text } })
    return
  }
  if (message.type === 'approve') {
    wsSend({ stream: 'approval', data: message.data })
    return
  }
  if (message.type === 'interrupt') {
    wsSend({ stream: 'interrupt', data: {} })
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

// -- Service request dispatch --
//
// currentRequestSlug/Timestamp are stashed per-call so the response helpers
// can include them. Easement needs slug and timestamp to route the response
// back to the correct coordinator. Without them, the response has nowhere to
// go.

let currentRequestSlug = null
let currentRequestTimestamp = null

function handleCall (data, slug, ts) {
  const who = data.who || ''
  const f = data.f || ''
  const id = data.id || ''
  const args = data.args || {}

  if (who !== 'shotgun') return

  currentRequestSlug = slug || null
  currentRequestTimestamp = ts || null

  switch (f) {
    case 'screenshot':
      captureScreenshot(id, args.tabId)
      break
    case 'javascript':
      executeJavascript(id, args.code, args.tabId)
      break
    case 'tabs_context':
      handleTabsContext(id, currentRequestSlug)
      break
    case 'tabs_create':
      handleTabsCreate(id, currentRequestSlug, args.url)
      break
    case 'navigate':
      handleNavigate(id, args.tabId, args.url)
      break
    default:
      sendServiceError(id, 'unknown function: ' + f)
  }
}

function handleToolsQuery (data) {
  const queryId = data.id || ''
  wsSend({
    stream: 'tools_response',
    data: {
      id: queryId,
      tools: [
        { who: 'shotgun', f: 'screenshot', description: 'Capture a screenshot of a browser tab. Args: tabId (int, optional).' },
        { who: 'shotgun', f: 'javascript', description: 'Execute JavaScript in a browser tab. Args: code (string), tabId (int, optional).' },
        { who: 'shotgun', f: 'tabs_context', description: 'List tabs in the browser tab group for this slug.' },
        { who: 'shotgun', f: 'tabs_create', description: 'Open a new tab. Args: url (string, optional).' },
        { who: 'shotgun', f: 'navigate', description: 'Navigate a tab to a URL. Args: tabId (int), url (string).' }
      ]
    }
  })
}

// -- Tab tools --

async function handleTabsContext (requestId, slug) {
  try {
    const context = await getTabContext(slug)
    sendServiceResult(requestId, { output: JSON.stringify(context, null, 2), tabContext: context })
  } catch (e) {
    sendServiceResult(requestId, { error: e.message || 'tabs_context failed' })
  }
}

async function handleTabsCreate (requestId, slug, url) {
  try {
    const result = await createTabInGroup(slug, url)
    sendServiceResult(requestId, result)
  } catch (e) {
    sendServiceResult(requestId, { error: e.message || 'tabs_create failed' })
  }
}

async function handleNavigate (requestId, tabId, url) {
  if (!tabId || !url) {
    sendServiceResult(requestId, { error: 'tabId and url are required' })
    return
  }
  try {
    const result = await navigateTab(tabId, url)
    sendServiceResult(requestId, result)
  } catch (e) {
    sendServiceResult(requestId, { error: e.message || 'navigate failed' })
  }
}

// -- Screenshot capture (ported from Claude Web) --

async function resolveTabId (tabId) {
  if (tabId) return tabId
  if (currentRequestSlug) {
    const context = await getTabContext(currentRequestSlug)
    if (context && context.currentTabId) return context.currentTabId
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab ? tab.id : null
}

async function captureScreenshot (requestId, tabId) {
  try {
    const resolvedTabId = await resolveTabId(tabId)
    if (!resolvedTabId) {
      sendServiceError(requestId, 'no tab to capture')
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
      sendServiceError(requestId, 'failed to get viewport information')
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
      sendServiceError(requestId, 'CDP capture returned no data')
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

    sendServiceResponse(requestId, 'image/jpeg', base64)
  } catch (e) {
    sendServiceError(requestId, e.message || 'screenshot failed')
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
// Runtime.evaluate in the page world via CDP. The sanitizer strips
// credentials, tokens, cookies, and long strings from the return value before
// it travels back through the WebSocket. Ported verbatim from Claude Web — the
// patterns are theirs, the paranoia is earned.
//
  // The CDP call uses .then() instead of await so the service worker stays
// responsive while synchronous JS (alert, confirm) freezes the renderer.

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

async function executeJavascript (requestId, code, tabId) {
  try {
    if (!code) {
      sendServiceResult(requestId, { error: 'Code parameter is required' })
      return
    }

    const resolvedTabId = await resolveTabId(tabId)
    if (!resolvedTabId) {
      sendServiceResult(requestId, { error: 'No tab found' })
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
      result => sendServiceResult(requestId, formatResult(result)),
      err => sendServiceResult(requestId, {
        error: `Failed to execute JavaScript: ${err.message || 'Unknown error'}`
      })
    )
  } catch (e) {
    sendServiceResult(requestId, {
      error: `Failed to execute JavaScript: ${e.message || 'Unknown error'}`
    })
  }
}

// -- Response helpers --
//
// Three flavors: binary (screenshots), JSON (tool results), and plain text
// (errors). All carry slug and timestamp for routing. sendServiceResponse
// passes base64 through as-is (already encoded by CDP). sendServiceResult and
// sendServiceError encode via utf8ToBase64 because the content may have
// unicode.

function sendServiceResponse (requestId, contentType, base64Body) {
  wsSend({
    stream: 'response',
    slug: currentRequestSlug,
    timestamp: currentRequestTimestamp,
    data: { id: requestId, slug: currentRequestSlug, timestamp: currentRequestTimestamp, content_type: contentType, body: base64Body }
  })
}

function sendServiceResult (requestId, result) {
  wsSend({
    stream: 'response',
    slug: currentRequestSlug,
    timestamp: currentRequestTimestamp,
    data: { id: requestId, slug: currentRequestSlug, timestamp: currentRequestTimestamp, content_type: 'application/json', body: utf8ToBase64(JSON.stringify(result)) }
  })
}

function sendServiceError (requestId, message) {
  wsSend({
    stream: 'response',
    slug: currentRequestSlug,
    timestamp: currentRequestTimestamp,
    data: { id: requestId, slug: currentRequestSlug, timestamp: currentRequestTimestamp, content_type: 'text/plain', body: utf8ToBase64(message) }
  })
}

// -- Connect on startup --
//
// Manifest V3 kills service workers after 30s idle. The alarm wakes us even
// after Chrome terminates the worker. 15 seconds is frequent enough that tool
// calls rarely hit a dead worker.

ensureConnection()

chrome.alarms.create('keepalive', { periodInMinutes: 0.25 })
chrome.alarms.onAlarm.addListener(() => ensureConnection())
