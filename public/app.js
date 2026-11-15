// Studio Board front end: projects -> sections -> boards with linked cards.
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
function closeModal() { const m = $('#modal'); m.hidden = true; m.innerHTML = ''; modalCleanup?.(); modalCleanup = null }
let modalCleanup = null
function openModal(content, cleanup) {
  const m = $('#modal'); m.innerHTML = ''; m.append(content); m.hidden = false; modalCleanup = cleanup
  m.onclick = e => { if (e.target === m) closeModal() }
}
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal() })
function prompt2(title, fields) {
  return new Promise(resolve => {
    const inputs = {}
    const form = h('form', { class: 'modal-box', onsubmit: e => { e.preventDefault(); const v = {}; for (const k in inputs) v[k] = inputs[k].value.trim(); closeModal(); resolve(v) } },
      h('h2', {}, title),
      ...fields.map(f => h('label', {}, f.label, inputs[f.key] = f.options ? h('select', {}, ...f.options.map(o => h('option', { value: o[0] }, o[1]))) : h('input', { value: f.value || '', placeholder: f.placeholder || '' }))),
      h('div', { class: 'row' }, h('span', { class: 'grow' }), h('button', { type: 'button', class: 'btn ghost', onclick: () => { closeModal(); resolve(null) } }, 'Отмена'), h('button', { class: 'btn primary' }, 'Готово')))
    openModal(form, () => resolve(null))
    setTimeout(() => form.querySelector('input,select')?.focus(), 30)
  })
}
function confirm2(text, yes = 'Удалить') {
  return new Promise(resolve => {
    openModal(h('div', { class: 'modal-box' }, h('h2', {}, text),
      h('div', { class: 'row' }, h('span', { class: 'grow' }), h('button', { class: 'btn ghost', onclick: () => { closeModal(); resolve(false) } }, 'Отмена'),
        h('button', { class: 'btn primary', onclick: () => { closeModal(); resolve(true) } }, yes))), () => resolve(false))
  })
}

// ---------- router ----------
let current = null // { stop() }
function crumbs(items) {
  const c = $('#crumbs'); c.innerHTML = ''
  items.forEach((it, i) => { if (i) c.append(h('span', { class: 'sep' }, '/')); c.append(it.href ? h('a', { href: it.href }, it.text) : h('span', { class: 'cur' }, it.text)) })
}
async function route() {
  current?.stop?.(); current = null
  const view = $('#view'); view.innerHTML = ''
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  try {
    if (parts[0] === 'p' && parts[2] === 'b') current = await boardPage(view, parts[1], parts[3])
    else if (parts[0] === 'p') current = await projectPage(view, parts[1], parts[2] || '3d')
    else current = await homePage(view)
  } catch (e) { console.error(e); view.append(h('div', { class: 'page' }, h('div', { class: 'empty-note' }, 'Не удалось открыть: ' + e.message, h('br'), h('a', { href: '#/' , class: 'btn', style: { marginTop: '14px' } }, 'На главную')))) }
}
window.addEventListener('hashchange', route)

// ---------- home ----------
async function homePage(view) {
  crumbs([{ text: 'Проекты' }])
  const list = await api('GET', '/api/projects')
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
async function projectPage(view, pid, sid) {
  const p = await api('GET', `/api/projects/${pid}`)
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
  if (sec.kind === 'boards') return boardsList(main, p, sec)
  return notesPage(main, p, sec)
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

async function notesPage(main, p, sec) {
  const { html } = await api('GET', `/api/projects/${p.id}/notes/${sec.id}`)
  const saved = h('span', { class: 'saved' }, 'Сохранено')
  const ed = h('div', { class: 'editor', contenteditable: 'true', html: html || `<h1>${esc(sec.title)}</h1><p>Пиши здесь. Сохраняется само.</p>` })
  const save = debounce(async () => { try { await api('PUT', `/api/projects/${p.id}/notes/${sec.id}`, { html: ed.innerHTML }, { quiet: true }); saved.textContent = 'Сохранено' } catch { saved.textContent = 'Не сохранено, повторю' ; save() } }, 700)
  ed.addEventListener('input', () => { saved.textContent = 'Сохраняю…'; save() })
  const cmd = (c, v) => () => { document.execCommand(c, false, v); ed.focus(); save() }
  const bar = h('div', { class: 'editor-bar' },
    h('button', { class: 'btn sm', onclick: cmd('formatBlock', 'H1') }, 'Заголовок'), h('button', { class: 'btn sm', onclick: cmd('formatBlock', 'H2') }, 'Подзаголовок'),
    h('button', { class: 'btn sm', onclick: cmd('formatBlock', 'P') }, 'Текст'), h('button', { class: 'btn sm', onclick: cmd('bold') }, 'Ж'), h('button', { class: 'btn sm', onclick: cmd('italic') }, 'К'),
    h('button', { class: 'btn sm', onclick: cmd('insertUnorderedList') }, '• Список'), saved)
  main.append(h('div', { class: 'page' }, bar, ed))
  window.addEventListener('beforeunload', save)
  return { stop: () => { window.removeEventListener('beforeunload', save) } }
}

// ---------- board ----------
const TYPES = {
  ref: 'Референс', part: 'Часть', split: 'Разбивка', model: 'Модель', final: 'Итог', note: 'Заметка',
}

async function boardPage(view, pid, bid) {
  const p = await api('GET', `/api/projects/${pid}`)
  let B = await api('GET', `/api/projects/${pid}/boards/${bid}`)
  const sec = p.sections.find(s => s.id === (p.boards.find(b => b.id === bid)?.section || '3d'))
  crumbs([{ text: 'Проекты', href: '#/' }, { text: p.name || p.dir, href: `#/p/${pid}/${sec?.id || '3d'}` }, { text: B.name }])
  const base = `/api/projects/${pid}/boards/${bid}`
  const el = h('div', { class: 'board' }); view.append(el)
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
    const nz = Math.min(2, Math.max(0.2, cam.z * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015))))
    cam.x = mx - (mx - cam.x) * nz / cam.z; cam.y = my - (my - cam.y) * nz / cam.z; cam.z = nz
    applyCam(); saveCam()
  }, { passive: false })
  function fit() {
    if (!B.cards.length) return
    const xs = B.cards.map(c => c.x), ys = B.cards.map(c => c.y), xe = B.cards.map(c => c.x + (c.w || 380)), ye = B.cards.map(c => c.y + (nodes.get(c.id)?.offsetHeight || 400))
    const r = el.getBoundingClientRect(), x0 = Math.min(...xs) - 60, y0 = Math.min(...ys) - 80, x1 = Math.max(...xe) + 60, y1 = Math.max(...ye) + 60
    cam.z = Math.min(1.2, Math.max(0.2, Math.min(r.width / (x1 - x0), r.height / (y1 - y0))))
    cam.x = (r.width - (x1 - x0) * cam.z) / 2 - x0 * cam.z; cam.y = (r.height - (y1 - y0) * cam.z) / 2 - y0 * cam.z + 20
    applyCam(); saveCam()
  }

  // cards are kept as DOM nodes keyed by id; a card being edited or dragged is not rebuilt under the user
  const nodes = new Map()
  let dragging = null, linking = null, editing = new Set()
  const jobOf = cid => B.jobs.filter(j => j.card === cid).sort((a, b) => a.created.localeCompare(b.created)).at(-1)
  const sig = c => JSON.stringify([c, jobOf(c.id)])

  function render() {
    const seen = new Set()
    for (const c of B.cards) {
      seen.add(c.id)
      let n = nodes.get(c.id)
      const s = sig(c)
      if (n && (n._sig === s || editing.has(c.id))) { if (!(dragging?.id === c.id)) { n.style.left = c.x + 'px'; n.style.top = c.y + 'px' } continue }
      const fresh = cardNode(c)
      fresh._sig = s
      if (n) n.replaceWith(fresh); else world.append(fresh)
      nodes.set(c.id, fresh)
    }
    for (const [cid, n] of nodes) if (!seen.has(cid)) { n.remove(); nodes.delete(cid) }
    requestAnimationFrame(drawLinks)
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
  const generate = async (c, body = {}) => { try { await api('POST', `${base}/cards/${c.id}/generate`, body); toast('Задача поставлена в очередь'); refresh() } catch {} }
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
    head.addEventListener('pointerup', endDrag); head.addEventListener('pointercancel', endDrag)

    const port = h('div', { class: 'port', title: 'Протяни к другой карточке, чтобы связать' })
    port.addEventListener('pointerdown', e => { e.stopPropagation(); e.preventDefault(); port.setPointerCapture(e.pointerId); const [x, y] = toWorld(e); linking = { from: c.id, x, y }; drawLinks() })
    port.addEventListener('pointermove', e => { if (!linking) return; const [x, y] = toWorld(e); linking.x = x; linking.y = y; drawLinks() })
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
    n.addEventListener('focusin', e => { if (e.target.matches('textarea, input')) editing.add(c.id) })
    n.addEventListener('focusout', e => { if (e.target.matches('textarea, input')) setTimeout(() => { if (!n.contains(document.activeElement)) { editing.delete(c.id); render() } }, 50) })
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
  const busy = c => ['queued', 'running'].includes(jobOf(c.id)?.status)

  function lightbox(c, v) {
    openModal(h('div', { class: 'lightbox' }, h('img', { src: fileUrl(v.file) }),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: () => { closeModal(); patch(c, { chosen: v.file }) } }, c.chosen === v.file ? 'Выбрано' : 'Выбрать этот'),
        h('a', { class: 'btn', href: fileUrl(v.file), target: '_blank' }, 'Открыть файл'),
        h('button', { class: 'btn ghost', onclick: closeModal }, 'Закрыть'))))
  }

  function imagesBody(c, b) {
    const vars = (c.variants || []).filter(v => !v.hidden)
    const hero = c.chosen ? h('div', { class: 'hero', style: { backgroundImage: `url("${fileUrl(c.chosen)}")` }, onclick: () => lightbox(c, { file: c.chosen }) })
      : h('div', { class: 'hero empty' }, vars.length ? 'Выбери вариант ниже' : 'Нет картинок. Сгенерируй или перетащи файл сюда.')
    b.append(hero)
    if (vars.length) {
      const showAll = c._all
      const list = showAll ? vars : vars.slice(-8)
      b.append(h('div', { class: 'strip' }, ...list.slice().reverse().map(v => h('div', { class: 'thumb-v' + (v.file === c.chosen ? ' ch' : ''), title: v.prompt || '', style: { backgroundImage: `url("${fileUrl(v.file)}")` }, onclick: () => lightbox(c, v) },
        h('button', { class: 'x', title: 'Скрыть вариант', onclick: e => { e.stopPropagation(); patch(c, { variants: (c.variants || []).map(x => x.file === v.file ? { ...x, hidden: true } : x), ...(c.chosen === v.file ? { chosen: null } : {}) }) } }, '✕')))))
      if (vars.length > 8) b.append(h('span', { class: 'more' }, `ещё ${vars.length - 8} вариантов в истории`))
    }
    const ta = h('textarea', { class: 'prompt', placeholder: 'Промпт (по-русски). Пусто — Claude напишет сам по названию и связанным карточкам.' }); ta.value = c.prompt || ''
    ta.addEventListener('change', () => patch(c, { prompt: ta.value }))
    b.append(ta)
    const count = h('select', { class: 'count', title: 'Сколько вариантов' }, ...[1, 2, 3, 4, 5, 6, 7, 8].map(k => h('option', { value: k, selected: (c.count || 4) === k }, k + ' шт')))
    count.addEventListener('change', () => patch(c, { count: Number(count.value) }))
    const views = h('div', { class: 'seg', title: 'Один вид или лист с 4 сторонами' },
      h('button', { class: (c.views || 4) === 1 ? 'on' : '', onclick: () => patch(c, { views: 1 }) }, '1 вид'),
      h('button', { class: (c.views || 4) === 4 ? 'on' : '', onclick: () => patch(c, { views: 4 }) }, '4 стороны'))
    const freeze = h('button', { class: 'icon-btn' + (c.frozen ? ' on' : ''), title: c.frozen ? 'Разморозить' : 'Заморозить: запретить перегенерацию', onclick: () => patch(c, { frozen: !c.frozen }) }, c.frozen ? '🔒' : '🔓')
    const gen = h('button', { class: 'btn primary sm', disabled: c.frozen || busy(c), onclick: () => { patch(c, { prompt: ta.value }); generate(c, { prompt: ta.value, count: Number(count.value) }) } }, vars.length ? 'Перегенерировать' : 'Сгенерировать')
    b.append(h('div', { class: 'row' }, count, views, h('span', { class: 'grow' }), freeze, gen))
    const st = statusLine(c); if (st) b.append(st)
  }

  async function confirmSplit(c) {
    const parts = (c.parts || []).filter(x => !x.card && x.name?.trim())
    if (!parts.length) return toast('Нет новых частей для создания')
    const fin = B.cards.find(x => x.type === 'final')
    let y = c.y - (parts.length - 1) * 340
    const updated = [...(c.parts || [])]
    for (const part of parts) {
      const pc = await api('POST', base + '/cards', { type: 'part', title: part.name, x: c.x + 480, y, w: 380, prompt: part.prompt || '', count: 4, views: 4, variants: [], note: part.includes, route: part.route, linkFrom: c.id })
      const mc = await api('POST', base + '/cards', { type: 'model', title: part.name + ': модель', x: c.x + 940, y, w: 340, mesh: [], textured: [], route: part.route, linkFrom: pc.id })
      if (fin) await api('POST', base + '/links', { from: mc.id, to: fin.id })
      const i = updated.indexOf(part); updated[i] = { ...part, card: pc.id }
      y += 700
    }
    await api('PATCH', `${base}/cards/${c.id}`, { parts: updated, confirmed: true })
    toast(`Создано частей: ${parts.length}`); refresh()
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
      const save = debounce(() => patch(c, { parts }), 500)
      parts.forEach((part, i) => {
        const name = h('input', { class: 'name', value: part.name || '', placeholder: 'Название части' }); name.addEventListener('input', () => { part.name = name.value; save() })
        const inc = h('input', { class: 'small', value: part.includes || '', placeholder: 'Что входит' }); inc.addEventListener('input', () => { part.includes = inc.value; save() })
        const rt = h('input', { class: 'small', value: part.route || '', placeholder: 'Tripo: модель и полигоны' }); rt.addEventListener('input', () => { part.route = rt.value; save() })
        const pr = h('textarea', { placeholder: 'Промпт референса части' }); pr.value = part.prompt || ''; pr.addEventListener('input', () => { part.prompt = pr.value; save() })
        box.append(h('div', { class: 'part' + (part.card ? ' done' : '') }, h('div', { class: 'row' }, name, part.card ? h('span', { class: 'tag done' }, 'создана') : h('button', { class: 'icon-btn', title: 'Убрать часть', onclick: () => { parts.splice(i, 1); patch(c, { parts }) } }, '✕')), inc, rt, pr))
      })
      if (!parts.length && !busy(c)) box.append(h('div', { class: 'proposal' }, 'Частей пока нет. Попроси Claude предложить или добавь вручную.'))
      b.append(box)
      b.append(h('div', { class: 'row' },
        h('button', { class: 'btn sm', onclick: () => { parts.push({ name: '', includes: '', route: '', prompt: '' }); patch(c, { parts }) } }, '+ часть'),
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
      onThumb: async blob => { try { const r = await api('POST', `${base}/cards/${c.id}/files?slot=thumbs&name=thumb.png`, blob, { raw: true, quiet: true }); await api('PATCH', `${base}/cards/${c.id}`, { thumb: r.file }, { quiet: true }); refresh() } catch {} } })
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
  const KIND = { images: 'Картинки', split: 'Разбивка', note: 'Вопрос' }
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

route(); queuePoll()
