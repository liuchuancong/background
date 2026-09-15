#!/usr/bin/env node
/**
 * 从 iTab 扩展源码中提取「纯色 / 渐变背景」定义
 * ==================================================================
 * 数据来源：chunks/index-BwPVRbSv.js
 *   - Re            渐变背景数组（WebGradients 合集，name/index/deg/group/gradient）
 *   - b(colors)     「自定义颜色」色板
 *
 * 扩展渲染时的 CSS 拼装逻辑（同文件 214-220 行）：
 *   gradient.reduce((acc, o) => acc ? `${acc}, ${o.color} ${o.pos}%` : `${o.color} ${o.pos}%`, '')
 *   → `linear-gradient(${deg}deg,${...})`
 *   即 3 == wallpaper.type 时，src 直接存这段 CSS 字符串。
 *
 * 用法：
 *   node extract-colors.mjs                       # 自动定位扩展目录
 *   node extract-colors.mjs --ext <扩展目录>
 *   node extract-colors.mjs --out solid-colors.json
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
const OUT = path.resolve(HERE, argOf('--out', 'solid-colors.json'))

// 依次尝试几个可能的扩展目录
const CANDIDATES = [
  argOf('--ext', ''),
  path.join(HERE, '..'),
  'C:\\Users\\XA-158\\Downloads\\iTab新标签页\\iTab新标签页',
  path.join(process.env.USERPROFILE || '', 'Downloads', 'iTab新标签页', 'iTab新标签页'),
].filter(Boolean)

function findChunk() {
  for (const dir of CANDIDATES) {
    const f = path.join(dir, 'chunks', 'index-BwPVRbSv.js')
    if (fs.existsSync(f)) return f
    const g = path.join(dir, 'index-BwPVRbSv.js')
    if (fs.existsSync(g)) return g
  }
  // 兜底：在扩展目录里全局搜
  for (const dir of CANDIDATES) {
    if (!fs.existsSync(dir)) continue
    const hit = search(path.join(dir, 'chunks'))
    if (hit) return hit
  }
  return null
}
function search(dir) {
  if (!fs.existsSync(dir)) return null
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      const r = search(p)
      if (r) return r
    } else if (e.name.endsWith('.js')) {
      const t = fs.readFileSync(p, 'utf8')
      if (t.includes('WebGradients') && t.includes('Night Fade')) return p
    }
  }
  return null
}

const chunkFile = findChunk()
if (!chunkFile) {
  console.error('找不到扩展源码 chunks/index-BwPVRbSv.js，请用 --ext <扩展目录> 指定')
  process.exit(1)
}
console.log(`源码: ${chunkFile}`)

const src = fs.readFileSync(chunkFile, 'utf8')

// ------------------------------------------------------------------
// 1. 提取渐变数组 Re = [ ... ]
// ------------------------------------------------------------------
function extractArray(text, marker) {
  const at = text.indexOf(marker)
  if (at < 0) throw new Error(`找不到标记: ${marker}`)
  const start = text.indexOf('[', at)
  let depth = 0
  let inStr = null
  let esc = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === inStr) inStr = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      inStr = c
      continue
    }
    if (c === '[') depth++
    else if (c === ']') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  throw new Error('数组括号不匹配')
}

// 先定位到「纯色」组件里引用的那个列表：__name:'color' 之前的 Re 定义
const colorCompAt = src.indexOf("__name: 'color'")
const markerAt = src.lastIndexOf('Re = [', colorCompAt > 0 ? colorCompAt : src.length)
if (markerAt < 0) throw new Error('找不到 Re 数组定义')
const rawArray = extractArray(src.slice(markerAt), 'Re = [')

// 该字面量只含字符串/数字/布尔/对象/数组，直接求值最稳妥
const gradients = new Function(`return ${rawArray}`)()

// ------------------------------------------------------------------
// 2. 提取「自定义颜色」色板
// ------------------------------------------------------------------
function extractColors() {
  const at = src.indexOf("title: '自定义颜色'")
  if (at < 0) return []
  const seg = src.slice(Math.max(0, at - 900), at)
  const m = seg.match(/colors:\s*\[([^\]]*)\]\s*,\s*$/)
  if (!m) return []
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)
}
const customPalette = extractColors()

// ------------------------------------------------------------------
// 3. 组装：补上扩展实际使用的 CSS 字符串
// ------------------------------------------------------------------
const cssOf = (g) => {
  const stops = g.gradient.reduce(
    (acc, o) => (acc ? `${acc}, ${o.color} ${o.pos}%` : `${o.color} ${o.pos}%`),
    ''
  )
  return `linear-gradient(${g.deg}deg,${stops})`
}

const backgrounds = gradients.map((g, i) => ({
  index: g.index,
  name: g.name,
  favorite: !!g.favorite,
  deg: g.deg,
  group: g.group || [],
  gradient: g.gradient,
  colors: [...new Set(g.gradient.map((s) => s.color))],
  stops: g.gradient.length,
  css: cssOf(g),
  wallpaper: {
    type: 3,
    src: cssOf(g),
    thumb: cssOf(g),
    name: '',
    time: 0,
  },
}))

const allGroups = [...new Set(backgrounds.flatMap((b) => b.group))]

const out = {
  $comment:
    'iTab 新标签页 · 纯色/渐变背景。来源 chunks/index-BwPVRbSv.js 的 Re 数组。' +
    'css 字段即扩展写入 localStorage[baseConfig].wallpaper.src 的内容（wallpaper.type = 3）。',
  source: path.basename(path.dirname(chunkFile)) + '/' + path.basename(chunkFile),
  extractedAt: new Date().toISOString(),
  count: backgrounds.length,
  customPalette,
  groups: allGroups,
  backgrounds,
}

await fsp.writeFile(OUT, JSON.stringify(out, null, 2))

console.log(`渐变背景   : ${backgrounds.length} 条`)
console.log(`自定义色板 : ${customPalette.length} 色  ${customPalette.join(' ')}`)
console.log(`分组色标   : ${allGroups.length} 个  ${allGroups.join(' ')}`)
console.log(`名称区间   : ${backgrounds[0].name} (${backgrounds[0].index}) … ${backgrounds.at(-1).name} (${backgrounds.at(-1).index})`)
console.log(`停靠点分布 : ${[...new Set(backgrounds.map((b) => b.stops))].sort().join(' / ')} 个`)
console.log(`\n示例 css   : ${backgrounds[0].css}`)
console.log(`已写出     : ${OUT}`)
