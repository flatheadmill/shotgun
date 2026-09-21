import { capturePlan, decodePng, resolveSaveTab } from './screenshot-save.js'

// CDP returns the complete base64 PNG in memory. Chunking happens only after
// this capture and validation; this function does not stream browser pixels.
export async function capturePng (args, { chrome, getContext, ensureDebugger, decodeImage = createImageBitmap }) {
  const tabId = await resolveSaveTab(args.tabId, args.slug, getContext,
    () => chrome.tabs.query({ active: true, currentWindow: true }))
  const tab = await chrome.tabs.get(tabId)
  const source_url = tab.url || ''
  if (new TextEncoder().encode(source_url).length > 8192) throw new Error('capture URL exceeds metadata limit')
  const source_title = (tab.title || '').slice(0, 4096)
  await ensureDebugger(tabId)
  const metrics = await chrome.debugger.sendCommand({ tabId }, 'Page.getLayoutMetrics')
  const [probe] = await chrome.scripting.executeScript({
    target: { tabId }, injectImmediately: true, func: () => ({ dpr: window.devicePixelRatio })
  })
  const dpr = probe?.result?.dpr
  const params = capturePlan(args.mode, metrics, dpr)
  const captured_at = new Date().toISOString()
  const result = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', params)
  const image = await decodePng(result?.data)
  // Header checks bound the allocation before asking Chrome to decode pixels.
  // The bitmap is validation only: never draw, scale, or re-encode it.
  const bitmap = await decodeImage(new Blob([image.bytes], { type: 'image/png' }))
  try {
    if (bitmap.width !== image.pixel_width || bitmap.height !== image.pixel_height) throw new Error('PNG decoded dimensions differ')
  } finally { bitmap.close() }
  return { ...image, tabId, source_url, source_title, captured_at,
    capture_metrics: { dpr, viewport: metrics.cssVisualViewport, content: metrics.cssContentSize } }
}
