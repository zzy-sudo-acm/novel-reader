# 小说阅读器

纯前端本地小说阅读器，适合 iPhone 使用（PWA，可添加到主屏幕）。

## 功能

- 导入本地 `book.json`（格式：`{ title, chapters: [{ title, content }] }`），数据存入 IndexedDB，永不上传
- 连续纵向滚动阅读，章节自动衔接，虚拟化窗口渲染（全书 1400+ 章也只渲染当前附近几章）
- 精确阅读进度恢复（按 章节 + 段落 + 段落内进度 定位，改字号/行距/横竖屏后仍能回到原文附近）
- 书架：多本书、阅读百分比、当前章节、删除、覆盖重导入
- 目录：搜索、当前章节高亮、虚拟化长列表
- 阅读设置：字号 / 行距 / 边距 / 字体 / 白色 / 米黄 / 深色主题，全部持久化
- PWA：可添加到主屏幕，应用壳离线缓存，导入的书离线可读
- iPhone Safari 适配：safe-area、100dvh、惯性滚动

## 开发

```bash
npm install
npm run gen-icons   # 生成 PWA 图标
npm run dev
```

## 构建与测试

```bash
npm run build
npm run e2e         # 需要本机装有 Edge，用真实 book.json 跑端到端测试
```

E2E 测试读取仓库外的 `../output/qiufeng-smoke/book.json`（仅本地使用，不会提交）。

## 部署

push 到 `main` 后 GitHub Actions 自动构建并部署到 GitHub Pages。
