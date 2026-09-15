# iTab 动态壁纸视频爬虫

抓取 iTab 新标签页的全部**动态壁纸视频**（`.mp4`）及其封面图，并生成
【接口数据 `_id` ↔ 本地文件名】映射表。

---

## 一、快速开始

```bash
cd E:\project\background

# 枚举 CDN + 下载全部（无需登录）
node download-videos.mjs

# 只出清单不下载
node download-videos.mjs --list

# 只下封面图
node download-videos.mjs --poster-only

# 走接口拿完整元数据（需要 token）
node download-videos.mjs --api
```

零依赖，Node 18+ 直接跑（当前环境 Node 26）。重复运行会自动跳过已下载的文件。

---

## 二、视频在哪、怎么找

视频本体放在**公开 CDN**上，**不需要登录**：

```
https://files.itab.link/itab/defaultWallpaper/videos/{name}.mp4      ← 视频
https://files.itab.link/itab/defaultWallpaper/videos/{name}.jpg      ← 封面原图
```

命名只有两种规律：`{数字}` 和 `v-{数字}`。

实测枚举结果（连续 25 次不存在即停止）：

| 规律 | 范围 | 数量 |
|---|---|---|
| `N.mp4` | `10` – `91` | 82 |
| `v-N.mp4` | `1` – `32` | 32 |
| | **合计** | **114** |

接口 `/wallpaper/video/list` 返回 `count: 125`，但 CDN 上实际只有 114 个文件，
差额 11 个是接口里的重复条目（不同 `_id` 指向同一个文件）。脚本会把它们列出来。

> 也就是说：**不需要 token，光靠命名规律就能把全部视频抓下来。**

### 走接口能多拿到什么

接口能给出 `_id`（MongoDB ObjectId），这是 iTab 内部的主键，用于收藏、统计等。
只有 `--api` + token 才能拿到完整的 125 条元数据；否则只有 `seed/` 里已提供的那几条有 `_id`。

---

## 三、产物结构

```
E:\project\background\
├─ download-videos.mjs
├─ token.txt                  登录凭证（gitignore）
├─ seed\
│   └─ video-list-p1.json     你提供的接口第 1 页数据
└─ videos\
    ├─ 10.mp4  …  91.mp4      82 个
    ├─ v-1.mp4 … v-32.mp4     32 个
    ├─ posters\
    │   ├─ 10.jpg …           封面原图（未压缩）
    │   └─ v-1.jpg …
    ├─ mapping.json           ★ 完整映射（含接口原始记录）
    ├─ mapping.csv            同上，Excel 可直接打开（UTF-8 BOM）
    └─ id-to-file.json        { "_id": "文件名" } 纯索引
```

### mapping.json 单条结构

```json
{
  "id": "625526fe452009fb7a5feb82",
  "file": "21.mp4",
  "poster": "posters/21.jpg",
  "video_url": "https://files.itab.link/itab/defaultWallpaper/videos/21.mp4",
  "poster_url": "https://files.itab.link/itab/defaultWallpaper/videos/21.jpg?...",
  "bytes": 8457216,
  "status": "ok",
  "meta": { "_id": "...", "url": "...", "thumb": "...", "poster": "...", "from": "seed/video-list-p1.json" }
}
```

- `id` 为空字符串表示这条是**靠枚举发现的**，接口数据里没有对应记录
- `meta` 保留接口返回的完整原始字段，未做任何裁剪
- `id-to-file.json` 是最轻量的查表文件，适合直接 `require`/`import`

### 常用参数

```
-o, --out <目录>         输出目录（默认 ./videos）
-c, --concurrency <n>    并发下载（默认 4）
    --api                走 /wallpaper/video/list 拿元数据（需 token.txt）
    --token <t>          直接指定 token
    --seed-dir <目录>    接口 JSON 种子目录（默认 ./seed）
    --poster-only        只下载封面
    --no-poster          跳过封面
    --list               只出清单
    --force              覆盖已存在文件
    --miss-stop <n>      枚举时连续 n 次不存在即停止（默认 25）
```

---

## 四、补充接口页数据（可选）

想要全部 125 条的 `_id`，把接口的 8 页 JSON 依次存成
`seed/video-list-p2.json` … `seed/video-list-p8.json`（格式随意，数组或 `{data:[...]}` 都认），
再跑一次即可自动合并：

```bash
node download-videos.mjs --list     # 先看合并了多少条 _id
node download-videos.mjs            # 再补全映射
```

或者配置 token 后直接 `node download-videos.mjs --api`，脚本会自己翻完 8 页。

### 获取 token

1. 打开 iTab 新标签页（保持登录）
2. `F12` → **Application** → **Local Storage** → `chrome-extension://mhloojimgilafopcmlcikiidgbbnelip`
3. 找到键名 `token`，复制值（**去掉首尾引号**）
4. 粘贴到 `token.txt`（该文件已在 `.gitignore` 中）

---

## 五、接口逆向记录

### 接口地址

```
GET https://api.itab.link/api/wallpaper/video/list?lang=cn&page=1&size=16&sortKey=updateTime
```

- `page` 从 1 开始，`size` 固定 16，`sortKey`：`updateTime` 最新 / `useTotal` 最热
- 响应：`{ code, data: [...], msg, count: 125, page, size, pages: 8 }`
- 列表项字段：`_id` / `url` / `thumb`（400×200 webp）/ `poster`（1920×1080 webp）
- 另有一个上报接口：`GET /api/wallpaper/video/use?_id=<id>`

### 请求头（`chunks/store-ve3N8KMS.js:2897-2910`）

```js
signaturekey: AES(Date.now().toString(), 'itab1314')  // CryptoJS AES 口令加密
version:      '2.2.25'
mode:         'itab'
fp:           localStorage['itab-visitorid']
token:        localStorage['token']      // 登录后才有
params.lang:  'cn'                       // 所有 GET 自动追加
```

签名算法等价于 **OpenSSL EVP_BytesToKey(MD5, 8字节随机salt) + AES-256-CBC + Pkcs7**，
输出 `"Salted__" + salt + ciphertext` 的 Base64。脚本里的 `signatureKey()` 是 Node 原生复刻。

> 实测：这些列表接口只认 `token`，`signaturekey` 传错或不传返回的都是同一个
> `401 用户登录凭证已过期`，说明**元数据接口不对匿名用户开放**。
> 但**视频文件本体在 `files.itab.link` 上完全公开**，所以本文的方案不依赖登录。

### 封面图的 OSS 处理参数

```
?x-oss-process=image/resize,limit_1,w_1920,h_1080/quality,q_93/format,webp
```

`resize` 缩放 · `limit_1` 不放大 · `w/h` 目标尺寸 · `quality,q_93` 质量 · `format,webp` 转 WebP。
脚本下载的是**去掉该参数的原图 jpg**，需要 webp 版本时自行拼接即可。

### 视频在页面里怎么生效（`chunks/main-Wfs5oDmC.js:14`）

```js
// type === 2 表示动态壁纸
const v = document.createElement('video')
v.className = 'wallpaper-video'
v.autoplay = true; v.muted = true; v.loop = true
v.poster = wallpaper.thumb
v.src = wallpaper.src
```

配置存在 `localStorage['baseConfig'].wallpaper`，切到后台标签时自动 `pause()` 省电。

---

## 六、纯色 / 渐变背景

壁纸库的「纯色」标签页里那些渐变色块，数据硬编码在扩展里，不在接口中。
用 `extract-colors.mjs` 从源码提取：

```bash
node extract-colors.mjs                    # 自动定位扩展目录
node extract-colors.mjs --ext <扩展目录>
```

产物 `solid-colors.json`（101 KB）：

```json
{
  "count": 139,
  "customPalette": ["#ffffff", "#3b78dc", "..."],      // 「自定义颜色」12 色色板
  "groups": ["#FC96D3", "#8B56E9", "..."],             // 顶部 5 个筛选色标
  "backgrounds": [
    {
      "index": "002",
      "name": "Night Fade",
      "favorite": false,
      "deg": 0,
      "group": ["#FC96D3", "#8B56E9"],
      "gradient": [{ "color": "#a18cd1", "pos": 0 }, { "color": "#fbc2eb", "pos": 100 }],
      "colors": ["#a18cd1", "#fbc2eb"],
      "stops": 2,
      "css": "linear-gradient(0deg,#a18cd1 0%, #fbc2eb 100%)",
      "wallpaper": { "type": 3, "src": "linear-gradient(...)", "thumb": "linear-gradient(...)", "name": "", "time": 0 }
    }
  ]
}
```

- **139 条**渐变，来自 `chunks/index-BwPVRbSv.js` 的 `Re` 数组（WebGradients 合集），
  原始编号 `002` – `180`（中间有缺口）
- `css` 字段就是扩展实际写进 `localStorage['baseConfig'].wallpaper.src` 的内容
  （`wallpaper.type = 3` 表示纯色/渐变），可直接丢给 CSS `background`
- `wallpaper` 子对象是**可直接塞回 iTab 配置**的完整结构

### CSS 拼装规则

扩展里（`index-BwPVRbSv.js:214-220`）：

```js
const stops = gradient.reduce(
  (acc, o) => (acc ? `${acc}, ${o.color} ${o.pos}%` : `${o.color} ${o.pos}%`),
  ''
)
return `linear-gradient(${deg}deg,${stops})`
```

注意 `deg` 后面**没有空格**，每条 `color pos%` 之间是 `, `（逗号 + 空格）。
脚本输出的 `css` 与扩展逐字节一致。

停靠点数量分布：2 / 3 / 4 / 6 / 7 / 8 个。

---

## 七、注意事项

- 抓取频率已内置退避与并发限制，别把 `-c` 调太高。
- 这些素材版权归原作者所有，**仅供个人学习使用，不要再分发或商用**。
- 断点续传：重复运行自动跳过已存在文件；要重下加 `--force`。
- 视频总体积可能较大（GB 级），先 `--list` 看清单再决定。
