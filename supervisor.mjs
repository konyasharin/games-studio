// Keeps server.mjs running: restarts it after a crash, with a growing pause if it keeps failing.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const dir = path.dirname(fileURLToPath(import.meta.url))
let fails = 0
function start() {
  const t0 = Date.now()
  const child = spawn(process.execPath, ['server.mjs'], { cwd: dir, stdio: 'inherit' })
  child.on('exit', code => {
    if (code === 3) { console.log(new Date().toISOString(), 'port busy, another Studio Board is running; supervisor exits'); process.exit(0) }
    fails = Date.now() - t0 < 30000 ? fails + 1 : 0
    const wait = Math.min(60000, 1000 * 2 ** fails)
    console.log(new Date().toISOString(), `server exited (${code}), restart in ${wait} ms`)
    setTimeout(start, wait)
  })
}
start()
