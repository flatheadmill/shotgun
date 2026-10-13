import test from 'node:test'
import assert from 'node:assert/strict'
import { setSink } from '../log.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
const key = slug => `shotgun_tab_group_${slug}`
const emptyContext = { currentTabId: null, availableTabs: [], tabCount: 0, tabGroupId: null }
let imports = 0

// Actual worker dispatch, with a stateful Chrome boundary. Moving tabs across
// windows ungroups them and deletes their empty source group immediately; using
// that old group ID afterward fails. This is not a loaded-browser test.
async function worker ({ groups = [], tabs = [], storage = {}, before = async () => {} } = {}) {
  const previous = Object.fromEntries(['chrome', 'WebSocket', 'setInterval', 'clearInterval'].map(k => [k, globalThis[k]]))
  const originalLog = console.log; console.log = () => {}
  const state = {
    groups: new Map(groups.map(g => [g.id, { color: 'yellow', collapsed: false, ...g }])),
    tabs: new Map(tabs.map((t, index) => [t.id, { index, url: `https://example.test/${t.id}`, title: `Tab ${t.id}`, ...t }])),
    storage: { ...storage }, calls: []
  }
  let nextTab = 1000; let nextGroup = 100; let sequence = 0; let socket
  const event = { addListener () {} }
  const group = id => {
    const value = state.groups.get(id)
    if (!value) throw new Error(`No group with id: ${id}`)
    return value
  }
  const tab = id => {
    const value = state.tabs.get(id)
    if (!value) throw new Error(`No tab with id: ${id}`)
    return value
  }
  const prune = () => {
    for (const id of state.groups.keys()) {
      if (![...state.tabs.values()].some(t => t.groupId === id)) state.groups.delete(id)
    }
  }
  const record = async (method, args) => { state.calls.push({ method, args: structuredClone(args) }); await before(method, args) }
  class Socket {
    static OPEN = 1; static CONNECTING = 0
    readyState = 1; bufferedAmount = 0; listeners = {}; frames = []
    constructor () { socket = this }
    addEventListener (type, fn) { this.listeners[type] = fn }
    send (data) { this.frames.push(JSON.parse(data)) }
    close () { this.readyState = 3; this.listeners.close({ code: 1000 }) }
    receive (packet) { this.listeners.message({ data: JSON.stringify(packet) }) }
  }
  const browser = {
    storage: { local: {
      get: async k => { await record('storage.get', k); return { [k]: state.storage[k] } },
      set: async values => { await record('storage.set', values); Object.assign(state.storage, values) },
      remove: async k => { await record('storage.remove', k); delete state.storage[k] }
    } },
    tabGroups: {
      get: async id => { await record('groups.get', id); return { ...group(id) } },
      // Deliberately return nonmatching titles too, so exact matching cannot
      // accidentally rely on Chrome's title-pattern query.
      query: async query => { await record('groups.query', query); return [...state.groups.values()].map(g => ({ ...g })) },
      update: async (id, values) => { await record('groups.update', { id, values }); Object.assign(group(id), values); return { ...group(id) } }
    },
    tabs: {
      onRemoved: event, onUpdated: event,
      query: async query => {
        await record('tabs.query', query)
        return [...state.tabs.values()].filter(t => query.groupId === undefined || t.groupId === query.groupId)
          .sort((a, b) => a.index - b.index).map(t => ({ ...t }))
      },
      create: async values => {
        await record('tabs.create', values)
        const result = { id: nextTab++, windowId: values.windowId ?? 1, groupId: -1, index: state.tabs.size,
          title: 'New tab', url: values.url, active: values.active }
        state.tabs.set(result.id, result); return { ...result }
      },
      move: async (ids, values) => {
        await record('tabs.move', { ids, values })
        assert.equal(values.index, -1)
        const moving = (Array.isArray(ids) ? ids : [ids]).map(tab)
        for (const t of moving) { t.windowId = values.windowId; t.groupId = -1 }
        prune()
        return moving.map(t => ({ ...t }))
      },
      group: async values => {
        await record('tabs.group', values)
        const moving = (Array.isArray(values.tabIds) ? values.tabIds : [values.tabIds]).map(tab)
        const target = values.groupId === undefined
          ? { id: nextGroup++, windowId: values.createProperties?.windowId ?? 1, title: '', color: 'grey', collapsed: false }
          : group(values.groupId)
        assert.ok(moving.length > 0)
        assert.ok(moving.every(t => t.windowId === target.windowId), 'move cross-window tabs before regrouping')
        state.groups.set(target.id, target)
        for (const t of moving) t.groupId = target.id
        prune()
        return target.id
      },
      remove: async () => { throw new Error('Recovery must never delete a tab') }
    },
    debugger: { onDetach: event, onEvent: event },
    alarms: { create () {}, onAlarm: event }
  }
  globalThis.chrome = browser; globalThis.WebSocket = Socket
  globalThis.setInterval = () => 1; globalThis.clearInterval = () => {}
  const cleanup = async () => {
    socket?.close(); await tick(); setSink(null); console.log = originalLog
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[name]
      else globalThis[name] = value
    }
  }
  try { await import(`../service-worker.js?groups-test=${++imports}`); socket.listeners.open() } catch (error) { await cleanup(); throw error }
  return { state, cleanup, invoke: async (f, slug, args = {}) => {
    const call_id = `group-call-${++sequence}`
    socket.receive({ what: 'tool', why: 'run', f, slug, call_id, ...args })
    let response
    for (let n = 0; n < 100 && !response; n++) {
      await tick(); response = socket.frames.find(p => p.what === 'tool' && p.call_id === call_id)
    }
    assert.ok(response, 'tool call must respond')
    return response.exit_code ? { error: response.output } : JSON.parse(response.output)
  } }
}

test('stale stored ID adopts the exact slug title in yellow and persists its current ID', async () => {
  const f = await worker({ storage: { [key('seat*')]: 88 }, groups: [
    { id: 11, windowId: 1, title: 'seat-other', color: 'blue' }, { id: 12, windowId: 1, title: 'seat*' }
  ], tabs: [{ id: 1, windowId: 1, groupId: 11 }, { id: 2, windowId: 1, groupId: 12 }] })
  try {
    const result = await f.invoke('tabs_context', 'seat*')
    assert.equal(result.tabContext.tabGroupId, 12)
    assert.deepEqual(result.tabContext.availableTabs.map(t => t.id), [2])
    assert.equal(f.state.storage[key('seat*')], 12)
    assert.equal(f.state.groups.get(12).color, 'yellow')
    assert.equal(f.state.groups.get(11).color, 'blue')
    assert.equal(f.state.calls.some(c => c.method === 'tabs.create'), false)
  } finally { await f.cleanup() }
})

test('an ID reused by an unrelated title is stale; the slug remains the identity', async () => {
  const f = await worker({ storage: { [key('seat')]: 11 }, groups: [
    { id: 11, windowId: 1, title: 'unrelated' }, { id: 12, windowId: 1, title: 'seat' }
  ], tabs: [{ id: 1, windowId: 1, groupId: 11 }, { id: 2, windowId: 1, groupId: 12 }] })
  try {
    assert.equal((await f.invoke('tabs_context', 'seat')).tabContext.tabGroupId, 12)
    assert.equal(f.state.groups.get(11).title, 'unrelated')
    assert.equal(f.state.tabs.get(1).groupId, 11)
  } finally { await f.cleanup() }
})

test('duplicate same-window groups merge into the lowest ID without losing tabs', async () => {
  const f = await worker({ groups: [9, 3, 6].map(id => ({ id, windowId: 1, title: 'seat' })),
    tabs: [9, 3, 6].map(id => ({ id: id + 10, windowId: 1, groupId: id })) })
  try {
    const result = await f.invoke('tabs_context', 'seat')
    assert.equal(result.tabContext.tabGroupId, 3)
    assert.deepEqual(result.tabContext.availableTabs.map(t => t.id).sort((a, b) => a - b), [13, 16, 19])
    assert.deepEqual([...f.state.groups.keys()], [3])
    assert.equal(f.state.tabs.size, 3)
    assert.equal(f.state.storage[key('seat')], 3)
    assert.equal(f.state.groups.get(3).color, 'yellow')
    assert.equal(f.state.calls.some(c => c.method === 'tabs.move'), false)
  } finally { await f.cleanup() }
})

test('cross-window merge preserves every tab after moving destroys the source group', async () => {
  const f = await worker({ groups: [
    { id: 20, windowId: 2, title: 'seat' }, { id: 5, windowId: 8, title: 'seat' },
    { id: 30, windowId: 2, title: 'other' }
  ], tabs: [
    { id: 1, windowId: 8, groupId: 5 }, { id: 2, windowId: 2, groupId: 20 },
    { id: 3, windowId: 2, groupId: 20 }, { id: 4, windowId: 2, groupId: 30 }
  ] })
  try {
    const result = await f.invoke('tabs_context', 'seat')
    assert.equal(result.tabContext.tabGroupId, 5)
    assert.equal(result.tabContext.tabCount, 3)
    assert.equal(f.state.groups.has(20), false)
    assert.equal(f.state.tabs.size, 4)
    for (const id of [1, 2, 3]) {
      assert.equal(f.state.tabs.get(id).windowId, 8)
      assert.equal(f.state.tabs.get(id).groupId, 5)
    }
    assert.equal(f.state.tabs.get(4).groupId, 30)
    assert.equal(f.state.tabs.get(4).windowId, 2)
    assert.equal(f.state.storage[key('seat')], 5)
    const created = await f.invoke('tabs_create', 'seat', { url: 'https://example.test/new' })
    assert.equal(created.tabContext.tabGroupId, 5)
    assert.equal(created.tabContext.tabCount, 4)
    assert.equal(f.state.tabs.get(1000).windowId, 8, 'create in the recovered group window, not the focused window')
  } finally { await f.cleanup() }
})

test('zero exact matches clears a stale cache and returns empty context without creating tabs', async () => {
  const f = await worker({ storage: { [key('seat')]: 88 }, groups: [{ id: 2, windowId: 1, title: 'seat-extra' }],
    tabs: [{ id: 1, windowId: 1, groupId: 2 }] })
  try {
    assert.deepEqual((await f.invoke('tabs_context', 'seat')).tabContext, emptyContext)
    assert.equal(f.state.storage[key('seat')], undefined)
    assert.equal(f.state.tabs.size, 1)
    assert.equal(f.state.calls.some(c => c.method === 'tabs.create' || c.method === 'tabs.group'), false)
  } finally { await f.cleanup() }
})

test('concurrent creation for one slug makes one group and retains both tabs', async () => {
  const f = await worker()
  try {
    const results = await Promise.all([
      f.invoke('tabs_create', 'seat', { url: 'https://example.test/first' }),
      f.invoke('tabs_create', 'seat', { url: 'https://example.test/second' })
    ])
    assert.ok(results.every(r => !r.error), JSON.stringify(results))
    assert.equal(f.state.groups.size, 1)
    assert.equal(f.state.tabs.size, 2)
    assert.equal(new Set(results.map(r => r.tabContext.tabGroupId)).size, 1)
    assert.equal(f.state.calls.filter(c => c.method === 'tabs.group' && c.args.groupId === undefined).length, 1)
    const context = (await f.invoke('tabs_context', 'seat')).tabContext
    assert.equal(context.tabCount, 2)
    assert.equal(f.state.storage[key('seat')], context.tabGroupId)
    assert.equal(f.state.groups.get(context.tabGroupId).title, 'seat')
    assert.equal(f.state.groups.get(context.tabGroupId).color, 'yellow')
  } finally { await f.cleanup() }
})

test('the memory cache is revalidated when a group disappears in the same worker', async () => {
  const f = await worker({ groups: [{ id: 2, windowId: 1, title: 'seat' }], tabs: [{ id: 1, windowId: 1, groupId: 2 }] })
  try {
    assert.equal((await f.invoke('tabs_context', 'seat')).tabContext.tabGroupId, 2)
    f.state.groups.delete(2)
    f.state.groups.set(7, { id: 7, windowId: 1, title: 'seat', color: 'yellow' })
    f.state.tabs.get(1).groupId = 7
    assert.equal((await f.invoke('tabs_context', 'seat')).tabContext.tabGroupId, 7)
    assert.equal(f.state.storage[key('seat')], 7)
  } finally { await f.cleanup() }
})

test('a failed recovery releases the slug queue and does not create a replacement', async () => {
  let fail = true
  const f = await worker({ groups: [{ id: 2, windowId: 1, title: 'seat' }], tabs: [{ id: 1, windowId: 1, groupId: 2 }],
    before: method => { if (method === 'groups.query' && fail) { fail = false; throw new Error('group query unavailable') } } })
  try {
    assert.match((await f.invoke('tabs_create', 'seat')).error, /group query unavailable/)
    assert.equal(f.state.tabs.size, 1)
    assert.equal((await f.invoke('tabs_create', 'seat')).tabContext.tabGroupId, 2)
    assert.equal(f.state.tabs.size, 2)
    assert.equal(f.state.groups.size, 1)
  } finally { await f.cleanup() }
})

test('regroup failure after a cross-window move preserves tabs and does not claim success', async () => {
  const f = await worker({ groups: [
    { id: 2, windowId: 1, title: 'seat' }, { id: 3, windowId: 2, title: 'seat' }
  ], tabs: [{ id: 1, windowId: 1, groupId: 2 }, { id: 2, windowId: 2, groupId: 3 }],
  before: method => { if (method === 'tabs.group') throw new Error('grouping unavailable') } })
  try {
    assert.match((await f.invoke('tabs_context', 'seat')).error, /grouping unavailable/)
    assert.equal(f.state.groups.has(3), false, 'moving the last tab destroyed the source group')
    assert.equal(f.state.tabs.size, 2)
    assert.equal(f.state.tabs.get(2).windowId, 1)
    assert.equal(f.state.tabs.get(2).groupId, -1, 'the moved tab survives ungrouped')
    assert.equal(f.state.storage[key('seat')], undefined, 'failed consolidation must not persist success')
  } finally { await f.cleanup() }
})

test('persistence failure leaves recovered tabs intact and a later lookup retries persistence', async () => {
  let fail = true
  const f = await worker({ groups: [{ id: 2, windowId: 1, title: 'seat' }], tabs: [{ id: 1, windowId: 1, groupId: 2 }],
    before: method => { if (method === 'storage.set' && fail) { fail = false; throw new Error('storage unavailable') } } })
  try {
    assert.match((await f.invoke('tabs_context', 'seat')).error, /storage unavailable/)
    assert.equal(f.state.storage[key('seat')], undefined)
    assert.equal(f.state.tabs.size, 1)
    assert.equal((await f.invoke('tabs_context', 'seat')).tabContext.tabGroupId, 2)
    assert.equal(f.state.storage[key('seat')], 2)
    assert.equal(f.state.tabs.size, 1)
  } finally { await f.cleanup() }
})

test('a cached same-title group of another color is stale and never recolored or claimed', async () => {
  const f = await worker({ storage: { [key('seat')]: 2 }, groups: [
    { id: 2, windowId: 1, title: 'seat', color: 'blue' }, { id: 3, windowId: 1, title: 'seat' }
  ], tabs: [{ id: 1, windowId: 1, groupId: 2 }, { id: 2, windowId: 1, groupId: 3 }] })
  try {
    const original = structuredClone(f.state.groups.get(2))
    assert.equal((await f.invoke('tabs_context', 'seat')).tabContext.tabGroupId, 3)
    assert.equal(f.state.storage[key('seat')], 3)
    assert.deepEqual(f.state.groups.get(2), original)
    assert.equal(f.state.tabs.get(1).groupId, 2)
    assert.equal(f.state.calls.some(c => c.method === 'groups.update'), false)
    // Recoloring the worker's cached group also revokes ownership.
    f.state.groups.get(3).color = 'red'
    assert.deepEqual((await f.invoke('tabs_context', 'seat')).tabContext, emptyContext)
    assert.equal(f.state.storage[key('seat')], undefined)
    assert.equal(f.state.groups.get(3).color, 'red')
    assert.equal(f.state.tabs.get(2).groupId, 3)
  } finally { await f.cleanup() }
})

test('mixed-color duplicate candidates merge only yellow groups across windows', async () => {
  const f = await worker({ groups: [
    { id: 1, windowId: 1, title: 'seat', color: 'red' },
    { id: 2, windowId: 2, title: 'seat', color: 'blue' },
    { id: 5, windowId: 1, title: 'seat' }, { id: 8, windowId: 2, title: 'seat' }
  ], tabs: [
    { id: 1, windowId: 1, groupId: 1 }, { id: 2, windowId: 2, groupId: 2 },
    { id: 3, windowId: 1, groupId: 5 }, { id: 4, windowId: 2, groupId: 8 }
  ] })
  try {
    const untouched = [1, 2].map(id => ({ group: structuredClone(f.state.groups.get(id)), tab: structuredClone(f.state.tabs.get(id)) }))
    const context = (await f.invoke('tabs_context', 'seat')).tabContext
    assert.equal(context.tabGroupId, 5, 'canonical selection is limited to owned yellow groups')
    assert.deepEqual(context.availableTabs.map(t => t.id), [3, 4])
    assert.equal(f.state.groups.has(8), false)
    assert.equal(f.state.storage[key('seat')], 5)
    assert.equal(f.state.tabs.size, 4)
    for (const { group, tab } of untouched) {
      assert.deepEqual(f.state.groups.get(group.id), group)
      assert.deepEqual(f.state.tabs.get(tab.id), tab)
    }
    assert.deepEqual(f.state.calls.filter(c => c.method === 'tabs.move').map(c => c.args.ids), [[4]])
    assert.equal(f.state.calls.some(c => c.method === 'groups.update'), false)
  } finally { await f.cleanup() }
})

test('only same-title non-yellow groups yields empty context and creation makes a new yellow group', async () => {
  const f = await worker({ groups: [{ id: 2, windowId: 1, title: 'seat', color: 'blue' }],
    tabs: [{ id: 1, windowId: 1, groupId: 2 }] })
  try {
    const original = structuredClone(f.state.groups.get(2))
    assert.deepEqual((await f.invoke('tabs_context', 'seat')).tabContext, emptyContext)
    assert.equal(f.state.calls.some(c => c.method === 'groups.update' || c.method === 'tabs.group'), false)
    const created = await f.invoke('tabs_create', 'seat')
    assert.notEqual(created.tabContext.tabGroupId, 2)
    assert.equal(created.tabContext.tabCount, 1)
    const owned = f.state.groups.get(created.tabContext.tabGroupId)
    assert.equal(owned.title, 'seat'); assert.equal(owned.color, 'yellow')
    assert.deepEqual(f.state.groups.get(2), original)
    assert.equal(f.state.tabs.get(1).groupId, 2)
    assert.equal(f.state.groups.size, 2)
  } finally { await f.cleanup() }
})

test('ownership lost after discovery fails without recoloring or moving the changed group', async () => {
  let f
  f = await worker({ groups: [{ id: 2, windowId: 1, title: 'seat' }, { id: 3, windowId: 2, title: 'seat' }],
    tabs: [{ id: 1, windowId: 1, groupId: 2 }, { id: 2, windowId: 2, groupId: 3 }],
    before: (method, args) => { if (method === 'tabs.query' && args.groupId === 3) f.state.groups.get(3).color = 'blue' } })
  try {
    assert.match((await f.invoke('tabs_context', 'seat')).error, /ownership/)
    assert.equal(f.state.groups.get(3).color, 'blue')
    assert.equal(f.state.tabs.get(2).windowId, 2)
    assert.equal(f.state.tabs.get(2).groupId, 3)
    assert.equal(f.state.calls.some(c => c.method === 'groups.update' || c.method === 'tabs.move' || c.method === 'tabs.group'), false)
    assert.equal(f.state.storage[key('seat')], undefined)
  } finally { await f.cleanup() }
})
