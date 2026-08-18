import { verifyFile } from './verify.js'
import { profileOf, classSummary, gradeBuckets, ranking, topWrong } from './analytics.js'
import { signCert, deriveKeyFromPassword, asKeyArray } from './identity.js'
import publicKeys from './data/public.json'

// 方案 Y：老师用密码在浏览器派生密钥，直接发布到学生站 KV（纯网页、不落盘）。
// 课程站生产域名（用于跨域 POST /api/issue）。如需本地联调可临时改这里。
const SITE_ENDPOINTS = {
  'cs-a': 'https://cs-a.pages.dev',
  'ss-a': 'https://ss-a.pages.dev'
}
// 方案 Y：老师密码派生密钥只要在 public.json 信任数组内即为有效（顺序/多余钥匙无关），见下方校验。

// 浏览器内生成随机激活码（16 字节十六进制）
function randomCode() {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('')
}

const $ = (sel) => document.querySelector(sel)
const el = (tag, props = {}, children = []) => {
  const n = document.createElement(tag)
  Object.assign(n, props)
  for (const c of [].concat(children)) if (c != null) n.append(c)
  return n
}

// 老师端会话：激活码库 + 已导入学生文件 + 分析配置（可跨设备导出/导入）
const SESSION_KEY = 'tc:session'
function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}
function saveSession(s) { localStorage.setItem(SESSION_KEY, JSON.stringify(s)) }

const store = {
  secrets: {},          // { sid -> code }，由老师粘贴本机 teacher-secrets.json 注入
  files: [],            // { name, result } 已核验的学生导出文件
  certs: [],            // 已签发证书（公开），从 src/data/certs.json 读取
  session: loadSession(),
  teacherEmail: loadSession().teacherEmail || ''
}

async function loadCerts() {
  try {
    store.certs = (await import('./data/certs.json')).default || []
  } catch {
    store.certs = []
  }
}

// ---------- 通用辅助 ----------
function downloadJson(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' })
  const a = el('a', { href: URL.createObjectURL(blob), download: filename })
  a.click()
  URL.revokeObjectURL(a.href)
}

function mailtoLink({ to, subject, body }) {
  return `mailto:${encodeURIComponent(to || '')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
}

function toast(parent, text, type = 'ok') {
  const t = el('div', { className: type, textContent: text })
  parent.append(t)
  setTimeout(() => t.remove(), 3600)
}

// ---------- 面板1：发放激活码 ----------
function renderIssue() {
  const box = $('#panel-issue')
  box.innerHTML = ''
  box.append(el('h2', { textContent: '① 发放激活码与证书' }))

  // 已签发名单（公开证书，不含激活码）
  const certBox = el('div', { className: 'cert-box' })
  certBox.append(el('h3', { textContent: `已签发学生名单（${store.certs.length} 人）` }))
  if (store.certs.length) {
    const t = el('table', { className: 'tbl compact' })
    t.append(thead(['学号', '姓名', '证书状态']))
    for (const c of store.certs) {
      t.append(tr([c.sid, c.name, c.sig ? '✓ 已签发' : '—']))
    }
    certBox.append(t)
  } else {
    certBox.append(el('p', { className: 'hint', textContent: '暂无已签发证书。请在下方粘贴名册并运行本地签发命令。' }))
  }
  box.append(certBox)

  // 名册编辑
  box.append(el('h3', { textContent: '名册与签发' }))
  box.append(el('p', { className: 'hint', textContent: '在 teacher-console 目录下运行：node tools/issue-codes.mjs（读取 tools/roster.csv：学号,姓名）。私钥与激活码不出本机。' }))
  const ta = el('textarea', { placeholder: 'roster.csv 示例（可粘贴后保存为本机名册）：\n2024001,张三\n2024002,李四', rows: 6 })
  const saved = localStorage.getItem('tc:roster')
  if (saved) ta.value = saved
  box.append(ta)
  box.append(el('button', {
    className: 'btn', textContent: '保存名册到本机',
    onclick: () => {
      const text = ta.value.trim()
      if (!text) return
      localStorage.setItem('tc:roster', text)
      toast(box, '已保存名册。请在项目目录运行 node tools/issue-codes.mjs 生成证书与激活码。')
    }
  }))

  // ---------- 网页签发并发布（方案 Y） ----------
  box.append(el('h3', { textContent: '网页签发并发布到远程名册（方案 Y）' }))
  box.append(el('p', { className: 'hint', textContent: '输入老师密码（任意电脑均可；密码不发送、不落盘），选择课程站，填写名册后直接发布到该站 KV。学生即时可激活，无需重部署学生站。' }))
  box.append(el('label', { textContent: '老师密码' }))
  const pwdInput = el('input', { type: 'password', placeholder: '老师密码（派生签名密钥）' })
  box.append(pwdInput)
  box.append(el('label', { textContent: '目标课程站' }))
  const siteSel = el('select')
  siteSel.append(el('option', { value: 'cs-a', textContent: 'cs-a · 数字化供应链运营' }))
  siteSel.append(el('option', { value: 'ss-a', textContent: 'ss-a · 销售交易数据分析' }))
  box.append(siteSel)
  box.append(el('label', { textContent: '名册（每行 学号,姓名）' }))
  const issueTa = el('textarea', { placeholder: '2024005,小明\n2024006,小红', rows: 6 })
  box.append(issueTa)
  box.append(el('button', {
    className: 'btn primary', textContent: '签发并发布',
    onclick: async () => {
      const password = pwdInput.value
      if (!password) { toast(box, '请输入老师密码', 'bad'); return }
      const rows = issueTa.value.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
        .map((l) => { const [sid, name] = l.split(',').map((s) => s.trim()); return { sid, name } })
        .filter((r) => r.sid && r.name)
      if (!rows.length) { toast(box, '名册为空或格式不对（应为 学号,姓名）', 'bad'); return }
      try {
        const priv = await deriveKeyFromPassword(password)
        const arr = asKeyArray(publicKeys)
        if (!arr.some((k) => k && k.x === priv.x)) { toast(box, '密码错误，或本站尚未配置该派生公钥', 'bad'); return }
        const site = siteSel.value
        const endpoint = SITE_ENDPOINTS[site] + '/api/issue'
        const certs = []
        const newSecrets = {}
        for (const r of rows) {
          const code = randomCode()
          const sig = await signCert(priv, r.sid, r.name, code)
          certs.push({ sid: r.sid, name: r.name, code, sig })
          newSecrets[r.sid] = { sid: r.sid, name: r.name, code }
        }
        const res = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(certs) })
        const data = await res.json().catch(() => ({}))
        if (!res.ok || !data.ok) { toast(box, '发布失败：' + (data.error || res.status), 'bad'); return }
        // 保存激活码到本机库（供后续 HMAC 核验学生导出）
        Object.assign(store.secrets, Object.fromEntries(Object.entries(newSecrets).map(([sid, c]) => [sid, c.code])))
        store.session.secrets = store.secrets
        saveSession(store.session)
        toast(box, `已发布 ${data.added} 个到 ${site}（当前共 ${data.total} 人）`)
        renderIssue()
      } catch (e) {
        toast(box, '签发出错：' + e.message, 'bad')
      }
    }
  }))

  // 激活码库
  box.append(el('h3', { textContent: '本机激活码库' }))
  box.append(el('p', { className: 'hint', textContent: '粘贴本机 tools/teacher-secrets.json 内容，浏览器本地保存，用于核验学生导出文件与查看激活码。不会随前端分发。' }))
  const secretTa = el('textarea', { rows: 4, placeholder: '[ { "sid": "2024001", "name": "张三", "code": "ABC123" }, ... ]' })
  if (Object.keys(store.secrets).length) secretTa.value = JSON.stringify(Object.entries(store.secrets).map(([sid, code]) => ({ sid, name: nameOf(sid), code })), null, 2)
  box.append(secretTa)
  box.append(el('button', {
    className: 'btn', textContent: '保存激活码库',
    onclick: () => {
      try {
        const arr = JSON.parse(secretTa.value)
        store.secrets = Object.fromEntries((Array.isArray(arr) ? arr : []).map((s) => [s.sid, s.code]))
        store.session.secrets = store.secrets
        saveSession(store.session)
        toast(box, `已保存 ${Object.keys(store.secrets).length} 条激活码`)
        renderIssue()
      } catch { toast(box, 'JSON 解析失败', 'bad') }
    }
  }))

  // 激活码表
  const secretsArr = Object.entries(store.secrets).map(([sid, code]) => ({ sid, name: nameOf(sid), code }))
  if (secretsArr.length) {
    box.append(el('h3', { textContent: '发放明细（学号 · 姓名 · 激活码）' }))
    const t = el('table', { className: 'tbl compact' })
    t.append(thead(['学号', '姓名', '激活码']))
    for (const s of secretsArr) t.append(tr([s.sid, s.name, s.code]))
    box.append(t)
  }

  // 教师端会话导入/导出
  box.append(el('h3', { textContent: '老师跨设备迁移' }))
  box.append(el('p', { className: 'hint', textContent: '把激活码库、已导入学生文件、邮件配置打包导出；换电脑后导入即可继续分析。注意：该文件含激活码，请妥善保管。' }))
  box.append(el('button', {
    className: 'btn', textContent: '导出教师端会话',
    onclick: () => exportSession()
  }))
  const importInput = el('input', { type: 'file', accept: '.json,application/json' })
  box.append(el('label', { className: 'btn ghost file-btn', textContent: '导入教师端会话' }, [importInput]))
  importInput.onchange = async (e) => {
    const f = e.target.files?.[0]
    if (!f) return
    try {
      const data = JSON.parse(await f.text())
      if (!data || data.type !== 'teacher-console-session') throw new Error('不是教师端会话文件')
      store.secrets = data.secrets || {}
      store.files = (data.files || []).map((x) => ({ name: x.name, result: x.result }))
      store.teacherEmail = data.teacherEmail || ''
      store.session = { secrets: store.secrets, files: store.files, teacherEmail: store.teacherEmail }
      saveSession(store.session)
      toast(box, `已导入会话：${Object.keys(store.secrets).length} 个激活码，${store.files.length} 份学生文件`)
      renderAll()
    } catch (err) { toast(box, '导入失败：' + err.message, 'bad') }
  }
}

function exportSession() {
  const payload = {
    type: 'teacher-console-session',
    exportedAt: Date.now(),
    secrets: store.secrets,
    files: store.files.map((x) => ({ name: x.name, result: x.result })),
    teacherEmail: store.teacherEmail
  }
  downloadJson(payload, `teacher-session-${new Date().toISOString().slice(0, 10)}.json`)
}

function nameOf(sid) {
  return store.certs.find((c) => c.sid === sid)?.name || store.files.find((f) => f.result.sid === sid)?.result.name || ''
}

// ---------- 面板2：导入与核验 ----------
function renderImport() {
  const box = $('#panel-import')
  box.innerHTML = ''
  box.append(el('h2', { textContent: '② 导入学生导出文件并核验' }))

  box.append(el('p', { className: 'hint', textContent: '选择多个学生导出的 .json 文件（可一次选全部）。系统会用公钥验身份、用激活码防篡改。' }))
  const input = el('input', { type: 'file', accept: '.json,application/json', multiple: true })
  box.append(input)
  box.append(el('button', {
    className: 'btn', textContent: '校验并加入分析',
    onclick: async () => {
      const files = input.files
      if (!files.length) return
      for (const f of files) {
        try {
          const text = await f.text()
          const data = JSON.parse(text)
          const res = await verifyFile(data, store.secrets)
          store.files.push({ name: f.name, result: res })
        } catch (e) {
          store.files.push({ name: f.name, result: { ok: false, reason: 'parse', sid: null, name: null } })
        }
      }
      store.session.files = store.files.map((x) => ({ name: x.name, result: x.result }))
      saveSession(store.session)
      renderImport()
      renderDashboard()
    }
  }))

  // 已导入列表
  if (store.files.length) {
    const list = el('div', { className: 'filelist' })
    for (const it of store.files) {
      const r = it.result
      const status = !r.sid ? '⚠ 无身份'
        : r.verified ? (r.tampered === true ? '✗ 被篡改' : '✓ 真实') : '✗ 非本校'
      const cls = !r.sid ? 'muted' : r.verified ? (r.tampered ? 'bad' : 'ok') : 'bad'
      list.append(el('div', { className: 'filerow ' + cls, textContent: `${it.name} — ${r.sid || '—'} ${r.name || ''} — ${status}` }))
    }
    box.append(list)
    box.append(el('button', { className: 'btn ghost', textContent: '清空已导入', onclick: () => { store.files = []; store.session.files = []; saveSession(store.session); renderImport(); renderDashboard() } }))

    // 学生明细表
    const verified = store.files.map((x) => x.result).filter((r) => r.verified && r.records)
    if (verified.length) {
      box.append(el('h3', { textContent: `已核验学生明细（${verified.length} 人）` }))
      box.append(el('p', { className: 'hint', textContent: '以下学生数据已通过身份与防篡改校验，将被纳入分析报表。' }))
      const t = el('table', { className: 'tbl compact' })
      t.append(thead(['学号', '姓名', '激活码', '阶段考', '单元', 'XP', '等级', '学习分钟', '错题']))
      for (const r of verified) {
        const p = profileOf(r)
        t.append(tr([
          p.sid,
          p.name,
          store.secrets[p.sid] ? '●●●●' + store.secrets[p.sid].slice(-4) : '—',
          p.examAvg != null ? p.examAvg + '%' : '—',
          p.unitAvg != null ? p.unitAvg + '%' : '—',
          p.xp,
          p.level,
          p.timeMin,
          p.wrongCount
        ]))
      }
      box.append(t)
    }
  }
}

// ---------- 面板3：可视化分析 ----------
function renderDashboard() {
  const box = $('#panel-dash')
  box.innerHTML = ''
  const verified = store.files.map((x) => x.result).filter((r) => r.verified && r.records)
  box.append(el('h2', { textContent: '③ 平时成绩可视化分析' }))

  // 老师邮箱配置
  box.append(el('h3', { textContent: '邮件配置' }))
  const emailWrap = el('div', { className: 'email-row' })
  const emailInp = el('input', { type: 'email', placeholder: '老师接收数据的邮箱，如 teacher@school.edu.cn', value: store.teacherEmail })
  emailInp.oninput = () => {
    store.teacherEmail = emailInp.value.trim()
    store.session.teacherEmail = store.teacherEmail
    saveSession(store.session)
  }
  emailWrap.append(el('span', { className: 'hint', textContent: '报表发送目标邮箱：' }))
  emailWrap.append(emailInp)
  box.append(emailWrap)

  if (!verified.length) {
    box.append(el('p', { className: 'hint', textContent: '尚未导入任何「已核验」的学生导出文件。' }))
    return
  }
  const profiles = verified.map((r) => profileOf({ sid: r.sid, name: r.name, records: r.records, verified: true, tampered: r.tampered }))
  const sum = classSummary(profiles)
  const tamperedList = store.files.filter((x) => x.result.tampered === true)

  // 概览卡片
  const cards = el('div', { className: 'cards' })
  cards.append(card('学生数', sum.count))
  cards.append(card('已核验', sum.verified))
  cards.append(card('阶段考均分', sum.examAvgAll != null ? sum.examAvgAll + '%' : '—'))
  cards.append(card('单元均分', sum.unitAvgAll != null ? sum.unitAvgAll + '%' : '—'))
  cards.append(card('平均XP', sum.avgXp))
  cards.append(card('总学习时长', Math.round(sum.totalTimeMin / 60) + 'h'))
  cards.append(card('总错题', sum.totalWrong))
  if (sum.tampered) cards.append(card('⚠ 篡改告警', sum.tampered, true))
  box.append(cards)

  if (tamperedList.length) {
    box.append(el('div', { className: 'bad banner', textContent: `⚠ 发现 ${tamperedList.length} 份文件被篡改，已从可信分析中剔除，请单独核查：${tamperedList.map((t) => t.result.sid).join(', ')}` }))
  }

  box.append(el('h3', { textContent: '成绩分布（按综合均分）' }))
  box.append(barChart(gradeBuckets(profiles)))

  box.append(el('h3', { textContent: '综合排名' }))
  box.append(rankTable(ranking(profiles)))

  box.append(el('h3', { textContent: '高频错点（重点讲评）' }))
  box.append(wrongTable(topWrong(profiles, 15)))

  box.append(el('h3', { textContent: '学生明细' }))
  box.append(detailTable(profiles))

  const btnWrap = el('div', { className: 'btn-row' })
  btnWrap.append(el('button', {
    className: 'btn', textContent: '导出分析报表 (CSV)',
    onclick: () => {
      const csv = buildCsv(profiles, sum)
      const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' })
      const a = el('a', { href: URL.createObjectURL(blob), download: `平时成绩分析_${new Date().toISOString().slice(0, 10)}.csv` })
      a.click()
      URL.revokeObjectURL(a.href)
    }
  }))
  btnWrap.append(el('button', {
    className: 'btn ghost', textContent: '邮件发送报表',
    onclick: () => sendReportMail(profiles, sum, box)
  }))
  box.append(btnWrap)
}

function sendReportMail(profiles, sum, box) {
  if (!store.teacherEmail) {
    toast(box, '请先填写接收邮箱', 'bad')
    $('#panel-dash input[type=email]').focus()
    return
  }
  const date = new Date().toISOString().slice(0, 10)
  const subject = `[学练测平台] 平时成绩分析报表 - ${date} - 共${profiles.length}人`
  const body = `老师您好，\n\n附件为 ${date} 的平时成绩分析报表。\n\n班级概况：\n- 学生数：${sum.count}\n- 阶段考均分：${sum.examAvgAll != null ? sum.examAvgAll + '%' : '—'}\n- 单元均分：${sum.unitAvgAll != null ? sum.unitAvgAll + '%' : '—'}\n- 平均 XP：${sum.avgXp}\n- 总学习时长：${Math.round(sum.totalTimeMin / 60)}h\n- 总错题数：${sum.totalWrong}\n\n请下载 CSV 附件后通过本邮件回复。\n\n（此邮件由「学练测平台 · 老师控制台」自动生成）`
  window.location.href = mailtoLink({ to: store.teacherEmail, subject, body })
  toast(box, '已唤起邮件客户端，请手动附加刚下载的 CSV 文件后发送')
}

function buildCsv(profiles, sum) {
  const head = ['学号', '姓名', '阶段考均', '单元均', '通关数', '总单元', 'XP', '等级', '连击', '徽章数', '学习分钟', '错题数']
  const lines = [head.join(',')]
  for (const p of profiles) lines.push([p.sid, p.name, p.examAvg ?? '', p.unitAvg ?? '', p.passedUnits, p.totalUnits, p.xp, p.level, p.streak, p.badges.length, p.timeMin, p.wrongCount].join(','))
  return lines.join('\n')
}

function card(label, val, warn) {
  return el('div', { className: 'card' + (warn ? ' warn' : '') }, [
    el('div', { className: 'card-val', textContent: String(val) }),
    el('div', { className: 'card-label', textContent: label })
  ])
}

function barChart(buckets) {
  const max = Math.max(1, ...buckets.map((b) => b.n))
  const wrap = el('div', { className: 'barchart' })
  for (const b of buckets) {
    const col = el('div', { className: 'bar-col' })
    col.append(el('div', { className: 'bar-val', textContent: b.n }))
    col.append(el('div', { className: 'bar', style: `height:${Math.round((b.n / max) * 120)}px;background:${b.color}` }))
    col.append(el('div', { className: 'bar-label', textContent: b.label }))
    wrap.append(col)
  }
  return wrap
}

function rankTable(rows) {
  const t = el('table', { className: 'tbl' })
  t.append(thead(['排名', '学号', '姓名', '综合分', '阶段考', '单元', 'XP', '核验']))
  rows.forEach((r, i) => {
    t.append(tr([String(i + 1), r.sid, r.name, r.score, r.examAvg != null ? r.examAvg + '%' : '—', r.unitAvg != null ? r.unitAvg + '%' : '—', r.xp, r.verified ? '✓' : '✗']))
  })
  return t
}

function wrongTable(rows) {
  if (!rows.length) return el('p', { className: 'hint', textContent: '暂无错题数据。' })
  const t = el('table', { className: 'tbl' })
  t.append(thead(['错点（单元:题）', '出错人数']))
  rows.forEach((r) => t.append(tr([r.key, String(r.count)])))
  return t
}

function detailTable(rows) {
  const t = el('table', { className: 'tbl' })
  t.append(thead(['学号', '姓名', '阶段考均', '单元均', '通关', 'XP', '等级', '连击', '徽章', '时长', '错题']))
  rows.forEach((p) => t.append(tr([
    p.sid, p.name, p.examAvg != null ? p.examAvg + '%' : '—', p.unitAvg != null ? p.unitAvg + '%' : '—',
    `${p.passedUnits}/${p.totalUnits}`, p.xp, p.level, p.streak, p.badges.length, p.timeMin + 'm', p.wrongCount
  ])))
  return t
}

function thead(cols) { const t = el('tr'); cols.forEach((c) => t.append(el('th', { textContent: c }))); return t }
function tr(cols) { const t = el('tr'); cols.forEach((c) => t.append(el('td', { textContent: c }))); return t }

// ---------- 初始化 ----------
async function renderAll() {
  await loadCerts()
  // 尝试从 session 恢复 secrets
  if (store.session.secrets) store.secrets = store.session.secrets
  if (store.session.files) store.files = store.session.files
  if (store.session.teacherEmail) store.teacherEmail = store.session.teacherEmail
  renderIssue()
  renderImport()
  renderDashboard()
}

function initTabs() {
  document.querySelectorAll('.tab').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'))
      document.querySelectorAll('.panel').forEach((x) => x.classList.remove('active'))
      b.classList.add('active')
      $('#' + b.dataset.target).classList.add('active')
    }
  })
}

renderAll()
initTabs()
