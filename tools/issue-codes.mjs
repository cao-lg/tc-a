// 老师工具：生成 Ed25519 密钥对（仅首次）+ 读取名册签发激活码与证书。
//
// 安全：私钥 teacher-keys.json、激活码 teacher-secrets.json 只存本机 tools/，
//       绝不进前端打包、绝不联网上传；public.json(公钥) 与 certs.json(公开证书) 才下发学生站。
//       密钥文件与 learning-platform/tools/sign-roster.mjs 完全同构（envelope + array secrets），
//       保证 cs-a / ss-a 已签发的学生在此处可直接核验。
//
// 用法：
//   1) 准备 tools/roster.csv：每行 "学号,姓名"（激活码自动生成）
//   2) node tools/issue-codes.mjs
//   3) 把生成的 src/data/public.json + src/data/certs.json 拷到学生站 src/data/
//
// 幂等：已存在的私钥会被复用（不覆盖）；已签发的学号会跳过证书更新（保留原证书）。
import { webcrypto as crypto } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { signCert } from '../src/identity.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const KEYS = join(__dirname, 'teacher-keys.json')
const SECRETS = join(__dirname, 'teacher-secrets.json')
const DATA_DIR = join(root, 'src', 'data')
const CERTS = join(DATA_DIR, 'certs.json')
const ROSTER = join(__dirname, 'roster.csv')
const PUBLIC = join(DATA_DIR, 'public.json')

function randomCode() {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('')
}

async function main() {
  // 1) 密钥对：复用已存在的私钥，保证旧证书持续有效
  let keys
  if (existsSync(KEYS)) {
    keys = JSON.parse(readFileSync(KEYS, 'utf8'))
  } else {
    const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
    keys = {
      private: await crypto.subtle.exportKey('jwk', kp.privateKey),
      public: await crypto.subtle.exportKey('jwk', kp.publicKey)
    }
    writeFileSync(KEYS, JSON.stringify(keys, null, 2))
    console.log('[ok] 已生成新的 Ed25519 密钥对')
  }

  // 2) 名册：每行 学号,姓名
  if (!existsSync(ROSTER)) { console.error('[错误] 缺少 tools/roster.csv（每行：学号,姓名）'); process.exit(1) }
  const rows = readFileSync(ROSTER, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    .map((l) => { const [sid, name] = l.split(',').map((s) => s.trim()); return { sid, name } })
  if (!rows.length) { console.error('[错误] 名册为空'); process.exit(1) }

  // 3) 已签发记录（map 形式便于查找）
  const secrets = existsSync(SECRETS) ? JSON.parse(readFileSync(SECRETS, 'utf8')) : []
  const secretsMap = Object.fromEntries(secrets.map((s) => [s.sid, s]))
  const certs = existsSync(CERTS) ? JSON.parse(readFileSync(CERTS, 'utf8')) : []

  let issued = 0
  for (const r of rows) {
    if (!r.sid || !r.name) { console.warn('[skip] 缺少学号/姓名：', r); continue }
    let code = secretsMap[r.sid]?.code
    if (!code) {
      code = randomCode()
      issued++
    }
    // 始终用当前私钥 + 当前激活码重新签发，保证证书与激活码严格一致（密钥/激活码轮换后也不会错位）
    const sig = await signCert(keys.private, r.sid, r.name, code)
    secretsMap[r.sid] = { sid: r.sid, name: r.name, code }
    const idx = certs.findIndex((c) => c.sid === r.sid)
    const entry = { sid: r.sid, name: r.name, sig }
    if (idx >= 0) certs[idx] = entry; else certs.push(entry)
  }

  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(SECRETS, JSON.stringify(Object.values(secretsMap), null, 2))
  writeFileSync(CERTS, JSON.stringify(certs, null, 2))
  writeFileSync(PUBLIC, JSON.stringify(keys.public, null, 2))

  console.log(`[ok] 本次新签发 ${issued} 个激活码，公开证书总数 ${certs.length}`)
  console.log('[下一步] 把 src/data/public.json 和 src/data/certs.json 拷到学生站 src/data/（覆盖同名文件），学生站即可激活与本地核验；')
  console.log('        老师站核验导出文件时直接读本机 tools/teacher-secrets.json（数组格式）。')
}

main().catch((e) => { console.error('[错误]', e.message); process.exit(1) })
