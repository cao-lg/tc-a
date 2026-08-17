// 老师端分析引擎：把若干「已核验」的学生导出记录聚合成报表与图表数据。
// 纯函数，便于测试与复用。输入 = 已通过 verify 的记录数组（每条含 sid/name/records/verified）。

// 单份记录 → 指标
export function profileOf(rec) {
  const r = rec.records || {}
  const exams = r.exams || {}
  const units = r.unitTests || {}
  const prog = r.progress || {}
  const time = r.time || {}
  const cp = r.checkpoints || {}
  const ch = r.checkpoints || {}

  const examList = Object.values(exams).filter((v) => v && v.pct != null)
  const unitList = Object.values(units).filter((v) => v && v.bestScore != null)
  const examBest = examList.length ? Math.max(...examList.map((v) => v.pct)) : null
  const examAvg = examList.length ? Math.round(examList.reduce((a, v) => a + v.pct, 0) / examList.length) : null
  const unitAvg = unitList.length ? Math.round(unitList.reduce((a, v) => a + v.bestScore, 0) / unitList.length) : null
  const passedUnits = unitList.filter((v) => v.passed).length
  const totalUnits = Object.keys(units).length

  // 错题本：从 post 测验 graded 中聚合（结构见 storage.getWrongBook）
  const wrong = aggregateWrong(r)

  return {
    sid: rec.sid,
    name: rec.name,
    verified: rec.verified,
    tampered: rec.tampered,
    examCount: examList.length,
    examBest,
    examAvg,
    unitCount: unitList.length,
    unitAvg,
    passedUnits,
    totalUnits,
    xp: typeof prog.xp === 'number' ? prog.xp : 0,
    level: prog.level || (prog.xp != null ? levelFromXp(prog.xp) : 0),
    streak: typeof prog.streakDays === 'number' ? prog.streakDays : 0,
    badges: Array.isArray(prog.badges) ? prog.badges : [],
    timeMin: time.totalMs ? Math.round(time.totalMs / 60000) : 0,
    timeDays: time.days ? Object.keys(time.days).length : 0,
    wrongCount: wrong.length,
    wrong
  }
}

export function levelFromXp(xp, per = 150) {
  return Math.floor(xp / per) + 1
}

// 从 records 聚合错题（与 student 站 getWrongBook 同构：读 post.graded）
function aggregateWrong(records) {
  const assess = records.assess || {}
  const out = []
  for (const [unitId, blob] of Object.entries(assess)) {
    const post = blob?.post
    if (!post?.graded) continue
    for (const g of post.graded) {
      if (g.correct) continue
      out.push({
        unitId,
        itemId: g.id,
        count: (post.history?.length || 1)
      })
    }
  }
  return out
}

// 全班聚合
export function classSummary(profiles) {
  const n = profiles.length || 1
  const avg = (sel) => Math.round(profiles.reduce((a, p) => a + (sel(p) || 0), 0) / n)
  const examAvgs = profiles.map((p) => p.examAvg).filter((x) => x != null)
  const unitAvgs = profiles.map((p) => p.unitAvg).filter((x) => x != null)
  return {
    count: profiles.length,
    examAvgAll: examAvgs.length ? Math.round(examAvgs.reduce((a, b) => a + b, 0) / examAvgs.length) : null,
    unitAvgAll: unitAvgs.length ? Math.round(unitAvgs.length ? unitAvgs.reduce((a, b) => a + b, 0) / unitAvgs.length : 0) : null,
    avgXp: avg((p) => p.xp),
    totalTimeMin: profiles.reduce((a, p) => a + p.timeMin, 0),
    totalWrong: profiles.reduce((a, p) => a + p.wrongCount, 0),
    verified: profiles.filter((p) => p.verified).length,
    tampered: profiles.filter((p) => p.tampered).length
  }
}

// 评分等级分布（用于柱状图）
export function gradeBuckets(profiles) {
  const buckets = [
    { label: '0-59', min: 0, max: 59, color: '#E24B4A', n: 0 },
    { label: '60-69', min: 60, max: 69, color: '#EF9F27', n: 0 },
    { label: '70-79', min: 70, max: 79, color: '#378ADD', n: 0 },
    { label: '80-89', min: 80, max: 89, color: '#1D9E75', n: 0 },
    { label: '90-100', min: 90, max: 100, color: '#534AB7', n: 0 }
  ]
  for (const p of profiles) {
    const v = p.examAvg ?? p.unitAvg
    if (v == null) continue
    const b = buckets.find((b) => v >= b.min && v <= b.max)
    if (b) b.n++
  }
  return buckets
}

// 排名（按综合分：阶段考均分*0.6 + 单元均分*0.4）
export function ranking(profiles) {
  return [...profiles]
    .map((p) => ({
      sid: p.sid,
      name: p.name,
      score: Math.round((p.examAvg ?? 0) * 0.6 + (p.unitAvg ?? 0) * 0.4),
      examAvg: p.examAvg,
      unitAvg: p.unitAvg,
      xp: p.xp,
      verified: p.verified
    }))
    .sort((a, b) => b.score - a.score)
}

// 顶部错题（高频错点）
export function topWrong(profiles, topN = 10) {
  const map = new Map()
  for (const p of profiles) {
    for (const w of p.wrong) {
      const key = w.unitId + ':' + w.itemId
      map.set(key, (map.get(key) || 0) + 1)
    }
  }
  return [...map.entries()]
    .map(([k, c]) => ({ key: k, count: c }))
    .sort((a, b) => b.count - a.count)
    .slice(0, topN)
}
