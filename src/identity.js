// 身份指纹与防篡改：基于 Web Crypto（浏览器与 Node 通用，无需第三方依赖）。
//
// 设计目标（来自需求）：数据在本地，学生导出后发给老师给平时成绩；
// 要求每份导出都和原始「学号+姓名」强绑定——即便导入了别人的文件，
// 看到的/发出去的仍是那个原主人的学号与姓名，无法冒用成自己。
//
// 机制：
//  1) 老师用 Ed25519 私钥给每个学生签发证书 cert = sign(priv, 学号|姓名|激活码)。
//     公钥内置 App，App 可验证证书确由老师签发，且无法伪造新身份。
//  2) 学生激活时输入 学号+姓名+激活码；App 校验证书签名通过即锁定本机身份。
//  3) 导出时用 激活码 派生 HMAC 密钥 k=SHA256(激活码)，对全量记录算 bundleMac，
//     把记录「绑死」在该身份上且防导出后篡改。
//  4) 老师核验：用公钥验证证书(确认真实归属) + 用该生激活码派生 k 复核 bundleMac(确认未篡改)。
//
// 说明：本地方案只能保证「文件确实属于老师签发的某身份、且导出后未被篡改」，
// 无法证明学生真正完成了学习（那需要服务端监考）。本方案精准解决「冒用/篡改归属」。

const enc = new TextEncoder()

function subtle() {
  const c = globalThis.crypto
  if (!c || !c.subtle) throw new Error('Web Crypto 不可用（需 https 或 localhost）')
  return c.subtle
}

export async function importPublicKey(jwk) {
  return subtle().importKey('jwk', jwk, { name: 'Ed25519' }, false, ['verify'])
}
export async function importPrivateKey(jwk) {
  return subtle().importKey('jwk', jwk, { name: 'Ed25519' }, false, ['sign'])
}

// 老师签发：msg = 学号|姓名|激活码
export async function signCert(privJwk, sid, name, code) {
  const key = await importPrivateKey(privJwk)
  const msg = enc.encode(`${sid}|${name}|${code}`)
  const sig = await subtle().sign({ name: 'Ed25519' }, key, msg)
  return bufToB64(sig)
}

// 验证证书：cert = { sid, name, code, sig }
// pub 可为 JWK 或已导入的 CryptoKey（兼容 student 站传 JWK、老师工具传 CryptoKey 两种写法）。
export async function verifyCert(pub, cert) {
  try {
    const key = (pub && pub instanceof CryptoKey) ? pub : await importPublicKey(pub)
    const msg = enc.encode(`${cert.sid}|${cert.name}|${cert.code}`)
    return await subtle().verify({ name: 'Ed25519' }, key, b64ToBuf(cert.sig), msg)
  } catch {
    return false
  }
}

// 由激活码派生 HMAC 密钥 k = SHA-256(激活码)
export async function deriveMacKey(code) {
  const hash = await subtle().digest('SHA-256', enc.encode(code))
  return subtle().importKey('raw', hash, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
}

// 全量记录的防篡改 MAC（绑定身份）
export async function bundleMac(key, payloadObj) {
  const data = enc.encode(canonicalize(payloadObj))
  const sig = await subtle().sign('HMAC', key, data)
  return bufToB64(sig)
}

export async function verifyBundle(key, payloadObj, mac) {
  const expected = await bundleMac(key, payloadObj)
  return expected === mac
}

// 规范序列化：递归按 key 排序，保证浏览器/Node 两端一致
export function canonicalize(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj)
  if (Array.isArray(obj)) return '[' + obj.map(canonicalize).join(',') + ']'
  const keys = Object.keys(obj).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}'
}

export function bufToB64(buf) {
  const bytes = new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}
export function b64ToBuf(b64) {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes.buffer
}

// ---------- 老师密码派生 Ed25519 密钥（方案 Y：跨电脑、不落盘） ----------
// 老师用同一密码在任意浏览器/Node 派生相同私钥；其公钥 x 一次性提交到学生站 public.json
// 与 Function 环境变量 TEACHER_PUBLIC_KEY。密码即根信任：丢失密码无法再签发，改密码=换密钥=重部署公钥。
// 老的「随机密钥」(teacher-keys.json) 仍然保留在 public.json 数组首位，保证已签发学生不受影响；
// 新密码派生密钥追加其后，平滑过渡。
export const KDF_SALT = 'xue-liang-ce-2026-salt'
export const KDF_ITER = 210000

// 由密码派生 Ed25519 私钥 JWK（含 d 与 x）。密码不出浏览器/不出 Node。
export async function deriveKeyFromPassword(password) {
  const base = await subtle().importKey('raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveBits'])
  const bits = await subtle().deriveBits(
    { name: 'PBKDF2', salt: enc.encode(KDF_SALT), iterations: KDF_ITER, hash: 'SHA-256' },
    base, 256
  )
  // 浏览器 / Cloudflare Worker (V8)：raw 导入 Ed25519 私钥种子会自动补算公钥 x。
  try {
    const privKey = await subtle().importKey('raw', bits, { name: 'Ed25519' }, true, ['sign'])
    return subtle().exportKey('jwk', privKey)
  } catch {
    // Node webcrypto 不支持 raw Ed25519 私钥导入：改用 node:crypto 构造 PKCS8 取公钥 x。
    return deriveNodeEd25519(bits)
  }
}

// 仅 Node 路径：用 32 字节种子构造 PKCS8 私钥，导出含 d 与 x 的 JWK。
// 此分支只在 Node 执行；@vite-ignore 让打包器忽略该动态导入，避免浏览器构建报错。
async function deriveNodeEd25519(seedBuf) {
  const spec = 'node:crypto'
  const nodeCrypto = await import(/* @vite-ignore */ spec)
  const seed = new Uint8Array(seedBuf)
  const der = new Uint8Array(48)
  // PKCS8 Ed25519: SEQ(30 2e) INT0(02 01 00) AlgId(30 05 06 03 2b 65 70) OCT(04 22 04 20 <seed>)
  der.set([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20], 0)
  der.set(seed, 16)
  const priv = nodeCrypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
  return priv.export({ format: 'jwk' })
}

// 由私钥 JWK 提取纯公钥 JWK（写入 public.json / 环境变量用，不含 d）。
export function publicJwkFromPrivate(privJwk) {
  return { kty: 'OKP', crv: 'Ed25519', x: privJwk.x, key_ops: ['verify'], ext: true }
}

// public.json 兼容「单 JWK」与「JWK 数组」两种形态，统一成数组，便于多密钥验签/过渡。
export function asKeyArray(pub) {
  if (Array.isArray(pub)) return pub
  return pub ? [pub] : []
}

// 在公钥数组中找出「非课程旧密钥」的那把（即老师密码派生密钥），用于校验老师输入的密码是否正确。
// 课程旧密钥由传入的 knownOldXs（旧公钥 x 值数组）排除；找不到则返回 null。
export function findTeacherKey(pub, knownOldXs = []) {
  const arr = asKeyArray(pub)
  const found = arr.find((k) => k && k.x && !knownOldXs.includes(k.x))
  return found || null
}
