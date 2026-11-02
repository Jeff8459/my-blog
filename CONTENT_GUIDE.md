# 日常写作指南

> 交付时间：2026-11-02 12:15

## 快速开始

1. 复制 `src/content/templates/article-template.md` 到 `src/content/blog/`。
2. 使用英文小写短横线文件名，例如 `notes-on-reading.md`。
3. 修改标题、摘要、日期、分类和标签。
4. 写作时先设 `draft: true`，准备发布后改为 `false`。
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

分类只能使用：`ai`、`technology`、`management`、`reading`、`life`。标签 slug 在 `src/config/taxonomy.ts` 查看和维护。

## 图片

把图片放进 `src/assets/`：

```yaml
cover: '../../assets/article-cover.jpg'
coverAlt: '面向屏幕阅读器用户的准确描述'
```

正文使用 `![替代文字](../../assets/photo.jpg)`。首屏封面无需手写懒加载，组件会自动处理；正文与非首屏图片按默认策略加载。

## 首页与专题

- 首页封面：给一篇文章设置 `featured: true`，其他文章保持 `false`。
- 加入专题：在 `src/config/topics.ts` 的对应 `posts` 数组里加入文章 slug（文件名，不含扩展名）。
- 示例或排版测试文章必须设置 `demo: true`，正式原创文章使用 `demo: false`。

## 排版建议

- 正文从段落开始，不要重复写一级标题；页面已使用文章标题作为 H1。
- 小节使用 `##`，子小节使用 `###`，目录会自动生成。
- 摘要控制在 50–100 个汉字，避免只重复标题。
- 代码块标注语言，如 ` ```ts `；表格保持少量列，移动端可横向滚动。
- 正式更新文章时同时修改 `updatedDate`。

完整字段、构建和发布说明见 `README.md`。
