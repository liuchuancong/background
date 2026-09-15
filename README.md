# iTab 资源爬虫

从 iTab 新标签页（`iTab新标签页.crx` v2.2.25）抓取 **壁纸**、**动态壁纸视频**、**纯色背景**。

三个脚本，**零依赖**，Node 18+ 直接跑（当前环境 Node 26，不需要 `npm install`）。

| 脚本 | 作用 | 产物 |
|---|---|---|
| `download-wallpapers.mjs` | 官方壁纸 / Wallhaven / 必应 / deepin | `wallpapers/` |
| `download-videos.mjs` | 动态壁纸视频（mp4 + 封面） | `videos/` |
| `extract-colors.mjs` | 纯色·渐变背景（从扩展源码提取） | `solid-colors.json` |

> **全都不需要 token。** 抓包确认扩展实际请求的是 `base.itab.link`，
> 请求头里根本没有 `token` 字段（详见「接口逆向记录」）。

---

## 一、壁纸 `download-wallpapers.mjs`

### 用法

```bash
cd E:\project\background

node download-wallpapers.mjs                    # 全部来源，每个分类 10 页
node download-wallpapers.mjs --source official  # 只下官方壁纸
node download-wallpapers.mjs --source bing,deepin
node download-wallpapers.mjs --list             # 只看会下什么，不下载
node download-wallpapers.mjs --limit 300        # 每个来源封顶 300 张
```

### 目录结构

**每个叶子目录 = `images/` + 一份映射表**：

```
wallpapers/
├─ bing/                                 无分类，平铺
│   ├─ images/20260915_red-macaws-flight.jpg
│   └─ mapping.json  mapping.csv  id-to-file.json
│
├─ deepin/                               无分类，平铺
│   ├─ images/purple-salt-flats-sunset.jpg
│   └─ mapping.json  mapping.csv  id-to-file.json
│
├─ wallhaven/                            iTab 的 19 个主题分类
│   ├─ popular/      images/ + mapping.json   ← 热门（不传 q）
│   ├─ minimalism/   ← 极简主义  q=id:2278
│   ├─ patterns/     ← 图案      q=id:869
│   ├─ landscape/    ← 风景      q=id:711
│   ├─ nature/       ← 自然      q=id:37
│   ├─ cosplay/      ← Cosplay   q=id:12757
│   ├─ spiderman/    ← 蜘蛛侠    q=id:2319
│   ├─ ghibli/       ← 吉卜力    q=id:1748
│   ├─ naruto/       ← 火影忍者  q=id:78174
│   ├─ sci-fi/       ← 科幻      q=id:14
│   ├─ anime/        ← 日漫      q=id:1
│   ├─ anime-girls/  ← 动漫女孩  q=id:5
│   ├─ cyberpunk/    ← 赛博朋克  q=id:376
│   ├─ pixel-art/    ← 像素艺术  q=id:2321
│   ├─ artwork/      ← Artwork   q=id:323
│   ├─ cityscape/    ← Cityscape q=id:479
│   ├─ digital-art/  ← Digital Art   q=id:13
│   ├─ fantasy-art/  ← Fantasy Art   q=id:853
│   └─ final-fantasy/ ← Final Fantasy q=id:997
│
└─ official/                             官方壁纸接口分类
    ├─ nature/      images/ + mapping.json  mapping.csv  id-to-file.json
    ├─ anime/       同上
    ├─ art/         同上
    ├─ architecture/ 同上
    ├─ life/        同上
    ├─ geometry/    同上
    └─ other/       同上
```

### mapping.json 结构

```json
{
  "source": "official",
  "category": "nature",
  "id": "6a82ec0ffc5b238d9bccdf68",
  "name": "20260817c11dn9",
  "file": "official/nature/images/20260817c11dn9.jpeg",
  "url": "https://files.itab.link/wallpaper/wallspic/20260817c11dn9.jpeg?x-oss-process=...",
  "thumb": "https://files.itab.link/...w_307,h_172...",
  "bytes": 516588,
  "status": "ok",
  "api": { "raw": "...", "thumb": "...", "id": "..." }
}
```

- `status`：`ok` 下载成功 · `exists` 已存在跳过 · `failed` 失败（带 `error`） · `listed` 仅清单
- `api` 保留接口返回的完整原始记录
- `id-to-file.json` 是 `{ "<接口 id>": "<文件名>" }` 的轻量索引

### 文件名（全英文）

| 来源 | 英文名怎么来 | 例子 |
|---|---|---|
| 必应 | `urlbase` 里的 `OHR.<Slug>`，必应自己的英文标识，前面加日期 | `20260914_kochia-china.jpg` |
| deepin | 接口没有名字，**逐张看图人工命名**（`data/deepin-names.json`） | `purple-salt-flats-sunset.jpg` |
| Wallhaven | `id-分辨率` | `ogjjx9-1920x1080.jpg` |
| 官方壁纸 | ⚠ 接口**没有 name 字段**，只能用 CDN 原始文件名（ASCII） | `20260817c11dn9.jpeg` |

### 参数

```
-s, --source <名称[,名称]>   official / wallhaven / bing / deepin（默认 all）
-o, --out <目录>             输出目录（默认 ./wallpapers）
-p, --pages <n>              每个分类抓取页数（默认 10；填 0 = 全部翻到底）
    --size <n>               每页条数（默认 24；必应服务端固定 16）
    --sr <3840x2160>         分辨率参数，见下
    --sort <updateTime|useTotal|random>
    --limit <n>              每个来源总量上限（默认 0 不限）
    --wh-category <名称[,名称]>  wallhaven 只下某几个分类
                             可用 英文目录名(sci-fi) / 中文标签(科幻) / 原始 id(id:14)
    --show-categories        只打印 wallhaven 分类对照表后退出
-c, --concurrency <n>        并发（默认 6）
    --list                   只出清单不下载
    --force                  覆盖已存在文件
-q, --quiet                  精简输出
```

### wallhaven 分类

分类 id 不在页面上，由 `base.itab.link/wallhaven/category` 单独下发。跑这条直接看对照表：

```bash
node download-wallpapers.mjs --show-categories
```

```
英文目录名           中文标签            q 参数
popular         热门              (不传)
minimalism      极简主义            id:2278
patterns        图案              id:869
landscape       风景              id:711
nature          自然              id:37
cosplay         Cosplay         id:12757
spiderman       蜘蛛侠             id:2319
ghibli          吉卜力             id:1748
naruto          火影忍者            id:78174
sci-fi          科幻              id:14
anime           日漫              id:1
anime-girls     动漫女孩            id:5
cyberpunk       赛博朋克            id:376
pixel-art       像素艺术            id:2321
artwork         Artwork         id:323
cityscape       Cityscape       id:479
digital-art     Digital Art     id:13
fantasy-art     Fantasy Art     id:853
final-fantasy   Final Fantasy   id:997
```

只要某几个分类（三种写法都认）：

```bash
node download-wallpapers.mjs --source wallhaven --wh-category sci-fi
node download-wallpapers.mjs --source wallhaven --wh-category "科幻,图案"
node download-wallpapers.mjs --source wallhaven --wh-category "id:14,id:869"
```

### 各来源实际情况

| 来源 | 接口总量 | 说明 |
|---|---|---|
| official | 1290 | nature 241 · other 657 · art 164 · geometry 100 · acg 94 · life 35 · architecture 29 |
| wallhaven | 每分类上千 | **19 个主题分类**，每页 24 条。`图案` 单类就有 1324 张 |
| bing | **2027** | iTab 自建的必应历史库，约 5 年多。每页固定 16 条 |
| deepin | **26** | CDN 上就 `0.jpg`–`25.jpg` 这么多 |

> 必应同一天同一张图会有多个地区版本（`ZH-CN` / `DE-DE` / `JA-JP` / `EN-GB`），
> slug 相同只是语言不同。脚本按「日期 + slug」去重并**优先保留中文版**，
> 所以 2027 条原始数据大约会得到 1900 张唯一图。

**体积参考**（实测平均 0.30 MB/张）：

| 来源 | 10 页 | 体积 |
|---|---|---|
| wallhaven | 19 分类 × 240 = 4560 张 | ≈ 1.4 GB |
| official | ≈ 900 张 | ≈ 450 MB |
| bing | 161 张（UHD 4K，单张约 3.5 MB） | ≈ 560 MB |
| deepin | 26 张 | ≈ 39 MB |

合计约 2.5 GB。先 `--list` 看清单更稳妥，或用 `--limit` 封顶。

想要必应全量：`node download-wallpapers.mjs --source bing --pages 0`（约 1900 张 / 7 GB）。

### 关于 `--sr`

`sr` 是「屏宽 x 屏高」，直接决定服务端返回的图片宽度：

| sr | 实际返回宽度 |
|---|---|
| `1920x1080` | w_1920 |
| `3840x2160` | **w_2560（上限）** |
| `16:9` | w_1280 |

默认 `3840x2160` 拿最大尺寸。想要原图，把返回的 `raw` 里 `?x-oss-process=...` 整段去掉即可。

---

## 二、视频 `download-videos.mjs`

```bash
node download-videos.mjs                 # 枚举 + 下载全部
node download-videos.mjs --api           # 走接口拿 _id 元数据
node download-videos.mjs --poster-only   # 只下封面
node download-videos.mjs --list          # 只出清单
```

视频在公开 CDN：`files.itab.link/itab/defaultWallpaper/videos/{name}.mp4`
命名只有 `{数字}` 和 `v-{数字}`，实测共 **114 个**（接口 `count` 报 125，多出的是重复条目）。

```
videos/
├─ 10.mp4 … 91.mp4           82 个
├─ v-1.mp4 … v-32.mp4        32 个
├─ posters/                  114 张封面原图
├─ mapping.json  mapping.csv
└─ id-to-file.json           { "_id": "21.mp4" }
```

---

## 三、纯色 / 渐变背景 `extract-colors.mjs`

壁纸库「纯色」标签页的色块**不走接口**，硬编码在 `chunks/index-BwPVRbSv.js` 的 `Re` 数组里。

```bash
node extract-colors.mjs
node extract-colors.mjs --ext <扩展目录>
```

`solid-colors.json`：139 条渐变 + 12 色自定义色板 + 5 个分组色标。
每条带 `css` 字段，就是扩展实际写进 `localStorage['baseConfig'].wallpaper.src` 的字符串：

```json
{
  "index": "002", "name": "Night Fade", "deg": 0,
  "gradient": [{"color":"#a18cd1","pos":0},{"color":"#fbc2eb","pos":100}],
  "css": "linear-gradient(0deg,#a18cd1 0%, #fbc2eb 100%)",
  "wallpaper": { "type": 3, "src": "...", "thumb": "...", "name": "", "time": 0 }
}
```

---

## 四、接口逆向记录

### 域名 —— 是 base 不是 api

| 域名 | 用途 | 鉴权 |
|---|---|---|
| **`base.itab.link`** | ★ 扩展实际在用：壁纸列表 / 分类 / 视频 / 必应 | **不需要** |
| `api.itab.link/api/*` | 账号 / 会员 / 同步那套 | 需要 token |
| `files.itab.link` | 静态资源 CDN（图片 / 视频） | 不需要 |

一开始误判成 `api.itab.link`，那边返回 `401 用户登录凭证已过期`，所以以为要 token。
抓包后发现真实请求走 `base.itab.link`，**请求头里根本没有 token**。

### 扩展实际发出的请求（抓包原文）

```
:authority   base.itab.link
:path        /wallpaper/list?lang=cn&sr=1920x1080&size=16&page=2&category=life&sortKey=updateTime
accept       application/json, text/plain, */*
fp           zhVusd_0lS.1758762915
mode         itab
origin       chrome-extension://mhloojimgilafopcmlcikiidgbbnelip
version      2.2.25
signaturekey U2FsdGVkX1+zJDH6Y5bG3qLKcVNWogT9D61JEV2Epjc=
```

> 实测：**这个接口连 `signaturekey` 都可以不传**（传错、不传、传对，返回完全一致）。

`signaturekey` 的生成方式（`chunks/store-ve3N8KMS.js:2885-2888`）是 CryptoJS 口令加密
`AES(Date.now().toString(), 'itab1314')`，等价于 OpenSSL `EVP_BytesToKey`(MD5) +
AES-256-CBC + Pkcs7，输出 `"Salted__" + salt + ciphertext` 的 Base64。

### 壁纸接口

```
GET /wallpaper/list            { sr, size, page, category, sortKey }
     → { code, data:[{ raw, thumb, id }], count, page, size, pages }
     ★ 没有 name 字段

GET /wallpaper/category        → 左侧导航：必应壁纸 / 动态壁纸 / Wallhaven
     （不是壁纸子分类！子分类是扩展里硬编码的）

GET /wallhaven/category        → iTab 的 19 个主题分类 { label, id }（label 是中文，id 是 wallhaven 的 tag）
GET /wallpaper/wallhaven       { sr, page, size, q=id:<id> }
     → data:[{ raw, thumb, id, name }]   name 是 wallhaven 图片号（如 965258）
     热门不传 q；科幻 q=id:14，图案 q=id:869，风景 q=id:711，自然 q=id:37 …

GET /wallpaper/video/list      { page, size, sortKey }
     → data:[{ _id, url, thumb, poster }]   pages=63, count=125
GET /wallpaper/video/use       { _id } 上报使用

GET /wallpaper/unsplash        { sr, per_page, size, page, type }
GET /wallpaper/unsplash/category  → 15 个主题
     → data:[{ id, w, h, raw, thumb }]   图在 dogefs.s3.ladydaily.com

GET /bing/list                 { page, size }   size 服务端固定 16
     → data:[{ _id, enddate, copyright, urlbase, raw, thumb }]   count ≈ 2027
     4K：raw 里 `1920x1080.jpg&rf=LaDigue_1920x1080.jpg&pid=hp` → `UHD.jpg`
         （扩展「下载4k壁纸」按钮的原逻辑，chunks/index-BwPVRbSv.js:205）
```

- **官方壁纸分类 id**（扩展硬编码，`chunks/index-BwPVRbSv.js:2291-2300`）：
  `nature` 自然 · `acg` 动漫 · `art` 艺术 · `architecture` 建筑 ·
  `life` 生命 · `geometry` 纹理 · `other` 其他
  （没有「全部」参数，不传 category 就是全部，但它和 7 个分类完全重叠）
- `sortKey`：`updateTime` 最新 · `useTotal` 最热 · `random` 换一批

### 图片 OSS 处理参数

```
?x-oss-process=image/resize,limit_1,w_2560,h_1440/quality,Q_94/format,webp
```

`resize` 缩放 · `limit_1` 不放大 · `w/h` 目标尺寸 · `quality` 质量 · `format` 转 WebP。

### 壁纸在页面里怎么生效（`chunks/main-Wfs5oDmC.js:14`）

Shadow DOM 自定义元素 `<itab-wallpaper>`，按 `wallpaper.type` 分支：

| type | 含义 |
|---|---|
| 0 | 必应每日（每天自动换） |
| 1 | 在线图片（官方库 / Wallhaven / Unsplash） |
| 2 | 动态壁纸视频（插入 `<video autoplay muted loop poster>`） |
| 3 | 纯色或渐变（`src` 存 CSS 值） |
| 4 | 用户上传 |

配置存在 `localStorage['baseConfig'].wallpaper`；动态壁纸切后台时自动 `pause()`。

---

## 五、注意事项

- 抓取频率已内置退避与并发限制，别把 `-c` 调太高。
- 官方壁纸库注明「收集于互联网，如有侵权请联系作者」。素材版权归原作者所有，
  **仅供个人学习使用，不要再分发或商用**。
- 断点续传：重复运行自动跳过已存在文件；要重下加 `--force`。
