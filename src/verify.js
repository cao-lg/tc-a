// 浏览器端核验：用内置公钥验证身份归属，并用老师粘贴的「激活码库」验证防篡改。
import { importPublicKey, verifyCert, deriveMacKey, verifyBundle } from './identity.js'
import { publicKeyJwks as fallbackJwks } from './public.js'

// 支持多学生站：内置多把公钥（每站一把），核验时逐把尝试。
async function loadPublicJwks() {
  try {
    const data = (await import('./data/public.json')).default
    return Array.isArray(data) ? data : [data]
  } catch {
    return Array.isArray(fallbackJwks) ? fallbackJwks : [fallbackJwks]
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
  const publicKeys = await loadPublicJwks()
  const code = map[id.sid]
  let certOk = false
  // 逐把公钥尝试（兼容 cs-a / ss-a 等多学生站各自独立密钥）
  for (const jwk of publicKeys) {
    try {
      const pub = await importPublicKey(jwk)
      // 与 student 站 IdentityGate 一致：code 须置于证书对象内（verifyCert 读取 cert.code 重建签名原文）
      if (await verifyCert(pub, { sid: id.sid, name: id.name, code, sig: id.sig })) {
        certOk = true
        break
      }
    } catch {
      // 换下一把公钥重试
    }
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
