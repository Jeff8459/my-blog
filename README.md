# 未命名 NOTES

> 交付时间：2026-11-02 12:15

一个面向长期写作的中文杂志编辑型个人博客。以排版、留白和内容层次为中心，支持分类、标签、专题、全文搜索、深浅色主题、RSS、Sitemap 与完整 SEO。

线上地址：`https://my-blog-2hf.pages.dev/`

## 1. 技术架构

- **Astro 7**：静态站点生成，无服务端运行时。
- **Content Collections**：Markdown / MDX 内容与 Zod 元数据校验。
- **Astro Assets**：本地图片响应式优化，不依赖外部图片 CDN。
- **Pagefind 1.6**：构建后生成静态中文全文索引，浏览器直接查询。
- **原生 Astro、CSS、TypeScript 与少量 JavaScript**：未引入前端 UI 框架。
- **Cloudflare Pages**：构建命令 `npm run build`，输出目录 `dist`。

核心目录：

```text
src/
├── components/       # 导航、文章卡片、目录、主题、SEO 等组件
├── config/           # 站点、分类标签、专题配置
├── content/blog/     # 正式文章与明确标记的示例文章
├── content/templates/# 写作模板
├── layouts/          # 全站与文章布局
├── lib/              # 内容查询、日期、阅读时长
├── pages/            # 全部静态路由
└── styles/global.css # Design Tokens 与正文排版
```

## 2. 本地启动

要求 **Node.js >= 22.23.4**。Astro 7 会拒绝更低版本。

```bash
npm install
npm run dev
```

开发地址默认为 `http://localhost:4321`。开发模式不会自动生成 Pagefind 索引；验证搜索请使用生产构建与预览：

```bash
npm run build
npm run preview
```

## 3. 新增文章

复制 `src/content/templates/article-template.md` 到 `src/content/blog/`，使用稳定的英文小写文件名，例如：

```text
src/content/blog/my-first-article.md
```

文件名将形成固定 URL：`/blog/my-first-article/`。填写 frontmatter，将 `draft` 改为 `false` 后即进入构建、归档、RSS、Sitemap 和搜索索引。日常字段说明见 `CONTENT_GUIDE.md`。

## 4. Markdown 元数据

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `title` | 是 | 文章标题 |
| `description` | 是 | 摘要，建议 50–100 个汉字，最长 180 字符 |
| `pubDate` | 是 | 发布日期，如 `2026-11-02` |
| `updatedDate` | 否 | 最近更新日期 |
| `category` | 否 | 主分类 slug，默认 `technology` |
| `tags` | 否 | 已配置的标签 slug 数组 |
| `cover` / `coverAlt` | 否 | 封面路径与替代文字 |
| `featured` | 否 | 是否优先作为首页封面，默认 `false` |
| `draft` | 否 | 是否草稿，默认 `false` |
| `demo` | 否 | 是否明确显示“示例”标识，默认 `false` |
| `author` | 否 | 默认取站点配置中的作者名 |
| `seoTitle` / `seoDescription` | 否 | 独立 SEO 标题与描述 |

仍兼容 Starter 的 `heroImage`，新文章统一使用 `cover`。

## 5. 图片使用

优先把图片放入 `src/assets/`，在 frontmatter 中使用相对文章文件的路径：

```yaml
cover: '../../assets/my-cover.jpg'
coverAlt: '准确描述图片内容'
```

正文图片：

```md
![图片替代文字](../../assets/inline-image.jpg)
```

不要在替代文字中重复“图片”二字。装饰性卡片封面会自动使用空 alt，文章主封面使用 `coverAlt`。

## 6. 分类、标签与专题

- 分类与标签集中在 `src/config/taxonomy.ts`。
- 新分类或标签必须同时提供**稳定英文 slug 和中文名称**，再加入文章使用。
- 分类：`ai`、`technology`、`management`、`reading`、`life`。
- 专题在 `src/config/topics.ts` 中独立配置，通过文章 slug 数组显式编排，可跨分类、自定义顺序。

新增配置不需要修改页面组件，但必须通过 `npm run check` 验证拼写。

## 7. 首页与站点信息

站点名称、英文标识、主标题、介绍、作者和 GitHub 地址统一在 `src/config/site.ts` 修改。正式站点 URL 同时位于该文件和 `astro.config.mjs`。

首页封面优先选择最新的 `featured: true` 文章；未设置时使用最新已发布文章。建议同一时间只给一篇文章设置 `featured: true`。文章归档每页数量也由站点配置控制。

## 8. 深浅色主题

主题提供“跟随系统 / 浅色 / 深色”三种选项。选择存入 `localStorage` 的 `notes-theme`；首屏内联脚本提前解析主题，跟随系统模式会响应系统变化。颜色、字体、宽度和间距等 Design Tokens 位于 `src/styles/global.css`。

## 9. 搜索索引

`npm run build` 实际执行：

```bash
astro build && pagefind --site dist
```

只索引带 `data-pagefind-body` 的已发布文章正文，导航、页脚、归档、搜索和 404 不进入索引。修改文章后必须重新构建，索引才会更新。

## 10. 检查与生产构建

```bash
npm run check       # Astro / TypeScript 检查
npm run build       # 静态页面、图片、Sitemap、Pagefind
npm run preview     # 预览 dist
npm run test:smoke  # 需先启动 preview；真实 Chrome 浏览器验收
```

浏览器测试默认使用 macOS 系统 Chrome；其他环境可通过 `CHROME_PATH` 指定浏览器，通过 `TEST_BASE_URL` 指定预览地址。测试输出不会进入 Git。

## 11. GitHub 与 Cloudflare 部署

检查改动后手动提交并推送：

```bash
git status
git add .
git commit -m "feat: redesign editorial blog"
git push -u origin feature/editorial-blog
```

在 GitHub 审查并合并到 `main` 后，Cloudflare Pages 会按照既有连接自动部署。仓库、分支和线上版本不会被项目脚本自动修改。

## 12. 常见错误排查

- **Node.js is not supported**：升级到 Node.js 22.23.4 或更高版本。
- **搜索框存在但无法搜索**：确认先执行 `npm run build`，再使用 `npm run preview`；不要只用开发服务器验收。
- **分类或标签校验失败**：先在 `src/config/taxonomy.ts` 注册 slug，再在文章中使用。
- **文章没有出现**：检查 `draft`、frontmatter 缩进、日期格式和文件名，再重新构建。
- **封面构建失败**：检查相对路径、文件扩展名和图片是否位于项目内。
- **线上 canonical 不正确**：同步修改 `astro.config.mjs` 与 `src/config/site.ts` 的正式 URL。
- **测试无法启动 Chrome**：设置 `CHROME_PATH`，或先安装 Playwright Chromium。

## 13. 验收边界

已自动化检查主要路由、中文搜索、主题、移动菜单、文章阅读器、404、RSS/Sitemap 和 360–1440px 横向溢出，并实际查看桌面、移动端和深色截图。颜色对比度按 WCAG 公式检查；屏幕阅读器、全部浏览器和完整 WCAG 2.2 AA 仍需人工审计。Lighthouse 本次因本地 npm 沙箱限制未运行，不宣称具体分数。
