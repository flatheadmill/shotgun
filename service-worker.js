// Shotgun service worker — WebSocket connection to Easement on port 6502.
//
// Registers as who=shotgun, where=localhost. Tools are declared at connect
// time. Easement dispatches tool calls directly to our socket — no
// broadcast, no claims.
//
// Ten tools: screenshot, screenshot_save, javascript, tabs_context,
// tabs_create, tabs_close, navigate, read_page, firehose, socialite. Tab groups
// use the slug plus reserved yellow color as ownership; stored IDs are caches.
//
import { trace, setSink, emit } from './log.js'
import { ScreenshotSaver } from './screenshot-save.js'
import { capturePng } from './screenshot-capture.js'
import { Firehose, LIMITS as FIREHOSE_LIMITS } from './firehose.js'
import { IngressProducer, IngressError, LIMITS as INGRESS_LIMITS, utf8Size } from './companion-ingress.js'
import { Socialite, LIMITS as SOCIALITE_LIMITS } from './socialite.js'

const EASEMENT_URL = 'ws://127.0.0.1:6502'
const BROWSER = 'localhost'

// MV3 may emit this again each time an alarm resurrects an idle worker while
// Easement is down. The console sink dies with that worker, so the churn is
// self-limiting today. Revisit it when emit gains a durable Easement endpoint;
// that sink is unavailable in the one condition that produces the churn.
trace('lifecycle', 'start', { where: BROWSER, how: 'service_worker' })

const GROUP_COLOR = 'yellow'
const STORAGE_KEY_PREFIX = 'shotgun_tab_group_'

// -- Screenshot constants --

const RESIZE_PARAMS = { pxPerToken: 28, maxTargetPx: 1568, maxTargetTokens: 1568 }
const MAX_BASE64_CHARS = 1398100
const INITIAL_JPEG_QUALITY = 0.75
const JPEG_QUALITY_STEP = 0.05
const MIN_JPEG_QUALITY = 0.10

// -- Per-tab state --

const attachedTabs = new Set()
const pendingDebuggerAttachments = new Map()
const screenshotContexts = new Map()

const firehose = new Firehose({
  attach: ensureDebugger,
  command: (tabId, method, params) => chrome.debugger.sendCommand({ tabId }, method, params)
})

function utf8ToBase64 (str) {
  // btoa chokes on non-Latin1. Page content has unicode.
  const bytes = new TextEncoder().encode(str)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

// -- Tab group management (per slug) --
//
// The slug survives restarts; Chrome's numeric group IDs are session-scoped.
// Shotgun reserves yellow: both exact slug title and color establish ownership.
// Validate cached IDs and recovery candidates against both; another color is
// not a cosmetic defect to repair, even when the title matches.
// Moving the last tab out also destroys a group, so merge by tab IDs and keep
// the canonical group's original tabs in place while moving the others.

const tabGroups = new Map()
const tabGroupTasks = new Map()
let tabGroupStartup = Promise.resolve()

function ownsTabGroup (slug, group) {
  return group?.title === slug && group?.color === GROUP_COLOR
}

async function queueTabGroup (slug, work) {
  const previous = tabGroupTasks.get(slug) || Promise.resolve()
  const current = previous.catch(() => {}).then(work)
  tabGroupTasks.set(slug, current)
  try { return await current } finally {
    if (tabGroupTasks.get(slug) === current) tabGroupTasks.delete(slug)
  }
}

function withTabGroup (slug, work) {
  return tabGroupStartup.then(() => queueTabGroup(slug, work))
}

// Internal helpers run under a per-slug queue, including startup recovery,
// creation and persistence.
async function loadTabGroupForSlug (slug, reconcile = false) {
  if (!slug) return null
  const key = STORAGE_KEY_PREFIX + slug
  const id = reconcile ? null : tabGroups.get(slug) ?? (await chrome.storage.local.get(key))[key]
  if (!reconcile && id != null) {
    let group
    if (Number.isSafeInteger(id) && id >= 0) {
      try { group = await chrome.tabGroups.get(id) } catch { /* Fall back to a current title lookup. */ }
    }
    if (ownsTabGroup(slug, group)) {
      tabGroups.set(slug, id)
      return id
    }
    trace('tabs', 'forget_group', {
      why: 'the cached tab group could not be validated against the slug and reserved color',
      slug,
      group_id: id
    })
    tabGroups.delete(slug)
    await chrome.storage.local.remove(key)
  }

  // Chrome's title query is pattern-based; enforce exact title and color here.
  const groups = (await chrome.tabGroups.query({}))
    .filter(group => ownsTabGroup(slug, group)).sort((a, b) => a.id - b.id)
  if (groups.length === 0) {
    if (reconcile) {
      tabGroups.delete(slug)
      await chrome.storage.local.remove(key)
    }
    return null
  }
  const canonical = groups[0]
  let groupId = canonical.id
  // Chrome mutations are not transactional. Propagate errors instead of
  // claiming consolidation succeeded; never close tabs to roll back a move.
  for (const duplicate of groups.slice(1)) {
    const tabs = (await chrome.tabs.query({ groupId: duplicate.id })).sort((a, b) => a.index - b.index)
    const tabIds = tabs.map(tab => tab.id)
    if (tabIds.length === 0) continue
    const source = await getOwnedTabGroup(slug, duplicate.id)
    const target = await getOwnedTabGroup(slug, groupId)
    if (source.windowId !== target.windowId) {
      await chrome.tabs.move(tabIds, { windowId: target.windowId, index: -1 })
      await getOwnedTabGroup(slug, groupId)
    }
    // The duplicate ID may no longer exist after move. Do not query or update
    // it again; use the retained tab IDs and the group returned by Chrome.
    groupId = await chrome.tabs.group({ tabIds, groupId })
  }
  await getOwnedTabGroup(slug, groupId)
  await saveTabGroupForSlug(slug, groupId)
  return groupId
}

async function saveTabGroupForSlug (slug, groupId) {
  const key = STORAGE_KEY_PREFIX + slug
  await chrome.storage.local.set({ [key]: groupId })
  tabGroups.set(slug, groupId)
}

async function getOwnedTabGroup (slug, groupId) {
  const group = await chrome.tabGroups.get(groupId)
  if (!ownsTabGroup(slug, group)) throw new Error('Tab group ownership changed; expected the exact slug title and yellow color')
  return group
}

function getTabContext (slug) {
  return withTabGroup(slug, async () => tabContextForGroup(await loadTabGroupForSlug(slug)))
}

async function tabContextForGroup (groupId) {
  if (groupId == null) {
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

function createTabInGroup (slug, url) {
  return withTabGroup(slug, async () => {
    let groupId = await loadTabGroupForSlug(slug)
    const group = groupId == null ? null : await getOwnedTabGroup(slug, groupId)
    const tab = await chrome.tabs.create({ url: url || 'chrome://newtab', active: true,
      ...(group ? { windowId: group.windowId } : {}) })
    if (!tab.id) return { error: 'Failed to create tab.' }
    if (groupId == null) {
      groupId = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId: tab.windowId } })
      await chrome.tabGroups.update(groupId, { title: slug, color: GROUP_COLOR, collapsed: false })
      await saveTabGroupForSlug(slug, groupId)
    } else {
      await getOwnedTabGroup(slug, groupId)
      groupId = await chrome.tabs.group({ tabIds: tab.id, groupId })
    }
    return {
      output: `Created tab ${tab.id}${url ? ' at ' + url : ''}`,
      tabContext: await tabContextForGroup(groupId)
    }
  })
}

async function recoverStoredTabGroups() {
  let stored
  try {
    stored = await chrome.storage.local.get(null)
  } catch {
    trace('tabs', 'fail_recover', { why: 'stored tab group keys could not be enumerated' })
    return
  }
  const slugs = [...new Set(Object.keys(stored)
    .filter(key => key.startsWith(STORAGE_KEY_PREFIX))
    .map(key => key.slice(STORAGE_KEY_PREFIX.length)).filter(Boolean))].sort()
  await Promise.all(slugs.map(slug => queueTabGroup(slug, () => loadTabGroupForSlug(slug, true)).catch(() => {
    trace('tabs', 'fail_recover', { why: 'startup tab group reconciliation failed', slug })
  })))
}

tabGroupStartup = recoverStoredTabGroups()

async function navigateTab (tabId, url) {
  try {
    await chrome.tabs.update(tabId, { url })
    return { output: `Navigated tab ${tabId} to ${url}` }
  } catch (e) {
    return { error: `Failed to navigate: ${e.message}` }
  }
}

// -- WebSocket connection to Easement --
//
// On open, register with who=shotgun, where=browser, and declare our tools.
// Easement dispatches calls directly to our socket. The heartbeat keeps the
// service worker alive. The chrome.alarms keepalive restarts the connection
// if the worker dies.

let ws = null

const TOOLS = [
  { f: 'screenshot_save', description: 'Save an exact PNG through Wicket. Required: action (capture|retry|status|abandon), operation_id (caller-known string; use a fresh ID for a deliberate new capture). Capture also requires destination (absolute file path with an existing parent) and mode (viewport|full_page). tabId (int, optional), where (localhost only, optional). Always checks status first. Retry uses only bytes retained in this worker and requires the original destination to retransmit; abandon explicitly releases retained bytes and cancels a live receive when one exists. After worker loss retry only reports status. Returns a Wicket outcome as text, without image content.' },
  { f: 'screenshot', description: 'Capture a screenshot of a browser tab. Args: tabId (int, optional).' },
  { f: 'javascript', description: 'Execute JavaScript in a browser tab. Args: code (string), tabId (int, optional).' },
  { f: 'tabs_context', description: 'List tabs in the browser tab group for this slug.' },
  { f: 'tabs_create', description: 'Open a new tab. Args: url (string, optional).' },
  { f: 'tabs_close', description: 'Close a browser tab. Args: tabId (positive safe integer, required).' },
  { f: 'navigate', description: 'Navigate a tab to a URL. Args: tabId (int), url (string).' },
  { f: 'read_page', description: 'Read page text through the isolated world content script. Invisible to the page. Args: selector (string, optional CSS selector to scope the read), maxChars (int, optional, default 50000), tabId (int, optional), frameId (int, optional, default 0 for top frame).' },
  { f: 'firehose', description: 'Temporary passive Network tap with one in-memory pile. action=start requires an explicit tabId (positive int), with optional url (absolute URL literal without query or fragment) selecting response bodies; all request metadata is observed. Start after stop replaces the pile. action=read inspects from (int, default 0) and limit (1-100, default 50), or body (one body-outcome pile index). Reading never starts capture or fetches a body. action=stop freezes the pile and disables Network reporting without detaching the debugger. One body command, no queue; busy, unavailable, clipping and full are explicit. Fixed limits are reported; worker loss loses the pile. No persistence or application parsing.' },
  { f: 'socialite', description: 'Passive X Bookmarks review to the standing Socialite companion. action=start requires an explicit positive tabId on https://x.com and one available companion. action=status reports limits, acquisition and retained-operation state without source content. action=stop closes acquisition while retained transfers resolve. action=lookup requires operation_id retained in this worker and only queries its receipt. action=abandon requires operation_id and explicitly discards its cargo, retaining the full manifest in a bounded in-memory tombstone for later lookup; remote acceptance remains unknown. Unresolved retained cargo blocks a later review. Mutually exclusive with Firehose Network capture. No scrolling, synthetic requests, reconnect retry, persistence or video capture.' },
]

function wsSend (obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj))
    return true
  }
  return false
}

// Route log records over the same socket. emit sends the log frame through
// wsSend, which reports whether the socket was open; when it is not, emit
// falls back to the console until the connection recovers.
setSink(wsSend)

const screenshotSaver = new ScreenshotSaver({
  send: (socket, packet) => {
    if (socket.readyState !== WebSocket.OPEN) return false
    // One acknowledged chunk at a time also bounds the browser's socket buffer.
    if (socket.bufferedAmount > 256 * 1024) return false
    socket.send(JSON.stringify(packet))
    return true
  },
  capture: args => capturePng(args, { chrome, getContext: getTabContext, ensureDebugger }),
  observe: emit
})

const socialiteIngress = new IngressProducer({
  send: (socket, packet) => {
    const text = JSON.stringify(packet)
    if (socket !== ws || socket?.readyState !== WebSocket.OPEN || utf8Size(text) > INGRESS_LIMITS.packetBytes ||
      socket.bufferedAmount + utf8Size(text) > INGRESS_LIMITS.socketBufferedBytes) return false
    socket.send(text)
    return true
  }
})
const socialite = new Socialite({
  ingress: socialiteIngress, attach: ensureDebugger,
  command: (tabId, method, params) => chrome.debugger.sendCommand({ tabId }, method, params),
  getTab: tabId => chrome.tabs.get(tabId), socket: () => ws,
  firehoseBusy: () => Boolean(firehose.transition) || firehose.current?.state === 'collecting'
})

function ensureConnection () {
  if (ws && ws.readyState === WebSocket.OPEN) return
  if (ws && ws.readyState === WebSocket.CONNECTING) return

  // Connection logging is transition-only: disconnect on losing an open
  // socket, connect on recovery, and no line for each failed attempt. A worker
  // cold-starting while Easement is already down therefore emits lifecycle
  // start but no fail_connect; that silence is deliberate, not an omission.
  const socket = new WebSocket(EASEMENT_URL)
  let opened = false
  let heartbeat = null
  ws = socket

  socket.addEventListener('open', () => {
    opened = true
    trace('websocket', 'connect', {
      whom: 'easement',
      where: BROWSER,
      how: 'websocket'
    })

    // Register with Easement. Tools declared here, not via tools_query.
    wsSend({ what: 'socket', why: 'connect', who: 'shotgun', where: 'localhost', tools: TOOLS })

    // Unlike Wicket, Shotgun does not log every sent frame: heartbeats are a
    // periodic condition, not an event, and must not flood the log.
    heartbeat = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ what: 'socket', why: 'heartbeat' }))
      }
    }, 20000)
  })

  socket.addEventListener('message', (event) => {
    // Only the parse can fail on a malformed frame off the wire. Guard that
    // narrowly and say so when it happens; do not wrap our own dispatch logic
    // below in a catch, where it would swallow real bugs into silence.
    let msg
    try {
      msg = JSON.parse(event.data)
    } catch {
      trace('wire', 'reject', { whom: 'easement', where: BROWSER, how: 'json', why: 'invalid JSON frame' })
      return
    }

    // Screenshot-family packets are never passed to a raw-wire logger.
    if (msg?.what === 'screenshot_save') {
      screenshotSaver.receive(msg, socket)
      return
    }
    if (msg?.what === 'companion_ingress') {
      socialiteIngress.receive(msg, socket)
      return
    }

    // Tool dispatch from Easement. Tagged with what=tool, why=run.
    if (msg?.what === 'tool' && msg.why === 'run') {
      handleToolRun(msg, socket)
      return
    }

    // The side-panel conversation surface was retired by decision with the
    // print-era bus. Shotgun receives tool dispatches; it no longer drives or
    // renders conversations. Unexpected frames are observed by logging.
    trace('wire', 'unrecognized', {
      whom: 'easement',
      where: BROWSER,
      why: 'the frame is not a tool dispatch',
      how: 'websocket'
    })
  })

  socket.addEventListener('close', (event) => {
    screenshotSaver.disconnect(socket)
    socialite.disconnect(socket)
    if (heartbeat) clearInterval(heartbeat)
    if (ws === socket) ws = null
    if (opened) {
      trace('websocket', 'disconnect', {
        whom: 'easement',
        where: BROWSER,
        why: `websocket closed with code ${event.code}`,
        how: 'websocket',
        code: event.code
      })
    }
  })

  socket.addEventListener('error', () => {
    socket.close()
  })
}

// -- Debugger lifecycle --
//
// Attach once per tab, stay attached. Chrome detaches automatically when the
// tab closes or navigates to a chrome:// URL. The yellow "is being debugged"
// bar is the cost of CDP access.

async function ensureDebugger (tabId) {
  if (attachedTabs.has(tabId)) return
  if (pendingDebuggerAttachments.has(tabId)) return pendingDebuggerAttachments.get(tabId)
  const pending = (async () => {
    await chrome.debugger.attach({ tabId }, '1.3')
    if (pendingDebuggerAttachments.get(tabId) !== pending) throw new Error('Debugger attachment ended before completing')
    attachedTabs.add(tabId)
    trace('debugger', 'attach', { how: 'cdp', tab_id: tabId })
  })()
  pendingDebuggerAttachments.set(tabId, pending)
  try { await pending } finally {
    if (pendingDebuggerAttachments.get(tabId) === pending) pendingDebuggerAttachments.delete(tabId)
  }
}

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId != null) {
    trace('debugger', 'detach', {
      why: reason || 'Chrome detached the debugger',
      how: 'cdp',
      tab_id: source.tabId
    })
    attachedTabs.delete(source.tabId)
    pendingDebuggerAttachments.delete(source.tabId)
    firehose.detached(source.tabId)
    socialite.detached(source.tabId)
  }
})

chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId)
  screenshotContexts.delete(tabId)
  pendingDebuggerAttachments.delete(tabId)
  firehose.detached(tabId, 'tab_removed')
  socialite.detached(tabId, 'tab_removed')
})
chrome.tabs.onUpdated.addListener((tabId, change) => socialite.navigation(tabId, change.url))

// -- Network event capture --
// The two explicit consumers exclude one another while owning Network capture.
// No child-session attachment is requested; body commands address the tab session.
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!source.sessionId) {
    firehose.onEvent(source.tabId, method, params)
    socialite.onEvent(source.tabId, method, params)
  }
})

// -- Token budget resize --
//
// Estimate image tokens from dimensions and resize toward configured limits. fitDimensions binary-searches for the largest size
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

function handleToolRun (msg, socket) {
  const callId = msg.call_id || ''
  const f = msg.f || ''
  currentSlug = msg.slug || null

  trace('tool', 'run', { call_id: callId, f, slug: currentSlug })

  switch (f) {
    case 'screenshot_save':
      handleScreenshotSave(msg, socket)
      break
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
    case 'tabs_close':
      handleTabsClose(callId, msg.tabId)
      break
    case 'navigate':
      handleNavigate(callId, msg.tabId, msg.url)
      break
    case 'read_page':
      handleReadPage(callId, msg.selector, msg.maxChars, msg.tabId, msg.frameId)
      break
    case 'firehose':
      handleFirehose(msg, socket)
      break
    case 'socialite':
      handleSocialite(msg, socket)
      break
    default:
      sendToolReject(callId, 'unknown function: ' + f)
  }
}

async function handleScreenshotSave (msg, socket) {
  const result = await screenshotSaver.run(msg, socket)
  const code = result.why === 'stored' || (msg.action === 'abandon' && ['abandoned', 'aborted'].includes(result.why)) ? 0 : 1
  // The outer response carries the exact relayed outcome. It never asserts a
  // separate artifact success, and an old call never replies on a new socket.
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ what: 'tool', why: 'response', call_id: msg.call_id,
      output: JSON.stringify(result), exit_code: code }))
    trace('tool', 'respond', { call_id: msg.call_id, exit_code: code,
      operation_id: msg.operation_id, event_id: result.receipt?.event_id })
  } else {
    trace('tool', 'fail_respond', { call_id: msg.call_id, operation_id: msg.operation_id,
      why: 'the owning socket disconnected; query status by operation_id' })
  }
}

function sendToolResponse (callId, output, exitCode) {
  const code = exitCode || 0
  const sent = wsSend({ what: 'tool', why: 'response', call_id: callId, output, exit_code: code })
  if (sent) {
    trace('tool', 'respond', { call_id: callId, exit_code: code })
  } else {
    trace('tool', 'fail_respond', {
      why: 'the websocket disconnected before the response was sent',
      call_id: callId,
      exit_code: code
    })
  }
}

function sendToolResult (callId, result) {
  const output = JSON.stringify(result)
  if (result.error) {
    trace('tool', 'fail_run', { why: result.error, call_id: callId })
  }
  sendToolResponse(callId, output, result.error ? 1 : 0)
}

function sendToolReject (callId, message) {
  trace('tool', 'reject', { why: message, call_id: callId })
  sendToolResponse(callId, message, 1)
}

function sendToolFailure (callId, message) {
  trace('tool', 'fail_run', { why: message, call_id: callId })
  sendToolResponse(callId, message, 1)
}

// -- Tab tools --

async function handleTabsContext (callId, slug) {
  try {
    const context = await getTabContext(slug)
    sendToolResult(callId, { output: JSON.stringify(context, null, 2), tabContext: context })
  } catch (e) {
    sendToolFailure(callId, e.message || 'tabs_context failed')
  }
}

async function handleTabsCreate (callId, slug, url) {
  try {
    const result = await createTabInGroup(slug, url)
    sendToolResult(callId, result)
  } catch (e) {
    sendToolFailure(callId, e.message || 'tabs_create failed')
  }
}

async function handleTabsClose (callId, tabId) {
  if (!Number.isSafeInteger(tabId) || tabId <= 0) {
    sendToolReject(callId, 'tabId is required and must be a positive safe integer')
    return
  }
  try {
    await chrome.tabs.remove(tabId)
    sendToolResponse(callId, `Closed tab ${tabId}`, 0)
  } catch (e) {
    sendToolFailure(callId, e.message || 'tabs_close failed')
  }
}

async function handleNavigate (callId, tabId, url) {
  if (!tabId || !url) {
    sendToolReject(callId, 'tabId and url are required')
    return
  }
  try {
    const result = await navigateTab(tabId, url)
    sendToolResult(callId, result)
  } catch (e) {
    sendToolFailure(callId, e.message || 'navigate failed')
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
      sendToolReject(callId, 'No tab found')
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
      sendToolFailure(callId, response.error)
    } else {
      sendToolResult(callId, { output: response.text, title: response.title, url: response.url, selector: response.selector, length: response.length })
    }
  } catch (e) {
    sendToolFailure(callId, e.message || 'read_page failed')
  }
}

// -- Firehose (explicit, disposable Network tap) --
async function handleFirehose (msg, socket) {
  const { call_id: callId, slug, action, tabId, url, from, limit, body } = msg
  let result; let exitCode = 0
  try {
    if (action === 'start') {
      if (socialite.ownsNetwork) throw new Error('Socialite owns Network capture; stop it before starting Firehose')
      result = await firehose.start({ tabId, url })
    }
    else if (action === 'read') result = firehose.read({ from, limit, body })
    else if (action === 'stop') result = firehose.stop()
    else throw new Error('firehose action must be start, read or stop')
  } catch (e) {
    result = { error: String(e?.message ?? e).slice(0, 1024) }
    exitCode = 1
  }
  let output = JSON.stringify(result)
  if (new TextEncoder().encode(output).length > FIREHOSE_LIMITS.readBytes) {
    output = JSON.stringify({ error: 'Firehose result exceeds its serialized read limit' })
    exitCode = 1
  }
  // Never log capture contents or returned CDP errors. A reply belongs to this
  // dispatch's socket even if a replacement connection is now open.
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ what: 'tool', why: 'response', call_id: callId, output, exit_code: exitCode }))
    trace('tool', 'respond', { call_id: callId, slug, exit_code: exitCode })
  } else {
    trace('tool', 'fail_respond', { call_id: callId, slug, why: 'the owning socket disconnected' })
  }
}

async function handleSocialite (msg, socket) {
  const { call_id: callId, slug, action, tabId, operation_id: operation } = msg
  let result; let exitCode = 0
  try {
    if (socket !== ws || socket.readyState !== WebSocket.OPEN) throw new IngressError('connection_unavailable')
    if (action === 'start') result = await socialite.start({ tabId }, socket)
    else if (action === 'status') result = socialite.status()
    else if (action === 'stop') result = socialite.stop()
    else if (action === 'lookup') result = await socialiteIngress.lookup(operation, socket)
    else if (action === 'abandon') result = socialiteIngress.abandon(operation)
    else throw new IngressError('invalid_action')
  } catch (error) {
    result = { error: error instanceof IngressError ? error.code : 'socialite_failed' }; exitCode = 1
  }
  let output = JSON.stringify(result)
  if (utf8Size(output) > SOCIALITE_LIMITS.statusBytes) { output = JSON.stringify({ error: 'status_limit' }); exitCode = 1 }
  // Status and failures are bounded dispositions, never CDP or peer error text.
  // A delayed tool response still belongs only to its original physical socket.
  if (socket === ws && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ what: 'tool', why: 'response', call_id: callId, output, exit_code: exitCode }))
    trace('tool', 'respond', { call_id: callId, slug, exit_code: exitCode })
  } else trace('tool', 'fail_respond', { call_id: callId, slug, why: 'the owning socket disconnected' })
}

// -- Screenshot capture --

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
      sendToolReject(callId, 'no tab to capture')
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
      sendToolFailure(callId, 'failed to get viewport information')
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
      sendToolFailure(callId, 'CDP capture returned no data')
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
    sendToolFailure(callId, e.message || 'screenshot failed')
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
      sendToolReject(callId, 'Code parameter is required')
      return
    }

    const resolvedTabId = await resolveTabId(tabId)
    if (!resolvedTabId) {
      sendToolReject(callId, 'No tab found')
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
      err => sendToolFailure(callId, `Failed to execute JavaScript: ${err.message || 'Unknown error'}`)
    )
  } catch (e) {
    sendToolFailure(callId, `Failed to execute JavaScript: ${e.message || 'Unknown error'}`)
  }
}

// -- Connect on startup --
//
// Manifest V3 kills service workers after 30s idle. The alarm wakes us even
// after Chrome terminates the worker. Alarm ticks themselves are conditions,
// not events; they stay silent unless connection state actually changes.

ensureConnection()

chrome.alarms.create('keepalive', { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') ensureConnection()
})
