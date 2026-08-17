// 老师端内置公钥（与 src/public.json 同内容，便于浏览器 import）。
// 仅含 verify 权限；私钥永远不进前端。若需轮换公钥，重新生成后同步此文件与 public.json。
// 多学生站各自独立密钥：此处保留降级用的副本（以 cs-a 公钥为主），正式以 public.json 数组为准。
export const publicKeyJwks = [
  {
    key_ops: ['verify'],
    ext: true,
    alg: 'Ed25519',
    crv: 'Ed25519',
    x: 'emENdFVH30ifajqzkWuc6ooFV6Af3UYERJRDqMIi_gY',
    kty: 'OKP'
  },
  {
    key_ops: ['verify'],
    ext: true,
    alg: 'Ed25519',
    crv: 'Ed25519',
    x: 'gGytN-pRrnr8DlBUsr_W9kzexeLHXLubguNpnI7tI_Y',
    kty: 'OKP'
  }
]
