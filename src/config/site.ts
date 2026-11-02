export const site = {
  name: "拔女孩的小萝卜",
  englishName: "NOTES",
  tagline: "记录思考，积累认知。",
  description: "关于技术、管理、阅读与那些值得认真思考的事。",
  url: "https://my-blog-2hf.pages.dev/",
  locale: "zh-CN",
  author: {
    name: "Jeff",
    bio: "关注技术、管理与阅读，也记录那些值得反复推敲的问题。这里不追逐更新速度，只保留经过思考的文字。",
  },
  github: "https://github.com/Jeff8459/my-blog",
  postsPerPage: 6,
} as const;

export const absoluteUrl = (path = "/") => new URL(path, site.url).toString();
