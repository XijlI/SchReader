[English](README.md) · **中文**

# SchReader

把任意出版社的论文页面，按 Nature 系期刊那种版式来读：正文一栏，右侧固定
**Sections / Figures / References** 三标签栏，角标引用悬停即看原文，图片点开灯箱。

它不下载正文、也不保存正文：阅读页直接用你已经登录、已经渲染好的那个标签页，所以付费墙、
Cloudflare、机构登录都不成问题。真正会存在本地浏览器里的是**文库里的条目**（题名、作者、期刊、
DOI、链接，加上你自己打的标签、备注和阅读位置）和一份简短的阅读历史，方便以后找回这篇论文；
这些数据只在你自己的机器上，随时可以在文库页面删掉。

两个版本，一套代码：桌面端是 `extension/` 里的 Chrome/Edge 扩展，手机端是 `android/` 里的
安卓 App —— 同一份解析器、同一个阅读页。手机端打开就是**我的文库**，底部三个标签：*文库*、
*搜索*（Google Scholar 加一排期刊官网，也可以自己加）、*设置*；往下滑时底栏会自动收起，整个外壳
（顶栏、底栏、状态栏）都跟着当前主题变色（包括阅读页里自定义的那套配色）。浏览器支持多标签
（最多 8 个，重开 App 会恢复），从搜索页点开的网页，再点一次"搜索"才回到搜索主页。

---

## 安装（一次性，约 30 秒）

1. 打开 `chrome://extensions`（Edge 是 `edge://extensions`），开启**开发者模式**
2. 点**加载已解压的扩展程序**，选中本仓库的 `extension` 文件夹
3. 把拼图图标钉到工具栏

给不写代码的人准备的逐步说明：[docs/INSTALL.zh-CN.md](docs/INSTALL.zh-CN.md)。
想直接下载现成的？[最新 Release](https://github.com/303035/SchReader/releases/latest)
里有扩展 zip 和 APK。

## 怎么用

1. 点工具栏图标：打开**我的文库**（每次都是同一个标签页）
2. 打开一篇论文，等正文加载完
3. 点右下角的深色胶囊：**N SchReader**
4. 阅读页直接接管当前标签（想保留原页面就按住 Ctrl/Cmd 点胶囊，或鼠标中键）；右上角
   "Original ↗" 回到出版社原页

胶囊旁边的 **▾** 里有：*这个站点自动转换*、*在这里隐藏按钮*、*允许的站点…*（会把域名直接填好）。

## 我的文库

两个版本都是从文库开始的。阅读页顶栏的 **☆** 收藏当前论文，**▤** 从阅读页打开文库：

- 按 题名 / 作者 / DOI / 标签 搜索；按 添加时间 / 最近阅读 / 题名 / 年份 排序
- 每篇可以打标签、写备注；下次打开会提示"上次读到 N%"，点一下回到原位置
- 阅读历史可一键关闭
- 导出 **BibTeX、RIS、CSV、JSON**（可直接导入 Zotero / EndNote / NoteExpress），也能从 BibTeX
  或 JSON 备份导入回来
- 右上角 **⚙ 设置**（手机上是它自己的一个标签页）：主题、阅读字体与字号、允许的站点、版本号
- **多设备同步**：库、阅读位置、高亮在浏览器和手机之间保持一致，走你自己的私有 gist ——
  见 [docs/INSTALL.zh-CN.md 第六节](docs/INSTALL.zh-CN.md)

"一篇论文"存的只是元数据 + 链接，正文在你打开时重新从出版社页面解析，所以库很小。安卓 App
用同一个页面、同一份数据格式。

## 它会在哪些站点运行

SchReader 只在自己认识的出版社站点上运行 —— ScienceDirect、Wiley、Springer、Cell、
Science、PNAS、PLOS、Frontiers、MDPI、IEEE、ACM、JSTOR、bioRxiv、知网等 47 个，
名单在 [extension/src/whitelist.js](extension/src/whitelist.js)；其他网站一概不碰。

<details>
<summary><b>已实测的出版社</b> —— 真正跑过解析器的 6 家</summary>

| 出版社 | 引用样式 | 验证方式 | 节 / 段 / 图 / 文献 |
|---|---|---|---|
| ScienceDirect | 作者-年份 | 真实页面存档 | 19 / 51 / 10 / 64 |
| Wiley Online Library | 作者-年份 | 真实页面存档 | 13 / 44 / 3 / 68 |
| Cell（cell.com） | 数字 | 真实页面存档 | 20 / 55 / 3 / 79 |
| PNAS（pnas.org） | 数字 | 真实页面存档 | 16 / 28 / 4 / 43 |
| PLOS（journals.plos.org） | 数字 | 实时页面 | 25 / 40 / 7 / 48 |
| Frontiers（frontiersin.org） | 数字 | 实时页面 | 28 / 64 / 4 / 51 |

名单上其余出版社走通用路径（`citation_*` meta 标签 + 启发式），属于尽力而为；阅读页的 `⋯`
面板能看到那边实际抓到了多少。通用兜底路径本身用两个手写样例（Elsevier 通用版式、作者-年份版式）验证过。

nature.com 是**故意**不在名单里的：它本来就是这个版式。

</details>

遇到名单里没有的出版社？在胶囊的 **▾** 里点 *允许的站点…*（或者 我的文库 → **⚙ → Allowed
sites**）：域名已经填好，点 **Allow site** 由 Chrome 询问权限，之后那个站点也会出现胶囊。
`chrome://extensions` 里的 **扩展程序选项** 打开的也是这个面板。

## 阅读页里能做什么

| 操作 | 效果 |
|---|---|
| 悬停正文角标 | 浮出该文献完整信息 + DOI 链接 |
| 点击角标 | 右栏切到 References 并固定该条，正文不滚动 |
| 文献条目的 `↑ cited 3×` | 跳回正文中引用它的位置 |
| 点图片或 Expand | 灯箱：滚轮缩放 25–600%，放大后拖动平移，← → 切换图片 |
| 选中文字后点笔 | 用当前颜色高亮（右键点笔可选 6 种颜色） |
| `J` / `K`、`S` / `F` / `R`、`T`、`Z`、`Esc` | 上下节、切标签、换主题、收起右栏、关闭浮层 |
| `Aa` | 主题、字体、自定义配色、字号、行高、版心宽度 |
| `⋯` | 解析诊断：抓到多少段、多少图、多少文献 |

共 17 套主题、7 种字体（Inter 和 IBM Plex Sans 随扩展打包，离线可用）。
高亮按文章存在 `chrome.storage.local` 里，键是 DOI。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/INSTALL.zh-CN.md](docs/INSTALL.zh-CN.md) | 逐步安装 + 阅读页用法，写给不写代码的人 |
| [android/README.zh-CN.md](android/README.zh-CN.md) | 手机版：安装、构建、镜像关系 |
| [docs/PLAN.md](docs/PLAN.md) | 架构、文章模型、白名单设计、实测站点 |
| [docs/RELEASING.zh-CN.md](docs/RELEASING.zh-CN.md) | 发版流程（签名的 APK + 扩展 zip） |

## 参与开发

```
extension/            加载进浏览器的那个文件夹
  src/whitelist.js    允许的站点名单与匹配规则
  src/content.js      页面探测、胶囊按钮、触发解析
  src/background.js   把解析结果放内存、打开阅读页、为用户添加的站点注册内容脚本
  src/extractor/      页面 → 文章模型（meta、正文块、文献、图片、适配器）
dev/                  本地调试：静态服务器 + POST /save
samples/              Ctrl+S 存下的页面，当解析样例用（已 gitignore）
```

```bash
python3 dev/serve.py 8799
# 然后打开 http://127.0.0.1:8799/extension/reader.html?dev=article.json

python3 .github/scripts/sync_whitelist.py --check   # 检查 manifest.json 与 whitelist.js 是否一致
```

## 已知限制

- 只读当前页面上已有的文字。全文若在 PDF 或独立 iframe 里，只能拿到摘要。
- 出版社改版会打坏选择器；届时看阅读页的 `⋯`，哪一项变成 0 就是它。
- 图片由阅读页直连出版社 CDN；极少数站点拒绝跨站引用，会显示一行提示文字。
