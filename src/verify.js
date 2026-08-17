// 浏览器端核验：用内置公钥验证身份归属，并用老师粘贴的「激活码库」验证防篡改。
import { importPublicKey, verifyCert, deriveMacKey, verifyBundle } from './identity.js'
import { publicKeyJwk as fallbackJwk } from './public.js'

async function loadPublicJwk() {
  try {
    return (await import('./data/public.json')).default
  } catch {
    return fallbackJwk
  }
}

// secrets: { [sid]: code } 或 [{sid,name,code}]，由老师在本地粘贴/导入（绝不随应用分发）。
export async function verifyFile(data, secrets) {
  const id = data.identity || null
  if (!id || !id.sid || !id.name) {
    return { ok: false, reason: 'no-identity', sid: null, name: null, records: data.records }
  }
  const map = Array.isArray(secrets)
    ? Object.fromEntries(secrets.map((s) => [s.sid, s.code]))
    : (secrets || {})
  const publicKeyJwk = await loadPublicJwk()
  const pub = await importPublicKey(publicKeyJwk)
  const code = map[id.sid]
  let certOk = false
  try {
    // 与 student 站 IdentityGate 一致：code 须置于证书对象内（verifyCert 读取 cert.code 重建签名原文）
    certOk = await verifyCert(pub, { sid: id.sid, name: id.name, code, sig: id.sig })
  } catch {
    certOk = false
  }
  let tampered = null
  if (data.mac && code) {
    const k = await deriveMacKey(code)
    tampered = !(await verifyBundle(k, { sid: id.sid, name: id.name, records: data.records }, data.mac))
  }
  return {
    ok: certOk,
    verified: certOk,
    tampered, // true=被篡改, false=完好, null=未校验
    sid: id.sid,
    name: id.name,
    records: data.records
  }
}
