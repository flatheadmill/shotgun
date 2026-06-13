import { ProtocolAdapter } from './panel/adapter.js'
import { TranscriptModel } from './panel/model.js'
import './panel/components/transcript.js'
import './panel/components/code-block.js'

const input = document.getElementById('input')
const button = document.getElementById('send')
const transcript = document.getElementById('transcript')

const adapter = new ProtocolAdapter()
const model = new TranscriptModel()

let roundActive = false

transcript.state = model.snapshot()

adapter.addEventListener('event', (event) => {
  model.apply(event.detail)
})

model.addEventListener('change', () => {
  transcript.state = model.snapshot()
})

transcript.addEventListener('sg-toggle-tool', (event) => {
  model.setToolExpanded(event.detail.key, event.detail.expanded)
})

button.addEventListener('click', () => {
  if (roundActive) interrupt()
  else send()
})

input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !roundActive) send()
})

chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== 'envelope') return
  const events = adapter.ingestEnvelope(message.envelope)
  for (const event of events) updateRoundState(event)
})

function updateRoundState (event) {
  if (event.type === 'lifecycle' && event.code === 'round_started') setRoundActive(true)
  if (event.type === 'lifecycle' && (event.code === 'round_completed' || event.code === 'round_interrupted')) setRoundActive(false)
  if (event.type === 'session.disconnected' || event.type === 'error') setRoundActive(false)
}

function setRoundActive (active) {
  roundActive = active
  input.disabled = active
  button.disabled = false
  button.textContent = active ? 'Stop' : 'Send'
  button.title = active ? 'Interrupt' : 'Send'
  button.dataset.mode = active ? 'interrupt' : 'send'
  if (!active) input.focus()
}

function send () {
  const text = input.value.trim()
  if (!text || roundActive) return
  model.apply(adapter.localUserEntry(text))
  input.value = ''
  setRoundActive(true)
  chrome.runtime.sendMessage({ type: 'send', text })
}

function interrupt () {
  chrome.runtime.sendMessage({ type: 'interrupt' })
}

chrome.runtime.sendMessage({ type: 'connect' })
