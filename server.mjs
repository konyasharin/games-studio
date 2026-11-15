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

// ---------- worker: one headless Claude at a time ----------
// Claude runs detached from the server with its output going to a file: a server restart neither kills it nor
// loses what it says; the new server picks the running job up again and keeps reading the file.
let running = null, child_ = null, ticking = false
const alive = pid => { if (!pid) return false; try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }

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

// follow a running Claude: parse its stream-json output from the log file, finish the job when it exits
function follow(job, { sid, started, pid, offset, owned }) {
  const logFile = path.join(JOBS, job.id + '.log')
  let pos = offset || 0, buf = '', result = null, tail = '', finished = false, exitCode = null
  job.events = []
  running = job.id
  const read = () => {
    let fd
    try {
      fd = fs.openSync(logFile, 'r')
      const size = fs.fstatSync(fd).size
      if (size > pos) {
        const b = Buffer.alloc(size - pos); fs.readSync(fd, b, 0, b.length, pos); pos = size
        const text = b.toString('utf8'); tail = (tail + text).slice(-4000); buf += text
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
      }
    } catch {} finally { if (fd !== undefined) try { fs.closeSync(fd) } catch {} }
  }
  const finish = async (status, line) => {
    if (finished) return
    finished = true; clearInterval(iv); read()
    try {
      await mutateJob(job.id, j => {
        if (j.kind === 'chat') { j.answer = String(result?.result || '').slice(0, 20000); j.cost = result?.total_cost_usd }
        if (j.status === 'running') { j.status = status; j.log.push(now() + ' ' + line); if (j.kind === 'request') j.thread = [...(j.thread || []), { who: 'claude', text: status === 'done' ? 'Готово (без отчёта).' : 'Не получилось: ' + line, at: now() }] }
      })
      for (const mid of job.batch || []) {
        const m = jobs.get(mid)
        if (m?.status === 'running') await mutateJob(mid, j => { j.status = (j.images || []).length ? status : 'error'; j.log.push(now() + ' ' + ((j.images || []).length ? line : 'Claude закончил, картинок для этой задачи нет')) })
      }
    } catch {}
    running = null; child_ = null
    setTimeout(workerTick, 500)
  }
  let doneCalled = false
  const done = async () => {
    if (doneCalled) return
    doneCalled = true
    read()
    const code = exitCode ?? (result && !result.is_error ? 0 : 1)
    // the session is gone (deleted, or this machine never had it): start a fresh one and run the job again
    if (code !== 0 && started && /No conversation found/i.test(tail)) {
      const p = await project(job.project).catch(() => null)
      if (p) await sessionFor(p.id, { fresh: true })
      finished = true; clearInterval(iv)
      try { await mutateJob(job.id, j => { if (j.status === 'running') { j.status = 'queued'; j.log.push(now() + ' сессия Claude не найдена, начинаю новую') } }) } catch {}
      running = null; child_ = null; setTimeout(workerTick, 300)
      return
    }
    await sessionUsed(job.project, sid).catch(() => {})
    const ok = code === 0 && (job.kind !== 'chat' || (result && !result.is_error))
    finish(ok ? 'done' : 'error', job.kind === 'chat' && ok ? 'ответ готов' : 'Claude завершился, код ' + code)
  }
  const t0 = Date.parse(job.started || now())
  const iv = setInterval(() => {
    read()
    // only a cancel stops the run; a job Claude already completed via /complete keeps its process (a batch goes on)
    if (job.status === 'cancelled') { if (alive(pid)) killTree(pid); return finish('cancelled', 'остановлено') }
    if (Date.now() - t0 > 45 * 60 * 1000) { killTree(pid); return finish('error', 'превышено время (45 мин)') }
    if (!owned && !alive(pid)) done()
  }, 700)
  return { setExit: code => { exitCode = code; done() } }
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
    // image jobs of the same project go together: one Claude submits all their generations at once in Flow
    let batch = []
    if (job.kind === 'images') {
      batch = sortedJobs().filter(j => j.id !== job.id && j.kind === 'images' && j.status === 'queued' && j.project === job.project).slice(0, 7)
      for (const m of batch) {
        m.token = crypto.randomBytes(16).toString('hex'); m.leader = job.id
        await mutateJob(m.id, j => { j.status = 'running'; j.started = now(); j.log.push(now() + ' выполняется вместе с задачей «' + job.cardTitle + '»') })
      }
    }
    const cardOf = async m => { const b = m.board === job.board ? board : await readJSON(boardFile(p, m.board), null); return b?.cards.find(c => c.id === m.card) || null }
    const batchCtx = batch.length ? await Promise.all([job, ...batch].map(async m => ({ id: m.id, token: m.token, card: await cardOf(m),
      prompt: m.prompt, count: m.count, sides: m.sides, inputs: (m.inputs || []).map(f => path.join(ROOT, f)).filter(f => inside(ROOT, f)) }))) : null
    job.batch = batch.map(m => m.id)
    const ctx = {
      api: `http://127.0.0.1:${PORT}`, token: job.token, job: publicJob(job), card, flowUrl: s.flowUrl, imageModel: s.imageModel,
      projectId: p.id, projectRoot: path.join(ROOT, p.dir), boardContext: board?.context || '',
      where: job.where || null, thread: job.thread || null, jobs: batchCtx,
      inputs: (job.inputs || []).map(f => path.join(ROOT, f)).filter(f => inside(ROOT, f)),
    }
    const prompt = job.kind === 'chat'
      ? `[Studio Board, чат проекта «${p.name || p.dir}» (${path.join(ROOT, p.dir)}). Это та же сессия, в которой ты выполняешь задачи с досок проекта. API доски: http://127.0.0.1:${PORT}/api (проект ${p.id}). Отвечай по-русски, коротко и по делу.]\n\n${job.text}`
      : template.replace('{{JOB}}', JSON.stringify(ctx, null, 2))
    const promptFile = path.join(JOBS, job.id + '.prompt.txt'), logFile = path.join(JOBS, job.id + '.log')
    await fsp.writeFile(promptFile, prompt)
    const sess = await sessionFor(p.id)
    const args = ['-p', '--chrome', '--permission-mode', 'auto', '--add-dir', ROOT, '--add-dir', APP, '--output-format', 'stream-json', '--verbose',
      ...(sess.started ? ['--resume', sess.id] : ['--session-id', sess.id])]
    await fsp.appendFile(logFile, `\n===== ${now()} session ${sess.id} (${sess.started ? 'resume' : 'new'}) =====\n`)
    const offset = (await fsp.stat(logFile)).size
    const inFd = fs.openSync(promptFile, 'r'), outFd = fs.openSync(logFile, 'a')
    let child
    try { child = spawn(CLAUDE, args, { cwd: path.join(ROOT, p.dir), windowsHide: true, detached: true, stdio: [inFd, outFd, outFd] }) }
    finally { fs.closeSync(inFd); fs.closeSync(outFd) }
    child_ = child
    await mutateJob(job.id, j => { j.status = 'running'; j.started = now(); j.pid = child.pid; j.sid = sess.id; j.sessStarted = sess.started; j.offset = offset; j.log.push(now() + ' запущен Claude') })
    const f = follow(job, { sid: sess.id, started: sess.started, pid: child.pid, offset, owned: true })
    child.on('error', e => { f.setExit(1); job.log.push(now() + ' не удалось запустить Claude: ' + e.message) })
    child.on('exit', code => f.setExit(code ?? 1))
    child.unref()
  } catch (e) {
    running = null; child_ = null
    await mutateJob(job.id, j => { j.status = 'error'; j.log.push(now() + ' ' + e.message) }).catch(() => {})
    for (const m of sortedJobs().filter(m => m.leader === job.id && m.status === 'running')) await mutateJob(m.id, j => { j.status = 'queued'; j.log.push(now() + ' вернулась в очередь') }).catch(() => {})
  }
}

// at startup: a job still "running" whose Claude is alive is picked up again; a dead one goes back to the queue once
for (const j of sortedJobs().filter(j => j.status === 'running')) {
  if (j.leader) continue
  if (alive(j.pid) && j.offset != null && !running) {
    j.log.push(now() + ' сервер перезапущен, продолжаю следить за задачей')
    follow(j, { sid: j.sid, started: j.sessStarted, pid: j.pid, offset: j.offset, owned: false })
    saveJob(j).catch(() => {})
    continue
  }
  killTree(j.pid)
  j.status = (j.retries || 0) < 1 ? 'queued' : 'error'
  j.retries = (j.retries || 0) + 1
  j.log.push(now() + ' прервано перезапуском сервера')
  saveJob(j).catch(() => {})
}
for (const j of sortedJobs().filter(j => j.status === 'running' && j.leader && jobs.get(j.leader)?.status !== 'running')) {
  j.status = 'queued'; j.log.push(now() + ' прервано перезапуском сервера'); saveJob(j).catch(() => {})
}
setInterval(workerTick, 4000)

// ---------- routes ----------
const routes = []
const route = (method, pattern, fn, opts = {}) =>
  routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn, ...opts })

route('GET', '/api/settings', async () => settings())
// open a project file on this computer: reveal it in the file manager, or load it into Blender
const BLENDER_DEFAULT = process.platform === 'win32' ? 'C:/Program Files (x86)/Steam/steamapps/common/Blender/blender.exe'
  : process.platform === 'darwin' ? '/Applications/Blender.app/Contents/MacOS/Blender' : 'blender'
// the chosen sides of a card copied into one folder named by Tripo's slots, opened with those files selected
route('POST', '/api/projects/:pid/boards/:bid/cards/:cid/tripo-files', async (req, m) => {
  const p = await project(m.pid)
  const b = await readJSON(boardFile(p, m.bid), null); if (!b) throw httpError(404, 'нет доски')
  const c = findCard(b, m.cid)
  const picks = { ...(c.picks || {}), front: c.picks?.front || c.chosen }
  const dir = path.join(projDir(p), 'tripo', safeName(c.title || c.id))
  await fsp.mkdir(dir, { recursive: true })
  // copy only what changed: rewriting a file makes Explorer refresh the folder and drop the selection
  const files = []
  for (const side of ['front', 'back', 'left', 'right']) {
    const src = picks[side] && path.resolve(ROOT, picks[side])
    const dst = src && path.join(dir, side + path.extname(src).toLowerCase())
    for (const f of await fsp.readdir(dir)) if (f.startsWith(side + '.') && path.join(dir, f) !== dst) await fsp.rm(path.join(dir, f), { force: true })
    if (!src || !inside(ROOT, src)) continue
    try {
      const [a, b] = await Promise.all([fsp.stat(src), fsp.stat(dst).catch(() => null)])
      if (!b || b.size !== a.size) await fsp.copyFile(src, dst)
      files.push(dst)
    } catch {}
  }
  if (!files.length) throw httpError(404, 'у карточки нет выбранных сторон')
  revealMany(dir, files)
  return { dir: toRel(dir), files: files.map(toRel) }
})
function revealMany(dir, files) {
  if (process.platform === 'win32') {
    const q = s => "'" + s.replace(/'/g, "''") + "'"
    const ps = [
      `$dir = ${q(path.win32.normalize(dir))}`, `$names = @(${files.map(f => q(path.basename(f))).join(',')})`, `$first = ${q(path.win32.normalize(files[0]))}`,
      '$sh = New-Object -ComObject Shell.Application',
      'function Find { @($sh.Windows() | Where-Object { try { $_.Document.Folder.Self.Path -eq $dir } catch { $false } }) | Select-Object -Last 1 }',
      // an open window of this folder is reused; otherwise explorer opens it at once with the first file selected
      '$w = Find', 'if (-not $w) { Start-Process explorer.exe -ArgumentList ("/select,`"" + $first + "`""); for ($i = 0; $i -lt 40 -and -not $w; $i++) { Start-Sleep -Milliseconds 100; $w = Find } }',
      'if (-not $w) { exit }',
      'function Sel { $one = $true; foreach ($n in $names) { $it = $w.Document.Folder.ParseName($n); if ($it) { $w.Document.SelectItem($it, $(if ($one) { 29 } else { 1 })); $one = $false } } }',
      'Sel',
      // Windows keeps background processes from raising windows; a synthetic Alt press lifts that lock for one call
      'Add-Type -Namespace SB -Name W -MemberDefinition \'[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c); [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e); [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);\'',
      '$h = [IntPtr]$w.HWND', 'if ([SB.W]::IsIconic($h)) { [SB.W]::ShowWindow($h, 9) | Out-Null }',
      '[SB.W]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [SB.W]::SetForegroundWindow($h) | Out-Null; [SB.W]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)',
      'for ($k = 0; $k -lt 4; $k++) { Start-Sleep -Milliseconds 300; if (@($w.Document.SelectedItems()).Count -lt $names.Count) { Sel } }',
    ].join('; ')
    // -EncodedCommand (UTF-16LE base64): no quoting trouble with spaces, quotes or Cyrillic in the path
    // not detached: a detached powershell.exe on Windows exits at once without running the script
    const ch = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { stdio: 'ignore', windowsHide: true })
    ch.on('error', () => {}); ch.unref()
  } else if (process.platform === 'darwin') {
    const ch = spawn('open', ['-R', files[0]], { detached: true, stdio: 'ignore' }); ch.on('error', () => {}); ch.unref()
  } else { const ch = spawn('xdg-open', [dir], { detached: true, stdio: 'ignore' }); ch.on('error', () => {}); ch.unref() }
}

route('POST', '/api/open', async req => {
  const { file, how = 'folder' } = await json(req)
  const abs = path.resolve(ROOT, String(file || ''))
  if (!inside(ROOT, abs)) throw httpError(403, 'outside')
  if (!(await fsp.stat(abs).catch(() => null))?.isFile()) throw httpError(404, 'нет файла')
  const detached = (cmd, args) => { const ch = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false }); ch.on('error', e => console.error(now(), 'open', e.message)); ch.unref() }
  if (how === 'folder') {
    if (process.platform === 'win32') revealMany(path.dirname(abs), [abs])
    else if (process.platform === 'darwin') detached('open', ['-R', abs])
    else detached('xdg-open', [path.dirname(abs)])
    return { ok: true }
  }
  if (how === 'blender') {
    const blender = (await readJSON(settingsFile, {})).blender || BLENDER_DEFAULT
    const ext = path.extname(abs).toLowerCase()
    if (ext === '.blend') { detached(blender, [abs]); return { ok: true } }
    const imp = { '.fbx': 'bpy.ops.import_scene.fbx', '.glb': 'bpy.ops.import_scene.gltf', '.gltf': 'bpy.ops.import_scene.gltf', '.obj': 'bpy.ops.wm.obj_import' }[ext]
    if (!imp) throw httpError(400, 'Blender не открывает ' + ext)
    // after the window is up: clear the startup scene's objects, import, frame the model
    const py = [
      'import bpy',
      'def go():',
      '    for o in list(bpy.data.objects): bpy.data.objects.remove(o)',
      `    ${imp}(filepath=${JSON.stringify(abs)})`,
      '    try:',
      '        for w in bpy.context.window_manager.windows:',
      '            for a in w.screen.areas:',
      "                if a.type == 'VIEW_3D':",
      "                    with bpy.context.temp_override(window=w, area=a, region=[r for r in a.regions if r.type == 'WINDOW'][0]):",
      '                        bpy.ops.view3d.view_all()',
      '    except Exception as e: print("view_all", e)',
      'bpy.app.timers.register(go, first_interval=1.0)',
    ].join(String.fromCharCode(10))
    detached(blender, ['--python-expr', py])
    return { ok: true }
  }
  throw httpError(400, 'how')
})
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
  const p = await project(m.pid); const { file, hidden, view } = await json(req)
  return mutateBoard(p, m.bid, b => {
    const c = findCard(b, m.cid)
    for (const v of c.variants || []) if (v.file === file) {
      if (hidden !== undefined) v.hidden = !!hidden
      if (['front', 'back', 'left', 'right', 'sheet'].includes(view)) v.view = view
    }
    if (hidden && c.chosen === file) c.chosen = null
    if (hidden && c.picks) for (const k in c.picks) if (c.picks[k] === file) c.picks[k] = null
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
// undo of a card deletion: the card comes back with its id and the links that still have both ends
route('POST', '/api/projects/:pid/boards/:bid/restore', async (req, m) => {
  const p = await project(m.pid); const { card, links = [] } = await json(req)
  if (!card?.id || !/^[\w-]{1,40}$/.test(card.id)) throw httpError(400, 'card')
  return mutateBoard(p, m.bid, b => {
    if (!b.cards.some(c => c.id === card.id)) b.cards.push(card)
    for (const l of links) if (l?.id && b.cards.some(c => c.id === l.from) && b.cards.some(c => c.id === l.to) && !b.links.some(x => x.id === l.id || (x.from === l.from && x.to === l.to))) b.links.push({ id: l.id, from: l.from, to: l.to })
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
    if (slot === 'thumb') { c.thumb = entry; c.thumbOf = url.searchParams.get('of') || null }
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
      const picked = [x.chosen, ...Object.values(x.picks || {})].filter(Boolean)
      if (picked.length) inputs.push(...new Set([...picked, ...(x.extraInputs || [])]))
      else up(x.id)
    }
  }
  up(c.id)
  inputs.push(...(c.inputs || []))
  if ([...jobs.values()].some(j => j.card === c.id && active(j))) throw httpError(409, 'уже в очереди')
  const kind = ['images', 'split', 'note', 'describe', 'tripo'].includes(opts.kind) ? opts.kind : c.type === 'split' ? 'split' : 'images'
  const SIDES = ['front', 'back', 'left', 'right']
  const sides = (Array.isArray(opts.sides) ? opts.sides : c.sides || ['front']).filter(x => SIDES.includes(x))
  if (kind === 'images' && !sides.length) throw httpError(400, 'выбери хотя бы одну сторону')
  // the card's own chosen sides are references too: the front for the other sides, all of them for a description
  const own = kind === 'describe' ? [c.picks?.front || c.chosen, ...Object.values(c.picks || {})] : sides.some(x => x !== 'front') ? [c.picks?.front || c.chosen] : []
  for (const f of new Set(own.filter(Boolean))) if (!inputs.includes(f)) inputs.unshift(f)
  const j = { id: id(), kind, project: p.id, projectDir: p.dir, board: m.bid, card: c.id, cardTitle: c.title, status: 'queued', created: now(), log: [],
    prompt: typeof opts.prompt === 'string' ? opts.prompt : c.prompt || '', count: Math.max(1, Math.min(8, Number(opts.count ?? c.count ?? 4) || 4)), inputs, sides }
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
      if (j.kind === 'describe' && typeof body.cardPatch.prompt === 'string' && c.prompt && c.prompt !== body.cardPatch.prompt) c.promptPrev = c.prompt
      for (const k of ['prompt', 'proposal', 'answer', 'doubts']) if (typeof body.cardPatch[k] === 'string') c[k] = body.cardPatch[k]
      if (body.cardPatch.tripo && typeof body.cardPatch.tripo === 'object') c.tripo = { ...(c.tripo || {}), ...body.cardPatch.tripo }
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
