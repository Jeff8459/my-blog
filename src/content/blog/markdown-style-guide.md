---
title: '中文博客 Markdown 排版示例：代码、表格与移动端长文阅读'
description: '集中展示标题、引用、表格、代码、图片与列表，用于检查长文阅读、深色主题和移动端排版。'
pubDate: '2026-10-16'
category: 'technology'
tags: ['markdown', 'demo', 'writing']
cover: '../../assets/blog-placeholder-1.jpg'
coverAlt: '用于排版演示的抽象封面'
author: 'Jeff'
demo: true
---

> 本文是明确的排版演示内容，用于检查站点组件，不是正式原创文章。

良好的排版应当让读者忘记排版本身。文字保持舒适的节奏，结构容易辨认，交互不争夺注意力。

## 标题与段落

正文应有足够行高，段与段之间保留清晰距离。中英文混排时，标点、数字和 `inline code` 都需要自然换行。即使遇到一段很长很长的内容，也不应该突破移动端屏幕边界。

### 三级标题

小节标题承担导航功能。文章目录会读取真实的二级、三级标题，而不是额外维护一份链接。

#### 四级标题

更深层的标题应谨慎使用。层次越多，不一定意味着结构越清楚。

## 引用与列表

> 写作是一种整理经验的方式。它让稍纵即逝的想法获得可以被重新检查的形状。
>
> —— 示例引文

无序列表：

- 保持句子简洁；
- 为链接提供有意义的文字；
- 不让装饰干扰阅读。

有序列表：

1. 明确要表达的问题；
2. 组织必要的材料；
3. 删除不服务主题的内容。

## 表格

| 元素 | 用途 | 移动端策略 |
| --- | --- | --- |
| 表格 | 对比结构化信息 | 容器横向滚动 |
| 代码块 | 保留格式与技术细节 | 容器横向滚动 |
| 图片 | 补充语境与视觉信息 | 自适应宽度 |

## 代码

行内代码使用 `const answer = 42`，代码块则保留语法高亮与复制按钮。

```ts
interface Article {
  title: string;
  publishedAt: Date;
  draft?: boolean;
}

export function canPublish(article: Article) {
  return !article.draft && article.publishedAt <= new Date();
}
```

```css
.article-body {
  max-width: 44rem;
  line-height: 1.9;
  text-wrap: pretty;
}
```

## 图片与说明

![用于演示的图片，展示抽象静物](../../assets/blog-placeholder-about.jpg)

*图 1：Markdown 图片在正文中自适应显示；图片说明可使用斜体段落。*

## 链接与其他元素

外部链接示例：[Astro 官方文档](https://docs.astro.build/)。快捷键使用 <kbd>Cmd</kbd> + <kbd>K</kbd>，强调内容可以使用 <mark>标记文本</mark>。

---

排版检查到这里结束。真正的文章仍应从一个值得讨论的问题开始。若需要组件化表达，可继续阅读[用 MDX 扩展文章表达能力](/blog/using-mdx/)。
