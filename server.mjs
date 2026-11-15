// Studio Board: local server for game projects, character boards and the generation queue.
// node server.mjs  ->  http://127.0.0.1:4777
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'

const APP = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(APP, '..') // the Projects folder
const DATA = path.join(APP, 'data')
const JOBS = path.join(DATA, 'jobs')
const PORT = Number(process.env.STUDIO_PORT || 4777)
const PUBLIC = path.join(APP, 'public')
fs.mkdirSync(JOBS, { recursive: true })

const id = () => crypto.randomBytes(5).toString('hex')
const now = () => new Date().toISOString()
const readJSON = async (f, d) => { try { return JSON.parse(await fsp.readFile(f, 'utf8')) } catch { return d } }
const writeJSON = async (f, v) => {
  await fsp.mkdir(path.dirname(f), { recursive: true })
  const tmp = f + '.' + id() + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify(v, null, 1))
  await fsp.rename(tmp, f)
}

// one writer per file: every mutation of a board goes through this lock
const locks = new Map()
async function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve()
  let release
  const next = new Promise(r => (release = r))
  locks.set(key, prev.then(() => next))
  await prev
  try { return await fn() } finally { release(); if (locks.get(key) === next) locks.delete(key) }
}

const registryFile = path.join(DATA, 'projects.json')
const settingsFile = path.join(DATA, 'settings.json')
const DEFAULT_SETTINGS = {
  flowUrl: 'https://labs.google/fx/tools/flow',
  imageModel: 'Nano Banana Pro',
  worker: true,
  claude: process.platform === 'win32' ? 'claude.exe' : 'claude',
}
const settings = async () => ({ ...DEFAULT_SETTINGS, ...(await readJSON(settingsFile, {})) })

const DEFAULT_SECTIONS = [
  { id: 'story', title: 'Сюжет', kind: 'notes' },
  { id: '3d', title: '3D', kind: 'boards' },
  { id: 'art', title: 'Арт', kind: 'notes' },
  { id: 'audio', title: 'Аудио', kind: 'notes' },
  { id: 'design', title: 'Геймдизайн', kind: 'notes' },
]

const projDir = p => path.join(ROOT, p.dir, 'studio')
async function project(pid) {
  const reg = await readJSON(registryFile, [])
  const p = reg.find(x => x.id === pid)
  if (!p) throw httpError(404, 'no project ' + pid)
  return p
}
const boardFile = (p, bid) => path.join(projDir(p), 'boards', bid + '.json')
const assetDir = (p, bid, cid) => path.join(projDir(p), 'assets', bid, cid)

function httpError(code, msg) { const e = new Error(msg); e.code = code; return e }

async function readBody(req, limit = 1024 * 1024 * 1024) {
  const chunks = []; let n = 0
  for await (const c of req) { n += c.length; if (n > limit) throw httpError(413, 'too big'); chunks.push(c) }
  return Buffer.concat(chunks)
}
const json = async req => { const b = await readBody(req, 20 * 1024 * 1024); return b.length ? JSON.parse(b.toString('utf8')) : {} }

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Private-Network': 'true',
    'Cache-Control': 'no-store',
  })
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.fbx': 'application/octet-stream', '.obj': 'text/plain', '.mtl': 'text/plain',
  '.json': 'application/json', '.mp4': 'video/mp4', '.md': 'text/markdown; charset=utf-8', '.bin': 'application/octet-stream' }

async function serveFile(res, file) {
  try {
    const st = await fsp.stat(file)
    if (!st.isFile()) throw 0
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size,
      'Access-Control-Allow-Origin': '*', 'Last-Modified': st.mtime.toUTCString(),
      'Cache-Control': file.startsWith(PUBLIC) ? 'no-store' : 'no-cache' })
    fs.createReadStream(file).pipe(res)
  } catch { send(res, 404, { error: 'not found' }) }
}

const safeName = s => String(s || 'file').replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 120)

// ---------- boards ----------
const emptyBoard = (name, kind) => ({ id: null, name, kind, version: 0, cards: [], links: [], context: '' })

function characterTemplate(board) {
  const ref = { id: id(), type: 'ref', title: 'Главный референс', x: 80, y: 120, w: 380,
    prompt: '', count: 4, frozen: false, variants: [], chosen: null, views: 4, note: '' }
  const fin = { id: id(), type: 'final', title: 'Итоговая модель', x: 1900, y: 160, w: 380, files: [], note: '' }
  board.cards.push(ref, fin)
  return board
}

async function mutateBoard(p, bid, fn) {
  return withLock(boardFile(p, bid), async () => {
    const b = await readJSON(boardFile(p, bid), null)
    if (!b) throw httpError(404, 'no board')
    const out = await fn(b)
    b.version = (b.version || 0) + 1
    b.updated = now()
    await writeJSON(boardFile(p, bid), b)
    return out === undefined ? b : out
  })
}

const findCard = (b, cid) => { const c = b.cards.find(x => x.id === cid); if (!c) throw httpError(404, 'no card'); return c }

// ---------- jobs ----------
async function listJobs() {
  const fs_ = await fsp.readdir(JOBS).catch(() => [])
  const all = await Promise.all(fs_.filter(f => f.endsWith('.json')).map(f => readJSON(path.join(JOBS, f), null)))
  return all.filter(Boolean).sort((a, b) => a.created.localeCompare(b.created))
}
const jobFile = jid => path.join(JOBS, jid + '.json')
const mutateJob = (jid, fn) => withLock(jobFile(jid), async () => {
  const j = await readJSON(jobFile(jid), null)
  if (!j) throw httpError(404, 'no job')
  await fn(j); j.updated = now(); await writeJSON(jobFile(jid), j); return j
})

async function createJob(p, bid, card, kind, extra = {}) {
  const j = { id: id(), kind, project: p.id, projectDir: p.dir, board: bid, card: card.id, cardTitle: card.title,
    status: 'queued', created: now(), log: [], ...extra }
  await writeJSON(jobFile(j.id), j)
  return j
}

// ---------- worker: one headless Claude at a time ----------
let running = null
let child_ = null
let ticking = false
async function workerTick() {
  if (ticking) return
  ticking = true
  try { await tick() } finally { ticking = false }
}
async function tick() {
  const s = await settings()
  if (!s.worker || running) return
  const jobs = await listJobs()
  // a job left "running" by a crashed or restarted server goes back to the queue once
  for (const j of jobs.filter(j => j.status === 'running' && !running)) {
    await mutateJob(j.id, x => { x.status = (x.retries || 0) < 1 ? 'queued' : 'error'; x.retries = (x.retries || 0) + 1; x.log.push(now() + ' прервано перезапуском') })
  }
  const next = (await listJobs()).find(j => j.status === 'queued')
  if (!next) return
  await runJob(next, s)
}

async function runJob(job, s) {
  const p = await project(job.project)
  const board = await readJSON(boardFile(p, job.board), null)
  const card = board?.cards.find(c => c.id === job.card)
  if (!card) { await mutateJob(job.id, j => { j.status = 'error'; j.log.push('карточка удалена') }); return }
  const template = await fsp.readFile(path.join(APP, 'worker-prompt.md'), 'utf8')
  const ctx = {
    api: `http://127.0.0.1:${PORT}`, job, card, flowUrl: s.flowUrl, imageModel: s.imageModel,
    projectRoot: path.join(ROOT, p.dir), boardContext: board.context || '',
    inputs: (job.inputs || []).map(f => path.join(ROOT, f)),
  }
  const prompt = template.replace('{{JOB}}', JSON.stringify(ctx, null, 2))
  running = job.id
  await mutateJob(job.id, j => { j.status = 'running'; j.started = now(); j.log.push(now() + ' запущен Claude') })
  const logFile = path.join(JOBS, job.id + '.log')
  const out = fs.createWriteStream(logFile, { flags: 'a' })
  const args = ['-p', '--chrome', '--permission-mode', 'auto', '--add-dir', ROOT, '--add-dir', APP]
  const child = child_ = spawn(s.claude, args, { cwd: path.join(ROOT, p.dir), shell: process.platform === 'win32', windowsHide: true })
  child.on('error', async e => {
    running = null
    await mutateJob(job.id, j => { j.status = 'error'; j.log.push(now() + ' не удалось запустить Claude: ' + e.message) }).catch(() => {})
  })
  child.stdin.on('error', () => {})
  child.stdin.end(prompt)
  child.stdout.pipe(out); child.stderr.pipe(out)
  const timer = setTimeout(() => { try { process.platform === 'win32' ? execFile('taskkill', ['/pid', String(child.pid), '/T', '/F']) : child.kill() } catch {} }, 45 * 60 * 1000)
  child.on('close', async code => {
    clearTimeout(timer); running = null
    out.end()
    await mutateJob(job.id, j => {
      if (j.status === 'running') { j.status = code === 0 ? 'done' : 'error'; j.log.push(now() + ' Claude завершился, код ' + code) }
    }).catch(() => {})
    setTimeout(workerTick, 500)
  })
}
setInterval(() => workerTick().catch(e => console.error('worker', e)), 4000)

// ---------- routes ----------
const routes = []
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn })

route('GET', '/api/settings', async () => settings())
route('PUT', '/api/settings', async req => { const s = { ...(await settings()), ...(await json(req)) }; await writeJSON(settingsFile, s); return s })

route('GET', '/api/projects', async () => {
  const reg = await readJSON(registryFile, [])
  return Promise.all(reg.map(async p => ({ ...p, ...(await readJSON(path.join(projDir(p), 'project.json'), {})) })))
})
route('POST', '/api/projects', async req => {
  const { name, dir } = await json(req)
  if (!name) throw httpError(400, 'name')
  const d = safeName(dir || name.toLowerCase().replace(/\s+/g, '-'))
  const reg = await readJSON(registryFile, [])
  if (reg.some(p => p.dir === d)) throw httpError(409, 'папка уже в списке')
  const p = { id: id(), dir: d }
  reg.push(p); await writeJSON(registryFile, reg)
  await writeJSON(path.join(projDir(p), 'project.json'), { name, created: now(), sections: DEFAULT_SECTIONS, boards: [] })
  return p
})
route('GET', '/api/projects/:pid', async (req, m) => {
  const p = await project(m.pid)
  return { ...p, ...(await readJSON(path.join(projDir(p), 'project.json'), {})) }
})
route('PATCH', '/api/projects/:pid', async (req, m) => {
  const p = await project(m.pid); const f = path.join(projDir(p), 'project.json'); const patch = await json(req)
  return withLock(f, async () => { const d = await readJSON(f, {}); Object.assign(d, patch); await writeJSON(f, d); return d })
})
route('GET', '/api/projects/:pid/notes/:sid', async (req, m) => {
  const p = await project(m.pid)
  return { html: await fsp.readFile(path.join(projDir(p), 'notes', m.sid + '.html'), 'utf8').catch(() => '') }
})
route('PUT', '/api/projects/:pid/notes/:sid', async (req, m) => {
  const p = await project(m.pid); const { html } = await json(req)
  await fsp.mkdir(path.join(projDir(p), 'notes'), { recursive: true })
  await fsp.writeFile(path.join(projDir(p), 'notes', safeName(m.sid) + '.html'), html || '')
  return { ok: true }
})
route('POST', '/api/projects/:pid/boards', async (req, m) => {
  const p = await project(m.pid); const { name, kind = 'character', section = '3d' } = await json(req)
  const b = emptyBoard(name || 'Без названия', kind); b.id = id()
  if (kind === 'character') characterTemplate(b)
  await writeJSON(boardFile(p, b.id), b)
  const f = path.join(projDir(p), 'project.json')
  await withLock(f, async () => { const d = await readJSON(f, {}); d.boards = [...(d.boards || []), { id: b.id, name: b.name, kind, section, created: now() }]; await writeJSON(f, d) })
  return b
})
route('DELETE', '/api/projects/:pid/boards/:bid', async (req, m) => {
  const p = await project(m.pid); const f = path.join(projDir(p), 'project.json')
  await withLock(f, async () => { const d = await readJSON(f, {}); d.boards = (d.boards || []).filter(b => b.id !== m.bid); await writeJSON(f, d) })
  return { ok: true } // the board file and assets stay on disk
})

route('GET', '/api/projects/:pid/boards/:bid', async (req, m) => {
  const p = await project(m.pid)
  const b = await readJSON(boardFile(p, m.bid), null)
  if (!b) throw httpError(404, 'no board')
  const jobs = (await listJobs()).filter(j => j.board === m.bid && j.project === p.id)
  return { ...b, jobs: jobs.map(({ id, kind, card, status, created, updated, log, progress }) => ({ id, kind, card, status, created, updated, progress, log: log.slice(-4) })) }
})
route('PATCH', '/api/projects/:pid/boards/:bid', async (req, m) => {
  const p = await project(m.pid); const patch = await json(req)
  const out = await mutateBoard(p, m.bid, b => { for (const k of ['name', 'context', 'view']) if (k in patch) b[k] = patch[k] })
  if (patch.name) {
    const f = path.join(projDir(p), 'project.json')
    await withLock(f, async () => { const d = await readJSON(f, {}); for (const x of d.boards || []) if (x.id === m.bid) x.name = patch.name; await writeJSON(f, d) })
  }
  return out
})
route('POST', '/api/projects/:pid/boards/:bid/cards', async (req, m) => {
  const p = await project(m.pid); const c = await json(req)
  return mutateBoard(p, m.bid, b => { const card = { id: id(), x: 100, y: 100, w: 360, ...c }; b.cards.push(card); if (c.linkFrom) { b.links.push({ id: id(), from: c.linkFrom, to: card.id }); delete card.linkFrom }; return card })
})
route('PATCH', '/api/projects/:pid/boards/:bid/cards/:cid', async (req, m) => {
  const p = await project(m.pid); const patch = await json(req)
  return mutateBoard(p, m.bid, b => { const c = findCard(b, m.cid); for (const [k, v] of Object.entries(patch)) if (k !== 'id') c[k] = v; return c })
})
route('DELETE', '/api/projects/:pid/boards/:bid/cards/:cid', async (req, m) => {
  const p = await project(m.pid)
  return mutateBoard(p, m.bid, b => { b.cards = b.cards.filter(c => c.id !== m.cid); b.links = b.links.filter(l => l.from !== m.cid && l.to !== m.cid) })
})
route('POST', '/api/projects/:pid/boards/:bid/links', async (req, m) => {
  const p = await project(m.pid); const { from, to } = await json(req)
  return mutateBoard(p, m.bid, b => { if (from !== to && !b.links.some(l => l.from === from && l.to === to)) b.links.push({ id: id(), from, to }) })
})
route('DELETE', '/api/projects/:pid/boards/:bid/links/:lid', async (req, m) => {
  const p = await project(m.pid)
  return mutateBoard(p, m.bid, b => { b.links = b.links.filter(l => l.id !== m.lid) })
})

// file into a card: raw body, ?name=...&slot=variants|files|mesh|textured
route('POST', '/api/projects/:pid/boards/:bid/cards/:cid/files', async (req, m, url) => {
  const p = await project(m.pid)
  const name = safeName(url.searchParams.get('name') || 'file.bin'); const slot = url.searchParams.get('slot') || 'files'
  const buf = await readBody(req)
  const dir = assetDir(p, m.bid, m.cid); await fsp.mkdir(dir, { recursive: true })
  let file = path.join(dir, Date.now().toString(36) + '-' + name)
  await fsp.writeFile(file, buf)
  let entry = path.relative(ROOT, file).split(path.sep).join('/')
  if (/\.zip$/i.test(name)) entry = await unzipModel(file) || entry
  return mutateBoard(p, m.bid, b => {
    const c = findCard(b, m.cid)
    const item = { file: entry, name, at: now(), size: buf.length }
    c[slot] = [...(c[slot] || []), item]
    return item
  })
})

// a zip from Tripo/Modddif: extract next to it, point the card at the first model file inside
function unzipModel(zip) {
  const out = zip.replace(/\.zip$/i, '')
  return new Promise(resolve => {
    fs.mkdirSync(out, { recursive: true })
    execFile('tar', ['-xf', zip, '-C', out], async err => {
      if (err) return resolve(null)
      const all = []
      const rec = async d => { for (const e of await fsp.readdir(d, { withFileTypes: true })) { const f = path.join(d, e.name); e.isDirectory() ? await rec(f) : all.push(f) } }
      await rec(out)
      const model = all.find(f => /\.(glb|gltf|fbx|obj)$/i.test(f))
      resolve(model ? path.relative(ROOT, model).split(path.sep).join('/') : null)
    })
  })
}

// generation request from a card
route('POST', '/api/projects/:pid/boards/:bid/cards/:cid/generate', async (req, m) => {
  const p = await project(m.pid); const opts = await json(req)
  const b = await readJSON(boardFile(p, m.bid), null)
  const c = findCard(b, m.cid)
  if (c.frozen) throw httpError(409, 'карточка заморожена')
  const jobs = await listJobs()
  if (jobs.some(j => j.card === c.id && ['queued', 'running'].includes(j.status))) throw httpError(409, 'уже в очереди')
  // inputs: the chosen image of every card linked into this one (parent references)
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
  const kind = opts.kind || (c.type === 'split' ? 'split' : 'images')
  const job = await createJob(p, m.bid, c, kind, { prompt: opts.prompt ?? c.prompt, count: Math.max(1, Math.min(8, Number(opts.count ?? c.count ?? 4))), inputs, views: c.views })
  setTimeout(workerTick, 50)
  return job
})

route('GET', '/api/jobs', async () => (await listJobs()).reverse().slice(0, 100))
route('GET', '/api/jobs/:jid', async (req, m) => readJSON(jobFile(m.jid), null))
route('GET', '/api/jobs/:jid/log', async (req, m) => ({ text: (await fsp.readFile(path.join(JOBS, m.jid + '.log'), 'utf8').catch(() => '')).slice(-20000) }))
route('POST', '/api/jobs/:jid/cancel', async (req, m) => {
  const j = await mutateJob(m.jid, j => { if (['queued', 'running'].includes(j.status)) { j.status = 'cancelled'; j.log.push(now() + ' отменено') } })
  if (running === m.jid && child_) { try { process.platform === 'win32' ? execFile('taskkill', ['/pid', String(child_.pid), '/T', '/F']) : child_.kill() } catch {} }
  return j
})
route('POST', '/api/jobs/:jid/retry', async (req, m) => mutateJob(m.jid, j => { j.status = 'queued'; j.log.push(now() + ' повтор') }))
// progress line from the worker Claude
route('POST', '/api/jobs/:jid/log', async (req, m) => { const { text, progress } = await json(req); return mutateJob(m.jid, j => { if (text) j.log.push(now() + ' ' + text); if (progress) j.progress = progress }) })
// an image (raw bytes) from the worker straight into the card's variants
route('POST', '/api/jobs/:jid/image', async (req, m, url) => {
  const j = await readJSON(jobFile(m.jid), null); if (!j) throw httpError(404, 'no job')
  const p = await project(j.project)
  const buf = await readBody(req, 60 * 1024 * 1024)
  const ext = (url.searchParams.get('ext') || 'png').replace(/\W/g, '')
  const dir = assetDir(p, j.board, j.card); await fsp.mkdir(dir, { recursive: true })
  const file = path.join(dir, `${j.id}-${Date.now().toString(36)}.${ext}`)
  await fsp.writeFile(file, buf)
  const rel = path.relative(ROOT, file).split(path.sep).join('/')
  const item = { file: rel, at: now(), job: j.id, prompt: url.searchParams.get('prompt') || j.prompt || '', view: url.searchParams.get('view') || '' }
  await mutateBoard(p, j.board, b => { const c = findCard(b, j.card); c.variants = [...(c.variants || []), item] })
  await mutateJob(j.id, x => { x.images = [...(x.images || []), rel] })
  return item
})
// finish: status + optional card patch (split proposals, prompt used)
route('POST', '/api/jobs/:jid/complete', async (req, m) => {
  const body = await json(req)
  const j = await mutateJob(m.jid, x => { if (x.status === 'cancelled') return; x.status = body.status || 'done'; x.result = body.result; x.log.push(now() + ' ' + (body.message || 'готово')) })
  if (body.cardPatch && j.status !== 'cancelled') {
    const p = await project(j.project)
    await mutateBoard(p, j.board, b => { Object.assign(findCard(b, j.card), body.cardPatch) })
  }
  return j
})

// files of a project, served from the Projects folder
route('GET', '/files/(?<rest>.+)', async (req, m) => ({ __file: path.join(ROOT, decodeURIComponent(m.rest)) }))

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  if (req.method === 'OPTIONS') return send(res, 204, '')
  try {
    for (const r of routes) {
      if (r.method !== req.method) continue
      const mm = url.pathname.match(r.re)
      if (!mm) continue
      const out = await r.fn(req, mm.groups || {}, url)
      if (out && out.__file) {
        const f = path.resolve(out.__file)
        if (!f.startsWith(ROOT)) return send(res, 403, { error: 'outside' })
        return serveFile(res, f)
      }
      return send(res, 200, out ?? { ok: true })
    }
    if (req.method === 'GET') {
      let f = path.resolve(PUBLIC, '.' + decodeURIComponent(url.pathname))
      if (!f.startsWith(PUBLIC)) return send(res, 403, '')
      if (!path.extname(f)) f = path.join(PUBLIC, 'index.html')
      return serveFile(res, f)
    }
    send(res, 404, { error: 'no route' })
  } catch (e) {
    send(res, e.code && Number.isInteger(e.code) ? e.code : 500, { error: e.message })
  }
})
server.listen(PORT, '127.0.0.1', () => console.log(`Studio Board: http://127.0.0.1:${PORT}  (projects in ${ROOT})`))

// never die on a stray error: log it and keep serving
process.on('uncaughtException', e => console.error(now(), 'uncaught', e))
process.on('unhandledRejection', e => console.error(now(), 'unhandled', e))
server.on('error', e => { console.error(now(), 'server', e.message); if (e.code === 'EADDRINUSE') process.exit(3) })
