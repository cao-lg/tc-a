// 验证：直接复用源码 src/identity.js，确认 PKCS8 派生路径在 Node22 下工作，
// 且与浏览器 Web Crypto 的 sign/verify 格式一致（Cloudflare Function 用同一格式验签）。
import { deriveKeyFromPassword, signCert, verifyCert, publicJwkFromPrivate } from '../src/identity.js'

;(async () => {
  const password = 'my-secret-password-2026'
  const priv = await deriveKeyFromPassword(password)
  console.log('priv has d:', !!priv.d, '| has x:', !!priv.x, '| crv:', priv.crv, '| kty:', priv.kty)

  const sid = '2024001', name = '张三', code = 'ABC1-2345'
  const sig = await signCert(priv, sid, name, code)
  const pub = publicJwkFromPrivate(priv)
  console.log('verify (correct):', await verifyCert(pub, { sid, name, code, sig }))
  console.log('verify (tampered):', await verifyCert(pub, { sid, name: '李四', code, sig }))

  // 确定性：同密码两次派生应得到相同公钥 x（跨设备/浏览器复现的根信任）
  const priv2 = await deriveKeyFromPassword(password)
  console.log('deterministic x:', priv.x === priv2.x)

  // 跨密码不可复现（不同密码 => 不同 x）
  const priv3 = await deriveKeyFromPassword('different-password')
  console.log('different pw => different x:', priv.x !== priv3.x)

  if (!priv.d || !priv.x || priv.x !== priv2.x) {
    console.error('FAIL: 派生逻辑异常')
    process.exit(1)
  }
  console.log('ALL OK')
})().catch((e) => { console.error('FAIL', e); process.exit(1) })
