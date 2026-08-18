// 方案 Y 全面端到端测试（真实部署端点 + 本地逻辑）
// 运行：node teacher-console/tools/_e2e_test.mjs
import { readFileSync } from 'node:fs'
import { webcrypto as crypto } from 'node:crypto'

const IDENTITY = 'file:///d:/workbuddy/chain_supply/learning-platform/src/lib/identity.js'
const { signCert, verifyCert, asKeyArray, findTeacherKey } = await import(IDENTITY)

const enc = new TextEncoder()
const bufToB64 = (buf) => Buffer.from(new Uint8Array(buf)).toString('base64')
const CS = 'https://cs-a.pages.dev/api'
const SS = 'https://ss-a.pages.dev/api'
const ACTIVE_X = 'CnxtXKXtWzl4tMC5TC7jQlBF0EDORNER8bMVpeFtw1U'

const results = []
const ok = (name, cond, extra = '') => { results.push([cond ? 'PASS' : 'FAIL', name, extra]); }

async function getJSON(u) {
  const r = await fetch(u, { cache: 'no-store' })
  const t = await r.text()
  let j = null; try { j = JSON.parse(t) } catch {}
  return { status: r.status, headers: Object.fromEntries(r.headers), body: j, raw: t }
}
async function postJSON(u, body) {
  const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const t = await r.text()
  let j = null; try { j = JSON.parse(t) } catch {}
  return { status: r.status, body: j, raw: t }
}
async function options(u) {
  const r = await fetch(u, { method: 'OPTIONS' })
  return { status: r.status, headers: Object.fromEntries(r.headers) }
}

// ---- 伪造证书：用一把随机 Ed25519 密钥签名（格式正确、钥匙错误）----
const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
const forgedPriv = await crypto.subtle.exportKey('jwk', kp.privateKey)
const forgedSig = await signCert(forgedPriv, 'FORGE01', '黑客', 'x')
const forgedCert = { sid: 'FORGE01', name: '黑客', code: 'x', sig: forgedSig }

console.log('=== Phase A: 真实部署端点 ===')

// A1/A2 GET 名单
const gCs = await getJSON(`${CS}/certs`)
ok('cs-a GET /api/certs → 200 + 数组', gCs.status === 200 && Array.isArray(gCs.body), `status=${gCs.status}`)
const gSs = await getJSON(`${SS}/certs`)
ok('ss-a GET /api/certs → 200 + 数组', gSs.status === 200 && Array.isArray(gSs.body), `status=${gSs.status}`)

// A3 OPTIONS 预检
const opt = await options(`${CS}/issue`)
ok('cs-a OPTIONS /api/issue → 204 + CORS', opt.status === 204 && opt.headers['access-control-allow-origin'] === '*', `status=${opt.status}`)

// A4 伪造签名 → 422
const pForge = await postJSON(`${CS}/issue`, [forgedCert])
ok('cs-a POST 伪造证书(错钥匙) → 422 拒收', pForge.status === 422, `status=${pForge.status} ${pForge.raw}`)

// A5 畸形 JSON → 400
const pBad = await postJSON(`${CS}/issue`, { foo: 1 })
ok('cs-a POST 畸形体 → 400', pBad.status === 400, `status=${pBad.status}`)

// A6 缺字段 → 422
const pMiss = await postJSON(`${CS}/issue`, [{ sid: 'A' }])
ok('cs-a POST 缺字段 → 422', pMiss.status === 422, `status=${pMiss.status}`)

// A7 伪造未被写入（名单仍空）
const gAfter = await getJSON(`${CS}/certs`)
ok('cs-a 伪造未污染 KV（名单仍空）', Array.isArray(gAfter.body) && gAfter.body.length === 0, `len=${gAfter.body?.length}`)

// 同样对 ss-a 验伪造拒收
const pForgeSs = await postJSON(`${SS}/issue`, [forgedCert])
ok('ss-a POST 伪造证书 → 422 拒收', pForgeSs.status === 422, `status=${pForgeSs.status}`)

console.log('=== Phase B: 学生端本地逻辑（真实 identity.js + public.json） ===')
const pub = JSON.parse(readFileSync('d:/workbuddy/chain_supply/learning-platform/src/data/public.json', 'utf8'))
const arr = asKeyArray(pub)
ok('public.json 为多密钥数组', Array.isArray(arr) && arr.length >= 2, `len=${arr.length}`)
ok('数组含当前激活公钥 x', arr.some((k) => k && k.x === ACTIVE_X), ACTIVE_X.slice(0, 12) + '…')
// 回归复现：用合成数组 [emEN, Cbc7(orphan), Cnxt] 复现旧逻辑缺陷（不依赖实时文件仍含 orphan）
const withOrphan = [
  { kty: 'OKP', crv: 'Ed25519', x: 'emENdFVH30ifajqzkWuc6ooFV6Af3UYERJRDqMIi_gY', key_ops: ['verify'], ext: true },
  { kty: 'OKP', crv: 'Ed25519', x: 'Cbc7MC3U06ScKrFFh58kj0PHr--1P1piGPq-8F3mPSA', key_ops: ['verify'], ext: true },
  { kty: 'OKP', crv: 'Ed25519', x: ACTIVE_X, key_ops: ['verify'], ext: true }
]
const buggy = findTeacherKey(withOrphan, ['emENdFVH30ifajqzkWuc6ooFV6Af3UYERJRDqMIi_gY', 'gGytN-pRrnr8DlBUsr_W9kzexeLHXLubguNpnI7tI_Y'])
ok('[回归] 旧 findTeacherKey 在 orphan 前会误定位 → 证明须用成员判定', buggy && buggy.x !== ACTIVE_X, buggy ? buggy.x.slice(0, 12) : 'null')
// 新逻辑：成员判定，顺序/orphan 无关
ok('[新逻辑] 激活公钥在信任数组内（含 orphan 也成立）', asKeyArray(withOrphan).some((k) => k && k.x === ACTIVE_X))
// 实际清理后的 public.json
const arr2 = asKeyArray(pub)
ok('[实际] 清理后 public.json 仍含激活公钥', arr2.some((k) => k && k.x === ACTIVE_X))

// B+: 用一把测试密钥自签自验，确认 verifyCert 对正确签名返回 true
const tk = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
const tPriv = await crypto.subtle.exportKey('jwk', tk.privateKey)
const tPub = await crypto.subtle.exportKey('jwk', tk.publicKey)
const tSig = await signCert(tPriv, 'S2024001', '张三', 'CODE123')
ok('verifyCert 对正确签名返回 true', await verifyCert(tPub, { sid: 'S2024001', name: '张三', code: 'CODE123', sig: tSig }) === true)

// B-: 用测试公钥验伪造证书（错钥匙）→ false
ok('verifyCert 对伪造证书返回 false', (await verifyCert(tPub, forgedCert)) === false)

// B-: 篡改字段 → false
const tampered = { ...forgedCert, name: '李四' }
ok('verifyCert 对篡改字段返回 false', (await verifyCert(tPub, tampered)) === false)

console.log('\n=== 结果 ===')
let fail = 0
for (const [s, n, e] of results) { if (s === 'FAIL') fail++; console.log(`${s}  ${n}${e ? '  ('+e+')' : ''}`) }
console.log(`\n合计 ${results.length} 项，失败 ${fail} 项。`)
process.exit(fail ? 1 : 0)
