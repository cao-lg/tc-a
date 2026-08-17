import { verifyFile } from './verify.js'
import { profileOf, classSummary, gradeBuckets, ranking, topWrong } from './analytics.js'

const $ = (sel) => document.querySelector(sel)
const el = (tag, props = {}, children = []) => {
  const n = document.createElement(tag)
  Object.assign(n, props)
  for (const c of [].concat(children)) n.append(c)
  return n
}

const store = {
  secrets: loadSecrets(),
  files: [] // { name, result }
}

function loadSecrets() {
  try { return JSON.parse(localStorage.getItem('tc:secrets') || '{}') } catch { return {} }
}
function saveSecrets() { localStorage.setItem('tc:secrets', JSON.stringify(store.secrets)) }

// ---------- 面板1：发放激活码 ----------
function renderIssue() {
  const box = $('#panel-issue')
  box.innerHTML = ''
  box.append(el('h2', { textContent: '① 发放激活码与证书' }))
  box.append(el('p', { className: 'hint', textContent: '在学生站目录下运行：node tools/issue-codes.mjs（读取 tools/roster.csv：学号,姓名,激活码）。本操作只在老师本机进行，私钥与激活码不出本机。' }))
  const ta = el('textarea', { placeholder: 'roster.csv 示例（可粘贴后保存为本机名册）：\n2024001,张三,ABC123\n2024002,李四,\n（激活码留空则自动生成）', rows: 6 })
  box.append(ta)
  box.append(el('button', {
    className: 'btn', textContent: '保存名册到本机并提示签发命令',
    onclick: () => {
      const text = ta.value.trim()
      if (!text) return
      localStorage.setItem('tc:roster', text)
      box.append(el('div', { className: 'ok', textContent: '已保存到本机。请在 teacher-console 目录运行：node tools/issue-codes.mjs，再把生成的 src/public.json + tools/certs.json 拷到学生站 src/data/。' }))
    }
  }))
  const saved = localStorage.getItem('tc:roster')
  if (saved) box.append(el('pre', { className: 'roster', textContent: saved }))
}

// ---------- 面板2：导入与核验 ----------
function renderImport() {
  const box = $('#panel-import')
  box.innerHTML = ''
  box.append(el('h2', { textContent: '② 导入学生导出文件并核验' }))

  // 激活码库
  box.append(el('p', { className: 'hint', textContent: '粘贴本机 tools/teacher-secrets.json 的内容（学号:激活码）。仅存浏览器本地，绝不随应用分发或上传。' }))
  const secretTa = el('textarea', { rows: 4, placeholder: '{ "2024001": "ABC123", "2024002": "DEF456" }' })
  secretTa.value = JSON.stringify(store.secrets, null, 2)
  box.append(secretTa)
  box.append(el('button', {
    className: 'btn', textContent: '保存激活码库',
    onclick: () => {
      try {
        store.secrets = JSON.parse(secretTa.value)
        saveSecrets()
        box.append(el('div', { className: 'ok', textContent: `已保存 ${Object.keys(store.secrets).length} 条激活码到本机。` }))
      } catch { box.append(el('div', { className: 'bad', textContent: 'JSON 解析失败，请检查格式。' })) }
    }
  }))

  // 文件选择（多文件）
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
    box.append(el('button', { className: 'btn ghost', textContent: '清空已导入', onclick: () => { store.files = []; renderImport(); renderDashboard() } }))
  }
}

// ---------- 面板3：可视化分析 ----------
function renderDashboard() {
  const box = $('#panel-dash')
  box.innerHTML = ''
  const verified = store.files.map((x) => x.result).filter((r) => r.verified && r.records)
  box.append(el('h2', { textContent: '③ 平时成绩可视化分析' }))
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

  // 等级分布柱状图
  box.append(el('h3', { textContent: '成绩分布（按综合均分）' }))
  box.append(barChart(gradeBuckets(profiles)))

  // 排名表
  box.append(el('h3', { textContent: '综合排名' }))
  box.append(rankTable(ranking(profiles)))

  // 高频错题
  box.append(el('h3', { textContent: '高频错点（重点讲评）' }))
  box.append(wrongTable(topWrong(profiles, 15)))

  // 明细表 + 导出
  box.append(el('h3', { textContent: '学生明细' }))
  box.append(detailTable(profiles))
  box.append(el('button', {
    className: 'btn', textContent: '导出分析报表 (CSV)',
    onclick: () => exportCsv(profiles, sum)
  }))
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

function exportCsv(profiles, sum) {
  const head = ['学号', '姓名', '阶段考均', '单元均', '通关数', '总单元', 'XP', '等级', '连击', '徽章数', '学习分钟', '错题数']
  const lines = [head.join(',')]
  for (const p of profiles) lines.push([p.sid, p.name, p.examAvg ?? '', p.unitAvg ?? '', p.passedUnits, p.totalUnits, p.xp, p.level, p.streak, p.badges.length, p.timeMin, p.wrongCount].join(','))
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
  const a = el('a', { href: URL.createObjectURL(blob), download: `平时成绩分析_${new Date().toISOString().slice(0, 10)}.csv` })
  a.click()
}

function thead(cols) { const t = el('tr'); cols.forEach((c) => t.append(el('th', { textContent: c }))); return t }
function tr(cols) { const t = el('tr'); cols.forEach((c) => t.append(el('td', { textContent: c }))); return t }

// ---------- 初始化 ----------
function renderAll() { renderIssue(); renderImport(); renderDashboard() }

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
