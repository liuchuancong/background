#!/usr/bin/env node
/**
 * iTab 壁纸爬虫
 * ==================================================================
 * 数据来源（全部来自抓包验证，域名是 base.itab.link，**不需要 token**）：
 *
 *   官方壁纸   GET base.itab.link/wallpaper/list
 *              ?lang=cn&sr=3840x2160&size=24&page=N&category=<分类>&sortKey=updateTime
 *              分类：'' (全部) / nature / acg / art / architecture / life / geometry / other
 *              单条：{ raw, thumb, id }     ← 没有 name 字段
 *
 *   Wallhaven  GET base.itab.link/wallhaven/category        ← 19 个中文主题分类
 *              GET base.itab.link/wallpaper/wallhaven?sr=&page=&size=&q=id:<分类id>
 *              单条：{ raw, thumb, id, name }  name 是 wallhaven 图片号
 *              热门不传 q；科幻=q=id:14，图案=id:869，风景=id:711 …
 *
 *   必应       GET base.itab.link/bing/list?lang=cn&page=N&size=16
 *              iTab 自建的必应历史库，约 2030 条（≈ 5 年多）
 *              单条：{ _id, enddate, copyright, urlbase, raw, thumb }
 *              urlbase 里含英文 slug：OHR.RedMacawsFlight_ZH-CN... → red-macaws-flight
 *              4K：raw 里 `1920x1080.jpg&rf=LaDigue_1920x1080.jpg&pid=hp` → `UHD.jpg`
 *
 *   deepin     GET files.itab.link/wallpaper/deepin/{0..25}.jpg   固定 26 张
 *
 * 目录结构：
 *   wallpapers/official/<分类>/<英文名>.jpg      保留分类
 *   wallpapers/wallhaven/<分类>/<英文名>.jpg     保留分类
 *   wallpapers/bing/<英文名>.jpg                 无分类，平铺
 *   wallpapers/deepin/<英文名>.jpg               无分类，平铺
 *
 *   wallpapers/<来源>/mapping.json               每个来源独立的映射表
 *   wallpapers/<来源>/mapping.csv
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// ==================================================================
// 0. 配置
// ==================================================================
const FILES = 'https://files.itab.link'
const BASE = 'https://base.itab.link' // ★ 抓包确认：不是 api.itab.link
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'

const cfg = {
  sources: [],
  out: path.join(HERE, 'wallpapers'),
  pages: 10,
  size: 24,
  sr: '3840x2160', // 抓包确认是 WxH；给 3840x2160 时服务端返回最大宽度 2560
  sortKey: 'updateTime',
  days: 0,
  concurrency: 6,
  retries: 3,
  timeout: 90_000,
  limit: 0, // 每个来源总量上限，0 = 不限
  whCategory: '', // wallhaven 分类筛选：英文目录名 / 中文标签 / 原始 id，逗号分隔
  showCategories: false,
  listOnly: false,
  force: false,
  quiet: false,
}

/**
 * 官方壁纸分类（扩展里硬编码，见 chunks/index-BwPVRbSv.js:2291-2300）
 * 注意：没有列 «全部»（category 为空）—— 它和下面 7 个分类完全重叠，
 * 先跑会把图提前"抢"走导致各分类不全。7 个分类加起来已经覆盖全部壁纸。
 */
const OFFICIAL_CATEGORIES = [
  { id: 'nature', label: 'nature' },
  { id: 'acg', label: 'anime' },
  { id: 'art', label: 'art' },
  { id: 'architecture', label: 'architecture' },
  { id: 'life', label: 'life' },
  { id: 'geometry', label: 'geometry' },
  { id: 'other', label: 'other' },
]

/** Wallhaven 分类中文标签 → 英文目录名（id 从 /wallhaven/category 动态取） */
const WALLHAVEN_LABELS = {
  热门: 'popular',
  极简主义: 'minimalism',
  图案: 'patterns',
  风景: 'landscape',
  自然: 'nature',
  Cosplay: 'cosplay',
  蜘蛛侠: 'spiderman',
  吉卜力: 'ghibli',
  火影忍者: 'naruto',
  科幻: 'sci-fi',
  日漫: 'anime',
  动漫女孩: 'anime-girls',
  赛博朋克: 'cyberpunk',
  像素艺术: 'pixel-art',
  Artwork: 'artwork',
  Cityscape: 'cityscape',
  'Digital Art': 'digital-art',
  'Fantasy Art': 'fantasy-art',
  'Final Fantasy': 'final-fantasy',
}
/** 分类清单兜底（接口挂了也能跑），顺序与扩展侧边栏一致 */
const WALLHAVEN_FALLBACK = [
  { label: '热门', id: '' },
  { label: '极简主义', id: 'id:2278' },
  { label: '图案', id: 'id:869' },
  { label: '风景', id: 'id:711' },
  { label: '自然', id: 'id:37' },
  { label: 'Cosplay', id: 'id:12757' },
  { label: '蜘蛛侠', id: 'id:2319' },
  { label: '吉卜力', id: 'id:1748' },
  { label: '火影忍者', id: 'id:78174' },
  { label: '科幻', id: 'id:14' },
  { label: '日漫', id: 'id:1' },
  { label: '动漫女孩', id: 'id:5' },
  { label: '赛博朋克', id: 'id:376' },
  { label: '像素艺术', id: 'id:2321' },
  { label: 'Artwork', id: 'id:323' },
  { label: 'Cityscape', id: 'id:479' },
  { label: 'Digital Art', id: 'id:13' },
  { label: 'Fantasy Art', id: 'id:853' },
  { label: 'Final Fantasy', id: 'id:997' },
]
/** 标签 → 英文目录名；表里没有就退化成 slug */
const whDir = (label) => WALLHAVEN_LABELS[String(label || '').trim()] || slugify(label) || 'other'

/** 按 英文目录名 / 中文标签 / 原始 id 任一匹配筛选分类 */
function filterWallhavenCats(cats, spec) {
  const want = String(spec || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  if (!want.length) return cats
  return cats.filter((c) => {
    const dir = whDir(c.label).toLowerCase()
    const label = String(c.label || '').trim().toLowerCase()
    const id = String(c.id || '').trim().toLowerCase()
    return want.includes(dir) || want.includes(label) || want.includes(id)
  })
}

/** 打印分类对照表 */
function printWallhavenCats(cats) {
  console.log('\n  wallhaven 分类对照（--wh-category 可用英文目录名 / 中文标签 / 原始 id）：')
  console.log('  ' + '英文目录名'.padEnd(16) + '中文标签'.padEnd(16) + 'q 参数')
  console.log('  ' + '-'.repeat(48))
  for (const c of cats) {
    console.log('  ' + whDir(c.label).padEnd(16) + String(c.label || '').padEnd(16) + (c.id || '(不传)'))
  }
  console.log('')
}

// ==================================================================
// 1. 工具
// ==================================================================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fmtSize = (n) => (n > 1048576 ? (n / 1048576).toFixed(2) + ' MB' : (n / 1024).toFixed(1) + ' KB')
const extOf = (u, fb = 'jpg') => {
  const e = String(u || '').split('?')[0].split('#')[0].split('.').pop()
  return e && e.length <= 5 && /^[a-z0-9]+$/i.test(e) ? e.toLowerCase() : fb
}
function slugify(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[^\x00-\x7F]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72)
}
/** CDN 原始文件名（官方壁纸没有 name，只能用这个当文件名） */
const cdnBase = (u) => String(u || '').split('?')[0].split('/').pop().replace(/\.[a-z0-9]+$/i, '')

async function withRetry(fn, tries = cfg.retries) {
  let last
  for (let i = 0; i < tries; i++) {
    try {
      return await fn()
    } catch (e) {
      last = e
      if (e?.noRetry) throw e
      if (i < tries - 1) await sleep(700 * 2 ** i)
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

/** base.itab.link 请求头（照抄扩展实际发的） */
const baseHeaders = () => ({
  'User-Agent': UA,
  fp: 'zhVusd_0lS.1758762915',
  mode: 'itab',
  origin: 'chrome-extension://mhloojimgilafopcmlcikiidgbbnelip',
  version: '2.2.25',
  accept: 'application/json, text/plain, */*',
})

async function apiGet(route, params = {}) {
  const url = new URL(BASE + route)
  url.searchParams.set('lang', 'cn')
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v)
  return withRetry(async () => {
    const res = await fetch(url, { headers: baseHeaders(), signal: AbortSignal.timeout(30_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = await res.json()
    if (body?.code && body.code !== 200) throw new Error(`code=${body.code} ${body.msg || ''}`)
    return body || {}
  })
}

// ==================================================================
// 2. 下载 & 每个叶子目录一份映射表
// ==================================================================
/**
 * 叶子目录规则：
 *   bing      → wallpapers/bing/                        （无分类，平铺）
 *   deepin    → wallpapers/deepin/                      （无分类，平铺）
 *   wallhaven → wallpapers/wallhaven/<general|anime|people>/
 *   official  → wallpapers/official/<分类>/
 * 图片放叶子目录下的 images/，映射表放叶子目录下：mapping.json / mapping.csv / id-to-file.json
 */
function leafOf(rec) {
  if (rec.source === 'bing' || rec.source === 'deepin') return path.join(cfg.out, rec.source)
  return path.join(cfg.out, rec.source, rec.category || 'other')
}

/** 叶子目录(相对路径) -> { items, stat } */
const STORE = new Map()
function bucket(leaf) {
  if (!STORE.has(leaf)) STORE.set(leaf, { items: [], stat: { ok: 0, skip: 0, fail: 0 } })
  return STORE.get(leaf)
}
/** 来源 -> 汇总统计（只用于最后的打印） */
const SRC_STAT = new Map()
function bump(source, key) {
  if (!SRC_STAT.has(source)) SRC_STAT.set(source, { ok: 0, skip: 0, fail: 0, count: 0 })
  SRC_STAT.get(source)[key]++
}

async function saveOne(rec) {
  const ext = rec.ext || extOf(rec.url, 'jpg')
  const leaf = leafOf(rec)
  const b = bucket(leaf)
  const dir = path.join(leaf, 'images')
  const base = `${rec.slug}.${ext}`
  const dest = path.join(dir, base)
  const rel = path.relative(cfg.out, dest).split(path.sep).join('/')

  const entry = {
    source: rec.source,
    category: rec.category || '',
    id: rec.id ?? '',
    name: rec.name ?? '',
    file: rel,
    url: rec.url,
    thumb: rec.thumb ?? '',
    bytes: 0,
    status: 'pending',
    api: rec.raw ?? null,
  }

  if (cfg.listOnly) {
    entry.status = 'listed'
    b.items.push(entry)
    return entry
  }

  if (!cfg.force) {
    try {
      const st = await fsp.stat(dest)
      if (st.size > 0) {
        b.stat.skip++
        bump(rec.source, 'skip')
        entry.bytes = st.size
        entry.status = 'exists'
        b.items.push(entry)
        if (!cfg.quiet) console.log(`  · 已存在 ${rel}`)
        return entry
      }
    } catch {
      /* 不存在 */
    }
  }

  await fsp.mkdir(path.dirname(dest), { recursive: true })
  const tmp = dest + '.part'
  try {
    await withRetry(async () => {
      const res = await fetch(rec.url, {
        headers: { 'User-Agent': UA, Referer: 'https://www.itab.link/' },
        signal: AbortSignal.timeout(cfg.timeout),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      if (!res.body) throw new Error('响应无 body')
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp))
    })
  } catch (e) {
    await fsp.rm(tmp, { force: true })
    b.stat.fail++
    bump(rec.source, 'fail')
    entry.status = 'failed'
    entry.error = e.message
    b.items.push(entry)
    console.log(`  ✗ ${rel} → ${e.message}`)
    return entry
  }
  await fsp.rename(tmp, dest)
  const st = await fsp.stat(dest)
  b.stat.ok++
  bump(rec.source, 'ok')
  entry.bytes = st.size
  entry.status = 'ok'
  b.items.push(entry)
  console.log(`  ✓ ${rel}  (${fmtSize(st.size)})`)
  return entry
}

/** 落盘：每个叶子目录一份 mapping.json / mapping.csv / id-to-file.json */
async function flushMappings() {
  await fsp.mkdir(cfg.out, { recursive: true })
  const head = ['id', 'name', 'category', 'file', 'bytes', 'status', 'url', 'thumb']
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
  for (const [leaf, b] of STORE) {
    await fsp.mkdir(path.join(leaf, 'images'), { recursive: true })
    await fsp.writeFile(path.join(leaf, 'mapping.json'), JSON.stringify(b.items, null, 2))
    await fsp.writeFile(
      path.join(leaf, 'mapping.csv'),
      '\uFEFF' + [head.join(','), ...b.items.map((m) => head.map((k) => esc(m[k])).join(','))].join('\n'),
      'utf8'
    )
    const byId = Object.fromEntries(b.items.filter((m) => m.id).map((m) => [m.id, path.basename(m.file)]))
    if (Object.keys(byId).length) {
      await fsp.writeFile(path.join(leaf, 'id-to-file.json'), JSON.stringify(byId, null, 2))
    }
  }
}

// ==================================================================
// 3. 各来源
// ==================================================================
const SOURCES = {}

/** ---------- 官方壁纸（base.itab.link/wallpaper/list）---------- */
SOURCES.official = {
  label: 'iTab 官方壁纸库',
  async run() {
    const seen = new Set()
    let collected = 0
    for (const cat of OFFICIAL_CATEGORIES) {
      console.log(`\n  [分类] ${cat.label}${cat.id ? ` (${cat.id})` : ' (全部)'}`)
      let catCount = 0
      for (let page = 1; page <= cfg.pages; page++) {
        let body
        try {
          body = await apiGet('/wallpaper/list', {
            sr: cfg.sr,
            size: cfg.size,
            page,
            category: cat.id,
            sortKey: cfg.sortKey,
          })
        } catch (e) {
          console.log(`  ✗ 第 ${page} 页失败: ${e.message}`)
          break
        }
        const rows = (body.data || []).filter((r) => {
          const id = r.id ?? r._id
          // 跨分类去重：同一张图可能同时出现在「全部」和某个分类里
          if (!id || seen.has(id)) return false
          seen.add(id)
          return true
        })
        if (!rows.length) break
        catCount += rows.length
        collected += rows.length
        const est = body.count ? ` / ${body.count}` : ''
        console.log(`    第 ${page} 页 +${rows.length}（本分类 ${catCount}${est}）`)
        await pool(
          rows.map((r) => ({
            source: 'official',
            category: cat.label,
            id: r.id ?? r._id,
            name: cdnBase(r.raw),
            // 官方壁纸接口没有 name 字段，只能用 CDN 原始文件名当文件名（ASCII）
            slug: slugify(cdnBase(r.raw)) || `official-${r.id ?? r._id}`,
            url: r.raw,
            thumb: r.thumb,
            raw: r,
          })),
          cfg.concurrency,
          saveOne
        )
        if (cfg.limit && collected >= cfg.limit) break
        if (body.count && catCount >= body.count) break
        await sleep(200)
      }
      if (cfg.limit && collected >= cfg.limit) {
        console.log(`  达到总量上限 ${cfg.limit}，停止`)
        break
      }
    }
    console.log(`  官方壁纸合计 ${collected} 张`)
  },
}

/** ---------- Wallhaven（iTab 代理，19 个中文主题分类）----------
 * 分类清单：GET base.itab.link/wallhaven/category   → [{ label, id }]
 *   热门 -> id 为空（不传 q）
 *   科幻 -> id:14   图案 -> id:869   风景 -> id:711   自然 -> id:37 …
 * 取图：    GET base.itab.link/wallpaper/wallhaven?sr=&page=&size=&q=id:14
 *   → data:[{ raw, thumb, id, name }]   name 是 wallhaven 图片号（如 965258）
 */
SOURCES.wallhaven = {
  label: 'Wallhaven（iTab 代理，19 个主题分类）',
  async run() {
    let cats = WALLHAVEN_FALLBACK
    try {
      const c = await apiGet('/wallhaven/category', {})
      if (Array.isArray(c.data) && c.data.length) {
        cats = c.data
        console.log(`  /wallhaven/category 返回 ${cats.length} 个分类`)
      }
    } catch (e) {
      console.log(`  ! 分类接口失败（${e.message}），用内置兜底清单`)
    }

    if (cfg.whCategory) {
      const before = cats.length
      cats = filterWallhavenCats(cats, cfg.whCategory)
      console.log(`  --wh-category "${cfg.whCategory}" → 命中 ${cats.length}/${before} 个分类`)
      if (!cats.length) {
        console.log(`  ✗ 没有匹配的分类`)
        printWallhavenCats(WALLHAVEN_FALLBACK)
        return
      }
    }

    const seen = new Set()
    let collected = 0
    for (const cat of cats) {
      const dir = whDir(cat.label)
      console.log(`\n  [分类] ${cat.label || '热门'}  q=${cat.id || '(不传)'}  → wallhaven/${dir}/`)
      let catCount = 0
      for (let page = 1; page <= (cfg.pages === 0 ? 1000 : cfg.pages); page++) {
        let body
        try {
          body = await apiGet('/wallpaper/wallhaven', { sr: cfg.sr, page, size: cfg.size, q: cat.id })
        } catch (e) {
          console.log(`  ✗ 第 ${page} 页失败: ${e.message}`)
          break
        }
        const rows = (body.data || []).filter((r) => {
          const id = r.id ?? r._id
          if (!id || seen.has(id)) return false
          seen.add(id)
          return true
        })
        if (!rows.length) break
        catCount += rows.length
        collected += rows.length
        console.log(`    第 ${page} 页 +${rows.length}（本分类 ${catCount}${body.count ? ` / ${body.count}` : ''}）`)
        await pool(
          rows.map((r) => {
            // name 形如 "965258"，是 wallhaven 的图片号
            const num = String(r.name || '').trim()
            return {
              source: 'wallhaven',
              category: dir,
              categoryLabel: cat.label || '热门',
              id: r.id ?? r._id,
              name: num,
              slug: slugify(num ? `wallhaven-${num}` : '') || `wallhaven-${r.id ?? r._id}`,
              url: r.raw,
              thumb: r.thumb,
              raw: { ...r, _categoryLabel: cat.label, _categoryQ: cat.id },
            }
          }),
          cfg.concurrency,
          saveOne
        )
        if (cfg.limit && collected >= cfg.limit) break
        if (body.count && catCount >= body.count) break
        await sleep(200)
      }
      if (cfg.limit && collected >= cfg.limit) {
        console.log(`  达到总量上限 ${cfg.limit}，停止`)
        break
      }
    }
    console.log(`  Wallhaven 合计 ${collected} 张`)
  },
}

/** ---------- 必应每日壁纸（iTab 自建的必应历史库，无分类 → 平铺）----------
 * GET base.itab.link/bing/list?lang=cn&page=N&size=16
 *   → { code, data:[{ _id, enddate, copyright, urlbase, raw, thumb }], count }
 *   count 约 2030（≈ 5 年多的每日壁纸），pages 字段不可靠，靠"返回空即停"翻页。
 *   size 服务端固定 16，传再大也只回 16 条。
 *   英文名取自 urlbase 里的 OHR.<Slug>（必应自己的英文标识）。
 *   4K：把 raw 里的 `1920x1080.jpg&rf=LaDigue_1920x1080.jpg&pid=hp` 换成 `UHD.jpg`
 *       —— 这是扩展「下载4k壁纸」按钮的原逻辑（chunks/index-BwPVRbSv.js:205）
 */
SOURCES.bing = {
  label: '必应每日壁纸（iTab 历史库，无分类 → 平铺）',
  async run() {
    const SIZE = 16 // 服务端固定
    const BING = 'https://base.itab.link/bing/list'
    /**
     * 同一天同一张图会有多个地区版本：
     *   OHR.SummitEverest_ZH-CN9252833251   ← 中文
     *   OHR.SummitEverest_DE-DE3618626129   ← 德文
     *   OHR.SummitEverest_JA-JP9857275970   ← 日文
     * slug 一样、只是 locale 不同，属于同一张壁纸。
     * 所以按「enddate + slug」去重，并优先保留 ZH-CN 版本。
     */
    const picked = new Map()
    const maxPages = cfg.pages === 0 ? 2000 : cfg.pages
    let total = null
    let raw = 0

    for (let page = 1; page <= maxPages; page++) {
      let body
      try {
        body = await withRetry(async () => {
          const u = new URL(BING)
          u.searchParams.set('lang', 'cn')
          u.searchParams.set('page', String(page))
          u.searchParams.set('size', String(SIZE))
          const r = await fetch(u, { headers: baseHeaders(), signal: AbortSignal.timeout(30_000) })
          if (!r.ok) throw new Error(`HTTP ${r.status}`)
          return r.json()
        })
      } catch (e) {
        console.log(`  ! 第 ${page} 页失败: ${e.message}`)
        break
      }
      if (total === null && body.count) total = body.count
      const rows = body.data || []
      if (!rows.length) {
        console.log(`  第 ${page} 页为空，翻页结束`)
        break
      }
      raw += rows.length
      for (const r of rows) {
        const m = String(r.urlbase || r.raw || '').match(/OHR\.([A-Za-z0-9]+)_/)
        const engSlug = m ? m[1] : ''
        const key = `${r.enddate}_${engSlug || r._id}`
        const prev = picked.get(key)
        const isZh = /ZH-CN/i.test(String(r.urlbase || ''))
        const prevZh = prev && /ZH-CN/i.test(String(prev.urlbase || ''))
        if (!prev || (isZh && !prevZh)) picked.set(key, r)
      }
      if (page % 10 === 0 || page === 1) {
        console.log(`  第 ${page} 页 → 原始 ${raw} 条 / 去重后 ${picked.size} 张${total ? `（接口共 ${total}）` : ''}`)
      }
      await sleep(120)
    }

    const uhd = (u) => String(u || '').replace('1920x1080.jpg&rf=LaDigue_1920x1080.jpg&pid=hp', 'UHD.jpg')
    const jobs = []
    for (const r of picked.values()) {
      const m = String(r.urlbase || r.raw || '').match(/OHR\.([A-Za-z0-9]+)_/)
      const engSlug = m ? m[1] : ''
      const name = engSlug
        ? engSlug.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        : ''
      jobs.push({
        source: 'bing',
        id: r._id ?? r.enddate,
        name: name || r.enddate,
        slug: `${r.enddate}_${slugify(name) || 'bing'}`,
        url: uhd(r.raw || r.fullSrc),
        thumb: r.thumb,
        ext: 'jpg',
        raw: r,
      })
    }
    console.log(`  必应合计 ${jobs.length} 张（原始 ${raw} 条，去掉同图多语言版本 ${raw - jobs.length} 条）`)
    await pool(jobs, Math.min(cfg.concurrency, 6), saveOne)
  },
}

/** ---------- deepin（无分类，平铺；名字来自看图人工命名）---------- */
SOURCES.deepin = {
  label: 'deepin · UOS 内置壁纸（26 张，无分类 → 平铺）',
  async run() {
    const map = JSON.parse(fs.readFileSync(path.join(HERE, 'data', 'deepin-names.json'), 'utf8')).items
    const jobs = Object.entries(map).map(([i, v]) => ({
      source: 'deepin',
      id: String(i),
      name: v.name,
      slug: slugify(v.name) || `deepin-${i}`,
      category: v.category,
      url: `${FILES}/wallpaper/deepin/${i}.jpg`,
      thumb: `${FILES}/wallpaper/deepin/${i}.jpg?x-oss-process=image/resize,limit_0,m_fill,w_300,h_156/quality,q_96/format,webp`,
      ext: 'jpg',
      raw: { index: Number(i), provider: 'deepin/UOS', note: 'named by vision' },
    }))
    await pool(jobs, cfg.concurrency, saveOne)
  },
}

// ==================================================================
// 4. CLI
// ==================================================================
const GROUPS = {
  all: Object.keys(SOURCES),
  public: ['official', 'wallhaven', 'bing', 'deepin'],
}

function usage() {
  console.log(`
iTab 壁纸爬虫（不需要 token）

  -s, --source <名称[,名称]>   official / wallhaven / bing / deepin
                               分组：all（默认）
  -o, --out <目录>             输出目录（默认 ./wallpapers）
  -p, --pages <n>              每个分类抓取页数（默认 10；填 0 = 全部翻到底）
      --size <n>               每页条数（默认 24；必应固定 16）
      --sr <3840x2160>         分辨率参数（默认 3840x2160，服务端给最大 2560 宽）
      --sort <updateTime|useTotal|random>
      --limit <n>              每个来源总量上限（默认 0 不限）
      --wh-category <名称[,名称]>  wallhaven 只要某几个分类
                               可用 英文目录名(sci-fi) / 中文标签(科幻) / 原始 id(id:14)
      --show-categories        只打印 wallhaven 分类对照表后退出
  -c, --concurrency <n>        并发（默认 6）
      --list                   只出清单不下载
      --force                  覆盖已存在文件
  -q, --quiet                  精简输出

目录：
  wallpapers/bing/          images/ + mapping.json   无分类，平铺
  wallpapers/deepin/        images/ + mapping.json   无分类，平铺
  wallpapers/wallhaven/<19 个主题分类>/   images/ + mapping.json
      popular 热门 · minimalism 极简主义 · patterns 图案 · landscape 风景 · nature 自然
      cosplay · spiderman 蜘蛛侠 · ghibli 吉卜力 · naruto 火影忍者 · sci-fi 科幻
      anime 日漫 · anime-girls 动漫女孩 · cyberpunk 赛博朋克 · pixel-art 像素艺术
      artwork · cityscape · digital-art · fantasy-art · final-fantasy
  wallpapers/official/<分类>/   nature anime art architecture life geometry other
  （--show-categories 可查看完整对照表）
`)
}
function parseArgs(argv) {
  const a = argv.slice(2)
  const num = (v, d) => (v === undefined ? d : Number(v))
  for (let i = 0; i < a.length; i++) {
    const k = a[i]
    const nx = () => a[++i]
    switch (k) {
      case '--source': case '-s':
        cfg.sources.push(...String(nx()).split(',').map((x) => x.trim()).filter(Boolean)); break
      case '--out': case '-o': cfg.out = path.resolve(nx()); break
      case '--pages': case '-p': cfg.pages = num(nx(), cfg.pages); break
      case '--size': cfg.size = num(nx(), cfg.size); break
      case '--sr': cfg.sr = nx(); break
      case '--sort': cfg.sortKey = nx(); break
      case '--limit': cfg.limit = num(nx(), 0); break
      case '--wh-category': case '--wallhaven-category': cfg.whCategory = nx(); break
      case '--show-categories': cfg.showCategories = true; break
      case '--concurrency': case '-c': cfg.concurrency = num(nx(), cfg.concurrency); break
      case '--list': case '--dry-run': cfg.listOnly = true; break
      case '--force': cfg.force = true; break
      case '--quiet': case '-q': cfg.quiet = true; break
      case '--help': case '-h': usage(); process.exit(0); break
      default:
        console.error(`未知参数: ${k}`)
        usage()
        process.exit(1)
    }
  }
}
parseArgs(process.argv)

// --show-categories：只打印对照表就退出
if (cfg.showCategories) {
  let cats = WALLHAVEN_FALLBACK
  try {
    const c = await apiGet('/wallhaven/category', {})
    if (Array.isArray(c.data) && c.data.length) cats = c.data
  } catch (e) {
    console.log(`! 分类接口失败（${e.message}），下面是内置兜底清单`)
  }
  printWallhavenCats(cats)
  console.log(`  用法示例： node download-wallpapers.mjs --source wallhaven --wh-category sci-fi`)
  console.log(`             node download-wallpapers.mjs --source wallhaven --wh-category "科幻,图案"`)
  process.exit(0)
}

if (!cfg.sources.length) cfg.sources = ['all']
const expanded = []
for (const s of cfg.sources) {
  if (GROUPS[s]) expanded.push(...GROUPS[s])
  else if (SOURCES[s]) expanded.push(s)
  else {
    console.error(`未知来源: ${s}\n可用: ${Object.keys(SOURCES).join(', ')}`)
    process.exit(1)
  }
}
const targets = [...new Set(expanded)]

console.log('='.repeat(70))
console.log('iTab 壁纸爬虫')
console.log(`  来源   : ${targets.join(', ')}`)
console.log(`  页数   : ${cfg.pages} / 分类    每页 ${cfg.size}`)
console.log(`  分辨率 : sr=${cfg.sr}`)
console.log(`  输出   : ${cfg.out}`)
console.log(`  上限   : ${cfg.limit || '不限'}`)
console.log('  token  : 不需要（抓包确认）')
console.log('='.repeat(70))

await fsp.mkdir(cfg.out, { recursive: true })
const t0 = Date.now()

// 每个来源开始前先把空映射表写出来，方便中断后仍能看到结构
for (const name of targets) {
  console.log(`\n▶ [${name}] ${SOURCES[name].label}`)
  const s0 = Date.now()
  try {
    await SOURCES[name].run()
  } catch (e) {
    console.log(`  ✗ 来源 ${name} 中断: ${e.message}`)
  }
  await flushMappings()
  const st = SRC_STAT.get(name) || { ok: 0, skip: 0, fail: 0 }
  console.log(`  ⏱ ${((Date.now() - s0) / 1000).toFixed(1)}s  新增 ${st.ok} · 已存在 ${st.skip} · 失败 ${st.fail}`)
}

console.log('\n' + '='.repeat(70))
console.log('产物：')
for (const [leaf, b] of STORE) {
  const rel = path.relative(cfg.out, leaf).split(path.sep).join('/')
  const bytes = b.items.reduce((s, i) => s + (i.bytes || 0), 0)
  console.log(
    `  ${(rel || '.').padEnd(26)} ${String(b.items.length).padStart(5)} 张  ${(bytes / 1048576).toFixed(1).padStart(8)} MB   images/ + mapping.json`
  )
}
console.log(`\n总用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
