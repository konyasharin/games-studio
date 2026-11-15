// Studio Board front end: projects -> sections -> boards with linked cards.
import { initAssist } from '/assist.js'
const $ = (s, el = document) => el.querySelector(s)
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue
    if (k === 'class') el.className = v
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v)
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v)
    else if (k === 'html') el.innerHTML = v
    else el.setAttribute(k, v === true ? '' : v)
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)))
  return el
}
const fileUrl = rel => '/files/' + rel.split('/').map(encodeURIComponent).join('/')
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

// ---------- api with retries; never throws into the UI without a toast ----------
let online = true
async function api(method, url, body, { raw = false, quiet = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, { method, headers: raw ? {} : { 'Content-Type': 'application/json' }, body: raw ? body : body === undefined ? undefined : JSON.stringify(body) })
      setOnline(true)
      const data = await r.json().catch(() => ({}))
      if (!r.ok) throw Object.assign(new Error(data.error || r.statusText), { status: r.status })
      return data
    } catch (e) {
      if (e.status) { if (!quiet) toast(e.message, true); throw e }
      setOnline(false)
      if (attempt >= 2 || method !== 'GET') { if (!quiet) toast('Сервер не отвечает, повторю позже', true); throw e }
      await new Promise(r => setTimeout(r, 600 * (attempt + 1)))
    }
  }
}
function setOnline(v) { if (v === online) return; online = v; $('#conn').classList.toggle('down', !v); $('#conn').title = v ? 'Сервер на связи' : 'Нет связи с сервером' }
function toast(text, err = false) {
  const t = h('div', { class: 'toast' + (err ? ' err' : '') }, text)
  $('#toasts').append(t); setTimeout(() => t.remove(), err ? 5200 : 2600)
}
window.addEventListener('error', e => { console.error(e.error || e.message); toast('Ошибка интерфейса: ' + (e.message || 'см. консоль'), true) })
window.addEventListener('unhandledrejection', e => { console.error(e.reason); e.preventDefault() })

const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms) } }

// ---------- modal ----------
function closeModal({ silent = false } = {}) { const m = $('#modal'); const cb = modalCleanup; modalCleanup = null; m.hidden = true; m.innerHTML = ''; if (!silent) cb?.() }
let modalCleanup = null
function openModal(content, cleanup) {
  const m = $('#modal'); m.innerHTML = ''; m.append(content); m.hidden = false; modalCleanup = cleanup
  m.onclick = e => { if (e.target === m) closeModal() }
}
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal() })
function prompt2(title, fields) {
  return new Promise(resolve => {
    const inputs = {}
    const form = h('form', { class: 'modal-box', onsubmit: e => { e.preventDefault(); const v = {}; for (const k in inputs) v[k] = inputs[k].value.trim(); closeModal({ silent: true }); resolve(v) } },
      h('h2', {}, title),
      ...fields.map(f => h('label', {}, f.label, inputs[f.key] = f.options ? h('select', {}, ...f.options.map(o => h('option', { value: o[0] }, o[1]))) : h('input', { value: f.value || '', placeholder: f.placeholder || '' }))),
      h('div', { class: 'row' }, h('span', { class: 'grow' }), h('button', { type: 'button', class: 'btn ghost', onclick: () => { closeModal({ silent: true }); resolve(null) } }, 'Отмена'), h('button', { class: 'btn primary' }, 'Готово')))
    openModal(form, () => resolve(null))
    setTimeout(() => form.querySelector('input,select')?.focus(), 30)
  })
}
function confirm2(text, yes = 'Удалить') {
  return new Promise(resolve => {
    openModal(h('div', { class: 'modal-box' }, h('h2', {}, text),
      h('div', { class: 'row' }, h('span', { class: 'grow' }), h('button', { class: 'btn ghost', onclick: () => { closeModal({ silent: true }); resolve(false) } }, 'Отмена'),
        h('button', { class: 'btn primary', onclick: () => { closeModal({ silent: true }); resolve(true) } }, yes))), () => resolve(false))
  })
}

// ---------- router ----------
let current = null // { stop() }
let ctxNow = {} // where the user is: read by the Claude assist (pointing, pins, chat)
let navSeq = 0
const stale = tok => tok !== navSeq
function crumbs(items) {
  const c = $('#crumbs'); c.innerHTML = ''
  items.forEach((it, i) => { if (i) c.append(h('span', { class: 'sep' }, '/')); c.append(it.href ? h('a', { href: it.href }, it.text) : h('span', { class: 'cur' }, it.text)) })
}
async function route() {
  current?.stop?.(); current = null
  if (!$('#modal').hidden) closeModal()
  const tok = ++navSeq
  const old = $('#view'); const view = old.cloneNode(false); old.replaceWith(view)
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  try {
    const page = parts[0] === 'p' && parts[2] === 'b' ? await boardPage(view, parts[1], parts[3], tok)
      : parts[0] === 'p' ? await projectPage(view, parts[1], parts[2] || '3d', tok) : await homePage(view, tok)
    if (stale(tok)) { page?.stop?.(); return }
    current = page
    assist.pageChanged()
  } catch (e) {
    if (stale(tok)) return console.error(e); view.append(h('div', { class: 'page' }, h('div', { class: 'empty-note' }, 'Не удалось открыть: ' + e.message, h('br'), h('a', { href: '#/' , class: 'btn', style: { marginTop: '14px' } }, 'На главную')))) }
}
window.addEventListener('hashchange', route)

// ---------- home ----------
async function homePage(view, tok) {
  const list = await api('GET', '/api/projects')
  if (stale(tok)) return
  crumbs([{ text: 'Проекты' }])
  ctxNow = { kind: 'home' }
  const page = h('div', { class: 'page' }, h('h1', {}, 'Проекты'), h('p', { class: 'sub' }, 'Игры и всё, что к ним относится: сюжет, 3D, звук. Данные лежат в папке проекта и переживают перезапуск.'))
  const grid = h('div', { class: 'grid' })
  for (const p of list) {
    grid.append(h('a', { class: 'tile', href: `#/p/${p.id}/3d` }, h('h2', {}, p.name || p.dir), h('div', { class: 'meta' }, `${(p.boards || []).length} досок · Projects/${p.dir}`)))
  }
  grid.append(h('div', { class: 'tile new', onclick: async () => {
    const v = await prompt2('Новый проект', [{ key: 'name', label: 'Название игры' }, { key: 'dir', label: 'Папка в Projects (можно существующую)', placeholder: 'space-anime-game' }])
    if (!v?.name) return
    const p = await api('POST', '/api/projects', v); location.hash = `#/p/${p.id}/3d`
  } }, '+ Новый проект'))
  page.append(grid); view.append(page)
  return {}
}

// ---------- project ----------
async function projectPage(view, pid, sid, tok) {
  const p = await api('GET', `/api/projects/${pid}`)
  if (stale(tok)) return
  const sec = p.sections.find(s => s.id === sid) || p.sections[0]
  crumbs([{ text: 'Проекты', href: '#/' }, { text: p.name || p.dir }])
  const side = h('aside', { class: 'side' }, h('h3', {}, 'Разделы'),
    ...p.sections.map(s => h('a', { href: `#/p/${pid}/${s.id}`, class: s.id === sec.id ? 'cur' : '' }, s.title)),
    h('a', { href: 'javascript:void 0', onclick: async () => {
      const v = await prompt2('Новый раздел', [{ key: 'title', label: 'Название' }, { key: 'kind', label: 'Тип', options: [['notes', 'Страница (текст)'], ['boards', 'Доски (как 3D)']] }])
      if (!v?.title) return
      const sections = [...p.sections, { id: 's' + Date.now().toString(36), title: v.title, kind: v.kind }]
      await api('PATCH', `/api/projects/${pid}`, { sections }); route()
    } }, '+ раздел'))
  const main = h('div', { class: 'proj-main' })
  view.append(h('div', { class: 'proj' }, side, main))
  ctxNow = sec.kind === 'boards' ? { pid: p.id, kind: 'page' } : { pid: p.id, kind: 'notes', section: sec.id, sectionTitle: sec.title }
  if (sec.kind === 'boards') return boardsList(main, p, sec)
  return notesPage(main, p, sec, tok)
}

async function boardsList(main, p, sec) {
  const page = h('div', { class: 'page' }, h('h1', {}, sec.title), h('p', { class: 'sub' }, 'Каждый персонаж или модель — своя доска: референс, разбивка на части, модели, итог.'))
  const grid = h('div', { class: 'grid' })
  const boards = (p.boards || []).filter(b => (b.section || '3d') === sec.id)
  for (const b of boards) {
    const tile = h('a', { class: 'tile', href: `#/p/${p.id}/b/${b.id}` }, h('div', { class: 'thumb' }), h('h2', {}, b.name), h('div', { class: 'meta' }, b.kind === 'character' ? 'Персонаж' : 'Модель'))
    grid.append(tile)
    api('GET', `/api/projects/${p.id}/boards/${b.id}`, undefined, { quiet: true }).then(full => {
      const img = full.cards.find(c => c.type === 'final' && c.thumb)?.thumb || full.cards.find(c => c.chosen)?.chosen
      if (img) tile.firstChild.style.backgroundImage = `url("${fileUrl(img)}")`
      tile.querySelector('.meta').textContent = `${b.kind === 'character' ? 'Персонаж' : 'Модель'} · ${full.cards.length} карточек`
    }).catch(() => {})
  }
  grid.append(h('div', { class: 'tile new', onclick: async () => {
    const v = await prompt2('Новая доска', [{ key: 'name', label: 'Название', placeholder: 'Мира' }, { key: 'kind', label: 'Шаблон', options: [['character', 'Персонаж (референс → части → модели → итог)'], ['model', 'Пустая доска']] }])
    if (!v?.name) return
    const b = await api('POST', `/api/projects/${p.id}/boards`, { ...v, section: sec.id })
    location.hash = `#/p/${p.id}/b/${b.id}`
  } }, '+ Новая доска'))
  page.append(grid); main.append(page)
  return {}
}

async function notesPage(main, p, sec, tok) {
  const { html, mtime: mtime0 } = await api('GET', `/api/projects/${p.id}/notes/${sec.id}`)
  if (stale(tok)) return
  let mtime = mtime0
  const saved = h('span', { class: 'saved' }, 'Сохранено')
  const ed = h('div', { class: 'editor', contenteditable: 'true', html: html || `<h1>${esc(sec.title)}</h1><p>Пиши здесь. Сохраняется само.</p>` })
  const save = debounce(async () => { try { const r = await api('PUT', `/api/projects/${p.id}/notes/${sec.id}`, { html: ed.innerHTML }, { quiet: true }); mtime = r.mtime; saved.textContent = 'Сохранено' } catch { saved.textContent = 'Не сохранено, повторю' ; save() } }, 700)
  ed.addEventListener('input', () => { saved.textContent = 'Сохраняю…'; save() })
  const cmd = (c, v) => () => { document.execCommand(c, false, v); ed.focus(); save() }
  const bar = h('div', { class: 'editor-bar' },
    h('button', { class: 'btn sm', onclick: cmd('formatBlock', 'H1') }, 'Заголовок'), h('button', { class: 'btn sm', onclick: cmd('formatBlock', 'H2') }, 'Подзаголовок'),
    h('button', { class: 'btn sm', onclick: cmd('formatBlock', 'P') }, 'Текст'), h('button', { class: 'btn sm', onclick: cmd('bold') }, 'Ж'), h('button', { class: 'btn sm', onclick: cmd('italic') }, 'К'),
    h('button', { class: 'btn sm', onclick: cmd('insertUnorderedList') }, '• Список'), saved)
  const banner = h('div', { class: 'callout warn changed', hidden: true }, h('b', {}, 'Claude изменил эту страницу'), 'Ты сейчас редактируешь её. ',
    h('button', { class: 'btn sm', onclick: () => load(true) }, 'Показать его версию'), ' (твои несохранённые правки пропадут)')
  async function load(force) {
    try {
      const r = await api('GET', `/api/projects/${p.id}/notes/${sec.id}?since=${mtime}`, undefined, { quiet: true })
      if (r.same) return
      const dirty = saved.textContent !== 'Сохранено' || document.activeElement === ed
      if (dirty && !force) { banner.hidden = false; return }
      ed.innerHTML = r.html; mtime = r.mtime; banner.hidden = true; saved.textContent = 'Сохранено'
      if (!force) toast('Страница обновлена'); assist.pageChanged()
    } catch {}
  }
  const poll = setInterval(() => !document.hidden && load(false), 4000)
  main.append(h('div', { class: 'page' }, bar, banner, ed))
  window.addEventListener('beforeunload', save)
  return { stop: () => { clearInterval(poll); window.removeEventListener('beforeunload', save); if (saved.textContent !== 'Сохранено') api('PUT', `/api/projects/${p.id}/notes/${sec.id}`, { html: ed.innerHTML }, { quiet: true }).catch(() => {}) } }
}

// ---------- board ----------
const TYPES = {
  ref: 'Референс', part: 'Часть', split: 'Разбивка', model: 'Модель', final: 'Итог', note: 'Заметка',
}

async function boardPage(view, pid, bid, tok) {
  const p = await api('GET', `/api/projects/${pid}`)
  let B = await api('GET', `/api/projects/${pid}/boards/${bid}`)
  if (stale(tok)) return
  const sec = p.sections.find(s => s.id === (p.boards.find(b => b.id === bid)?.section || '3d'))
  crumbs([{ text: 'Проекты', href: '#/' }, { text: p.name || p.dir, href: `#/p/${pid}/${sec?.id || '3d'}` }, { text: B.name }])
  const base = `/api/projects/${pid}/boards/${bid}`
  ctxNow = { pid, kind: 'board', board: bid, boardName: B.name, cards: () => B.cards, world: () => world, toWorld: e => toWorld(e) }
  const el = h('div', { class: 'board' }); view.append(el)
  // a file dropped between cards must not make the browser leave the app
  el.addEventListener('dragover', e => e.preventDefault())
  el.addEventListener('drop', e => { e.preventDefault(); if (!e.target.closest('.card')) toast('Перетащи файл на карточку') })
  const world = h('div', { class: 'world' }); el.append(world)
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.classList.add('links'); world.append(svg)
  let cam = B.view || { x: 40, y: 60, z: 0.85 }
  const zoomInd = h('span', { class: 'zoom-ind' })
  const applyCam = () => { world.style.transform = `translate(${cam.x}px,${cam.y}px) scale(${cam.z})`; zoomInd.textContent = Math.round(cam.z * 100) + '%' }
  const saveCam = debounce(() => api('PATCH', base, { view: cam }, { quiet: true }).catch(() => {}), 800)
  applyCam()

  const addCard = async (type, extra = {}) => {
    const r = el.getBoundingClientRect()
    const x = (r.width / 2 - cam.x) / cam.z - 180, y = (r.height / 2 - cam.y) / cam.z - 120
    const defaults = { ref: { prompt: '', count: 4, views: 4, variants: [] }, part: { prompt: '', count: 4, views: 4, variants: [] }, split: { parts: [] }, model: { mesh: [], textured: [] }, final: { files: [] }, note: { prompt: '' } }
    await api('POST', base + '/cards', { type, title: TYPES[type], x, y, w: 380, ...defaults[type], ...extra }); refresh()
  }
  const tools = h('div', { class: 'board-tools' },
    ...['ref', 'split', 'part', 'model', 'final', 'note'].map(t => h('button', { class: 'btn sm', onclick: () => addCard(t) }, '+ ' + TYPES[t])))
  let ctxOpen = false
  const right = h('div', { class: 'board-right' }, zoomInd,
    h('button', { class: 'btn sm', title: 'Разложить карточки по этапам слева направо', onclick: () => layout() }, 'Выровнять'),
    h('button', { class: 'btn sm', title: 'Показать всё', onclick: () => fit() }, 'Всё'),
    h('button', { class: 'btn sm', onclick: () => { ctxOpen = !ctxOpen; renderCtx() } }, 'Контекст для Claude'))
  el.append(tools, right)
  const ctxBox = h('div', { class: 'ctx', hidden: true })
  el.append(ctxBox)
  function renderCtx() {
    ctxBox.hidden = !ctxOpen; if (!ctxOpen) return
    ctxBox.innerHTML = ''
    const ta = h('textarea', { class: 'prompt' }); ta.value = B.context || ''
    const save = debounce(() => api('PATCH', base, { context: ta.value }, { quiet: true }).then(() => { B.context = ta.value }).catch(() => {}), 600)
    ta.addEventListener('input', save)
    ctxBox.append(h('h2', {}, 'Контекст доски'), h('p', { class: 'more' }, 'Что фоновый Claude должен знать по этой доске: стиль, что уже готово, чего не трогать.'), ta)
  }

  // pan / zoom
  let pan = null
  el.addEventListener('pointerdown', e => {
    if (e.target !== el && e.target !== world && e.target !== svg) return
    pan = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y }; el.classList.add('panning'); el.setPointerCapture(e.pointerId)
  })
  el.addEventListener('pointermove', e => { if (!pan) return; cam.x = pan.cx + e.clientX - pan.x; cam.y = pan.cy + e.clientY - pan.y; applyCam() })
  const endPan = () => { if (pan) { pan = null; el.classList.remove('panning'); saveCam() } }
  el.addEventListener('pointerup', endPan); el.addEventListener('pointercancel', endPan)
  el.addEventListener('wheel', e => {
    if (e.target.closest('textarea, .card-b') && !e.ctrlKey) return
    e.preventDefault()
    const r = el.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top
    const nz = Math.min(2, Math.max(0.1, cam.z * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015))))
    cam.x = mx - (mx - cam.x) * nz / cam.z; cam.y = my - (my - cam.y) * nz / cam.z; cam.z = nz
    applyCam(); saveCam()
  }, { passive: false })
  function fit() {
    if (!B.cards.length) return
    const xs = B.cards.map(c => c.x), ys = B.cards.map(c => c.y), xe = B.cards.map(c => c.x + (c.w || 380)), ye = B.cards.map(c => c.y + (nodes.get(c.id)?.offsetHeight || 400))
    const r = el.getBoundingClientRect(), x0 = Math.min(...xs) - 60, y0 = Math.min(...ys) - 80, x1 = Math.max(...xe) + 60, y1 = Math.max(...ye) + 60
    cam.z = Math.min(1.2, Math.max(0.1, Math.min(r.width / (x1 - x0), r.height / (y1 - y0))))
    cam.x = (r.width - (x1 - x0) * cam.z) / 2 - x0 * cam.z; cam.y = (r.height - (y1 - y0) * cam.z) / 2 - y0 * cam.z + 20
    applyCam(); saveCam()
  }

  // auto layout: columns by stage (longest path from the roots), order inside a column by the parents'
  // positions (barycenter sweeps, fewer crossings), each card centred on its parents without overlaps
  async function layout({ quiet = false } = {}) {
    const cards = B.cards, ids = new Set(cards.map(c => c.id))
    const links = B.links.filter(l => ids.has(l.from) && ids.has(l.to) && l.from !== l.to)
    const parents = new Map(cards.map(c => [c.id, []])), kids = new Map(cards.map(c => [c.id, []]))
    for (const l of links) { parents.get(l.to).push(l.from); kids.get(l.from).push(l.to) }
    const linked = cards.filter(c => parents.get(c.id).length || kids.get(c.id).length)
    const loose = cards.filter(c => !parents.get(c.id).length && !kids.get(c.id).length)
    // columns are pipeline stages by card type; a card linked from the same or a later stage moves one column right
    const STAGE = { ref: 0, split: 1, part: 2, model: 3, final: 4 }
    const layer = new Map()
    const stageOf = (cid, seen = new Set()) => {
      if (layer.has(cid)) return layer.get(cid)
      if (seen.has(cid)) return 0
      seen.add(cid)
      const c = byIdAll.get(cid)
      const fromParents = Math.max(-1, ...parents.get(cid).map(pid => stageOf(pid, seen))) + 1
      const d = c.type in STAGE ? Math.max(STAGE[c.type], c.type === 'final' ? 0 : fromParents) : fromParents
      layer.set(cid, d); return d
    }
    const byIdAll = new Map(cards.map(c => [c.id, c]))
    linked.forEach(c => stageOf(c.id))
    const maxL = Math.max(0, ...layer.values())
    for (const c of linked) if (c.type === 'final') layer.set(c.id, maxL)
    const cols = []
    for (const c of linked) (cols[layer.get(c.id)] ||= []).push(c)
    cols.forEach(col => col.sort((a, b) => a.y - b.y))
    const idx = () => { const m = new Map(); cols.forEach(col => col?.forEach((c, i) => m.set(c.id, i))); return m }
    for (let sweep = 0; sweep < 6; sweep++) {
      const down = sweep % 2 === 0, pos = idx()
      const order = down ? cols.map((_, i) => i) : cols.map((_, i) => i).reverse()
      for (const li of order) {
        const col = cols[li]; if (!col) continue
        const bary = c => { const ns = (down ? parents : kids).get(c.id).filter(x => pos.has(x)); return ns.length ? ns.reduce((a, x) => a + pos.get(x), 0) / ns.length : pos.get(c.id) }
        const keyed = col.map(c => [bary(c), pos.get(c.id), c])
        keyed.sort((a, b) => a[0] - b[0] || a[1] - b[1])
        cols[li] = keyed.map(k => k[2])
        cols[li].forEach((c, i) => pos.set(c.id, i))
      }
    }
    const H = c => nodes.get(c.id)?.offsetHeight || 400, W = c => c.w || 380
    const GX = 150, GY = 56, out = {}
    let x = 80
    const center = {}
    cols.forEach((col, li) => {
      if (!col) return
      const colW = Math.max(...col.map(W))
      // desired tops from the parents' centres, then pushed down so nothing overlaps
      const placed = col.map(c => {
        const ps = parents.get(c.id).filter(pid => center[pid] != null)
        const want = ps.length ? ps.reduce((a, pid) => a + center[pid], 0) / ps.length - H(c) / 2 : null
        return { c, want }
      })
      let y = 80
      for (const it of placed) {
        let top = it.want == null ? y : Math.max(it.want, y)
        it.top = top; y = top + H(it.c) + GY
      }
      for (const it of placed) {
        out[it.c.id] = [x + (colW - W(it.c)) / 2, it.top]
        center[it.c.id] = it.top + H(it.c) / 2
      }
      x += colW + GX
    })
    // roots and other parent-free cards: centre on their children where possible
    for (const col of cols.slice(0, 1)) {
      if (!col) continue
      let y = -Infinity
      for (const c of col) {
        const ks = kids.get(c.id).filter(k => center[k] != null)
        const want = ks.length ? ks.reduce((a, k) => a + center[k], 0) / ks.length - H(c) / 2 : out[c.id][1]
        const top = Math.max(want, y === -Infinity ? -1e9 : y)
        out[c.id][1] = top; y = top + H(c) + GY
      }
    }
    // loose cards (notes) in a column after the last one
    let ly = 80
    for (const c of loose) { out[c.id] = [x, ly]; ly += H(c) + GY }
    // keep the whole thing near the origin
    const minY = Math.min(...Object.values(out).map(v => v[1]))
    for (const v of Object.values(out)) v[1] += 80 - minY
    try {
      await api('POST', `${base}/layout`, { positions: out })
      for (const c of cards) if (out[c.id]) { c.x = out[c.id][0]; c.y = out[c.id][1] }
      for (const c of cards) { const n = nodes.get(c.id); if (n) { n.style.left = c.x + 'px'; n.style.top = c.y + 'px' } }
      drawLinks(); fit()
      if (!quiet) toast('Карточки разложены по этапам')
    } catch {}
  }

  // a card that grew (new pictures, a status line) must not cover the one below: push the lower ones down
  const unoverlap = debounce(async () => {
    if (dragging) return
    const GAP = 40, moved = {}
    const box = c => ({ c, x0: c.x, x1: c.x + (nodes.get(c.id)?.offsetWidth || c.w || 380), h: nodes.get(c.id)?.offsetHeight || 0 })
    const all = B.cards.map(box).filter(b => b.h).sort((a, b) => a.c.y - b.c.y)
    for (let i = 0; i < all.length; i++) {
      for (let k = 0; k < i; k++) {
        const a = all[k], b = all[i]
        if (a.x1 <= b.x0 || b.x1 <= a.x0) continue
        const need = a.c.y + a.h + GAP
        if (b.c.y < need && b.c.y + b.h > a.c.y) { b.c.y = need; moved[b.c.id] = [b.c.x, need] }
      }
    }
    if (!Object.keys(moved).length) return
    for (const id of Object.keys(moved)) { const n = nodes.get(id); if (n) n.style.top = moved[id][1] + 'px' }
    drawLinks(); assist.boardRendered()
    try { await api('POST', `${base}/layout`, { positions: moved }, { quiet: true }) } catch {}
  }, 250)

  // cards are kept as DOM nodes keyed by id; a card being edited or dragged is not rebuilt under the user
  const nodes = new Map()
  let dragging = null, linking = null, editing = new Set()
  const jobOf = cid => B.jobs.filter(j => j.card === cid).sort((a, b) => a.created.localeCompare(b.created)).at(-1)
  const filters = new Map() // per card: which side's variants the strip shows
  const sig = c => JSON.stringify([c, jobOf(c.id), filters.get(c.id)])

  function render() {
    const seen = new Set()
    for (const c of B.cards) {
      seen.add(c.id)
      let n = nodes.get(c.id)
      const s = sig(c)
      if (n && (n._sig === s || editing.has(c.id) || dragging?.id === c.id)) { if (!(dragging?.id === c.id)) { n.style.left = c.x + 'px'; n.style.top = c.y + 'px' } continue }
      const fresh = cardNode(c)
      fresh._sig = s
      if (n) n.replaceWith(fresh); else world.append(fresh)
      nodes.set(c.id, fresh)
    }
    for (const [cid, n] of nodes) if (!seen.has(cid)) { n.remove(); nodes.delete(cid) }
    requestAnimationFrame(() => { drawLinks(); assist.boardRendered(); unoverlap() })
  }
  function anchor(cid, side) {
    const c = B.cards.find(x => x.id === cid), n = nodes.get(cid); if (!c || !n) return null
    const x = dragging?.id === cid ? dragging.nx : c.x, y = dragging?.id === cid ? dragging.ny : c.y
    return side === 'out' ? [x + n.offsetWidth, y + n.offsetHeight / 2] : [x, y + Math.min(60, n.offsetHeight / 2)]
  }
  const curve = (a, b) => { const dx = Math.max(60, Math.abs(b[0] - a[0]) * 0.45); return `M${a[0]},${a[1]} C${a[0] + dx},${a[1]} ${b[0] - dx},${b[1]} ${b[0]},${b[1]}` }
  function drawLinks() {
    svg.innerHTML = ''
    for (const l of B.links) {
      const a = anchor(l.from, 'out'), b = anchor(l.to, 'in'); if (!a || !b) continue
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('d', curve(a, b))
      path.addEventListener('click', async e => { e.stopPropagation(); if (await confirm2('Убрать связь?', 'Убрать')) { await api('DELETE', `${base}/links/${l.id}`); refresh() } })
      svg.append(path)
    }
    if (linking) {
      const a = anchor(linking.from, 'out'); if (!a) return
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.classList.add('draft'); path.setAttribute('d', curve(a, [linking.x, linking.y])); svg.append(path)
    }
  }
  const toWorld = e => { const r = el.getBoundingClientRect(); return [(e.clientX - r.left - cam.x) / cam.z, (e.clientY - r.top - cam.y) / cam.z] }

  const patch = (c, body) => api('PATCH', `${base}/cards/${c.id}`, body).then(() => refresh()).catch(() => {})
  const inflight = new Set()
  const generate = async (c, body = {}) => {
    if (inflight.has(c.id)) return
    inflight.add(c.id)
    try { await api('POST', `${base}/cards/${c.id}/generate`, body); toast('Задача поставлена в очередь') } catch {} finally { inflight.delete(c.id); refresh() }
  }
  async function upload(c, file, slot) {
    toast(`Загружаю ${file.name}…`)
    try { await api('POST', `${base}/cards/${c.id}/files?slot=${slot}&name=${encodeURIComponent(file.name)}`, file, { raw: true }); refresh() } catch {}
  }

  function cardNode(c) {
    const n = h('div', { class: 'card', 'data-id': c.id, style: { left: c.x + 'px', top: c.y + 'px', width: (c.w || 380) + 'px' } })
    const title = h('div', { class: 'card-title', contenteditable: 'true', spellcheck: 'false' }, c.title || TYPES[c.type])
    title.addEventListener('focus', () => editing.add(c.id))
    title.addEventListener('blur', () => { editing.delete(c.id); const t = title.textContent.trim(); if (t && t !== c.title) patch(c, { title: t }) })
    title.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); title.blur() } })
    const head = h('div', { class: 'card-h' }, h('span', { class: 'card-type' }, TYPES[c.type] || c.type), title,
      c.frozen ? h('span', { class: 'frozen-badge' }, 'заморожено') : null,
      h('button', { class: 'icon-btn', title: 'Удалить карточку', onclick: async () => { if (await confirm2(`Удалить карточку «${c.title}»? Файлы останутся на диске.`)) { await api('DELETE', `${base}/cards/${c.id}`); refresh() } } }, '✕'))
    head.addEventListener('pointerdown', e => {
      if (e.target.closest('.card-title:focus, button')) return
      if (e.target.classList.contains('card-title') && document.activeElement === e.target) return
      e.preventDefault(); head.setPointerCapture(e.pointerId)
      const [wx, wy] = toWorld(e); dragging = { id: c.id, dx: wx - c.x, dy: wy - c.y, nx: c.x, ny: c.y, moved: false }
    })
    head.addEventListener('pointermove', e => {
      if (dragging?.id !== c.id) return
      const [wx, wy] = toWorld(e); dragging.nx = Math.round(wx - dragging.dx); dragging.ny = Math.round(wy - dragging.dy); dragging.moved = true
      n.style.left = dragging.nx + 'px'; n.style.top = dragging.ny + 'px'; drawLinks()
    })
    const endDrag = () => {
      if (dragging?.id !== c.id) return
      const d = dragging; dragging = null
      if (d.moved) { c.x = d.nx; c.y = d.ny; api('PATCH', `${base}/cards/${c.id}`, { x: d.nx, y: d.ny }, { quiet: true }).catch(() => toast('Позиция не сохранилась', true)) }
      else if (!title.contains(document.activeElement)) title.focus()
    }
    head.addEventListener('pointerup', endDrag); head.addEventListener('pointercancel', endDrag); head.addEventListener('lostpointercapture', endDrag)

    const port = h('div', { class: 'port', title: 'Протяни к другой карточке, чтобы связать' })
    port.addEventListener('pointerdown', e => { e.stopPropagation(); e.preventDefault(); port.setPointerCapture(e.pointerId); const [x, y] = toWorld(e); linking = { from: c.id, x, y }; drawLinks() })
    port.addEventListener('pointermove', e => { if (!linking) return; const [x, y] = toWorld(e); linking.x = x; linking.y = y; drawLinks() })
    port.addEventListener('lostpointercapture', () => setTimeout(() => { if (linking?.from === c.id) { linking = null; drawLinks() } }, 0))
    port.addEventListener('pointerup', async e => {
      if (!linking) return
      const target = document.elementsFromPoint(e.clientX, e.clientY).map(x => x.closest?.('.card')).find(x => x && x.dataset.id !== c.id)
      linking = null; drawLinks()
      if (target) { await api('POST', `${base}/links`, { from: c.id, to: target.dataset.id }).catch(() => {}); refresh() }
    })

    const body = h('div', { class: 'card-b' })
    try { (BODY[c.type] || BODY.note)(c, body) } catch (e) { console.error(e); body.append(h('div', { class: 'status error' }, 'Карточка не отрисовалась: ' + e.message)) }
    n.append(head, body, port)
    // drop files anywhere on the card
    n.addEventListener('dragover', e => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); n.classList.add('drop') } })
    n.addEventListener('dragleave', e => { if (!n.contains(e.relatedTarget)) n.classList.remove('drop') })
    n.addEventListener('drop', e => {
      e.preventDefault(); n.classList.remove('drop')
      const slotEl = e.target.closest('[data-slot]')
      const slot = slotEl?.dataset.slot || (['ref', 'part'].includes(c.type) ? 'variants' : c.type === 'model' ? 'mesh' : 'files')
      for (const f of e.dataTransfer.files) upload(c, f, slot)
    })
    const typing = x => !!x?.matches?.('textarea, input, [contenteditable="true"]')
    n.addEventListener('focusin', e => { if (typing(e.target)) editing.add(c.id) })
    n.addEventListener('focusout', () => setTimeout(() => { if (!(typing(document.activeElement) && n.contains(document.activeElement)) && editing.delete(c.id)) render() }, 30))
    return n
  }

  function statusLine(c) {
    const j = jobOf(c.id); if (!j || (j.status === 'done' && Date.now() - Date.parse(j.updated || j.created) > 15000)) return null
    const label = { queued: 'В очереди', running: 'Claude работает', done: 'Готово', error: 'Ошибка', cancelled: 'Отменено' }[j.status] || j.status
    const last = (j.log || []).at(-1)?.replace(/^\S+\s/, '') || ''
    return h('div', { class: 'status ' + j.status }, ['queued', 'running'].includes(j.status) ? h('span', { class: 'spinner' }) : null,
      h('span', { class: 'grow' }, `${label}${j.progress ? ' · ' + j.progress : ''}${last ? ' — ' + last : ''}`),
      ['queued', 'running'].includes(j.status) ? h('button', { class: 'btn sm ghost', onclick: () => api('POST', `/api/jobs/${j.id}/cancel`).then(refresh) }, 'Отменить') : null,
      j.status === 'error' ? h('button', { class: 'btn sm ghost', onclick: () => api('POST', `/api/jobs/${j.id}/retry`).then(refresh) }, 'Повторить') : null)
  }
  const busy = c => inflight.has(c.id) || ['queued', 'running'].includes(jobOf(c.id)?.status)

  // sides of an object: each generated picture is one strict view; the front is the main one
  const SIDES = [['front', 'Спереди', 'Ф'], ['back', 'Сзади', 'З'], ['left', 'Слева', 'Л'], ['right', 'Справа', 'П']]
  const SIDE = Object.fromEntries(SIDES.map(([k, n, s]) => [k, { name: n, short: s }]))
  SIDE.sheet = { name: 'Лист с 4 сторонами', short: '4' }
  const viewOf = v => v.view && SIDE[v.view] ? v.view : 'front'
  const picksOf = c => ({ ...(c.picks || {}), front: c.picks?.front || c.chosen || null })
  const pick = (c, v) => { const side = viewOf(v); const picks = { ...picksOf(c), [side]: v.file }; patch(c, side === 'front' || side === 'sheet' ? { picks, chosen: v.file } : { picks }) }
  const sideIcon = side => h('span', { class: 'side-ic side-' + side, title: SIDE[side].name }, SIDE[side].short)

  // fullscreen view; `list` = the pictures to page through (the card's chosen sides, or its variants)
  function lightbox(c, v, list) {
    const vars = (c.variants || []).filter(x => !x.hidden)
    const seq = (list && list.length ? list : [v]).map(x => vars.find(y => y.file === x.file) || x)
    let i = Math.max(0, seq.findIndex(x => x.file === v.file))
    const box = h('div', { class: 'lightbox' })
    const show = () => {
      const cur = seq[i], side = viewOf(cur), picked = picksOf(c)[side] === cur.file
      box.innerHTML = ''
      const nav = seq.length > 1 ? h('div', { class: 'lb-sides' }, ...seq.map((x, k) => h('button', { class: k === i ? 'on' : '', onclick: () => { i = k; show() } }, sideIcon(viewOf(x)), ' ', SIDE[viewOf(x)].name))) : null
      box.append(nav || '', h('div', { class: 'lb-img' },
        seq.length > 1 ? h('button', { class: 'lb-arrow l', title: '←', onclick: () => { i = (i - 1 + seq.length) % seq.length; show() } }, '‹') : '',
        h('img', { src: fileUrl(cur.file) }),
        seq.length > 1 ? h('button', { class: 'lb-arrow r', title: '→', onclick: () => { i = (i + 1) % seq.length; show() } }, '›') : ''),
        h('div', { class: 'row lb-bar' }, sideIcon(side), h('span', { class: 'more' }, SIDE[side].name),
          h('button', { class: 'btn primary', disabled: picked, onclick: () => { closeModal(); pick(c, cur) } }, picked ? (side === 'front' || side === 'sheet' ? 'Главный вид' : 'Выбран для этой стороны') : side === 'front' || side === 'sheet' ? 'Сделать главным' : `Выбрать для вида «${SIDE[side].name.toLowerCase()}»`),
          h('div', { class: 'seg', title: 'Какая это сторона (поправь, если определилась неверно)' }, ...[...SIDES.map(x => x[0]), 'sheet'].map(k => h('button', { class: k === side ? 'on' : '', onclick: () => { closeModal(); api('POST', `${base}/cards/${c.id}/variant`, { file: cur.file, view: k }).then(refresh).catch(() => {}) } }, SIDE[k].short))),
          h('a', { class: 'btn', href: fileUrl(cur.file), target: '_blank' }, 'Открыть файл'),
          h('button', { class: 'btn ghost', onclick: closeModal }, 'Закрыть')),
        cur.prompt ? h('details', { class: 'lb-prompt' }, h('summary', {}, 'Промпт, с которым сделана картинка'), h('div', {}, cur.prompt)) : '')
    }
    const key = e => {
      if (e.key === 'ArrowRight' && seq.length > 1) { i = (i + 1) % seq.length; show() }
      if (e.key === 'ArrowLeft' && seq.length > 1) { i = (i - 1 + seq.length) % seq.length; show() }
    }
    document.addEventListener('keydown', key)
    show()
    openModal(box, () => document.removeEventListener('keydown', key))
  }
  // the chosen picture of every side, front first: what the hero and the side slots open
  const pickedList = c => { const pk = picksOf(c); return SIDES.map(x => x[0]).filter(k => pk[k]).map(k => ({ file: pk[k], view: k })) }

  function imagesBody(c, b) {
    const vars = (c.variants || []).filter(v => !v.hidden)
    const picks = picksOf(c)
    const main = picks.front
    b.append(main ? h('div', { class: 'hero', style: { backgroundImage: `url("${fileUrl(main)}")` }, onclick: () => lightbox(c, { file: main }, pickedList(c)) }, h('span', { class: 'hero-side' }, sideIcon(viewOf(vars.find(v => v.file === main) || { view: 'front' }))))
      : h('div', { class: 'hero empty' }, vars.length ? 'Выбери главный вид (спереди) ниже' : 'Нет картинок. Сгенерируй или перетащи файл сюда.'))
    // the other sides: small, under the main view
    const others = SIDES.slice(1)
    if (vars.some(v => viewOf(v) !== 'front') || others.some(([k]) => picks[k])) {
      b.append(h('div', { class: 'side-row' }, ...others.map(([k, name]) => {
        const f = picks[k]
        return h('div', { class: 'side-slot' + (f ? '' : ' empty') + (filters.get(c.id) === k ? ' on' : ''), title: name + (f ? '' : ': не выбрано'),
          style: f ? { backgroundImage: `url("${fileUrl(f)}")` } : {}, onclick: () => { if (f) lightbox(c, { file: f }, pickedList(c)); else { filters.set(c.id, filters.get(c.id) === k ? null : k); render() } } }, sideIcon(k), f ? null : h('span', {}, name))
      })))
    }
    if (vars.length) {
      const counts = {}; for (const v of vars) counts[viewOf(v)] = (counts[viewOf(v)] || 0) + 1
      const filter = filters.get(c.id) && counts[filters.get(c.id)] ? filters.get(c.id) : null
      const tabs = Object.keys(counts).length > 1 ? h('div', { class: 'side-tabs' },
        h('button', { class: filter ? '' : 'on', onclick: () => { filters.set(c.id, null); render() } }, `Все ${vars.length}`),
        ...[...SIDES.map(x => x[0]), 'sheet'].filter(k => counts[k]).map(k => h('button', { class: filter === k ? 'on' : '', onclick: () => { filters.set(c.id, k); render() } }, sideIcon(k), ' ', counts[k]))) : null
      if (tabs) b.append(tabs)
      const list = (filter ? vars.filter(v => viewOf(v) === filter) : vars).slice(-8)
      b.append(h('div', { class: 'strip' }, ...list.slice().reverse().map(v => {
        const side = viewOf(v), isPick = picks[side] === v.file
        return h('div', { class: 'thumb-v' + (isPick ? ' ch' : ''), title: (SIDE[side].name + (v.prompt ? ': ' + v.prompt : '')).slice(0, 300), style: { backgroundImage: `url("${fileUrl(v.file)}")` }, onclick: () => lightbox(c, v, list.slice().reverse()) },
          sideIcon(side),
          h('button', { class: 'x', title: 'Скрыть вариант', onclick: e => { e.stopPropagation(); api('POST', `${base}/cards/${c.id}/variant`, { file: v.file, hidden: true }).then(refresh).catch(() => {}) } }, '✕'))
      })))
      const shown = filter ? counts[filter] : vars.length
      if (shown > 8) b.append(h('span', { class: 'more' }, `ещё ${shown - 8} в истории`))
    }
    const ta = h('textarea', { class: 'prompt desc', placeholder: 'Описание детали со всех сторон: основа промптов. Нажми «Описать со всех сторон», и Claude напишет его по референсам; потом поправь.' }); ta.value = c.prompt || ''
    ta.addEventListener('change', () => patch(c, { prompt: ta.value }))
    b.append(h('div', { class: 'desc-h' }, h('span', {}, 'Описание детали'),
      c.promptPrev ? h('button', { class: 'btn sm ghost', title: 'Вернуть текст, который был до последнего описания Claude', onclick: () => patch(c, { prompt: c.promptPrev, promptPrev: c.prompt || '' }) }, '↶ прошлое') : null,
      h('button', { class: 'btn sm', disabled: busy(c), title: 'Claude посмотрит на референсы и опишет деталь спереди, сзади и с боков; промпты под каждую сторону он соберёт из этого описания при генерации', onclick: () => generate(c, { kind: 'describe' }) }, '✎ Описать со всех сторон')), ta)
    if (c.doubts) b.append(h('div', { class: 'doubts', title: 'В этом Claude не уверен: при нескольких вариантах на сторону он меняет только эти места' }, h('b', {}, 'Сомнения: '), c.doubts))
    const chosenSides = c.sides?.length ? c.sides : ['front']
    const sidePick = h('div', { class: 'seg sides', title: 'Какие стороны генерировать: каждая отдельной картинкой, строго, не в три четверти' },
      ...SIDES.map(([k, name, short]) => h('button', { class: chosenSides.includes(k) ? 'on' : '', title: name, onclick: () => {
        const next = chosenSides.includes(k) ? chosenSides.filter(x => x !== k) : [...chosenSides, k]
        if (next.length) patch(c, { sides: SIDES.map(x => x[0]).filter(x => next.includes(x)) })
      } }, short)))
    const count = h('select', { class: 'count', title: 'Вариантов на каждую сторону' }, ...[1, 2, 3, 4, 5, 6, 7, 8].map(k => h('option', { value: k, selected: (c.count || 4) === k }, k + ' шт')))
    count.addEventListener('change', () => patch(c, { count: Number(count.value) }))
    const freeze = h('button', { class: 'icon-btn' + (c.frozen ? ' on' : ''), title: c.frozen ? 'Разморозить' : 'Заморозить: запретить перегенерацию', onclick: () => patch(c, { frozen: !c.frozen }) }, c.frozen ? '🔒' : '🔓')
    const total = chosenSides.length * Number(count.value)
    const gen = h('button', { class: 'btn primary sm', disabled: c.frozen || busy(c), title: `${total} картинок: ${chosenSides.map(k => SIDE[k].name.toLowerCase()).join(', ')}`,
      onclick: () => { patch(c, { prompt: ta.value }); generate(c, { prompt: ta.value, count: Number(count.value), sides: chosenSides }) } }, vars.length ? `Ещё ${total}` : `Сгенерировать ${total}`)
    b.append(h('div', { class: 'row' }, sidePick, count, h('span', { class: 'grow' }), freeze, gen))
    const st = statusLine(c); if (st) b.append(st)
  }

  let confirming = false
  async function confirmSplit(c) {
    if (confirming) return
    confirming = true
    try { const r = await api('POST', `${base}/cards/${c.id}/confirm-split`); toast(`Создано частей: ${r.created}`); await refresh(); await new Promise(r => requestAnimationFrame(r)); await layout({ quiet: true }) } catch {} finally { confirming = false; refresh() }
  }

  const BODY = {
    ref(c, b) {
      imagesBody(c, b)
      const hasSplit = B.links.some(l => l.from === c.id && B.cards.find(x => x.id === l.to)?.type === 'split')
      if (c.chosen && !hasSplit) b.append(h('button', { class: 'btn', onclick: async () => {
        const s = await api('POST', base + '/cards', { type: 'split', title: 'Разбивка на части', x: c.x + 470, y: c.y, w: 400, parts: [], linkFrom: c.id })
        await generate(s, { kind: 'split' }); refresh()
      } }, 'Разбить на части →'))
    },
    part(c, b) {
      if (c.note || c.route) b.append(h('div', { class: 'proposal' }, [c.note, c.route && 'Tripo: ' + c.route].filter(Boolean).join(' · ')))
      imagesBody(c, b)
    },
    split(c, b) {
      if (c.proposal) b.append(h('div', { class: 'proposal' }, c.proposal))
      const parts = c.parts || []
      const box = h('div', { class: 'parts' })
      const partOp = body => api('POST', `${base}/cards/${c.id}/parts`, body).then(refresh).catch(() => {})
      parts.forEach(part => {
        const pending = {}
        const push = debounce(() => { const fields = { ...pending }; for (const k in pending) delete pending[k]; partOp(part.pid ? { op: 'update', pid: part.pid, fields } : { op: 'noop' }) }, 500)
        const field = (tag, key, attrs) => { const x = h(tag, attrs); x.value = part[key] || ''; x.addEventListener('input', () => { pending[key] = x.value; push() }); return x }
        box.append(h('div', { class: 'part' + (part.card ? ' done' : '') },
          h('div', { class: 'row' }, field('input', 'name', { class: 'name', placeholder: 'Название части' }),
            part.card ? h('span', { class: 'tag done' }, 'создана') : h('button', { class: 'icon-btn', title: 'Убрать часть', onclick: () => part.pid && partOp({ op: 'remove', pid: part.pid }) }, '✕')),
          field('input', 'includes', { class: 'small', placeholder: 'Что входит' }), field('input', 'route', { class: 'small', placeholder: 'Tripo: модель и полигоны' }),
          field('textarea', 'prompt', { placeholder: 'Промпт референса части' })))
      })
      if (!parts.length && !busy(c)) box.append(h('div', { class: 'proposal' }, 'Частей пока нет. Попроси Claude предложить или добавь вручную.'))
      b.append(box)
      b.append(h('div', { class: 'row' },
        h('button', { class: 'btn sm', onclick: () => partOp({ op: 'add' }) }, '+ часть'),
        h('button', { class: 'btn sm', disabled: busy(c), onclick: () => generate(c, { kind: 'split' }) }, parts.length ? 'Предложить заново' : 'Предложить'),
        h('span', { class: 'grow' }),
        h('button', { class: 'btn primary sm', disabled: !parts.some(x => !x.card && x.name), onclick: () => confirmSplit(c) }, 'Подтвердить →')))
      const st = statusLine(c); if (st) b.append(st)
    },
    model(c, b) {
      if (c.route) b.append(h('div', { class: 'proposal' }, 'Tripo: ' + c.route))
      const latest = (c.textured || []).at(-1) || (c.mesh || []).at(-1)
      b.append(modelThumb(c, latest))
      for (const [slot, label] of [['mesh', 'Сетка'], ['textured', 'С текстурой']]) {
        const items = c[slot] || []
        b.append(h('div', { class: 'slot', 'data-slot': slot, ondragover: e => e.currentTarget.classList.add('over'), ondragleave: e => e.currentTarget.classList.remove('over'), ondrop: e => e.currentTarget.classList.remove('over') },
          h('b', {}, label), ' — перетащи .glb / .fbx / .obj / .zip', ...items.slice(-3).map(f => fileLine(c, f, slot))))
      }
    },
    final(c, b) {
      const latest = (c.files || []).at(-1)
      b.append(modelThumb(c, latest))
      b.append(h('div', { class: 'slot', 'data-slot': 'files' }, h('b', {}, 'Итоговая модель'), ' — перетащи файл', ...(c.files || []).slice(-3).map(f => fileLine(c, f, 'files'))))
      const parts = B.links.filter(l => l.to === c.id).map(l => B.cards.find(x => x.id === l.from)).filter(Boolean)
      if (parts.length) b.append(h('div', { class: 'proposal' }, 'Сходятся: ' + parts.map(x => `${x.title}${(x.textured || []).length ? ' ✓' : ''}`).join(', ')))
    },
    note(c, b) {
      const ta = h('textarea', { class: 'prompt', placeholder: 'Заметка или вопрос к Claude' }); ta.value = c.prompt || ''
      ta.addEventListener('change', () => patch(c, { prompt: ta.value }))
      b.append(ta)
      if (c.answer) b.append(h('div', { class: 'answer' }, c.answer))
      b.append(h('div', { class: 'row' }, h('span', { class: 'grow' }), h('button', { class: 'btn sm', disabled: busy(c), onclick: () => { patch(c, { prompt: ta.value }); generate(c, { kind: 'note', prompt: ta.value }) } }, 'Спросить Claude')))
      const st = statusLine(c); if (st) b.append(st)
    },
  }
  function fileLine(c, f, slot) {
    return h('div', { class: 'file-line' }, h('span', { title: f.file }, f.name || f.file.split('/').at(-1)),
      /\.(glb|gltf|fbx|obj)$/i.test(f.file) ? h('button', { class: 'btn sm ghost', onclick: () => openViewer(c, f) }, '3D') : null,
      h('a', { class: 'btn sm ghost', href: fileUrl(f.file), download: '' }, '↓'))
  }
  function modelThumb(c, f) {
    if (!f) return h('div', { class: 'model-thumb' }, 'Модели пока нет')
    return h('div', { class: 'model-thumb', style: c.thumb ? { backgroundImage: `url("${fileUrl(c.thumb)}")` } : {}, onclick: () => openViewer(c, f) }, c.thumb ? '' : 'Открыть 3D')
  }
  async function openViewer(c, f) {
    const { showModel } = await import('/viewer.js')
    showModel({ url: fileUrl(f.file), name: f.name || f.file, openModal, closeModal, toast,
      hasThumb: !!c.thumb,
      onThumb: async blob => { try { await api('POST', `${base}/cards/${c.id}/files?slot=thumb&name=thumb.png`, blob, { raw: true, quiet: true }); refresh() } catch {} } })
  }

  // keep in sync with the server (worker results arrive here)
  let stopped = false, lastVersion = -1, timer
  async function refresh() {
    try {
      const nb = await api('GET', base, undefined, { quiet: true })
      const changed = nb.version !== lastVersion || JSON.stringify(nb.jobs) !== JSON.stringify(B.jobs)
      B = nb; lastVersion = nb.version
      if (changed) render()
    } catch {}
  }
  async function loop() { if (stopped) return; await refresh(); timer = setTimeout(loop, document.hidden ? 6000 : 2000) }
  render(); lastVersion = B.version; if (!B.view) setTimeout(fit, 60)
  timer = setTimeout(loop, 2000)
  return { stop: () => { stopped = true; clearTimeout(timer) } }
}

// ---------- queue panel ----------
async function queuePoll() {
  try {
    const jobs = await api('GET', '/api/jobs', undefined, { quiet: true })
    const run = jobs.filter(j => j.status === 'running').length, q = jobs.filter(j => j.status === 'queued').length
    $('#queueDot').className = 'dot' + (run ? ' run' : q ? '' : ' ok')
    $('#queueText').textContent = run ? `Claude работает${q ? ` · ещё ${q}` : ''}` : q ? `В очереди: ${q}` : 'Очередь пуста'
    if (!$('#queuePanel').hidden) renderQueue(jobs)
  } catch {}
  setTimeout(queuePoll, 3000)
}
function renderQueue(jobs) {
  const p = $('#queuePanel'); p.innerHTML = ''
  p.append(h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'Задачи Claude'), h('button', { class: 'icon-btn', onclick: () => { p.hidden = true } }, '✕')))
  if (!jobs.length) p.append(h('div', { class: 'empty-note' }, 'Задач ещё не было'))
  const KIND = { images: 'Картинки', split: 'Разбивка', note: 'Вопрос', describe: 'Описание', request: 'Задача на месте', chat: 'Чат' }
  for (const j of jobs.slice(0, 40)) {
    p.append(h('div', { class: 'job' }, h('div', { class: 't' }, h('b', {}, `${KIND[j.kind] || j.kind}: ${j.cardTitle || ''}`), h('span', { class: 'tag ' + j.status }, j.status)),
      h('div', { class: 'l' }, (j.log || []).slice(-3).map(x => x.replace(/^\S+\s/, '')).join('\n')),
      h('div', { class: 'row' },
        h('a', { class: 'btn sm ghost', href: `#/p/${j.project}/b/${j.board}` }, 'К доске'),
        h('button', { class: 'btn sm ghost', onclick: async () => { const { text } = await api('GET', `/api/jobs/${j.id}/log`); openModal(h('div', { class: 'modal-box', style: { width: 'min(900px, calc(100% - 32px))' } }, h('h2', {}, 'Журнал'), h('pre', { style: { whiteSpace: 'pre-wrap', maxHeight: '70vh', overflow: 'auto', fontSize: '12px' } }, text || 'пусто'))) } }, 'Журнал'),
        ['queued', 'running'].includes(j.status) ? h('button', { class: 'btn sm ghost', onclick: () => api('POST', `/api/jobs/${j.id}/cancel`) }, 'Отменить') : null,
        ['error', 'cancelled'].includes(j.status) ? h('button', { class: 'btn sm ghost', onclick: () => api('POST', `/api/jobs/${j.id}/retry`) }, 'Повторить') : null)))
  }
}
$('#queueBtn').addEventListener('click', async () => { const p = $('#queuePanel'); p.hidden = !p.hidden; if (!p.hidden) renderQueue(await api('GET', '/api/jobs', undefined, { quiet: true }).catch(() => [])) })

const assist = initAssist({ api, h, toast, getCtx: () => ctxNow, confirm2 })
route(); queuePoll()
