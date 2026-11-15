// 3D preview in a modal: glb/gltf/fbx/obj, orbit, auto-fit; one WebGL context at a time, freed on close.
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

export async function showModel({ url, name, openModal, closeModal, toast, onThumb, hasThumb }) {
  const box = document.createElement('div'); box.className = 'viewer'
  const msg = document.createElement('div'); msg.className = 'msg'; msg.textContent = 'Загружаю модель…'
  const bar = document.createElement('div'); bar.className = 'bar'
  bar.innerHTML = `<span class="name"></span>`; bar.firstChild.textContent = name
  const btn = (t, f) => { const b = document.createElement('button'); b.className = 'btn sm'; b.textContent = t; b.onclick = f; bar.append(b); return b }
  let renderer, raf, mixer, ro, disposed = false
  const cleanup = () => {
    disposed = true; cancelAnimationFrame(raf); ro?.disconnect()
    try { renderer?.dispose(); renderer?.forceContextLoss() } catch {}
  }
  openModal(box, cleanup)
  box.append(msg, bar)
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
  } catch (e) { msg.textContent = 'WebGL недоступен в этом браузере'; return }
  renderer.setPixelRatio(Math.min(2, devicePixelRatio)); renderer.outputColorSpace = THREE.SRGBColorSpace
  box.prepend(renderer.domElement)
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x0b0d11)
  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x20232b, 1.6))
  const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(2, 4, 3); scene.add(key)
  const rim = new THREE.DirectionalLight(0xff9aa8, 0.8); rim.position.set(-3, 2, -3); scene.add(rim)
  const grid = new THREE.GridHelper(4, 20, 0x2c3241, 0x1b1f29); scene.add(grid)
  const cam = new THREE.PerspectiveCamera(35, 1, 0.01, 200)
  const ctl = new OrbitControls(cam, renderer.domElement); ctl.enableDamping = true
  const resize = () => { const w = box.clientWidth, h = box.clientHeight; renderer.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix() }
  resize(); ro = new ResizeObserver(() => !disposed && resize()); ro.observe(box)
  const clock = new THREE.Clock()
  const loop = () => { if (disposed) return; raf = requestAnimationFrame(loop); mixer?.update(clock.getDelta()); ctl.update(); renderer.render(scene, cam) }
  loop()

  let obj
  try {
    const ext = url.split('?')[0].split('.').pop().toLowerCase()
    if (ext === 'glb' || ext === 'gltf') {
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js')
      const g = await new GLTFLoader().loadAsync(url); obj = g.scene
      if (g.animations?.length) { mixer = new THREE.AnimationMixer(obj); mixer.clipAction(g.animations[0]).play() }
    } else if (ext === 'fbx') {
      const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js')
      obj = await new FBXLoader().loadAsync(url)
      if (obj.animations?.length) { mixer = new THREE.AnimationMixer(obj); mixer.clipAction(obj.animations[0]).play() }
    } else if (ext === 'obj') {
      const { OBJLoader } = await import('three/addons/loaders/OBJLoader.js')
      obj = await new OBJLoader().loadAsync(url)
    } else throw new Error('формат .' + ext + ' не поддерживается')
  } catch (e) { msg.textContent = 'Не открылась: ' + (e.message || e); return }
  if (disposed) return
  scene.add(obj); msg.remove()
  const b = new THREE.Box3().setFromObject(obj), size = b.getSize(new THREE.Vector3()), c = b.getCenter(new THREE.Vector3())
  const s = 1.8 / Math.max(size.x, size.y, size.z, 1e-6)
  obj.scale.multiplyScalar(s); obj.position.sub(c.multiplyScalar(s)); obj.position.y += size.y * s / 2
  cam.position.set(1.6, 1.3, 3.2); ctl.target.set(0, size.y * s / 2, 0); ctl.update()
  let wire = false
  btn('Сетка', () => { wire = !wire; obj.traverse(o => { if (o.isMesh) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { m.wireframe = wire }) }) })
  if (mixer) btn('Пауза', e => { mixer.timeScale = mixer.timeScale ? 0 : 1; e.target.textContent = mixer.timeScale ? 'Пауза' : 'Играть' })
  btn('Сделать превью карточки', () => renderer.domElement.toBlob(bl => { if (bl) { onThumb?.(bl); toast('Превью сохранено') } }, 'image/png'))
  btn('Закрыть', closeModal)
  // first look becomes the card picture automatically
  if (!hasThumb) setTimeout(() => !disposed && renderer.domElement.toBlob(bl => bl && onThumb?.(bl), 'image/png'), 900)
}
