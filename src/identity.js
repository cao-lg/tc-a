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
