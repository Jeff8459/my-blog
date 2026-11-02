# 拔女孩的小萝卜 · NOTES

> 交付时间：2026-11-02 22:59

一个极简、紧凑的中文数字花园。采用桌面三栏知识工作台布局，支持站内双向链接、反向链接、分类、标签、专题、中文搜索、深浅色主题、RSS、Sitemap 与 SEO。

线上地址：`https://my-blog-2hf.pages.dev/`

## 1. 技术架构

- **Astro 7**：静态站点生成，无服务端运行时。
- **Content Collections**：Markdown / MDX 内容与 Zod 元数据校验。
- **Astro Assets**：本地图片处理，不依赖外部图片服务。
- **Pagefind 1.6**：构建后生成静态中文全文索引。
- **原生 Astro、CSS、TypeScript 与少量 JavaScript**：未引入前端 UI 框架。
- **Cloudflare Pages**：构建命令 `npm run build`，输出目录 `dist`。
- **本地发布中心**：独立 Node 服务，CodeMirror + Markdown-it，不进入生产站点。

```text
src/
├── components/        # 三栏导航、文章列表、目录、快捷搜索、主题、SEO
├── config/            # 站点、分类标签、专题配置
├── content/blog/      # 正式文章与明确标记的示例文章
├── content/templates/ # 写作模板
├── layouts/           # 全局三栏布局与文章阅读布局
├── lib/               # 内容查询、双向链接图、日期、阅读时长
├── pages/             # 全部静态路由
└── styles/global.css  # Design Tokens 与正文排版

tools/publisher/        # 仅本机运行的文章发布中心
PUBLISHER.command       # macOS 一键启动脚本
```

## 2. 本地启动

要求 **Node.js >= 22.23.4**。

```bash
npm install
npm run dev
```

开发模式不会生成 Pagefind 索引。验证完整搜索请执行：

```bash
npm run build
npm run preview
```

## 3. 新增文章

复制 `src/content/templates/article-template.md` 到 `src/content/blog/`，使用稳定的英文小写文件名：

```text
src/content/blog/my-first-article.md
```

文件名形成固定 URL：`/blog/my-first-article/`。将 `draft` 改为 `false` 后，文章会进入构建、归档、RSS、Sitemap 和搜索索引。

## 4. Markdown 元数据

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `title` | 是 | 文章标题 |
| `description` | 是 | 摘要，建议 50–100 个汉字，最长 180 字符 |
| `pubDate` | 是 | 发布日期，如 `2026-11-02` |
| `updatedDate` | 否 | 最近更新日期 |
| `category` | 否 | 主分类 slug，默认 `technology` |
| `tags` | 否 | 已配置的标签 slug 数组 |
| `cover` / `coverAlt` | 否 | 封面路径与替代文字，阅读页不再展示大封面 |
| `featured` | 否 | 字段保留兼容，首页现在按更新时间组织内容 |
| `draft` | 否 | 是否草稿，默认 `false` |
| `demo` | 否 | 是否明确显示“示例”标识，默认 `false` |
| `author` | 否 | 默认取站点配置中的作者名 |
| `seoTitle` / `seoDescription` | 否 | 独立 SEO 标题与描述 |

新文章统一使用 `cover`，仍兼容旧 `heroImage`。

## 5. 图片使用

图片优先放入 `src/assets/`：

```yaml
cover: '../../assets/my-cover.jpg'
coverAlt: '准确描述图片内容'
```

正文图片：

```md
![图片替代文字](../../assets/inline-image.jpg)
```

正文图片会按容器宽度显示，表格与代码块在窄屏自动横向滚动。

## 6. 分类、标签与专题

- 分类与标签集中在 `src/config/taxonomy.ts`。
- 分类：`ai`、`technology`、`systems`、`management`、`reading`。
- 新分类或标签必须同时提供稳定英文 slug 和中文名称。
- 专题在 `src/config/topics.ts` 中通过文章 slug 数组独立编排，可跨分类并自定义顺序。

左侧导航数量与首页分类数量均按真实已发布文章动态统计。

## 7. 站内链接与反向链接

正文可以使用标准 Markdown 链接引用其他文章：

```md
[另一篇笔记](/blog/another-note/)
[相对路径](../another-note/#section)
```

构建时会解析站内路径、相对路径、中文编码、尾斜杠与锚点，只把有效且已发布的文章加入关系索引。被引用文章会自动显示“被引用”，相关文章优先依据双向链接，其次根据共同标签和分类计算。

草稿不会进入链接索引、正式页面、RSS、Sitemap 或搜索索引。链接解析逻辑位于 `src/lib/links.ts`。

## 8. 首页与站点信息

站点名称、英文标识、主标题、介绍、作者和 GitHub 地址统一在 `src/config/site.ts` 修改。正式站点 URL 同时位于该文件和 `astro.config.mjs`。

首页由最近更新、分类入口、精选专题、最近修改笔记和站点简介组成，不依赖大封面或伪统计数据。

## 9. 深浅色主题

提供“跟随系统 / 浅色 / 深色”三种选项，保存在 `localStorage` 的 `notes-theme`。首屏内联脚本提前解析主题，避免闪烁；跟随系统模式会响应系统变化。所有 Token 位于 `src/styles/global.css`。

## 10. 搜索

生产构建自动执行：

```bash
astro build && pagefind --site dist
```

只索引带 `data-pagefind-body` 的已发布文章正文。搜索支持：

- 顶部按钮或 `⌘K` / `Ctrl+K` 打开快捷搜索；
- 非输入状态下按 `/` 打开快捷搜索；
- `Esc` 关闭，方向键在结果间移动；
- `/search/` 提供完整中文搜索结果、摘要和高亮。

修改文章后必须重新构建，索引才会更新。

## 11. 检查与构建

```bash
npm run check       # Astro / TypeScript 检查
npm run build       # 静态页面、图片、Sitemap、Pagefind
npm run preview     # 预览 dist，默认 http://127.0.0.1:4321
npm run test:smoke  # 需先启动 preview；真实 Chrome 验收
npm run publisher   # 本地发布中心，http://127.0.0.1:4322
npm run test:publisher # 发布中心单元、API 与浏览器测试
```

浏览器测试默认使用 macOS 系统 Chrome；可通过 `CHROME_PATH` 指定浏览器，通过 `TEST_BASE_URL` 指定预览地址。

## 12. GitHub 与 Cloudflare

```bash
git status
git add .
git commit -m "feat: redesign digital garden"
git push -u origin feature/digital-garden
```

在 GitHub 审查并合并到 `main` 后，Cloudflare Pages 会按现有配置自动部署。项目脚本不会自动推送或修改线上版本。

## 13. 常见错误排查

- **Node.js is not supported**：升级到 Node.js 22.23.4 或更高版本。
- **搜索框存在但无结果**：先执行 `npm run build` 和 `npm run preview`，开发服务器不生成索引。
- **分类或标签校验失败**：先在 `src/config/taxonomy.ts` 注册 slug。
- **站内链接没有产生反向链接**：确认目标文章已发布，并使用 `/blog/<slug>/` 或可正确解析的相对路径。
- **文章没有出现**：检查 `draft`、frontmatter 缩进、日期格式与文件名。
- **线上 canonical 不正确**：同步修改 `astro.config.mjs` 与 `src/config/site.ts`。
- **测试无法启动 Chrome**：设置 `CHROME_PATH`，或安装 Playwright Chromium。

## 14. 本地发布中心

日常写作与发布推荐使用本地工具：

```bash
npm run publisher
```

或双击项目根目录的 `PUBLISHER.command`。服务只监听 `127.0.0.1:4322`，支持新建草稿、CodeMirror 编辑、实时预览、自动保存与备份、图片插入、Obsidian 导入、发布检查、受限 Git 提交、部署核验，以及归档与恢复（两者同样经过构建、确认、推送和线上核验，可随时取消还原）。

详细操作、安全机制、失败恢复与测试说明见 [`tools/publisher/README.md`](tools/publisher/README.md)。发布中心不会被 Astro 构建到 `dist`，线上博客没有对应管理路由。

## 15. 验收边界

已自动检查类型、构建、Pagefind 索引、主要路由、站内链接与反向链接、快捷搜索、主题、移动抽屉、404、RSS/Sitemap、三栏断点及 360–1440px 横向溢出，并实际查看 390、768、1440px 与深色截图。屏幕阅读器、全部浏览器及完整 WCAG 2.2 AA 仍需人工审计。
