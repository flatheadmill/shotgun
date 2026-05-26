// Shotgun service worker — WebSocket connection to Wicket on port 6502.
//
// Ported from Claude Web (mcpPermissions-CUBzZeeG.js, 1.0.72).

const SLUG = 'chrome'

// -- Screenshot constants from Claude Web --

const RESIZE_PARAMS = { pxPerToken: 28, maxTargetPx: 1568, maxTargetTokens: 1568 }
const MAX_BASE64_CHARS = 1398100
const INITIAL_JPEG_QUALITY = 0.75
const JPEG_QUALITY_STEP = 0.05
const MIN_JPEG_QUALITY = 0.10

// -- Per-tab state --

const attachedTabs = new Set()
const screenshotContexts = new Map()

// -- Side panel and action --

chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ tabId: tab.id })
})

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })

// -- WebSocket connection to Wicket --

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
    wsSend({ slug: SLUG, protocol: 'wicket' })
    if (heartbeatInterval) clearInterval(heartbeatInterval)
    heartbeatInterval = setInterval(() => {
      wsSend({ stream: 'heartbeat', data: {} })
    }, 20000)
    forward({ stream: 'connected', data: {} })
  })

  ws.addEventListener('message', (event) => {
    try {
      const envelope = JSON.parse(event.data)
      if (envelope.stream === 'request') {
        handleServiceRequest(envelope.data)
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

function handleServiceRequest (data) {
  const id = data.id
  wsSend({ stream: 'claim', data: { id } })

  const type = data.type
  if (type === 'capture') {
    captureScreenshot(id)
  } else if (type === 'javascript') {
    executeJavascript(id, data.code)
  } else {
    sendServiceError(id, 'unknown request type: ' + data.type)
  }
}

// -- Screenshot capture (ported from Claude Web) --

async function captureScreenshot (requestId) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab) {
      sendServiceError(requestId, 'no active tab')
      return
    }

    const tabId = tab.id
    await ensureDebugger(tabId)

    const [probeResult] = await chrome.scripting.executeScript({
      target: { tabId },
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

    const result = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', cdpParams)
    if (!result || !result.data) {
      sendServiceError(requestId, 'CDP capture returned no data')
      return
    }

    let base64 = result.data

    if (base64.length > MAX_BASE64_CHARS) {
      base64 = await resizeInContentScript(tabId, base64, width, height, dpr, scale)
    }

    screenshotContexts.set(tabId, {
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

// -- JavaScript execution (ported from Claude Web) --

const JS_TIMEOUT = 10000
const JS_OUTER_TIMEOUT = 15000
const JS_MAX_OUTPUT = 51200

const SENSITIVE_KEY_PATTERN = /password|token|secret|api[_-]?key|auth|credential|private[_-]?key|access[_-]?key|bearer|oauth|session/i

function sanitizeOutput (value, depth = 0) {
  if (depth > 5) return '[TRUNCATED: Max depth exceeded]'

  if (typeof value === 'string') {
    if (value.includes('=') && (value.includes(';') || value.includes('&'))) {
      return '[BLOCKED: Cookie/query string data]'
    }
    if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) {
      return '[BLOCKED: JWT token]'
    }
    if (/^[A-Za-z0-9+/]{20,}={0,2}$/.test(value)) {
      return '[BLOCKED: Base64 encoded data]'
    }
    if (/^[a-f0-9]{32,}$/i.test(value)) {
      return '[BLOCKED: Hex credential]'
    }
    if (value.length > 1000) return value.substring(0, 1000) + '[TRUNCATED]'
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const result = {}
    for (const [key, val] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        result[key] = '[BLOCKED: Sensitive key]'
      } else if (key === 'cookie' || key === 'cookies') {
        result[key] = '[BLOCKED: Cookie access]'
      } else {
        result[key] = sanitizeOutput(val, depth + 1)
      }
    }
    return result
  }

  if (Array.isArray(value)) {
    const result = value.slice(0, 100).map(item => sanitizeOutput(item, depth + 1))
    if (value.length > 100) {
      result.push(`[TRUNCATED: ${value.length - 100} more items]`)
    }
    return result
  }

  return value
}

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
      const sanitized = sanitizeOutput(r.value || {})
      output = r.description || JSON.stringify(sanitized, null, 2)
    }
  } else if (r.value !== undefined) {
    const sanitized = sanitizeOutput(r.value)
    output = typeof sanitized === 'string' ? sanitized : JSON.stringify(sanitized, null, 2)
  } else {
    output = r.description || String(r.value)
  }

  if (output.length > JS_MAX_OUTPUT) {
    output = output.substring(0, JS_MAX_OUTPUT) + '\n[OUTPUT TRUNCATED: Exceeded 50KB limit]'
  }

  return { output }
}

async function executeJavascript (requestId, code) {
  try {
    if (!code) {
      sendServiceResult(requestId, { error: 'Code parameter is required' })
      return
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab) {
      sendServiceResult(requestId, { error: 'No active tab found' })
      return
    }

    const tabId = tab.id
    await ensureDebugger(tabId)

    const expression = `
      (function() {
        'use strict';
        try {
          return eval(${JSON.stringify(code)});
        } catch (e) {
          throw e;
        }
      })()`

    const result = await chrome.debugger.sendCommand(
      { tabId },
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true, timeout: JS_TIMEOUT }
    )

    sendServiceResult(requestId, formatResult(result))
  } catch (e) {
    sendServiceResult(requestId, {
      error: `Failed to execute JavaScript: ${e.message || 'Unknown error'}`
    })
  }
}

// -- Service response helpers --

function sendServiceResponse (requestId, contentType, base64Body) {
  wsSend({
    stream: 'response',
    data: { id: requestId, content_type: contentType, body: base64Body }
  })
}

function sendServiceResult (requestId, result) {
  wsSend({
    stream: 'response',
    data: { id: requestId, content_type: 'application/json', body: btoa(JSON.stringify(result)) }
  })
}

function sendServiceError (requestId, message) {
  wsSend({
    stream: 'response',
    data: { id: requestId, content_type: 'text/plain', body: btoa(message) }
  })
}
