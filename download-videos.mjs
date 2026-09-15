#!/usr/bin/env node
/**
 * iTab 动态壁纸视频爬虫
 * ==================================================================
 * 视频本体放在公开 CDN 上，不需要登录：
 *   https://files.itab.link/itab/defaultWallpaper/videos/{name}.mp4
 *   https://files.itab.link/itab/defaultWallpaper/videos/{name}.jpg   ← 封面
 *
 * 命名规律只有两种：{数字} 和 v-{数字}
 *
 * 两条路取数据：
 *   1) 枚举 CDN（默认，无需 token）——直接按命名规律探测存在的文件
 *   2) 接口 /wallpaper/video/list（--api，需要 token）——拿完整元数据（_id/名称）
 *   两种都跑时会用接口数据补全 _id
 *
 * 用法：
 *   node download-videos.mjs                     # 枚举 + 下载全部
 *   node download-videos.mjs --poster-only       # 只下封面
 *   node download-videos.mjs --api               # 走接口拿元数据后再下载（读 token.txt）
 *   node download-videos.mjs --list              # 只出清单不下载
 *   node download-videos.mjs --out D:\videos     # 自定义输出目录
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// ------------------------------------------------------------------
// 配置
// ------------------------------------------------------------------
const CDN_DIR = 'https://files.itab.link/itab/defaultWallpaper/videos'
const API = 'https://api.itab.link/api'
const SIGN_KEY = 'itab1314'
const APP_VERSION = '2.2.25'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const cfg = {
  out: path.join(HERE, 'videos'),
  seedDir: path.join(HERE, 'seed'),
  token: '',
  concurrency: 4,
  retries: 3,
  timeout: 120_000,
  // 枚举
  maxPlain: 300, // 普通编号上限
  maxDashed: 300, // v- 编号上限
  missStop: 25, // 连续多少个不存在就停止
  probeConcurrency: 16,
  // 开关
  api: false,
  posterOnly: false,
  skipPoster: false,
  listOnly: false,
  force: false,
  quiet: false,
}

// ------------------------------------------------------------------
// 工具
// ------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fmtSize = (n) =>
  n > 1048576 ? (n / 1048576).toFixed(2) + ' MB' : (n / 1024).toFixed(1) + ' KB'

async function withRetry(fn, tries = cfg.retries) {
  let last
  for (let i = 0; i < tries; i++) {
    try {
      return await fn()
    } catch (e) {
      last = e
      if (e?.noRetry) throw e
      if (i < tries - 1) await sleep(800 * 2 ** i)
    }
  }
  throw last
}

async function pool(items, limit, worker) {
  const out = new Array(items.length)
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      for (;;) {
        const i = cursor++
        if (i >= items.length) return
        try {
          out[i] = await worker(items[i], i)
        } catch (e) {
          out[i] = { error: e.message }
        }
      }
    })
  )
  return out
}

// ---- iTab 接口签名（同扩展 chunks/store-ve3N8KMS.js:2885-2888）----
function evpBytesToKey(passphrase, salt, keyLen, ivLen) {
  const pass = Buffer.from(passphrase, 'utf8')
  let d = Buffer.alloc(0)
  let prev = Buffer.alloc(0)
  while (d.length < keyLen + ivLen) {
    prev = crypto.createHash('md5').update(Buffer.concat([prev, pass, salt])).digest()
    d = Buffer.concat([d, prev])
  }
  return { key: d.subarray(0, keyLen), iv: d.subarray(keyLen, keyLen + ivLen) }
}
function signatureKey(ts = Date.now()) {
  const salt = crypto.randomBytes(8)
  const { key, iv } = evpBytesToKey(SIGN_KEY, salt, 32, 16)
  const c = crypto.createCipheriv('aes-256-cbc', key, iv)
  const ct = Buffer.concat([c.update(String(ts), 'utf8'), c.final()])
  return Buffer.concat([Buffer.from('Salted__', 'ascii'), salt, ct]).toString('base64')
}
async function apiGet(route, params = {}) {
  const url = new URL(API + route)
  url.searchParams.set('lang', 'cn')
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v)
  }
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      signaturekey: signatureKey(),
      version: APP_VERSION,
      mode: 'itab',
      fp: `${Math.random().toString(36).slice(2, 12)}.${String(Date.now()).slice(0, 10)}`,
      ...(cfg.token ? { token: cfg.token } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  })
  const body = await res.json()
  if (body?.code === 401) {
    const e = new Error(`接口需要 token（401）`)
    e.noRetry = true
    throw e
  }
  return body
}

// ------------------------------------------------------------------
// 1. 从 seed 目录收集已有的接口元数据
// ------------------------------------------------------------------
/** 把接口返回的 url 还原成 CDN 里的文件名，作为唯一键 */
const nameOf = (u) => String(u || '').split('?')[0].split('/').pop()

async function loadSeedMeta() {
  const byName = new Map() // name.mp4 -> { _id, url, thumb, poster, from }
  if (!fs.existsSync(cfg.seedDir)) return byName
  for (const f of await fsp.readdir(cfg.seedDir)) {
    if (!f.endsWith('.json')) continue
    try {
      const raw = JSON.parse(await fsp.readFile(path.join(cfg.seedDir, f), 'utf8'))
      const rows = Array.isArray(raw) ? raw : raw.data || []
      for (const r of rows) {
        const n = nameOf(r.url)
        if (!n) continue
        if (!byName.has(n)) byName.set(n, { ...r, from: `seed/${f}` })
      }
      console.log(`  seed/${f}      → ${rows.length} 条`)
    } catch (e) {
      console.log(`  ! seed/${f} 解析失败: ${e.message}`)
    }
  }
  return byName
}

// ------------------------------------------------------------------
// 2. 走接口拿全部页元数据
// ------------------------------------------------------------------
async function loadApiMeta() {
  const byName = new Map()
  let page = 1
  let total = null
  for (;;) {
    let body
    try {
      body = await withRetry(() => apiGet('/wallpaper/video/list', { page, size: 16, sortKey: 'updateTime' }))
    } catch (e) {
      console.log(`  ! 第 ${page} 页失败（${e.message}）`)
      break
    }
    const rows = body.data || []
    if (total === null) total = body.count ?? null
    if (!rows.length) break
    for (const r of rows) {
      const n = nameOf(r.url)
      if (n && !byName.has(n)) byName.set(n, { ...r, from: 'api' })
    }
    console.log(`  接口第 ${page}/${body.pages ?? '?'} 页 → ${rows.length} 条（累计 ${byName.size}${total ? `/${total}` : ''}）`)
    const pages = body.pages || Math.ceil((total || 0) / 16)
    if (page >= pages || page >= 40) break
    page++
    await sleep(250)
  }
  return byName
}

// ------------------------------------------------------------------
// 3. 枚举 CDN 上真实存在的文件
// ------------------------------------------------------------------
async function exists(name) {
  try {
    const r = await fetch(`${CDN_DIR}/${name}`, {
      headers: { 'User-Agent': UA, Range: 'bytes=0-1' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!r.ok && r.status !== 206) return false
    await r.arrayBuffer()
    return true
  } catch {
    return false
  }
}

/** 递增探测，连续 missStop 次不存在就收工 */
async function enumerate(prefix) {
  const found = []
  let misses = 0
  const max = prefix === 'v-' ? cfg.maxDashed : cfg.maxPlain
  let n = 1
  while (n <= max && misses < cfg.missStop) {
    const batch = []
    for (let k = 0; k < cfg.probeConcurrency && n <= max; k++, n++) batch.push(`${prefix}${n}.mp4`)
    const res = await pool(batch, cfg.probeConcurrency, async (name) => ((await exists(name)) ? name : null))
    for (let i = 0; i < res.length; i++) {
      if (res[i]) {
        found.push(res[i])
        misses = 0
      } else {
        misses++
      }
    }
    process.stdout.write(`\r  ${prefix ? prefix + 'N' : 'N'}.mp4 探测到 ${String(n - 1).padStart(3)} … 命中 ${found.length} 个`)
    if (misses >= cfg.missStop) break
  }
  process.stdout.write('\n')
  return found
}

// ------------------------------------------------------------------
// 4. 下载
// ------------------------------------------------------------------
const mapping = []
const stat = { ok: 0, skip: 0, fail: 0 }

async function download(url, dest, label) {
  if (!cfg.force) {
    try {
      const st = await fsp.stat(dest)
      if (st.size > 0) {
        stat.skip++
        if (!cfg.quiet) console.log(`  · 已存在 ${label}  (${fmtSize(st.size)})`)
        return st.size
      }
    } catch {
      /* 无 */
    }
  }
  await fsp.mkdir(path.dirname(dest), { recursive: true })
  const tmp = dest + '.part'
  try {
    await withRetry(async () => {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Referer: 'https://www.itab.link/' },
        signal: AbortSignal.timeout(cfg.timeout),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      if (!res.body) throw new Error('响应无 body')
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp))
    })
  } catch (e) {
    await fsp.rm(tmp, { force: true })
    stat.fail++
    console.log(`  ✗ 失败 ${label} → ${e.message}`)
    return 0
  }
  await fsp.rename(tmp, dest)
  const st = await fsp.stat(dest)
  stat.ok++
  console.log(`  ✓ ${label}  (${fmtSize(st.size)})`)
  return st.size
}

// ------------------------------------------------------------------
// main
// ------------------------------------------------------------------
function parseArgs(argv) {
  const a = argv.slice(2)
  const num = (v, d) => (v === undefined ? d : Number(v))
  for (let i = 0; i < a.length; i++) {
    const k = a[i]
    const nx = () => a[++i]
    switch (k) {
      case '--out': case '-o': cfg.out = path.resolve(nx()); break
      case '--token': cfg.token = String(nx()).trim(); break
      case '--seed-dir': cfg.seedDir = path.resolve(nx()); break
      case '--concurrency': case '-c': cfg.concurrency = num(nx(), cfg.concurrency); break
      case '--api': cfg.api = true; break
      case '--poster-only': cfg.posterOnly = true; break
      case '--no-poster': cfg.skipPoster = true; break
      case '--list': case '--dry-run': cfg.listOnly = true; break
      case '--force': cfg.force = true; break
      case '--quiet': case '-q': cfg.quiet = true; break
      case '--miss-stop': cfg.missStop = num(nx(), cfg.missStop); break
      case '--help': case '-h':
        console.log(`
iTab 动态壁纸视频爬虫

  -o, --out <目录>        输出目录（默认 ./videos）
  -c, --concurrency <n>   并发下载（默认 4）
      --api               走 /wallpaper/video/list 接口拿元数据（需 token.txt）
      --token <t>         直接指定 token
      --seed-dir <目录>   接口 JSON 种子目录（默认 ./seed）
      --poster-only       只下载封面图
      --no-poster         跳过封面图
      --list              只输出清单，不下载
      --force             覆盖已存在文件
      --miss-stop <n>     枚举时连续 n 次不存在即停止（默认 25）
`)
        process.exit(0)
      default:
        console.error(`未知参数: ${k}`)
        process.exit(1)
    }
  }
}
parseArgs(process.argv)

if (!cfg.token) {
  try {
    const line = fs
      .readFileSync(path.join(HERE, 'token.txt'), 'utf8')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s && !s.startsWith('#'))
    if (line) cfg.token = line.replace(/^"|"$/g, '')
  } catch {
    /* 无 */
  }
}

console.log('='.repeat(70))
console.log('iTab 动态壁纸视频爬虫')
console.log(`  输出目录 : ${cfg.out}`)
console.log(`  并发     : ${cfg.concurrency}`)
console.log(`  token    : ${cfg.token ? '已就绪' : '未提供'}`)
console.log('='.repeat(70))

// --- 元数据 ---
console.log('\n[1/3] 收集接口元数据')
const meta = await loadSeedMeta()
if (cfg.api) {
  if (!cfg.token) {
    console.log('  ! --api 需要 token（写入 token.txt），跳过接口，仅用 seed + 枚举')
  } else {
    const m = await loadApiMeta()
    for (const [k, v] of m) if (!meta.has(k)) meta.set(k, v)
  }
}
console.log(`  元数据共 ${meta.size} 条（含 _id 可比对）`)

// --- 枚举 ---
console.log('\n[2/3] 枚举 CDN 上实际存在的视频')
const names = [...(await enumerate('')), ...(await enumerate('v-'))]
names.sort((a, b) => {
  const ka = /^v-/.test(a) ? 100000 + parseInt(a.slice(2)) : parseInt(a)
  const kb = /^v-/.test(b) ? 100000 + parseInt(b.slice(2)) : parseInt(b)
  return ka - kb
})
console.log(`  命中 ${names.length} 个视频`)

// 接口里有、CDN 上没有的（多为重复条目）
const have = new Set(names)
const onlyInApi = [...meta.keys()].filter((n) => !have.has(n))
if (onlyInApi.length) {
  console.log(`  注：接口有 ${meta.size} 条，其中 ${onlyInApi.length} 条在 CDN 上不存在（重复条目或已下架）：`)
  console.log(`      ${onlyInApi.join(', ')}`)
}

// --- 下载 ---
console.log(`\n[3/3] ${cfg.listOnly ? '生成清单' : '下载'} → ${cfg.out}`)
await fsp.mkdir(cfg.out, { recursive: true })

const jobs = names.map((file) => {
  const stem = file.replace(/\.mp4$/, '')
  const m = meta.get(file) || {}
  return {
    file,
    stem,
    videoUrl: m.url || `${CDN_DIR}/${file}`,
    posterUrl: m.poster || `${CDN_DIR}/${stem}.jpg`,
    id: m._id || '',
    meta: m,
  }
})

if (!cfg.listOnly) {
  const downloaded = await pool(jobs, cfg.concurrency, async (j) => {
    let bytes = 0
    if (!cfg.posterOnly) {
      bytes = await download(j.videoUrl, path.join(cfg.out, j.file), j.file)
    }
    if (!cfg.skipPoster) {
      const pst = path.join(cfg.out, 'posters', `${j.stem}.jpg`)
      if (cfg.posterOnly || bytes > 0) await download(j.posterUrl, pst, `posters/${j.stem}.jpg`)
      else if (!cfg.force) {
        // 视频已存在的情况也要保证封面在
        await download(j.posterUrl, pst, `posters/${j.stem}.jpg`)
      }
    }
    return bytes
  })
  jobs.forEach((j, i) => (j.bytes = downloaded[i] || 0))
}

// --- 映射表 ---
for (const j of jobs) {
  mapping.push({
    id: j.id,
    file: j.file,
    poster: cfg.skipPoster ? '' : `posters/${j.stem}.jpg`,
    video_url: j.videoUrl,
    poster_url: j.posterUrl,
    bytes: j.bytes || 0,
    status: cfg.listOnly ? 'listed' : j.bytes > 0 ? 'ok' : 'exists-or-failed',
    meta: Object.keys(j.meta).length ? j.meta : null,
  })
}

await fsp.writeFile(path.join(cfg.out, 'mapping.json'), JSON.stringify(mapping, null, 2))
const head = ['id', 'file', 'poster', 'bytes', 'status', 'video_url', 'poster_url']
const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
await fsp.writeFile(
  path.join(cfg.out, 'mapping.csv'),
  '\uFEFF' + [head.join(','), ...mapping.map((m) => head.map((k) => esc(m[k])).join(','))].join('\n'),
  'utf8'
)

// 只包含接口元数据的索引（按 _id 查文件名）
const byId = Object.fromEntries(mapping.filter((m) => m.id).map((m) => [m.id, m.file]))
await fsp.writeFile(path.join(cfg.out, 'id-to-file.json'), JSON.stringify(byId, null, 2))

const totalBytes = mapping.reduce((s, m) => s + (m.bytes || 0), 0)
console.log('\n' + '='.repeat(70))
console.log(`视频 ${names.length} 个 · 有 _id 的 ${Object.keys(byId).length} 个`)
console.log(`新增 ${stat.ok} · 已存在 ${stat.skip} · 失败 ${stat.fail}`)
if (totalBytes) console.log(`本次/累计占用约 ${(totalBytes / 1048576).toFixed(1)} MB`)
console.log(`映射表 ${path.join(cfg.out, 'mapping.json')}`)
console.log(`       ${path.join(cfg.out, 'mapping.csv')}`)
console.log(`ID 索引 ${path.join(cfg.out, 'id-to-file.json')}`)
