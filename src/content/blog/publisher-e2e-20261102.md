---
title: "博客发布系统端到端验收"
description: "用于验证 Astro 博客发布、更新与部署链路的测试文章。"
pubDate: "2026-11-02"
updatedDate: "2026-11-02"
category: "technology"
tags: ["astro","workflow"]
featured: false
draft: false
demo: false
---

这是一段用于端到端验收的普通正文，用来确认段落、行内代码（如 `npm run build`）与中文排版是否正常。

E2E-PUBLISH-V2-20261102

## 一、发布链路概览

这一节验证二级标题下的正文、段落间距与站内链接。相关内容可以参考站内的 [人工智能时代，如何保留判断力](/blog/second-post/)，确认链接可解析、可点击。

### 1.1 关键步骤

1. 保存草稿并运行发布检查。
2. 执行生产构建并核对变更范围。
3. 推送后核验线上正文指纹。

- 只提交当前文章与它的图片目录。
- 推送失败时保留本地提交与正文。
- 线上核验以页面内的 `article-revision` 为准。

## 二、结构化内容

| 阶段 | 触发方式 | 期望结果 |
| --- | --- | --- |
| 本地保存 | 编辑器自动保存 | 原子写入并保留备份 |
| 发布检查 | 检查接口 | 校验与构建通过 |
| 推送 | Git push | 远程 main 前进一个提交 |
| 线上核验 | 文章页 meta | 指纹与正文一致 |

```bash
npm run build
npm run preview
```

![publisher-e2e](../../assets/publisher/publisher-e2e-20261102/publisher-e2e.png)

更新测试新增段落：本次修改用于确认同一篇文章可以原地更新，slug 与文章地址保持不变，且不会产生重复文章。

最后再次记录本次唯一标记：E2E-PUBLISH-V2-20261102。
