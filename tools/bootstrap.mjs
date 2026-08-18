// 一次性引导（方案 Y）：用老师密码派生 Ed25519 公钥，写入三站 public.json，并生成 KV 种子。
//
// 用法：
//   node tools/bootstrap.mjs <老师密码>
//   # 或：BOOTSTRAP_PASSWORD=xxx node tools/bootstrap.mjs
//
// 安全：
//   - 密码只在内存中用于派生，不写入任何文件；私钥不落盘（仅公钥写入 public.json / 环境变量）。
//   - 旧随机密钥(teacher-keys.json)保留在 public.json 数组首位，已签发旧学生仍可激活，平滑过渡。
//
// 前置：在链_supply 目录下三个仓库为同级兄弟目录（learning-platform / sales-platform / teacher-console）。
//       若某学生站仓库不在本地，脚本会跳过并提示你手动把下方派生公钥粘贴进其 src/data/public.json。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { deriveKeyFromPassword, publicJwkFromPrivate } from '../src/identity.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..') // teacher-console/

const password = process.argv[2] || process.env.BOOTSTRAP_PASSWORD
if (!password) {
  console.error('用法：node tools/bootstrap.mjs <老师密码>')
  console.error('   或：BOOTSTRAP_PASSWORD=xxx node tools/bootstrap.mjs')
  process.exit(2)
}

async function main() {
  const priv = await deriveKeyFromPassword(password)
  const pub = publicJwkFromPrivate(priv)
  console.log('[ok] 已用密码派生老师密钥（私钥不落盘）')

  // 三站 public.json：保留旧密钥，追加密码派生公钥
  const sites = [
    { name: 'cs-a', file: join(root, '..', 'learning-platform', 'src', 'data', 'public.json') },
    { name: 'ss-a', file: join(root, '..', 'sales-platform', 'src', 'data', 'public.json') },
    { name: 'tc-a', file: join(root, 'src', 'data', 'public.json') }
  ]
  for (const s of sites) {
    try {
      let arr = []
      if (existsSync(s.file)) {
        const cur = JSON.parse(readFileSync(s.file, 'utf8'))
        arr = Array.isArray(cur) ? cur : [cur]
      } else {
        console.log(`[warn] ${s.name} public.json 不存在（${s.file}），跳过写文件；请手动把下方派生公钥加入其数组。`)
        continue
      }
      if (arr.some((k) => k && k.x === pub.x)) {
        console.log(`[skip] ${s.name} 已含该派生公钥`)
      } else {
        arr.push(pub)
        mkdirSync(dirname(s.file), { recursive: true })
        writeFileSync(s.file, JSON.stringify(arr, null, 2))
        console.log(`[ok] 已写入 ${s.name} public.json（共 ${arr.length} 把公钥）`)
      }
    } catch (e) {
      console.log(`[warn] ${s.name} 写入失败：${e.message}；请手动把下方派生公钥加入其 public.json 数组。`)
    }
  }

  console.log('\n=== 1) 把以下值粘贴到 Cloudflare「学生站 Pages 项目 → Settings → Environment variables」===')
  console.log(`    变量名：TEACHER_PUBLIC_KEY （明文变量，公钥非密）`)
  console.log(`    值：    ${JSON.stringify(pub)}`)
  console.log('    （只需派生公钥即可；Function 用它验签你网页签发的证书。）')

  console.log('\n=== 2) 建 KV 命名空间并绑定（两个学生站各做一次）===')
  console.log('    - Cloudflare 控制台 → Workers & Pages → 你的学生站项目 → Settings → Variables → KV namespaces')
  console.log('    - 新建命名空间（如 certs-kv），绑定名填 CERTS_KV（Production + Preview 都勾上）')
  console.log('    - 新建后重新部署一次学生站，Function 才能读到 CERTS_KV')

  // KV 种子：合并两站现有 certs.json（让 /api/certs 也含已签发旧学生；不填也不影响，学生站会兜底打包名册）
  console.log('\n=== 3) 可选：KV 种子（让远程名册也含旧学生；跳过则学生站用打包名册兜底）===')
  const kvSeed = []
  for (const f of [
    join(root, '..', 'learning-platform', 'src', 'data', 'certs.json'),
    join(root, '..', 'sales-platform', 'src', 'data', 'certs.json')
  ]) {
    if (existsSync(f)) {
      const c = JSON.parse(readFileSync(f, 'utf8'))
      if (Array.isArray(c)) kvSeed.push(...c)
    }
  }
  const seedFile = join(__dirname, 'kv-seed.json')
  writeFileSync(seedFile, JSON.stringify(kvSeed, null, 2))
  console.log(`    [ok] 已写出种子文件 tools/kv-seed.json（${kvSeed.length} 条）`)
  console.log('    用 wrangler 写入（需登录 Cloudflare）：')
  console.log(`      npx wrangler kv key put --binding CERTS_KV certs --path ${seedFile}`)
  console.log('    （每个学生站绑定的 CERTS_KV 都要写一次；或直接在 KV 控制台手动新建键 certs，值为本文件内容。）')

  console.log('\n=== 4) 完成 ===')
  console.log('    重新部署三站（使 public.json 变更与 Function 生效）后，教师端「网页签发并发布」即可纯网页发码、学生即时激活。')
}

main().catch((e) => { console.error('[错误]', e.message); process.exit(1) })
