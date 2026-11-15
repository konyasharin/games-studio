// A project's look: colour tokens and fonts swapped on :root while the project is open, plus a logo and a cover.
export const FONTS = [ // Google fonts with Cyrillic
  'Inter', 'Manrope', 'Montserrat', 'Exo 2', 'Unbounded', 'Russo One', 'Oswald', 'Comfortaa', 'Philosopher',
  'Cormorant Garamond', 'Cormorant SC', 'EB Garamond', 'Playfair Display', 'PT Serif', 'Lora', 'Ruslan Display',
  'Neucha', 'Marck Script', 'Press Start 2P', 'Jura', 'Tektur', 'M PLUS Rounded 1c', 'Nunito', 'Rubik', 'Space Grotesk',
]
export const PRESETS = {
  studio: { name: 'Studio (стандарт)', fontDisplay: 'Space Grotesk', fontBody: 'Inter',
    colors: { bg: '#0f1115', bg2: '#151820', panel: '#1b1f29', panel2: '#222734', line: '#2c3241', line2: '#3a4155', fg: '#e9ecf2', muted: '#9098aa', dim: '#646c7e', accent: '#e2384d', accent2: '#ff6b7d' } },
  fairy: { name: 'Сказка / фэнтези (пергамент, золото)', fontDisplay: 'Cormorant Garamond', fontBody: 'EB Garamond', texture: true,
    colors: { bg: '#15110d', bg2: '#1c1611', panel: '#221b15', panel2: '#2c231b', line: '#3a2f24', line2: '#4d3e2f', fg: '#efe6d6', muted: '#b5a68e', dim: '#7d705e', accent: '#c9a45c', accent2: '#e4c47e' } },
  space: { name: 'Космос / sci-fi', fontDisplay: 'Exo 2', fontBody: 'Manrope',
    colors: { bg: '#080b12', bg2: '#0d1220', panel: '#121a2b', panel2: '#192338', line: '#22304a', line2: '#2f4263', fg: '#e6eeff', muted: '#8fa0c0', dim: '#5e6d8a', accent: '#36c6ff', accent2: '#7fdcff' } },
  anime: { name: 'Аниме sci-fi (тёмный, красный акцент)', fontDisplay: 'Unbounded', fontBody: 'Manrope',
    colors: { bg: '#0b0c12', bg2: '#11131c', panel: '#171a26', panel2: '#1f2332', line: '#2a2f42', line2: '#3a4057', fg: '#eef0f8', muted: '#99a0b8', dim: '#666d86', accent: '#e8344f', accent2: '#ff6a80' } },
  noir: { name: 'Нуар / хоррор', fontDisplay: 'Russo One', fontBody: 'PT Serif',
    colors: { bg: '#0a0a0a', bg2: '#111111', panel: '#171717', panel2: '#1f1f1f', line: '#2b2b2b', line2: '#3a3a3a', fg: '#e8e3da', muted: '#a09a90', dim: '#6b665f', accent: '#b3261e', accent2: '#e0453b' } },
  pastel: { name: 'Светлый пастельный', fontDisplay: 'Comfortaa', fontBody: 'Nunito',
    colors: { bg: '#2a2433', bg2: '#312a3c', panel: '#3a3247', panel2: '#443a53', line: '#54496a', line2: '#67597f', fg: '#fbf6ff', muted: '#cbbfe0', dim: '#9a8db3', accent: '#ff9ec7', accent2: '#ffc2dc' } },
}
const DEFAULT = PRESETS.studio
const VAR = { bg: '--bg', bg2: '--bg2', panel: '--panel', panel2: '--panel2', line: '--line', line2: '--line2', fg: '--fg', muted: '--muted', dim: '--dim', accent: '--accent', accent2: '--accent2' }

export function applyTheme(t) {
  const th = t && Object.keys(t.colors || {}).length ? t : DEFAULT
  const root = document.documentElement.style
  for (const [k, v] of Object.entries(VAR)) root.setProperty(v, th.colors?.[k] || DEFAULT.colors[k])
  const disp = th.fontDisplay || DEFAULT.fontDisplay, body = th.fontBody || DEFAULT.fontBody
  root.setProperty('--display', `"${disp}", system-ui, sans-serif`)
  root.setProperty('--body', `"${body}", system-ui, sans-serif`)
  document.body.classList.toggle('textured', !!th.texture)
  const fams = [...new Set([disp, body])].filter(f => !['Inter', 'Space Grotesk'].includes(f))
  let link = document.getElementById('proj-fonts')
  if (fams.length) {
    const href = 'https://fonts.googleapis.com/css2?' + fams.map(f => 'family=' + encodeURIComponent(f).replace(/%20/g, '+') + ':wght@400;500;600;700').join('&') + '&display=swap'
    if (!link) { link = document.createElement('link'); link.id = 'proj-fonts'; link.rel = 'stylesheet'; document.head.append(link) }
    if (link.href !== href) link.href = href
  } else link?.remove()
}
export const resetTheme = () => applyTheme(null)

// the «Оформление» page of a project
export function themePage(main, p, { api, h, toast, fileUrl, onSaved }) {
  let t = JSON.parse(JSON.stringify(p.theme && Object.keys(p.theme.colors || {}).length ? p.theme : { ...DEFAULT, preset: 'studio' }))
  const save = async () => { try { const d = await api('PATCH', `/api/projects/${p.id}`, { theme: t }); t = d.theme || t; applyTheme(t); onSaved?.(t) } catch {} }
  let timer; const saveSoon = () => { applyTheme(t); clearTimeout(timer); timer = setTimeout(save, 500) }
  const page = h('div', { class: 'page theme-page' })
  // the page shows every preset and font in its own face: load them all here once
  if (!document.getElementById('all-fonts')) {
    const fams = [...new Set([...FONTS, ...Object.values(PRESETS).flatMap(x => [x.fontDisplay, x.fontBody])])].filter(f => !['Inter', 'Space Grotesk'].includes(f))
    const l = document.createElement('link'); l.id = 'all-fonts'; l.rel = 'stylesheet'
    l.href = 'https://fonts.googleapis.com/css2?' + fams.map(f => 'family=' + encodeURIComponent(f).replace(/%20/g, '+') + ':wght@400;700').join('&') + '&display=swap'
    document.head.append(l)
  }
  const render = () => {
    page.innerHTML = ''
    page.append(h('h1', {}, 'Оформление'), h('p', { class: 'sub' }, 'Шрифты, цвета, логотип и обложка этого проекта. Меняется сразу, сохраняется само.'))
    // presets
    page.append(h('h2', {}, 'Готовые стили'), h('div', { class: 'theme-presets' }, ...Object.entries(PRESETS).map(([k, pr]) =>
      h('button', { class: 'theme-card' + (t.preset === k ? ' on' : ''), style: { background: pr.colors.bg, borderColor: t.preset === k ? pr.colors.accent : pr.colors.line, color: pr.colors.fg }, onclick: () => { t = { ...t, ...JSON.parse(JSON.stringify(pr)), preset: k, logo: t.logo, cover: t.cover, tagline: t.tagline }; delete t.name; saveSoon(); render() } },
        h('span', { class: 'tc-title', style: { fontFamily: `"${pr.fontDisplay}"`, color: pr.colors.fg } }, 'Аа'),
        h('span', { class: 'tc-dots' }, ...['panel', 'line2', 'accent', 'accent2'].map(c => h('i', { style: { background: pr.colors[c] } }))),
        h('span', { class: 'tc-name', style: { color: pr.colors.muted } }, pr.name)))))
    // fonts
    const fontSel = key => { const sel = h('select', {}, ...FONTS.map(f => h('option', { value: f, selected: t[key] === f, style: { fontFamily: `"${f}"` } }, f))); sel.addEventListener('change', () => { t[key] = sel.value; t.preset = 'custom'; saveSoon(); render() }); return sel }
    page.append(h('h2', {}, 'Шрифты'), h('div', { class: 'theme-row' },
      h('label', {}, 'Заголовки', fontSel('fontDisplay')), h('label', {}, 'Текст', fontSel('fontBody'))),
      h('div', { class: 'theme-sample' }, h('div', { style: { fontFamily: 'var(--display)', fontSize: '30px', fontWeight: 700 } }, p.name || p.dir), h('div', { style: { fontFamily: 'var(--body)' } }, 'Съешь же ещё этих мягких французских булок, да выпей чаю. 0123456789')))
    // colours
    const LABEL = { bg: 'Фон', bg2: 'Фон 2', panel: 'Панели', panel2: 'Панели 2', line: 'Линии', line2: 'Линии 2', fg: 'Текст', muted: 'Тусклый текст', dim: 'Подписи', accent: 'Акцент', accent2: 'Акцент светлый' }
    page.append(h('h2', {}, 'Цвета'), h('div', { class: 'theme-colors' }, ...Object.keys(LABEL).map(k => {
      const inp = h('input', { type: 'color', value: t.colors[k] || DEFAULT.colors[k] })
      inp.addEventListener('input', () => { t.colors[k] = inp.value; t.preset = 'custom'; saveSoon() })
      return h('label', { class: 'theme-color' }, inp, h('span', {}, LABEL[k]))
    })))
    const tex = h('input', { type: 'checkbox', checked: !!t.texture }); tex.addEventListener('change', () => { t.texture = tex.checked; saveSoon() })
    page.append(h('label', { class: 'theme-check' }, tex, ' Фактура фона (виньетка, зерно)'))
    // logo and cover
    const imgSlot = (key, title, hint) => {
      const slot = h('div', { class: 'theme-img' + (t[key] ? '' : ' empty'), style: t[key] ? { backgroundImage: `url("${fileUrl(t[key])}")` } : {} },
        h('b', {}, title), h('span', {}, t[key] ? 'перетащи другую картинку, чтобы заменить' : hint))
      slot.addEventListener('dragover', e => { e.preventDefault(); slot.classList.add('over') })
      slot.addEventListener('dragleave', () => slot.classList.remove('over'))
      slot.addEventListener('drop', async e => {
        e.preventDefault(); slot.classList.remove('over')
        const f = e.dataTransfer.files[0]; const rel = e.dataTransfer.getData('text/x-studio-file')
        try {
          if (rel) t[key] = rel
          else if (f) t[key] = (await api('POST', `/api/projects/${p.id}/brand?name=${encodeURIComponent(f.name)}`, f, { raw: true })).file
          else return
          await save(); render()
        } catch {}
      })
      const clear = t[key] ? h('button', { class: 'btn sm ghost', onclick: () => { delete t[key]; save().then(render) } }, 'Убрать') : null
      return h('div', {}, slot, clear)
    }
    // pictures made on the boards for this purpose (cards marked brand: 'logo' / 'cover'), one click to use
    const picker = h('div', { class: 'theme-pick' })
    Promise.all((p.boards || []).map(b => api('GET', `/api/projects/${p.id}/boards/${b.id}`, undefined, { quiet: true }).catch(() => null))).then(bs => {
      const cands = []
      for (const b of bs.filter(Boolean)) for (const c of b.cards) if (c.brand) for (const v of (c.variants || []).filter(v => !v.hidden)) cands.push({ kind: c.brand, file: v.file, chosen: c.chosen === v.file })
      if (!cands.length) return
      picker.append(h('div', { class: 'more' }, 'Сгенерировано на доске: клик — поставить'))
      picker.append(h('div', { class: 'theme-pick-row' }, ...cands.sort((a, b) => b.chosen - a.chosen).map(x =>
        h('button', { class: 'theme-pick-item' + (t[x.kind] === x.file ? ' on' : ''), title: x.kind === 'logo' ? 'Сделать логотипом' : 'Сделать обложкой', style: { backgroundImage: `url("${fileUrl(x.file)}")` },
          onclick: () => { t[x.kind] = x.file; save().then(render) } }, h('span', {}, x.kind === 'logo' ? 'лого' : 'обложка')))))
    })
    const tag = h('input', { class: 'theme-tag', value: t.tagline || '', placeholder: 'Подпись под обложкой, например «Мира, оперативник роя»' })
    tag.addEventListener('input', () => { t.tagline = tag.value; saveSoon() })
    page.append(h('h2', {}, 'Логотип и обложка'), h('div', { class: 'theme-row' },
      imgSlot('logo', 'Логотип', 'перетащи картинку: показывается в шапке рядом с названием'),
      imgSlot('cover', 'Обложка', 'перетащи арт: встаёт сверху в боковой панели проекта')), picker, tag)
    page.append(h('div', { class: 'row', style: { marginTop: '24px' } },
      h('button', { class: 'btn', onclick: async () => { try { await api('POST', `/api/projects/${p.id}/chat`, { text: 'Подбери оформление Studio Board для этого проекта под его тематику и настроение (посмотри документы проекта и арт). Поставь через PATCH /api/projects/' + p.id + ' поле theme: {preset:"custom", fontDisplay, fontBody (только шрифты Google с кириллицей), colors:{bg,bg2,panel,panel2,line,line2,fg,muted,dim,accent,accent2} (#hex, тёмная тема, хороший контраст текста), texture:true|false, tagline, cover:"<путь к подходящему арту внутри Projects>"}. Коротко объясни выбор.' }); toast('Попросила Claude подобрать стиль: ответ будет в чате') } catch {} } }, '✦ Claude, подбери стиль'),
      h('button', { class: 'btn ghost', onclick: () => { t = { ...JSON.parse(JSON.stringify(DEFAULT)), preset: 'studio' }; delete t.name; save().then(render) } }, 'Вернуть стандартный')))
  }
  render(); main.append(page)
}
