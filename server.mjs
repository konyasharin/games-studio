// Studio Board: local server for game projects, character boards and the generation queue.
// node server.mjs  ->  http://127.0.0.1:4777
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import os from 'node:os'

const APP = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(APP, '..') // the Projects folder
const DATA = path.join(APP, 'data')
const JOBS = path.join(DATA, 'jobs')
const PORT = Number(process.env.STUDIO_PORT || 4777)
const PUBLIC = path.join(APP, 'public')
const CLAUDE = process.platform === 'win32' ? 'claude.exe' : 'claude'
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`])
const SELF_ORIGINS = new Set([...HOSTS].map(h => 'http://' + h))
// pages the worker Claude posts results from (Flow)
const WORKER_ORIGINS = new Set(['https://flow.google.com', 'https://labs.google'])
fs.mkdirSync(JOBS, { recursive: true })

const id = () => crypto.randomBytes(5).toString('hex')
const now = () => new Date().toISOString()
const sleep = ms => new Promise(r => setTimeout(r, ms))
const inside = (base, f) => { const rel = path.relative(base, f); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)) }
const toRel = f => path.relative(ROOT, f).split(path.sep).join('/')
function httpError(code, msg) { const e = new Error(msg); e.status = code; return e }

const readJSON = async (f, d) => { try { return JSON.parse(await fsp.readFile(f, 'utf8')) } catch { return d } }
// tmp + rename; on Windows a reader (Syncthing, antivirus) can hold the target for a moment, so retry
async function writeAtomic(f, data) {
  await fsp.mkdir(path.dirname(f), { recursive: true })
  const tmp = f + '.' + id() + '.tmp'
  await fsp.writeFile(tmp, data)
  for (let i = 0; ; i++) {
    try { await fsp.rename(tmp, f); return } catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code) || i >= 20) { await fsp.rm(tmp, { force: true }).catch(() => {}); throw e }
      await sleep(50 + i * 25)
    }
  }
}
const writeJSON = (f, v) => writeAtomic(f, JSON.stringify(v, null, 1))

// one writer per file: every mutation goes through this lock
const locks = new Map()
async function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve()
  let release
  const gate = new Promise(r => (release = r))
  const tail = prev.then(() => gate)
  locks.set(key, tail)
  await prev
  try { return await fn() } finally { release(); if (locks.get(key) === tail) locks.delete(key) }
}

const registryFile = path.join(DATA, 'projects.json')
// one Claude session per project, continued with --resume; a session made on another machine is not reused
const sessionsFile = path.join(DATA, 'sessions.json')
async function sessionFor(pid, { fresh = false } = {}) {
  return withLock(sessionsFile, async () => {
    const all = await readJSON(sessionsFile, {})
    let sess = all[pid]
    if (fresh || !sess || sess.machine !== os.hostname()) {
      sess = { id: crypto.randomUUID(), machine: os.hostname(), created: now(), started: false, jobs: 0 }
      all[pid] = sess; await writeJSON(sessionsFile, all)
    }
    return { ...sess }
  })
}
async function sessionUsed(pid, sid) {
  await withLock(sessionsFile, async () => {
    const all = await readJSON(sessionsFile, {})
    if (all[pid]?.id === sid) { all[pid].started = true; all[pid].jobs = (all[pid].jobs || 0) + 1; all[pid].last = now(); await writeJSON(sessionsFile, all) }
  })
}
const settingsFile = path.join(DATA, 'settings.json')
const DEFAULT_SETTINGS = { flowUrl: 'https://flow.google.com/', imageModel: 'Nano Banana Pro', worker: true }
const settings = async () => ({ ...DEFAULT_SETTINGS, ...(await readJSON(settingsFile, {})) })

const DEFAULT_SECTIONS = [
  { id: 'story', title: 'Сюжет', kind: 'notes' },
  { id: '3d', title: '3D', kind: 'boards' },
  { id: 'art', title: 'Арт', kind: 'notes' },
  { id: 'audio', title: 'Аудио', kind: 'notes' },
  { id: 'design', title: 'Геймдизайн', kind: 'notes' },
]

const safeName = s => String(s || 'file').replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^\.+/, '_').slice(0, 120)
const safeId = s => { if (!/^[\w-]{1,40}$/.test(s)) throw httpError(400, 'bad id'); return s }
function projDir(p) {
  const d = path.join(ROOT, p.dir, 'studio')
  if (!inside(ROOT, d) || /^\.*$/.test(p.dir)) throw httpError(400, 'bad project folder')
  return d
}
async function project(pid) {
  const reg = await readJSON(registryFile, [])
  const p = reg.find(x => x.id === pid)
  if (!p) throw httpError(404, 'нет проекта')
  return p
}
const boardFile = (p, bid) => path.join(projDir(p), 'boards', safeId(bid) + '.json')
const assetDir = (p, bid, cid) => path.join(projDir(p), 'assets', safeId(bid), safeId(cid))

async function readBody(req, limit = 1024 * 1024 * 1024) {
  const chunks = []; let n = 0
  for await (const c of req) { n += c.length; if (n > limit) throw httpError(413, 'файл слишком большой'); chunks.push(c) }
  return Buffer.concat(chunks)
}
async function json(req) {
  const b = await readBody(req, 20 * 1024 * 1024)
  if (!b.length) return {}
  try { return JSON.parse(b.toString('utf8')) } catch { throw httpError(400, 'bad json') }
}

function send(res, code, body, extra = {}) {
  if (res.headersSent) return res.end()
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra })
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.fbx': 'application/octet-stream', '.obj': 'text/plain',
  '.mtl': 'text/plain', '.json': 'application/json', '.mp4': 'video/mp4', '.md': 'text/markdown; charset=utf-8', '.bin': 'application/octet-stream' }

async function serveFile(res, file) {
  let st
  try { st = await fsp.stat(file); if (!st.isFile()) throw 0 } catch { return send(res, 404, { error: 'not found' }) }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size,
    'Last-Modified': st.mtime.toUTCString(), 'Cache-Control': inside(PUBLIC, file) ? 'no-store' : 'no-cache' })
  const s = fs.createReadStream(file)
  s.on('error', () => res.destroy())
  s.pipe(res)
}

// ---------- boards ----------
function characterTemplate(board) {
  board.cards.push(
    { id: id(), type: 'ref', title: 'Главный референс', x: 80, y: 120, w: 380, prompt: '', count: 4, frozen: false, variants: [], chosen: null, views: 4 },
    { id: id(), type: 'final', title: 'Итоговая модель', x: 1900, y: 160, w: 380, files: [] })
  return board
}

async function mutateBoard(p, bid, fn) {
  const f = boardFile(p, bid)
  return withLock(f, async () => {
    const b = await readJSON(f, null)
    if (!b) throw httpError(404, 'нет доски')
    const out = await fn(b)
    b.version = (b.version || 0) + 1
    b.updated = now()
    await writeJSON(f, b)
    return out === undefined ? b : out
  })
}
const findCard = (b, cid) => { const c = b.cards.find(x => x.id === cid); if (!c) throw httpError(404, 'нет карточки'); return c }

// ---------- jobs: kept in memory, written through to data/jobs ----------
const jobs = new Map()
for (const f of fs.readdirSync(JOBS).filter(f => f.endsWith('.json'))) {
  try { const j = JSON.parse(fs.readFileSync(path.join(JOBS, f), 'utf8')); jobs.set(j.id, j) } catch {}
}
const sortedJobs = () => [...jobs.values()].sort((a, b) => a.created.localeCompare(b.created))
const jobFile = jid => path.join(JOBS, safeId(jid) + '.json')
const getJob = jid => { const j = jobs.get(jid); if (!j) throw httpError(404, 'нет задачи'); return j }
const saveJob = j => withLock(jobFile(j.id), () => writeJSON(jobFile(j.id), j))
async function mutateJob(jid, fn) {
  const j = getJob(jid)
  fn(j); j.updated = now()
  await saveJob(j)
  return j
}
const publicJob = j => { const { token, pid, ...rest } = j; return rest }
const active = j => ['queued', 'running'].includes(j.status)

function toolBrief(name, input = {}) {
  const v = input.file_path || input.path || input.command || input.pattern || input.url || input.query || input.description || input.prompt || ''
  return String(v).replace(/\s+/g, ' ').slice(0, 160)
}

function killTree(pid) {
  if (!pid) return
  try { process.platform === 'win32' ? execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {}) : process.kill(pid) } catch {}
}

// at startup: a job left "running" by a crashed server gets its Claude killed and goes back to the queue once
for (const j of sortedJobs().filter(j => j.status === 'running')) {
  killTree(j.pid)
  j.status = (j.retries || 0) < 1 ? 'queued' : 'error'
  j.retries = (j.retries || 0) + 1
  j.log.push(now() + ' прервано перезапуском сервера')
  saveJob(j).catch(() => {})
}

// ---------- worker: one headless Claude at a time ----------
let running = null, child_ = null, ticking = false
async function workerTick() {
  if (ticking || running) return
  ticking = true
  try {
    const s = await settings()
    if (!s.worker) return
    const next = sortedJobs().find(j => j.status === 'queued')
    if (next) await runJob(next, s)
  } catch (e) { console.error(now(), 'worker', e) } finally { ticking = false }
}

async function runJob(job, s) {
  try {
    const p = await project(job.project)
    const board = job.board ? await readJSON(boardFile(p, job.board), null) : null
    const card = board?.cards.find(c => c.id === job.card) || null
    if (!['request', 'chat'].includes(job.kind) && !card) throw new Error('карточка удалена')
    if (job.kind === 'request' && job.board && !board) throw new Error('доска удалена')
    const template = await fsp.readFile(path.join(APP, 'worker-prompt.md'), 'utf8')
    job.token = crypto.randomBytes(16).toString('hex')
    const ctx = {
      api: `http://127.0.0.1:${PORT}`, token: job.token, job: publicJob(job), card, flowUrl: s.flowUrl, imageModel: s.imageModel,
      projectId: p.id, projectRoot: path.join(ROOT, p.dir), boardContext: board?.context || '',
      where: job.where || null, thread: job.thread || null,
      inputs: (job.inputs || []).map(f => path.join(ROOT, f)).filter(f => inside(ROOT, f)),
    }
    const prompt = job.kind === 'chat'
      ? `[Studio Board, чат проекта «${p.name || p.dir}» (${path.join(ROOT, p.dir)}). Это та же сессия, в которой ты выполняешь задачи с досок проекта. API доски: http://127.0.0.1:${PORT}/api (проект ${p.id}). Отвечай по-русски, коротко и по делу.]\n\n${job.text}`
      : template.replace('{{JOB}}', JSON.stringify(ctx, null, 2))
    const out = fs.createWriteStream(path.join(JOBS, job.id + '.log'), { flags: 'a' })
    out.on('error', () => {})
    const sess = await sessionFor(p.id)
    const args = ['-p', '--chrome', '--permission-mode', 'auto', '--add-dir', ROOT, '--add-dir', APP, '--output-format', 'stream-json', '--verbose',
      ...(sess.started ? ['--resume', sess.id] : ['--session-id', sess.id])]
    out.write(`\n===== ${now()} session ${sess.id} (${sess.started ? 'resume' : 'new'}) =====\n`)
    const child = spawn(CLAUDE, args, { cwd: path.join(ROOT, p.dir), windowsHide: true })
    running = job.id; child_ = child
    let finished = false
    const finish = async (status, line) => {
      if (finished) return
      finished = true; clearTimeout(timer); out.end()
      try { await mutateJob(job.id, j => { if (j.status === 'running') { j.status = status; j.log.push(now() + ' ' + line); if (j.kind === 'request') j.thread = [...(j.thread || []), { who: 'claude', text: status === 'done' ? 'Готово (без отчёта).' : 'Не получилось: ' + line, at: now() }] } }) } catch {}
      running = null; child_ = null
      setTimeout(workerTick, 500)
    }
    const timer = setTimeout(() => killTree(child.pid), 45 * 60 * 1000)
    child.on('error', e => finish('error', 'не удалось запустить Claude: ' + e.message))
    let tail = '', buf = '', result = null
    const keep = d => { tail = (tail + d.toString()).slice(-4000) }
    child.stderr.on('data', keep)
    job.events = job.kind === 'chat' ? [] : (job.events || [])
    child.stdout.on('data', d => {
      keep(d); buf += d.toString()
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        let e; try { e = JSON.parse(line) } catch { continue }
        if (e.type === 'assistant') {
          for (const c of e.message?.content || []) {
            if (c.type === 'text' && c.text?.trim()) job.events.push({ t: 'text', text: c.text.slice(0, 8000), at: now() })
            else if (c.type === 'tool_use') job.events.push({ t: 'tool', name: c.name, brief: toolBrief(c.name, c.input), at: now() })
          }
        } else if (e.type === 'result') result = e
        if (job.events.length > 300) job.events.splice(0, job.events.length - 300)
        job.updated = now()
      }
    })
    child.on('close', async code => {
      // the session is gone (deleted, or this machine never had it): start a fresh one and run the job again
      if (code !== 0 && sess.started && /No conversation found/i.test(tail)) {
        await sessionFor(p.id, { fresh: true })
        if (!finished) {
          finished = true; clearTimeout(timer); out.end()
          try { await mutateJob(job.id, j => { if (j.status === 'running') { j.status = 'queued'; j.log.push(now() + ' сессия Claude не найдена, начинаю новую') } }) } catch {}
          running = null; child_ = null; setTimeout(workerTick, 300)
        }
        return
      }
      await sessionUsed(p.id, sess.id).catch(() => {})
      if (job.kind === 'chat') {
        const ok = code === 0 && result && !result.is_error
        try { await mutateJob(job.id, j => { j.answer = String(result?.result || '').slice(0, 20000); j.cost = result?.total_cost_usd }) } catch {}
        return finish(ok ? 'done' : 'error', ok ? 'ответ готов' : 'Claude завершился, код ' + code)
      }
      finish(code === 0 ? 'done' : 'error', 'Claude завершился, код ' + code)
    })
    child.stdin.on('error', () => {})
    child.stdout.pipe(out); child.stderr.pipe(out)
    child.stdin.end(prompt)
    await mutateJob(job.id, j => { j.status = 'running'; j.started = now(); j.pid = child.pid; j.log.push(now() + ' запущен Claude') })
  } catch (e) {
    running = null; child_ = null
    await mutateJob(job.id, j => { j.status = 'error'; j.log.push(now() + ' ' + e.message) }).catch(() => {})
  }
}
setInterval(workerTick, 4000)

// ---------- routes ----------
const routes = []
const route = (method, pattern, fn, opts = {}) =>
  routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn, ...opts })

route('GET', '/api/settings', async () => settings())
route('POST', '/api/projects/:pid/chat', async (req, m) => {
  const p = await project(m.pid); const { text } = await json(req)
  if (!String(text || '').trim()) throw httpError(400, 'пусто')
  const j = { id: id(), kind: 'chat', project: p.id, projectDir: p.dir, board: null, card: null, cardTitle: String(text).trim().slice(0, 60),
    status: 'queued', created: now(), log: [], text: String(text).trim().slice(0, 20000), events: [] }
  jobs.set(j.id, j); await saveJob(j)
  setTimeout(workerTick, 50)
  return publicJob(j)
})
// the project's whole conversation: chat messages and the tasks done in the same session
route('GET', '/api/projects/:pid/chat', async (req, m, url) => {
  const since = url.searchParams.get('since') || ''
  return sortedJobs().filter(j => j.project === m.pid && (!since || (j.updated || j.created) > since)).slice(-150).map(j => {
    const { token, pid, log, ...rest } = j
    return { ...rest, log: (log || []).slice(-3) }
  })
})
route('GET', '/api/projects/:pid/session', async (req, m) => {
  await project(m.pid)
  const sess = (await readJSON(sessionsFile, {}))[m.pid]
  return sess && sess.machine === os.hostname() ? { ...sess, cwd: path.join(ROOT, (await project(m.pid)).dir) } : null
})
route('POST', '/api/projects/:pid/session/reset', async (req, m) => {
  await project(m.pid)
  if ([...jobs.values()].some(j => j.project === m.pid && j.status === 'running')) throw httpError(409, 'сейчас идёт задача, дождись её')
  return sessionFor(m.pid, { fresh: true })
})
route('PUT', '/api/settings', async req => {
  const body = await json(req), s = await settings()
  if (typeof body.flowUrl === 'string' && /^https:\/\//.test(body.flowUrl)) s.flowUrl = body.flowUrl
  if (typeof body.imageModel === 'string') s.imageModel = body.imageModel.slice(0, 80)
  if (typeof body.worker === 'boolean') s.worker = body.worker
  await writeJSON(settingsFile, s); return s
})

route('GET', '/api/projects', async () => {
  const reg = await readJSON(registryFile, [])
  return Promise.all(reg.map(async p => ({ ...p, ...(await readJSON(path.join(projDir(p), 'project.json'), {})) })))
})
route('POST', '/api/projects', async req => {
  const { name, dir } = await json(req)
  if (!name || typeof name !== 'string') throw httpError(400, 'нужно название')
  const d = safeName(dir || name.toLowerCase().replace(/\s+/g, '-'))
  if (/^[._]*$/.test(d) || d === 'studio-board') throw httpError(400, 'неподходящая папка')
  return withLock(registryFile, async () => {
    const reg = await readJSON(registryFile, [])
    if (reg.some(p => p.dir === d)) throw httpError(409, 'эта папка уже в списке')
    const p = { id: id(), dir: d }
    const pf = path.join(projDir(p), 'project.json')
    if (!(await readJSON(pf, null))) await writeJSON(pf, { name, created: now(), sections: DEFAULT_SECTIONS, boards: [] })
    reg.push(p); await writeJSON(registryFile, reg)
    return p
  })
})
route('GET', '/api/projects/:pid', async (req, m) => {
  const p = await project(m.pid)
  return { ...p, ...(await readJSON(path.join(projDir(p), 'project.json'), {})) }
})
route('PATCH', '/api/projects/:pid', async (req, m) => {
  const p = await project(m.pid); const f = path.join(projDir(p), 'project.json'); const patch = await json(req)
  return withLock(f, async () => {
    const d = await readJSON(f, {})
    if (typeof patch.name === 'string') d.name = patch.name
    if (Array.isArray(patch.sections)) d.sections = patch.sections.filter(s => s && /^[\w-]{1,40}$/.test(s.id)).map(s => ({ id: s.id, title: String(s.title || s.id), kind: s.kind === 'boards' ? 'boards' : 'notes' }))
    await writeJSON(f, d); return d
  })
})
const notesFile = (p, sid) => path.join(projDir(p), 'notes', safeId(sid) + '.html')
const mtimeOf = async f => (await fsp.stat(f).catch(() => null))?.mtimeMs || 0
route('GET', '/api/projects/:pid/notes/:sid', async (req, m, url) => {
  const p = await project(m.pid); const f = notesFile(p, m.sid); const mtime = await mtimeOf(f)
  if (url.searchParams.get('since') && Number(url.searchParams.get('since')) === mtime) return { mtime, same: true }
  return { html: await fsp.readFile(f, 'utf8').catch(() => ''), mtime }
})
route('PUT', '/api/projects/:pid/notes/:sid', async (req, m) => {
  const p = await project(m.pid); const { html } = await json(req); const f = notesFile(p, m.sid)
  await withLock(f, () => writeAtomic(f, String(html || '')))
  return { ok: true, mtime: await mtimeOf(f) }
})

// "point and tell Claude": a request anchored to a place in the project ({where}), with a thread of messages
route('POST', '/api/projects/:pid/requests', async (req, m) => {
  const p = await project(m.pid); const { text, where = {} } = await json(req)
  if (!String(text || '').trim()) throw httpError(400, 'пустой запрос')
  const w = JSON.parse(JSON.stringify(where).slice(0, 20000))
  const j = { id: id(), kind: 'request', project: p.id, projectDir: p.dir, board: w.board || null, card: w.card || null,
    cardTitle: String(text).trim().slice(0, 60), status: 'queued', created: now(), log: [], where: w,
    thread: [{ who: 'user', text: String(text).trim(), at: now() }] }
  if (j.board) safeId(j.board)
  jobs.set(j.id, j); await saveJob(j)
  setTimeout(workerTick, 50)
  return publicJob(j)
})
route('GET', '/api/projects/:pid/requests', async (req, m, url) => {
  const sec = url.searchParams.get('section'), board = url.searchParams.get('board')
  return sortedJobs().filter(j => j.kind === 'request' && j.project === m.pid && !j.archived &&
    (!sec || j.where?.section === sec) && (!board || j.board === board)).map(publicJob)
})
route('POST', '/api/jobs/:jid/reply', async (req, m) => {
  const { text } = await json(req)
  if (!String(text || '').trim()) throw httpError(400, 'пусто')
  const j = await mutateJob(m.jid, j => {
    if (j.kind !== 'request') throw httpError(400, 'не запрос')
    j.thread = [...(j.thread || []), { who: 'user', text: String(text).trim(), at: now() }]
    if (!active(j)) { j.status = 'queued'; j.log.push(now() + ' уточнение от автора') }
  })
  setTimeout(workerTick, 50)
  return publicJob(j)
})
route('POST', '/api/jobs/:jid/archive', async (req, m) => publicJob(await mutateJob(m.jid, j => { if (!active(j)) j.archived = true })))
route('POST', '/api/projects/:pid/boards', async (req, m) => {
  const p = await project(m.pid); const { name, kind = 'character', section = '3d' } = await json(req)
  const b = { id: id(), name: String(name || 'Без названия'), kind, version: 0, cards: [], links: [], context: '' }
  if (kind === 'character') characterTemplate(b)
  await writeJSON(boardFile(p, b.id), b)
  const f = path.join(projDir(p), 'project.json')
  await withLock(f, async () => { const d = await readJSON(f, {}); d.boards = [...(d.boards || []), { id: b.id, name: b.name, kind, section: safeId(section), created: now() }]; await writeJSON(f, d) })
  return b
})
route('DELETE', '/api/projects/:pid/boards/:bid', async (req, m) => {
  const p = await project(m.pid); const f = path.join(projDir(p), 'project.json')
  await withLock(f, async () => { const d = await readJSON(f, {}); d.boards = (d.boards || []).filter(b => b.id !== m.bid); await writeJSON(f, d) })
  return { ok: true } // the board file and its assets stay on disk
})

route('GET', '/api/projects/:pid/boards/:bid', async (req, m) => {
  const p = await project(m.pid)
  const b = await readJSON(boardFile(p, m.bid), null)
  if (!b) throw httpError(404, 'нет доски')
  const js = sortedJobs().filter(j => j.board === m.bid && j.project === p.id)
  return { ...b, jobs: js.slice(-60).map(({ id, kind, card, status, created, updated, log, progress }) => ({ id, kind, card, status, created, updated, progress, log: log.slice(-4) })) }
})
route('PATCH', '/api/projects/:pid/boards/:bid', async (req, m) => {
  const p = await project(m.pid); const patch = await json(req)
  const out = await mutateBoard(p, m.bid, b => { for (const k of ['name', 'context', 'view']) if (k in patch) b[k] = patch[k] })
  if (typeof patch.name === 'string') {
    const f = path.join(projDir(p), 'project.json')
    await withLock(f, async () => { const d = await readJSON(f, {}); for (const x of d.boards || []) if (x.id === m.bid) x.name = patch.name; await writeJSON(f, d) })
  }
  return { version: out.version }
})
route('POST', '/api/projects/:pid/boards/:bid/cards', async (req, m) => {
  const p = await project(m.pid); const c = await json(req)
  return mutateBoard(p, m.bid, b => {
    const { linkFrom, id: _, ...rest } = c
    const card = { x: 100, y: 100, w: 360, ...rest, id: id() }
    b.cards.push(card)
    if (linkFrom && b.cards.some(x => x.id === linkFrom)) b.links.push({ id: id(), from: linkFrom, to: card.id })
    return card
  })
})
// scalar fields only; lists (variants, parts, files) change through their own operations below
const LIST_FIELDS = new Set(['variants', 'parts', 'mesh', 'textured', 'files', 'thumbs'])
route('PATCH', '/api/projects/:pid/boards/:bid/cards/:cid', async (req, m) => {
  const p = await project(m.pid); const patch = await json(req)
  return mutateBoard(p, m.bid, b => { const c = findCard(b, m.cid); for (const [k, v] of Object.entries(patch)) if (k !== 'id' && !LIST_FIELDS.has(k)) c[k] = v; return c })
})
route('DELETE', '/api/projects/:pid/boards/:bid/cards/:cid', async (req, m) => {
  const p = await project(m.pid)
  for (const j of sortedJobs().filter(j => j.card === m.cid && active(j))) await cancelJob(j.id)
  return mutateBoard(p, m.bid, b => { b.cards = b.cards.filter(c => c.id !== m.cid); b.links = b.links.filter(l => l.from !== m.cid && l.to !== m.cid) })
})
// one variant: hide/show
route('POST', '/api/projects/:pid/boards/:bid/cards/:cid/variant', async (req, m) => {
  const p = await project(m.pid); const { file, hidden } = await json(req)
  return mutateBoard(p, m.bid, b => {
    const c = findCard(b, m.cid)
    for (const v of c.variants || []) if (v.file === file) v.hidden = !!hidden
    if (hidden && c.chosen === file) c.chosen = null
    return c
  })
})
// split parts, one at a time: {op: 'add'} | {op: 'update', pid, fields} | {op: 'remove', pid}
route('POST', '/api/projects/:pid/boards/:bid/cards/:cid/parts', async (req, m) => {
  const p = await project(m.pid); const op = await json(req)
  return mutateBoard(p, m.bid, b => {
    const c = findCard(b, m.cid)
    c.parts = (c.parts || []).map(x => x.pid ? x : { ...x, pid: id() })
    if (op.op === 'add') c.parts.push({ pid: id(), name: '', includes: '', route: '', prompt: '' })
    else if (op.op === 'update') { const x = c.parts.find(x => x.pid === op.pid); if (x) for (const k of ['name', 'includes', 'route', 'prompt']) if (typeof op.fields?.[k] === 'string') x[k] = op.fields[k] }
    else if (op.op === 'remove') c.parts = c.parts.filter(x => x.pid !== op.pid || x.card)
    return c
  })
})
// confirm a split: part card + model card per new part, linked ref -> part -> model -> final, in one write
route('POST', '/api/projects/:pid/boards/:bid/cards/:cid/confirm-split', async (req, m) => {
  const p = await project(m.pid)
  return mutateBoard(p, m.bid, b => {
    const c = findCard(b, m.cid)
    const todo = (c.parts || []).filter(x => !x.card && String(x.name || '').trim())
    if (!todo.length) throw httpError(409, 'нет новых частей')
    const fin = b.cards.find(x => x.type === 'final')
    let y = c.y - (todo.length - 1) * 350
    for (const part of todo) {
      const pc = { id: id(), type: 'part', title: part.name.trim(), x: c.x + 500, y, w: 380, prompt: part.prompt || '', count: 4, views: 4, variants: [], chosen: null, frozen: false, note: part.includes || '', route: part.route || '' }
      const mc = { id: id(), type: 'model', title: part.name.trim() + ': модель', x: c.x + 960, y, w: 340, mesh: [], textured: [], route: part.route || '' }
      b.cards.push(pc, mc)
      b.links.push({ id: id(), from: c.id, to: pc.id }, { id: id(), from: pc.id, to: mc.id })
      if (fin) b.links.push({ id: id(), from: mc.id, to: fin.id })
      part.pid = part.pid || id(); part.card = pc.id
      y += 700
    }
    c.confirmed = true
    return { created: todo.length }
  })
})
// many card positions in one write (auto layout): {positions: {cardId: [x, y]}}
route('POST', '/api/projects/:pid/boards/:bid/layout', async (req, m) => {
  const p = await project(m.pid); const { positions } = await json(req)
  if (!positions || typeof positions !== 'object') throw httpError(400, 'positions')
  return mutateBoard(p, m.bid, b => {
    for (const c of b.cards) {
      const v = positions[c.id]
      if (Array.isArray(v) && Number.isFinite(v[0]) && Number.isFinite(v[1])) { c.x = Math.round(v[0]); c.y = Math.round(v[1]) }
    }
    return { version: b.version + 1 }
  })
})
route('POST', '/api/projects/:pid/boards/:bid/links', async (req, m) => {
  const p = await project(m.pid); const { from, to } = await json(req)
  return mutateBoard(p, m.bid, b => {
    if (from !== to && b.cards.some(c => c.id === from) && b.cards.some(c => c.id === to) && !b.links.some(l => l.from === from && l.to === to)) b.links.push({ id: id(), from, to })
  })
})
route('DELETE', '/api/projects/:pid/boards/:bid/links/:lid', async (req, m) => {
  const p = await project(m.pid)
  return mutateBoard(p, m.bid, b => { b.links = b.links.filter(l => l.id !== m.lid) })
})

// file into a card: raw body, ?name=...&slot=variants|files|mesh|textured|thumb
route('POST', '/api/projects/:pid/boards/:bid/cards/:cid/files', async (req, m, url) => {
  const p = await project(m.pid)
  const slot = url.searchParams.get('slot') || 'files'
  if (!['variants', 'files', 'mesh', 'textured', 'thumb'].includes(slot)) throw httpError(400, 'bad slot')
  const board = await readJSON(boardFile(p, m.bid), null)
  if (!board) throw httpError(404, 'нет доски')
  findCard(board, m.cid)
  const name = safeName(url.searchParams.get('name') || 'file.bin')
  const buf = await readBody(req)
  const dir = assetDir(p, m.bid, m.cid); await fsp.mkdir(dir, { recursive: true })
  const file = path.join(dir, Date.now().toString(36) + '-' + name)
  await fsp.writeFile(file, buf)
  let entry = toRel(file)
  if (/\.zip$/i.test(name)) entry = (await unzipModel(file)) || entry
  return mutateBoard(p, m.bid, b => {
    const c = findCard(b, m.cid)
    const item = { file: entry, name, at: now(), size: buf.length }
    if (slot === 'thumb') c.thumb = entry
    else c[slot] = [...(c[slot] || []), item]
    return item
  })
})

// a file already inside the Projects folder, attached without copying: {slot, file: 'game/art/x.glb', name?}
route('POST', '/api/projects/:pid/boards/:bid/cards/:cid/attach', async (req, m) => {
  const p = await project(m.pid); const { slot = 'files', file, name } = await json(req)
  if (!['variants', 'files', 'mesh', 'textured'].includes(slot)) throw httpError(400, 'bad slot')
  const abs = path.resolve(ROOT, String(file || ''))
  if (!inside(ROOT, abs)) throw httpError(403, 'outside')
  const st = await fsp.stat(abs).catch(() => null)
  if (!st?.isFile()) throw httpError(404, 'нет файла ' + file)
  const rel = toRel(abs)
  return mutateBoard(p, m.bid, b => {
    const c = findCard(b, m.cid)
    if ((c[slot] || []).some(x => x.file === rel)) return c
    c[slot] = [...(c[slot] || []), { file: rel, name: name || path.basename(abs), at: now(), size: st.size }]
    return c
  })
})

// a zip from Tripo/Modddif: extract next to it, point the card at the first model file inside
function unzipModel(zip) {
  const out = zip.replace(/\.zip$/i, '')
  return new Promise(resolve => {
    try { fs.mkdirSync(out, { recursive: true }) } catch { return resolve(null) }
    execFile('tar', ['-xf', zip, '-C', out], async err => {
      try {
        if (err) return resolve(null)
        const all = []
        const rec = async d => { for (const e of await fsp.readdir(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (!inside(out, f)) continue; e.isDirectory() ? await rec(f) : all.push(f) } }
        await rec(out)
        const model = all.find(f => /\.(glb|gltf|fbx|obj)$/i.test(f))
        resolve(model ? toRel(model) : null)
      } catch { resolve(null) }
    })
  })
}

// generation request from a card; check and enqueue happen without an await in between, so double clicks make one job
route('POST', '/api/projects/:pid/boards/:bid/cards/:cid/generate', async (req, m) => {
  const p = await project(m.pid); const opts = await json(req)
  const b = await readJSON(boardFile(p, m.bid), null)
  if (!b) throw httpError(404, 'нет доски')
  const c = findCard(b, m.cid)
  if (c.frozen) throw httpError(409, 'карточка заморожена')
  // inputs: walk up the links to the nearest cards with a chosen picture (a split card has none, its parent has)
  const inputs = [], seen = new Set()
  const up = cid => {
    for (const l of b.links.filter(l => l.to === cid)) {
      const x = b.cards.find(k => k.id === l.from)
      if (!x || seen.has(x.id)) continue
      seen.add(x.id)
      if (x.chosen) inputs.push(x.chosen, ...(x.extraInputs || []))
      else up(x.id)
    }
  }
  up(c.id)
  inputs.push(...(c.inputs || []))
  if ([...jobs.values()].some(j => j.card === c.id && active(j))) throw httpError(409, 'уже в очереди')
  const kind = ['images', 'split', 'note'].includes(opts.kind) ? opts.kind : c.type === 'split' ? 'split' : 'images'
  const j = { id: id(), kind, project: p.id, projectDir: p.dir, board: m.bid, card: c.id, cardTitle: c.title, status: 'queued', created: now(), log: [],
    prompt: typeof opts.prompt === 'string' ? opts.prompt : c.prompt || '', count: Math.max(1, Math.min(8, Number(opts.count ?? c.count ?? 4) || 4)), inputs, views: c.views }
  jobs.set(j.id, j)
  await saveJob(j)
  setTimeout(workerTick, 50)
  return publicJob(j)
})

async function cancelJob(jid) {
  const j = await mutateJob(jid, j => { if (active(j)) { j.status = 'cancelled'; j.log.push(now() + ' отменено') } })
  if (running === jid && child_) killTree(child_.pid)
  return j
}
route('GET', '/api/jobs', async () => sortedJobs().reverse().slice(0, 100).map(publicJob))
route('GET', '/api/jobs/:jid', async (req, m) => publicJob(getJob(m.jid)))
route('GET', '/api/jobs/:jid/log', async (req, m) => ({ text: (await fsp.readFile(path.join(JOBS, safeId(m.jid) + '.log'), 'utf8').catch(() => '')).slice(-20000) }))
route('POST', '/api/jobs/:jid/cancel', async (req, m) => publicJob(await cancelJob(m.jid)))
route('POST', '/api/jobs/:jid/retry', async (req, m) => publicJob(await mutateJob(m.jid, j => { if (!active(j)) { j.status = 'queued'; j.log.push(now() + ' повтор') } })))

// ---- worker callbacks: need the job token; may come from the Flow page (CORS) ----
const workerJob = (req, m, url) => {
  const j = getJob(m.jid)
  const t = req.headers['x-job-token'] || url.searchParams.get('token')
  if (!j.token || t !== j.token) throw httpError(403, 'bad token')
  if (j.status !== 'running') throw httpError(409, 'задача уже не выполняется')
  return j
}
route('POST', '/api/jobs/:jid/log', async (req, m, url) => {
  const j = workerJob(req, m, url); const { text, progress } = await json(req)
  return publicJob(await mutateJob(j.id, j => { if (text) j.log.push(now() + ' ' + String(text).slice(0, 500)); if (progress) j.progress = String(progress).slice(0, 20) }))
}, { worker: true })
route('POST', '/api/jobs/:jid/image', async (req, m, url) => {
  const j = workerJob(req, m, url)
  const p = await project(j.project)
  const buf = await readBody(req, 60 * 1024 * 1024)
  if (buf.length < 100) throw httpError(400, 'пустая картинка')
  const ext = (url.searchParams.get('ext') || 'png').replace(/\W/g, '').slice(0, 5) || 'png'
  const dir = assetDir(p, j.board, j.card); await fsp.mkdir(dir, { recursive: true })
  const file = path.join(dir, `${j.id}-${Date.now().toString(36)}-${id()}.${ext}`)
  await fsp.writeFile(file, buf)
  const rel = toRel(file)
  const item = { file: rel, at: now(), job: j.id, prompt: (url.searchParams.get('prompt') || j.prompt || '').slice(0, 4000), view: url.searchParams.get('view') || '' }
  await mutateBoard(p, j.board, b => { const c = findCard(b, j.card); c.variants = [...(c.variants || []), item] })
  await mutateJob(j.id, x => { x.images = [...(x.images || []), rel] })
  return item
}, { worker: true })
// finish: status + optional card patch (split proposals, prompt used)
route('POST', '/api/jobs/:jid/complete', async (req, m, url) => {
  const j0 = workerJob(req, m, url); const body = await json(req)
  const j = await mutateJob(j0.id, x => {
    x.status = body.status === 'error' ? 'error' : 'done'; x.log.push(now() + ' ' + String(body.message || 'готово').slice(0, 500))
    if (x.kind === 'request') x.thread = [...(x.thread || []), { who: 'claude', text: String(body.message || 'Готово.').slice(0, 6000), at: now() }]
  })
  if (body.cardPatch && typeof body.cardPatch === 'object' && j.status === 'done') {
    const p = await project(j.project)
    await mutateBoard(p, j.board, b => {
      const c = findCard(b, j.card)
      for (const k of ['prompt', 'proposal', 'answer']) if (typeof body.cardPatch[k] === 'string') c[k] = body.cardPatch[k]
      if (Array.isArray(body.cardPatch.parts)) {
        const keep = (c.parts || []).filter(x => x.card)
        c.parts = keep.concat(body.cardPatch.parts.map(x => ({ pid: id(), name: String(x.name || ''), includes: String(x.includes || ''), route: String(x.route || ''), prompt: String(x.prompt || '') })))
      }
    })
  }
  return publicJob(j)
}, { worker: true })

// files of a project, served from the Projects folder
route('GET', '/files/(?<rest>.+)', async (req, m) => ({ __file: path.resolve(ROOT, decodeURIComponent(m.rest)) }))

function corsFor(req, r) {
  const o = req.headers.origin
  return r?.worker && o && WORKER_ORIGINS.has(o)
    ? { 'Access-Control-Allow-Origin': o, 'Access-Control-Allow-Headers': 'content-type, x-job-token', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Private-Network': 'true', Vary: 'Origin' }
    : {}
}

const server = http.createServer(async (req, res) => {
  res.on('error', () => {})
  let url
  try { url = new URL(req.url, 'http://x') } catch { return send(res, 400, { error: 'bad url' }) }
  // DNS rebinding: only our own host names
  if (!HOSTS.has(req.headers.host)) return send(res, 421, { error: 'bad host' })
  const match = method => { for (const r of routes) { if (r.method !== method) continue; const mm = url.pathname.match(r.re); if (mm) return [r, mm] } return [] }
  if (req.method === 'OPTIONS') {
    const [r] = match(req.headers['access-control-request-method'] || 'POST')
    return send(res, 204, '', corsFor(req, r))
  }
  const [r, mm] = match(req.method)
  // writes from other web pages are refused; only the worker routes accept the Flow page, with a token
  if (req.method !== 'GET') {
    const o = req.headers.origin
    if (o && !SELF_ORIGINS.has(o) && !(r?.worker && WORKER_ORIGINS.has(o))) return send(res, 403, { error: 'foreign origin' })
  }
  const cors = corsFor(req, r)
  try {
    if (r) {
      const out = await r.fn(req, mm.groups || {}, url)
      if (out && out.__file) {
        if (!inside(ROOT, out.__file)) return send(res, 403, { error: 'outside' })
        return serveFile(res, out.__file)
      }
      return send(res, 200, out ?? { ok: true }, cors)
    }
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      let f = path.resolve(PUBLIC, '.' + decodeURIComponent(url.pathname))
      if (!inside(PUBLIC, f)) return send(res, 403, { error: 'outside' })
      if (!path.extname(f)) f = path.join(PUBLIC, 'index.html')
      return serveFile(res, f)
    }
    send(res, 404, { error: 'no route' })
  } catch (e) {
    if (!e.status) console.error(now(), req.method, url.pathname, e)
    send(res, e.status || 500, { error: e.message }, cors)
  }
})
server.listen(PORT, '127.0.0.1', () => console.log(`Studio Board: http://127.0.0.1:${PORT}  (projects in ${ROOT})`))

// never die on a stray error: log it and keep serving
process.on('uncaughtException', e => console.error(now(), 'uncaught', e))
process.on('unhandledRejection', e => console.error(now(), 'unhandled', e))
server.on('error', e => { console.error(now(), 'server', e.message); if (e.code === 'EADDRINUSE') process.exit(3) })
