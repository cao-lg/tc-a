// 老师工具（命令行）：批量核验多个学生导出文件，输出归属 + 真伪 + 成绩摘要。
//
// 用法：node tools/verify-export.mjs 文件1.json 文件2.json ...
//   激活码从本机 tools/teacher-secrets.json 注入（不下发、不联网）。
//
// 退出码：全部真实 -> 0；存在伪造/篡改 -> 1（便于脚本判断）。
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { importPublicKey, verifyCert, deriveMacKey, verifyBundle } from '../src/identity.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SECRETS = join(__dirname, 'teacher-secrets.json')
const PUBLIC = join(__dirname, '..', 'src', 'public.json')

function pctScore(rec) {
  if (!rec || rec.total === 0) return null
  return Math.round((rec.score / rec.total) * 100)
}

function summarize(records) {
  const out = { exams: 0, examBest: null, units: 0, unitBest: null, xp: 0, timeMin: 0 }
  const exams = records.exams || {}
  const unitTests = records.unitTests || {}
  for (const v of Object.values(exams)) {
    if (v?.pct == null) continue
    out.exams++
    if (out.examBest == null || v.pct > out.examBest) out.examBest = v.pct
  }
  for (const v of Object.values(unitTests)) {
    if (v?.bestScore == null) continue
    out.units++
    if (out.unitBest == null || v.bestScore > out.unitBest) out.unitBest = v.bestScore
  }
  const prog = records.progress || {}
  if (typeof prog.xp === 'number') out.xp = prog.xp
  const time = records.time || {}
  if (time.totalMs) out.timeMin = Math.round(time.totalMs / 60000)
  return out
}

async function main() {
  const files = process.argv.slice(2)
  if (!files.length) {
    console.error('用法：node tools/verify-export.mjs 文件1.json [文件2.json ...]')
    process.exit(2)
  }
  if (!existsSync(SECRETS) || !existsSync(PUBLIC)) {
    console.error('[错误] 缺少 teacher-secrets.json / public.json，请先运行 node tools/issue-codes.mjs')
    process.exit(2)
  }
  const pubJwk = JSON.parse(readFileSync(PUBLIC, 'utf8'))
  const secretsArr = JSON.parse(readFileSync(SECRETS, 'utf8'))
  const secrets = Object.fromEntries((Array.isArray(secretsArr) ? secretsArr : []).map((s) => [s.sid, s.code]))
  const pub = await importPublicKey(pubJwk)

  let bad = 0
  for (const f of files) {
    if (!existsSync(f)) { console.log(`\n[缺失] ${f}`); bad++; continue }
    const data = JSON.parse(readFileSync(f, 'utf8'))
    const id = data.identity || null
    const line = `\n[文件] ${f}\n  学号：${id?.sid ?? '—'}  姓名：${id?.name ?? '—'}`
    if (!id) { console.log(line, '\n  ⚠ 无身份信息（非法导出）'); bad++; continue }
    const code = secrets[id.sid]
    // 1) 证书校验：确认真实归属（老师签发）；code 须置于证书对象内（与 student 站一致）
    let certOk = false
    try { certOk = await verifyCert(pub, { sid: id.sid, name: id.name, code, sig: id.sig }) } catch {}
    // 2) HMAC 校验：确认导出后未被篡改（需要激活码）
    let tamperOk = null
    if (data.mac && code) {
      const k = await deriveMacKey(code)
      tamperOk = await verifyBundle(k, { sid: id.sid, name: id.name, records: data.records }, data.mac)
    }
    const tag = certOk ? '✓ 真实' : '✗ 伪造/非本校'
    console.log(line, `\n  归属：${tag}`)
    if (tamperOk === false) { console.log('  ✗ 文件已被篡改'); bad++ }
    else if (tamperOk === true) console.log('  ✓ 未被篡改')
    else console.log('  · 未带 mac 或无激活码，跳过防篡改校验')
    const s = summarize(data.records || {})
    console.log(`  画像：阶段考 ${s.exams}套(最佳${s.examBest ?? '—'}%) · 单元测试 ${s.units}份(最佳${s.unitBest ?? '—'}%) · XP ${s.xp} · 学习${s.timeMin}分钟`)
  }
  console.log(`\n=== 共 ${files.length} 份，异常 ${bad} 份 ===`)
  process.exit(bad ? 1 : 0)
}

main().catch((e) => { console.error('[错误]', e.message); process.exit(1) })
