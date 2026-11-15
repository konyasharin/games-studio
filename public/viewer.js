// 3D preview: a fullscreen viewer (orbit, textures on/off, wireframe, animation) and offscreen card thumbnails.
// glb/gltf/fbx/obj; every WebGL context is freed when its view closes.
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

async function loadModel(url) {
  const ext = url.split('?')[0].split('.').pop().toLowerCase()
  if (ext === 'glb' || ext === 'gltf') {
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js')
    const g = await new GLTFLoader().loadAsync(url)
    return { obj: g.scene, animations: g.animations || [] }
  }
  if (ext === 'fbx') {
    const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js')
    const o = await new FBXLoader().loadAsync(url)
    return { obj: o, animations: o.animations || [] }
  }
  if (ext === 'obj') {
    const { OBJLoader } = await import('three/addons/loaders/OBJLoader.js')
    return { obj: await new OBJLoader().loadAsync(url), animations: [] }
  }
  throw new Error('формат .' + ext + ' не поддерживается')
}

// scale to ~1.8 units tall-or-wide, stand on the grid; skinned meshes measured in their posed shape
function frame(obj, cam, ctl) {
  obj.updateMatrixWorld(true)
  const b = new THREE.Box3().setFromObject(obj, true)
  const size = b.getSize(new THREE.Vector3()), c = b.getCenter(new THREE.Vector3())
  const s = 1.8 / Math.max(size.x, size.y, size.z, 1e-6)
  obj.scale.multiplyScalar(s); obj.position.sub(c.multiplyScalar(s)); obj.position.y += size.y * s / 2
  const h = size.y * s
  cam.position.set(1.5, 0.35 + h * 0.6, 3.3)
  if (ctl) { ctl.target.set(0, h / 2, 0); ctl.update() } else cam.lookAt(0, h / 2, 0)
}

function lights(scene) {
  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x20232b, 1.6))
  const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(2, 4, 3); scene.add(key)
  const rim = new THREE.DirectionalLight(0xff9aa8, 0.8); rim.position.set(-3, 2, -3); scene.add(rim)
}

function disposeTree(obj) {
  obj?.traverse(o => {
    o.geometry?.dispose?.()
    for (const m of [].concat(o.material || [])) { for (const v of Object.values(m)) if (v?.isTexture) v.dispose(); m.dispose?.() }
  })
}

export async function showModel({ url, name, openModal, closeModal, toast, onThumb, hasThumb, onOpen }) {
  const box = document.createElement('div'); box.className = 'viewer'
  const msg = document.createElement('div'); msg.className = 'msg'; msg.textContent = 'Загружаю модель…'
  const bar = document.createElement('div'); bar.className = 'bar'
  bar.innerHTML = `<span class="name"></span>`; bar.firstChild.textContent = name
  const btn = (t, f, title) => { const b = document.createElement('button'); b.className = 'btn sm'; b.textContent = t; if (title) b.title = title; b.onclick = f; bar.append(b); return b }
  let renderer, raf, mixer, ro, obj, disposed = false
  const cleanup = () => {
    disposed = true; cancelAnimationFrame(raf); ro?.disconnect()
    try { disposeTree(obj); renderer?.dispose(); renderer?.forceContextLoss() } catch {}
  }
  openModal(box, cleanup)
  box.append(msg, bar)
  if (onOpen) { btn('Открыть в Blender', () => onOpen('blender')); btn('Показать в папке', () => onOpen('folder'), 'Открыть папку с файлом, например чтобы перетащить его в Tripo') }
  try { renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true }) } catch { msg.textContent = 'WebGL недоступен в этом браузере'; return }
  renderer.setPixelRatio(Math.min(2, devicePixelRatio)); renderer.outputColorSpace = THREE.SRGBColorSpace
  box.prepend(renderer.domElement)
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x0b0d11)
  lights(scene)
  scene.add(new THREE.GridHelper(4, 20, 0x2c3241, 0x1b1f29))
  const cam = new THREE.PerspectiveCamera(35, 1, 0.01, 200)
  const ctl = new OrbitControls(cam, renderer.domElement); ctl.enableDamping = true
  const resize = () => { const w = box.clientWidth, h = box.clientHeight; renderer.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix() }
  resize(); ro = new ResizeObserver(() => !disposed && resize()); ro.observe(box)
  const clock = new THREE.Clock()
  const loop = () => { if (disposed) return; raf = requestAnimationFrame(loop); mixer?.update(clock.getDelta()); ctl.update(); renderer.render(scene, cam) }
  loop()

  let anims
  try { ({ obj, animations: anims } = await loadModel(url)) } catch (e) { msg.textContent = 'Не открылась: ' + (e.message || e); return }
  if (disposed) { disposeTree(obj); return }
  if (anims.length) { mixer = new THREE.AnimationMixer(obj); mixer.clipAction(anims[0]).play() }
  scene.add(obj); msg.remove()
  frame(obj, cam, ctl)

  // textures on/off: the original materials are kept and swapped back
  const orig = new Map()
  const meshes = []; obj.traverse(o => { if (o.isMesh) meshes.push(o) })
  const hasTex = meshes.some(o => [].concat(o.material || []).some(m => m.map))
  let plain = false, wire = false
  const clay = new THREE.MeshStandardMaterial({ color: 0xb9bdc8, roughness: 0.75, metalness: 0 })
  const texBtn = btn(hasTex ? 'Текстуры: вкл' : 'Без текстур', () => {
    plain = !plain
    for (const o of meshes) {
      if (plain) { orig.set(o, o.material); o.material = Array.isArray(o.material) ? o.material.map(() => clay) : clay }
      else if (orig.has(o)) o.material = orig.get(o)
    }
    for (const o of meshes) for (const m of [].concat(o.material)) m.wireframe = wire
    texBtn.textContent = plain ? 'Текстуры: выкл' : 'Текстуры: вкл'
  }, 'Показать модель без текстур (серой) и обратно')
  if (!hasTex) texBtn.disabled = true
  btn('Сетка', () => { wire = !wire; for (const o of meshes) for (const m of [].concat(o.material)) m.wireframe = wire })
  if (mixer) btn('Пауза', e => { mixer.timeScale = mixer.timeScale ? 0 : 1; e.target.textContent = mixer.timeScale ? 'Пауза' : 'Играть' })
  btn('Сделать превью карточки', () => renderer.domElement.toBlob(bl => { if (bl) { onThumb?.(bl); toast('Превью сохранено') } }, 'image/png'))
  btn('Закрыть', closeModal)
  if (!hasThumb) setTimeout(() => !disposed && renderer.domElement.toBlob(bl => bl && onThumb?.(bl), 'image/png'), 900)
}

// card thumbnail without opening anything: one offscreen render at a time
let chain = Promise.resolve()
export function makeThumb(url) {
  const job = chain.then(async () => {
    const canvas = document.createElement('canvas')
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, alpha: false })
    let obj
    try {
      renderer.setSize(640, 480, false); renderer.outputColorSpace = THREE.SRGBColorSpace
      const scene = new THREE.Scene(); scene.background = new THREE.Color(0x0b0d11); lights(scene)
      const cam = new THREE.PerspectiveCamera(35, 4 / 3, 0.01, 200)
      const m = await loadModel(url); obj = m.obj
      scene.add(obj); frame(obj, cam, null)
      renderer.render(scene, cam)
      return await new Promise(r => canvas.toBlob(r, 'image/png'))
    } finally { try { disposeTree(obj); renderer.dispose(); renderer.forceContextLoss() } catch {} }
  })
  chain = job.catch(() => {})
  return job
}
