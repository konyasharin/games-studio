// Claude everywhere: point at any place and say what to do (pins with threads), and the project chat drawer.
// Both talk to the project's one continuing Claude session through the server queue.
export function initAssist({ api, h, toast, getCtx, confirm2 }) {
  const $ = s => document.querySelector(s)
  const top = $('.top-right')
  const pointBtn = h('button', { class: 'top-btn', title: 'Указать Claude место и сказать, что сделать (Esc — выйти)' }, '◎ Указать')
  const chatBtn = h('button', { class: 'top-btn', title: 'Чат с Claude по проекту' }, 'Чат с Claude')
  top.prepend(pointBtn, chatBtn)
  const sync = () => { const c = getCtx(); pointBtn.disabled = chatBtn.disabled = !c?.pid }

  // ---------- markdown-lite for Claude's text ----------
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  function md(text) {
    const lines = esc(text).split('\n'), out = []
    let list = false, code = false
    for (const l of lines) {
      if (l.trim().startsWith('```')) { out.push(code ? '</code></pre>' : '<pre><code>'); code = !code; continue }
      if (code) { out.push(l); continue }
      const li = l.match(/^\s*([-*]|\d+[.)])\s+(.*)/)
      if (li) { if (!list) { out.push('<ul>'); list = true } out.push('<li>' + inl(li[2]) + '</li>'); continue }
      if (list) { out.push('</ul>'); list = false }
      out.push(l.trim() ? '<p>' + inl(l) + '</p>' : '')
    }
    if (list) out.push('</ul>'); if (code) out.push('</code></pre>')
    return out.join('')
  }
  const inl = t => t.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<i>$2</i>')
  const STATUS = { queued: 'в очереди', running: 'Claude работает', done: 'готово', error: 'ошибка', cancelled: 'отменено' }

  // ---------- pointing ----------
  let pointing = false, hoverEl = null, drag = null, frame = null
  const BLOCKS = 'p, li, h1, h2, h3, h4, .box, .stat, .step, .callout, .quote, table, tr, figure, svg.viz, pre, blockquote, dl, .doc-hero, .gallery'
  function setPointing(on) {
    pointing = on; document.body.classList.toggle('pointing', on); pointBtn.classList.toggle('on', on)
    if (!on) { hoverEl?.classList.remove('point-hover'); hoverEl = null; frame?.remove(); frame = null; drag = null }
    else toast('Кликни по месту: блок страницы, карточку или пустое место доски. На доске можно обвести рамкой. Esc — выход')
  }
  pointBtn.addEventListener('click', () => setPointing(!pointing))
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && pointing) setPointing(false) })
  const targetOf = e => {
    const c = getCtx(); const v = $('#view')
    if (!v.contains(e.target) || e.target.closest('.board-tools, .board-right, .editor-bar, .assist-pop, .pin, .side')) return null
    if (c.kind === 'notes') return e.target.closest('.editor') ? (e.target.closest(BLOCKS) || e.target.closest('.editor')) : null
    if (c.kind === 'board') return e.target.closest('.card') || e.target.closest('.board')
    return e.target.closest('.tile, .page, .proj-main') || v
  }
  document.addEventListener('mouseover', e => {
    if (!pointing || drag) return
    const t = targetOf(e); if (t === hoverEl) return
    hoverEl?.classList.remove('point-hover'); hoverEl = t; t?.classList.add('point-hover')
  }, true)
  document.addEventListener('pointerdown', e => {
    if (!pointing) return
    const c = getCtx(), t = targetOf(e)
    if (!t) return
    e.preventDefault(); e.stopPropagation()
    if (c.kind === 'board' && t.classList.contains('board')) {
      drag = { x: e.clientX, y: e.clientY, w0: c.toWorld(e) }
      frame = h('div', { class: 'point-frame' }); document.body.append(frame); place(e)
    } else finish(e, t)
  }, true)
  const place = e => { const x0 = Math.min(drag.x, e.clientX), y0 = Math.min(drag.y, e.clientY); Object.assign(frame.style, { left: x0 + 'px', top: y0 + 'px', width: Math.abs(e.clientX - drag.x) + 'px', height: Math.abs(e.clientY - drag.y) + 'px' }) }
  document.addEventListener('pointermove', e => { if (pointing && drag) { e.preventDefault(); place(e) } }, true)
  document.addEventListener('pointerup', e => {
    if (!pointing || !drag) return
    e.preventDefault(); e.stopPropagation()
    const c = getCtx(), a = drag.w0, b = c.toWorld(e), d = drag
    frame.remove(); frame = null; drag = null
    if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) < 8) return finish(e, null, { x: Math.round(a[0]), y: Math.round(a[1]) })
    const r = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])].map(Math.round)
    const cards = c.cards().filter(k => k.x < r[2] && k.x + (k.w || 380) > r[0] && k.y < r[3] && k.y + 300 > r[1])
    finish(e, null, { x: r[0], y: r[1], rect: r, cards: cards.map(k => k.id), cardTitles: cards.map(k => k.title) })
  }, true)
  document.addEventListener('click', e => { if (pointing && $('#view').contains(e.target)) { e.preventDefault(); e.stopPropagation() } }, true)

  function finish(e, el, extra = {}) {
    const c = getCtx()
    let where = { kind: c.kind, route: location.hash }
    if (c.kind === 'notes') {
      const ed = el?.closest('.editor')
      let hd = null
      if (el && ed) { const all = [...ed.querySelectorAll('h1, h2, h3')]; hd = all.filter(x => x.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING || x === el).at(-1) }
      where = { ...where, section: c.section, sectionTitle: c.sectionTitle, heading: hd?.textContent.trim().slice(0, 200) || '',
        snippet: (el?.innerText || '').trim().slice(0, 800), selection: String(getSelection() || '').trim().slice(0, 800), tag: el?.tagName.toLowerCase() }
    } else if (c.kind === 'board') {
      const cardEl = el?.closest?.('.card')
      const card = cardEl ? c.cards().find(k => k.id === cardEl.dataset.id) : null
      where = { ...where, board: c.board, boardName: c.boardName, ...(card ? { card: card.id, cardTitle: card.title, cardType: card.type } : extra) }
    }
    hoverEl?.classList.remove('point-hover'); hoverEl = null
    setPointing(false)
    composer(e.clientX, e.clientY, where)
  }

  function popAt(x, y, node) {
    document.querySelectorAll('.assist-pop').forEach(p => p.remove())
    const pop = h('div', { class: 'assist-pop' }, node)
    document.body.append(pop)
    const r = pop.getBoundingClientRect()
    pop.style.left = Math.max(12, Math.min(x + 10, innerWidth - r.width - 12)) + 'px'
    pop.style.top = Math.max(60, Math.min(y + 10, innerHeight - r.height - 12)) + 'px'
    const close = ev => { if (!pop.contains(ev.target) && !ev.target.closest('.pin')) { pop.remove(); document.removeEventListener('pointerdown', close, true) } }
    setTimeout(() => document.addEventListener('pointerdown', close, true), 0)
    return pop
  }
  function describe(w) {
    if (w.kind === 'notes') return `${w.sectionTitle || 'Страница'}${w.heading ? ' → ' + w.heading : ''}${w.selection ? ' · «' + w.selection.slice(0, 60) + '»' : w.snippet ? ' · «' + w.snippet.slice(0, 60) + '…»' : ''}`
    if (w.kind === 'board') return `${w.boardName || 'Доска'} → ${w.cardTitle ? 'карточка «' + w.cardTitle + '»' : w.rect ? `область (${(w.cardTitles || []).length} карт.)` : 'место на доске'}`
    return 'Экран ' + (w.route || '')
  }
  function composer(x, y, where) {
    const ta = h('textarea', { class: 'prompt', placeholder: 'Что сделать или исправить здесь? Ctrl+Enter — отправить' })
    const send = async () => {
      if (!ta.value.trim()) return
      try { await api('POST', `/api/projects/${getCtx().pid}/requests`, { text: ta.value, where }); pop.remove(); toast('Claude получил задачу'); pins.refresh() } catch {}
    }
    ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send() })
    const pop = popAt(x, y, h('div', {}, h('div', { class: 'pop-where' }, '◎ ' + describe(where)), ta,
      h('div', { class: 'row' }, h('span', { class: 'grow' }), h('button', { class: 'btn ghost sm', onclick: () => pop.remove() }, 'Отмена'), h('button', { class: 'btn primary sm', onclick: send }, 'Отправить Claude'))))
    setTimeout(() => ta.focus(), 20)
  }

  // ---------- pins with threads ----------
  const pins = { list: [], timer: null, key: '' }
  function threadView(j) {
    const msgs = (j.thread || []).map(m => h('div', { class: 'msg ' + m.who }, h('div', { class: 'who' }, m.who === 'user' ? 'Ты' : 'Claude'), h('div', { class: 'body', html: m.who === 'user' ? esc(m.text).replace(/\n/g, '<br>') : md(m.text) })))
    const live = ['queued', 'running'].includes(j.status) ? h('div', { class: 'msg claude' }, h('div', { class: 'who' }, 'Claude'), h('div', { class: 'body typing' }, h('span', { class: 'spinner' }), ' ', j.status === 'queued' ? 'в очереди…' : (j.events || []).filter(e => e.t === 'tool').at(-1)?.brief ? 'работает: ' + (j.events || []).filter(e => e.t === 'tool').at(-1).name + ' ' + (j.events || []).filter(e => e.t === 'tool').at(-1).brief.slice(0, 60) : 'думает…')) : null
    const ta = h('textarea', { class: 'prompt', placeholder: 'Уточнить или ответить… Ctrl+Enter' })
    const reply = async () => { if (!ta.value.trim()) return; try { await api('POST', `/api/jobs/${j.id}/reply`, { text: ta.value }); ta.value = ''; pins.refresh(true) } catch {} }
    ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) reply() })
    return h('div', { class: 'thread' }, h('div', { class: 'pop-where' }, '◎ ' + describe(j.where || {}), h('span', { class: 'tag ' + j.status }, STATUS[j.status] || j.status)),
      h('div', { class: 'msgs' }, ...msgs, live), ta,
      h('div', { class: 'row' },
        ['queued', 'running'].includes(j.status) ? h('button', { class: 'btn ghost sm', onclick: () => api('POST', `/api/jobs/${j.id}/cancel`).then(() => pins.refresh(true)) }, 'Остановить') : h('button', { class: 'btn ghost sm', title: 'Убрать метку (переписка останется в чате)', onclick: () => api('POST', `/api/jobs/${j.id}/archive`).then(() => { document.querySelectorAll('.assist-pop').forEach(p => p.remove()); pins.refresh(true) }) }, 'Закрыть метку'),
        h('span', { class: 'grow' }), h('button', { class: 'btn primary sm', onclick: reply }, 'Отправить')))
  }
  let openThread = null
  function showThread(j, x, y) {
    openThread = j.id
    const pop = popAt(x, y, threadView(j)); pop.dataset.job = j.id
    pop.querySelector('.msgs').scrollTop = 1e9
  }
  pins.render = function () {
    document.querySelectorAll('.pin').forEach(p => p.remove())
    const c = getCtx(); if (!c?.pid) return
    pins.list.forEach((j, i) => {
      const pin = h('button', { class: 'pin ' + j.status, title: (j.thread?.[0]?.text || '').slice(0, 120) }, String(i + 1))
      pin.addEventListener('click', e => { e.stopPropagation(); showThread(j, e.clientX, e.clientY) })
      if (c.kind === 'board') {
        const w = j.where || {}
        const card = w.card && c.cards().find(k => k.id === w.card)
        const node = card && document.querySelector(`.card[data-id="${card.id}"]`)
        const x = card ? card.x + (node?.offsetWidth || 380) - 18 : w.x, y = card ? card.y - 14 : w.y
        if (x == null) return
        Object.assign(pin.style, { left: x + 'px', top: y + 'px' }); pin.classList.add('in-world')
        c.world()?.append(pin)
      } else if (c.kind === 'notes') {
        const ed = document.querySelector('.editor'); if (!ed) return
        const snip = (j.where?.snippet || '').slice(0, 50)
        let el = null
        if (snip) el = [...ed.querySelectorAll(BLOCKS)].filter(x => (x.innerText || '').trim().startsWith(snip)).at(-1)
        if (!el && j.where?.heading) el = [...ed.querySelectorAll('h1, h2, h3')].find(x => x.textContent.trim() === j.where.heading)
        if (!el) el = ed
        const host = ed.parentElement; host.style.position = 'relative'
        const r = el.getBoundingClientRect(), hr = host.getBoundingClientRect()
        Object.assign(pin.style, { left: (r.right - hr.left - 10) + 'px', top: (r.top - hr.top - 10) + 'px' }); pin.classList.add('in-page')
        host.append(pin)
      }
    })
    // keep an open thread live
    if (openThread) {
      const pop = document.querySelector(`.assist-pop[data-job="${openThread}"]`)
      const j = pins.list.find(x => x.id === openThread)
      if (!pop) openThread = null
      else if (j && !pop.contains(document.activeElement)) { const sc = pop.querySelector('.msgs').scrollTop; pop.firstChild.replaceWith(threadView(j)); pop.querySelector('.msgs').scrollTop = sc + 1e9 }
    }
  }
  pins.refresh = async function (force) {
    clearTimeout(pins.timer)
    const c = getCtx()
    if (c?.pid && (c.kind === 'board' || c.kind === 'notes')) {
      const q = c.kind === 'board' ? 'board=' + c.board : 'section=' + c.section
      try {
        const list = await api('GET', `/api/projects/${c.pid}/requests?${q}`, undefined, { quiet: true })
        const key = JSON.stringify(list.map(j => [j.id, j.status, (j.thread || []).length, (j.events || []).length])) + q + location.hash
        if (force || key !== pins.key) { pins.list = list; pins.key = key; pins.render() }
      } catch {}
    } else { pins.list = []; pins.key = ''; document.querySelectorAll('.pin').forEach(p => p.remove()) }
    pins.timer = setTimeout(pins.refresh, pins.list.some(j => ['queued', 'running'].includes(j.status)) ? 1500 : 4000)
  }

  // ---------- chat drawer ----------
  const drawer = h('aside', { class: 'chat', hidden: true })
  document.body.append(drawer)
  let chatOpen = false, chatTimer = null, chatKey = ''
  chatBtn.addEventListener('click', () => { chatOpen = !chatOpen; drawer.hidden = !chatOpen; chatBtn.classList.toggle('on', chatOpen); document.body.classList.toggle('chat-open', chatOpen); if (chatOpen) buildChat() })
  const KIND = { images: 'Генерация картинок', split: 'Разбивка на части', note: 'Вопрос с карточки', request: 'Задача на месте' }
  function buildChat() {
    const c = getCtx(); drawer.innerHTML = ''
    if (!c?.pid) { drawer.append(h('div', { class: 'empty-note' }, 'Открой проект, чтобы говорить с Claude')); return }
    const sessLine = h('div', { class: 'chat-sess' }, 'сессия…')
    const head = h('div', { class: 'chat-h' }, h('div', { class: 'grow' }, h('b', {}, 'Claude'), sessLine),
      h('button', { class: 'icon-btn', title: 'Закрыть', onclick: () => chatBtn.click() }, '✕'))
    const log = h('div', { class: 'chat-log' })
    const ta = h('textarea', { class: 'chat-in', rows: 1, placeholder: 'Напиши Claude…', title: 'Enter — отправить, Shift+Enter — новая строка' })
    const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(200, ta.scrollHeight) + 'px' }
    ta.addEventListener('input', grow)
    const send = async () => {
      const t = ta.value.trim(); if (!t) return
      ta.value = ''; grow()
      try { await api('POST', `/api/projects/${c.pid}/chat`, { text: t }); poll(true) } catch { ta.value = t }
    }
    ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } })
    drawer.append(head, log, h('div', { class: 'chat-foot' }, ta, h('button', { class: 'btn primary sm', onclick: send }, 'Отправить')))
    api('GET', `/api/projects/${c.pid}/session`, undefined, { quiet: true }).then(s => {
      sessLine.innerHTML = ''
      if (!s) { sessLine.append('новая сессия начнётся с первого сообщения'); return }
      const cmd = `cd "${s.cwd}" && claude --resume ${s.id}`
      sessLine.append(`одна сессия · ${s.jobs || 0} задач · `,
        h('a', { href: 'javascript:void 0', title: cmd, onclick: () => navigator.clipboard.writeText(cmd).then(() => toast('Команда скопирована: вставь в терминал')) }, 'открыть в терминале'), ' · ',
        h('a', { href: 'javascript:void 0', onclick: async () => { if (await confirm2('Начать новую сессию? Claude забудет прошлый разговор проекта.', 'Новая сессия')) { try { await api('POST', `/api/projects/${c.pid}/session/reset`); toast('Следующее сообщение начнёт новую сессию'); buildChat() } catch {} } } }, 'новая сессия'))
    }).catch(() => {})
    chatKey = ''
    async function poll(force) {
      clearTimeout(chatTimer)
      if (!chatOpen || getCtx()?.pid !== c.pid) return
      let items = []
      try { items = await api('GET', `/api/projects/${c.pid}/chat`, undefined, { quiet: true }) } catch {}
      const key = JSON.stringify(items.map(j => [j.id, j.status, (j.events || []).length, (j.thread || []).length]))
      if (force || key !== chatKey) {
        chatKey = key
        const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80
        log.innerHTML = ''
        if (!items.length) log.append(h('div', { class: 'chat-empty' }, h('b', {}, 'Это общий разговор проекта.'), h('p', {}, 'Сюда же попадают задачи с досок и метки «Указать»: всё идёт в одну сессию Claude, поэтому он помнит контекст.')))
        for (const j of items) log.append(...chatItem(j))
        if (atBottom || force) log.scrollTop = 1e9
      }
      chatTimer = setTimeout(() => poll(), items.some(j => ['queued', 'running'].includes(j.status)) ? 1200 : 4000)
    }
    poll(true)
    setTimeout(() => ta.focus(), 30)
  }
  function chatItem(j) {
    const ev = j.events || []
    const steps = ev.filter(e => e.t === 'tool')
    const texts = ev.filter(e => e.t === 'text')
    const working = ['queued', 'running'].includes(j.status)
    const toolsBox = steps.length ? h('details', { class: 'tools', open: working }, h('summary', {}, `${steps.length} ${steps.length === 1 ? 'действие' : 'действий'}`),
      ...steps.slice(-40).map(s => h('div', { class: 'tool' }, h('b', {}, s.name), ' ', s.brief))) : null
    const status = working ? h('div', { class: 'bubble claude typing' }, h('span', { class: 'spinner' }), ' ', j.status === 'queued' ? 'в очереди…' : steps.at(-1) ? `${steps.at(-1).name} ${steps.at(-1).brief.slice(0, 70)}` : 'думает…') : null
    if (j.kind === 'chat') {
      const answer = texts.length ? texts.map(t => t.text).join('\n\n') : j.answer
      return [h('div', { class: 'bubble user' }, j.text),
        toolsBox, answer ? h('div', { class: 'bubble claude', html: md(answer) }) : null, status,
        j.status === 'error' ? h('div', { class: 'bubble err' }, (j.log || []).at(-1)?.replace(/^\S+\s/, '') || 'ошибка') : null].filter(Boolean)
    }
    const title = j.kind === 'request' ? (j.thread?.[0]?.text || '') : j.cardTitle
    const last = j.kind === 'request' ? [...(j.thread || [])].reverse().find(m => m.who === 'claude')?.text : (j.log || []).at(-1)?.replace(/^\S+\s/, '')
    const goto = j.board ? `#/p/${j.project}/b/${j.board}` : j.where?.route || null
    return [h('div', { class: 'task ' + j.status },
      h('div', { class: 'task-h' }, h('span', { class: 'k' }, KIND[j.kind] || j.kind), h('span', { class: 'tag ' + j.status }, STATUS[j.status] || j.status)),
      h('div', { class: 'task-t' }, title), last ? h('div', { class: 'task-l', html: md(last.slice(0, 600)) }) : null, toolsBox,
      goto ? h('a', { class: 'btn sm ghost', href: goto }, 'К месту →') : null)]
  }

  return {
    pageChanged() { sync(); pins.key = ''; pins.refresh(true); if (chatOpen) buildChat() },
    boardRendered() { pins.render() },
  }
}
