# 小说阅读器

纯前端本地小说阅读器，适合 iPhone 使用（PWA，可添加到主屏幕）。

## 功能

- 导入本地 `book.json`（格式：`{ title, chapters: [{ title, content }] }`），数据存入 IndexedDB，永不上传
- 连续纵向滚动阅读，章节自动衔接，回收远处章节时保留等高占位；短章节按屏幕缓冲范围保留，避免反复加载
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
npm run test:regression # 独立合成书籍测试，无需真实小说文件，需要本机 Edge
```

E2E 测试读取仓库外的 `../output/qiufeng-smoke/book.json`（仅本地使用，不会提交）。

回归测试覆盖连续滚动与章节回收、进度精确恢复、主题/字号/横竖屏切换、弹层背景滚动锁定、触摸点击与滑动区分、短章节稳定性、导入失败事务回滚、同名书籍身份识别、进度迁移、删除原子性、旧版进度数据兼容。测试使用独立浏览器上下文，不会修改日常阅读数据。

书籍身份按 `title + source`（无 source 时用内容指纹）判定：同一本书重新导入时原子覆盖并迁移阅读进度（按章节标题 ±20 章内对齐）；同名不同来源/版本的书互不覆盖。进度同时保存到 IndexedDB 和同步镜像，恢复时选择更新的有效记录。

代码结构：滚动窗口（`src/hooks/useChapterWindow.ts`）、阅读进度（`useReadingProgress.ts`）、手势（`useReaderGestures.ts`）、视口（`useReaderViewport.ts`）各自独立，`Reader.tsx` 只负责组合与渲染。

## 部署

push 到 `main` 后 GitHub Actions 自动构建并部署到 GitHub Pages。
