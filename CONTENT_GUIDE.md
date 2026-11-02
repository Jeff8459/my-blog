# 日常写作指南

> 交付时间：2026-11-02 21:53

## 推荐方式：本地发布中心

执行 `npm run publisher` 或双击根目录 `PUBLISHER.command`，在 `http://127.0.0.1:4322/` 创建、编辑、导入和发布。工具会自动处理 frontmatter、图片目录、发布检查和 Git 提交。详细说明见 `tools/publisher/README.md`。

以下手工流程保留，适合批量修改或排查内容问题。

## 快速开始

1. 复制 `src/content/templates/article-template.md` 到 `src/content/blog/`。
2. 使用英文小写短横线文件名，例如 `notes-on-reading.md`。
3. 修改标题、摘要、日期、分类和标签。
4. 写作时设 `draft: true`，准备发布后改为 `false`。
5. 执行 `npm run check && npm run build`，用 `npm run preview` 检查文章与搜索。

## 最小 frontmatter

```yaml
---
title: '文章标题'
description: '一段能独立说明文章价值的摘要。'
pubDate: '2026-11-02'
category: 'reading'
tags: ['reading-notes']
draft: true
demo: false
---
```

分类只能使用：`ai`、`technology`、`systems`、`management`、`reading`。标签 slug 在 `src/config/taxonomy.ts` 查看和维护。

## 站内链接

使用标准 Markdown 链接连接其他笔记：

```md
[把复杂问题写清楚](/blog/first-post/)
[延伸阅读](../third-post/#把结论变成行动)
```

构建时会自动生成反向链接与关联文章。只引用**已发布**文章；草稿、外链和无效路径会被安全忽略。锚点和尾斜杠不影响关系解析。

## 图片

图片放入 `src/assets/`，封面字段可选：

```yaml
cover: '../../assets/article-cover.jpg'
coverAlt: '面向屏幕阅读器用户的准确描述'
```

正文使用 `![替代文字](../../assets/photo.jpg)`。阅读页不再展示大尺寸封面，图片应真正服务于正文内容。

## 专题与示例

- 加入专题：在 `src/config/topics.ts` 的 `posts` 数组加入文章 slug（文件名，不含扩展名）。
- 示例或排版测试文章必须设置 `demo: true`，正式原创文章使用 `demo: false`。
- 首页按真实发布时间和更新时间生成，不再依赖 `featured` 选择封面。

## 排版建议

- 正文从段落开始，不要重复写一级标题；页面已使用文章标题作为 H1。
- 小节使用 `##`，子小节使用 `###`，右侧目录会自动生成。
- 摘要控制在 50–100 个汉字，避免只重复标题。
- 代码块标注语言，如 ` ```ts `；表格保持少量列。
- 正式更新文章时同时修改 `updatedDate`。

## 写作后验证

```bash
npm run check
npm run build
npm run preview
```

搜索需要使用生产构建产物。快捷键：`⌘K` / `Ctrl+K` 打开搜索，`/` 聚焦，`Esc` 关闭。

完整字段、链接图机制和发布说明见 `README.md`。
