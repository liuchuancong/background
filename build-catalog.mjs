#!/usr/bin/env node
/**
 * 生成 App 用的背景目录（catalog）
 * ==================================================================
 * 输入：wallpapers/<来源>/.../mapping.json、videos/mapping.json、solid-colors.json
 * 输出：
 *   catalog.json                     总索引（来源 + 分类 + 计数）
 *   catalog/<source>/<category>.json 每个分类的图片清单（精简，只留 App 需要的字段）
 *   catalog/video.json               动态壁纸视频清单
 *   catalog/solid-colors.json        纯色/渐变（从 solid-colors.json 精简）
 *
 * 之所以不直接让 App 读 mapping.json：mapping 里每条都带完整接口原始记录（api 字段），
 * 体积能大 3~5 倍，而且字段名面向抓取过程，不适合 App。
 *
 * 用法：
 *   node build-catalog.mjs
 *   node build-catalog.mjs --owner liuchuancong --repo background --branch main
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const args = process.argv.slice(2)
const argOf = (k, d) => {
  const i = args.indexOf(k)
  return i >= 0 && args[i + 1] ? args[i + 1] : d
}

const OWNER = argOf('--owner', 'liuchuancong')
const REPO = argOf('--repo', 'background')
const BRANCH = argOf('--branch', 'master')
const OUT = path.resolve(HERE, argOf('--out', 'catalog'))

// ------------------------------------------------------------------
// 分类显示名（[中文, 英文]）
// ------------------------------------------------------------------
const OFFICIAL_CATS = {
  nature: ['自然', 'Nature'],
  anime: ['动漫', 'Anime'],
  art: ['艺术', 'Art'],
  architecture: ['建筑', 'Architecture'],
  life: ['生命', 'Life'],
  geometry: ['纹理', 'Texture'],
  other: ['其他', 'Other'],
}
const WALLHAVEN_CATS = {
  popular: ['热门', 'Popular'],
  minimalism: ['极简主义', 'Minimalism'],
  patterns: ['图案', 'Patterns'],
  landscape: ['风景', 'Landscape'],
  nature: ['自然', 'Nature'],
  cosplay: ['Cosplay', 'Cosplay'],
  spiderman: ['蜘蛛侠', 'Spider-Man'],
  ghibli: ['吉卜力', 'Ghibli'],
  naruto: ['火影忍者', 'Naruto'],
  'sci-fi': ['科幻', 'Sci-Fi'],
  anime: ['日漫', 'Anime'],
  'anime-girls': ['动漫女孩', 'Anime Girls'],
  cyberpunk: ['赛博朋克', 'Cyberpunk'],
  'pixel-art': ['像素艺术', 'Pixel Art'],
  artwork: ['Artwork', 'Artwork'],
  cityscape: ['Cityscape', 'Cityscape'],
  'digital-art': ['Digital Art', 'Digital Art'],
  'fantasy-art': ['Fantasy Art', 'Fantasy Art'],
  'final-fantasy': ['Final Fantasy', 'Final Fantasy'],
}

const SOURCE_META = {
  official: { name: ['官方壁纸', 'Official'], type: 'image', categorized: true },
  wallhaven: { name: ['Wallhaven', 'Wallhaven'], type: 'image', categorized: true },
  bing: { name: ['必应壁纸', 'Bing'], type: 'image', categorized: false },
  deepin: { name: ['deepin', 'deepin'], type: 'image', categorized: false },
}

const readJson = async (p) => JSON.parse(await fsp.readFile(p, 'utf8'))
const exists = (p) => fs.existsSync(p)

// ------------------------------------------------------------------
// 精简单条图片记录
// ------------------------------------------------------------------
/** prefix 是相对仓库根目录的前缀，例如 "wallpapers/"、"videos/" */
function slimItem(m, prefix = '') {
  // mapping 的 file 形如 "official/nature/images/xxx.jpeg"，是相对 wallpapers/ 的
  const it = { file: prefix + m.file }
  if (m.id) it.id = m.id
  if (m.name && m.name !== m.id) it.name = String(m.name).slice(0, 80)
  if (m.bytes) it.bytes = m.bytes
  return it
}

async function buildImageSource(sourceId, dirs) {
  const meta = SOURCE_META[sourceId]
  const categories = []
  const shards = []

  for (const { id, mappingPath } of dirs) {
    if (!exists(mappingPath)) {
      console.log(`  ! 跳过（不存在）: ${path.relative(HERE, mappingPath)}`)
      continue
    }
    const raw = await readJson(mappingPath)
    const items = raw.filter((m) => m.status === 'ok' || m.status === 'exists').map((m) => slimItem(m, 'wallpapers/'))
    if (!items.length) continue

    const nameMap = sourceId === 'official' ? OFFICIAL_CATS : WALLHAVEN_CATS
    // 无分类来源（bing/deepin）只有一个分片，名字直接用来源名
    const [displayName, displayNameEn] = meta.categorized
      ? nameMap[id] || [id, id]
      : meta.name
    const shardRel = path.posix.join('catalog', sourceId, `${id}.json`)

    const shard = {
      source: sourceId,
      category: id,
      name: displayName,
      nameEn: displayNameEn,
      type: 'image',
      count: items.length,
      items,
    }
    const shardPath = path.join(OUT, sourceId, `${id}.json`)
    await fsp.mkdir(path.dirname(shardPath), { recursive: true })
    await fsp.writeFile(shardPath, JSON.stringify(shard))
    shards.push(shard)

    categories.push({
      id,
      name: displayName,
      nameEn: displayNameEn,
      count: items.length,
      catalog: shardRel,
    })
    console.log(`  ${sourceId}/${id.padEnd(14)} ${String(items.length).padStart(5)} 张  ${displayName}`)
  }

  return {
    descriptor: {
      id: sourceId,
      name: meta.name[0],
      nameEn: meta.name[1],
      type: meta.type,
      categorized: meta.categorized,
      count: categories.reduce((s, c) => s + c.count, 0),
      categories,
    },
    shards,
  }
}

// ------------------------------------------------------------------
// 主流程
// ------------------------------------------------------------------
console.log('生成 catalog …\n')
await fsp.mkdir(OUT, { recursive: true })

const sources = []
const allShards = []

// ---- 图片类来源 ----
const imagePlan = {
  official: ['nature', 'anime', 'art', 'architecture', 'life', 'geometry', 'other'].map((id) => ({
    id,
    mappingPath: path.join(HERE, 'wallpapers', 'official', id, 'mapping.json'),
  })),
  wallhaven: Object.keys(WALLHAVEN_CATS).map((id) => ({
    id,
    mappingPath: path.join(HERE, 'wallpapers', 'wallhaven', id, 'mapping.json'),
  })),
  bing: [{ id: 'all', mappingPath: path.join(HERE, 'wallpapers', 'bing', 'mapping.json') }],
  deepin: [{ id: 'all', mappingPath: path.join(HERE, 'wallpapers', 'deepin', 'mapping.json') }],
}

for (const sourceId of ['official', 'wallhaven', 'bing', 'deepin']) {
  console.log(`[${sourceId}]`)
  const { descriptor, shards } = await buildImageSource(sourceId, imagePlan[sourceId])
  if (!descriptor.count) {
    console.log('  （没有数据，跳过）\n')
    continue
  }
  // bing / deepin 无分类：把 all 分片的名字改成来源名，界面上就不用再分支
  if (!descriptor.categorized && descriptor.categories.length === 1) {
    const c = descriptor.categories[0]
    c.hidden = true
  }
  sources.push(descriptor)
  allShards.push(...shards)
  console.log('')
}

// ---- 视频 ----
console.log('[video]')
const videoMapping = path.join(HERE, 'videos', 'mapping.json')
if (exists(videoMapping)) {
  const raw = await readJson(videoMapping)
  const items = raw
    .filter((m) => m.status === 'ok' || m.status === 'exists' || m.bytes > 0)
    .map((m) => {
      const it = { file: 'videos/' + m.file }
      if (m.id) it.id = m.id
      if (m.bytes) it.bytes = m.bytes
      if (m.poster) it.poster = 'videos/' + m.poster
      return it
    })
  if (items.length) {
    const shard = {
      source: 'video',
      category: 'all',
      name: '动态壁纸',
      nameEn: 'Live Wallpapers',
      type: 'video',
      count: items.length,
      items,
    }
    await fsp.writeFile(path.join(OUT, 'video.json'), JSON.stringify(shard))
    allShards.push(shard)
    sources.push({
      id: 'video',
      name: '动态壁纸',
      nameEn: 'Live Wallpapers',
      type: 'video',
      categorized: false,
      count: items.length,
      categories: [{
        id: 'all',
        name: '动态壁纸',
        nameEn: 'Live Wallpapers',
        count: items.length,
        catalog: 'catalog/video.json',
        hidden: true,
      }],
    })
    console.log(`  video            ${String(items.length).padStart(5)} 个`)
  }
} else {
  console.log('  ! 没有 videos/mapping.json，跳过')
}
console.log('')

// ---- 纯色 / 渐变 ----
console.log('[solid-color]')
const solidPath = path.join(HERE, 'solid-colors.json')
if (exists(solidPath)) {
  const solid = await readJson(solidPath)
  const items = solid.backgrounds.map((b) => ({
    // file/id 与 App 内置兜底路径保持一致：
    // 渐变没有真实文件，用伪路径当稳定标识，避免界面上所有渐变格子
    // 都因为 file 为空而被判定成“同一个”。
    id: b.index,
    file: `solid-colors.json#${b.index}`,
    name: b.name,
    css: b.css,
    deg: b.deg,
    gradient: b.gradient,
  }))
  const shard = {
    source: 'solid-color',
    category: 'all',
    name: '纯色渐变',
    nameEn: 'Colors',
    type: 'gradient',
    count: items.length,
    customPalette: solid.customPalette || [],
    items,
  }
  await fsp.writeFile(path.join(OUT, 'solid-colors.json'), JSON.stringify(shard))
  allShards.push(shard)
  sources.push({
    id: 'solid-color',
    name: '纯色渐变',
    nameEn: 'Colors',
    type: 'gradient',
    categorized: false,
    count: items.length,
    categories: [
      {
        id: 'all',
        name: '纯色渐变',
        nameEn: 'Colors',
        count: items.length,
        catalog: 'catalog/solid-colors.json',
        hidden: true,
      },
    ],
  })
  console.log(`  solid-color      ${String(items.length).padStart(5)} 条`)
}
console.log('')

// ---- 总索引 ----
const catalog = {
  version: 1,
  generatedAt: new Date().toISOString(),
  repo: { owner: OWNER, name: REPO, branch: BRANCH },
  totals: {
    sources: sources.length,
    items: sources.reduce((s, x) => s + x.count, 0),
    images: sources.filter((s) => s.type === 'image').reduce((s, x) => s + x.count, 0),
    videos: sources.filter((s) => s.type === 'video').reduce((s, x) => s + x.count, 0),
    gradients: sources.filter((s) => s.type === 'gradient').reduce((s, x) => s + x.count, 0),
  },
  sources,
}

await fsp.writeFile(path.join(HERE, 'catalog.json'), JSON.stringify(catalog, null, 2))

// 统计体积
let bytes = (await fsp.stat(path.join(HERE, 'catalog.json'))).size
for (const s of allShards) {
  const p = path.join(OUT, s.source, `${s.category}.json`)
  if (exists(p)) bytes += (await fsp.stat(p)).size
}

console.log('='.repeat(60))
console.log(`来源 ${catalog.totals.sources} 个，条目 ${catalog.totals.items} 条`)
console.log(`  图片 ${catalog.totals.images} · 视频 ${catalog.totals.videos} · 渐变 ${catalog.totals.gradients}`)
console.log(`catalog.json + ${allShards.length} 个分片，合计 ${(bytes / 1048576).toFixed(2)} MB`)
console.log(`\n输出：`)
console.log(`  ${path.join(HERE, 'catalog.json')}`)
console.log(`  ${OUT}\\<source>\\<category>.json`)
