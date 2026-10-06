# 带插图的书籍

继续使用书架原来的“导入小说”，选择 `book.json`。旧纯文字文件无需修改。

每章可以增加 `images` 数组，每项包含：

- `afterParagraph`：插入位置，从 0 开始。正文按换行分段，忽略空行。
- `dataUrl`：图片完整的 Base64 Data URL，例如 `data:image/png;base64,...`。不是图片网址或本地路径。
- `alt`：图片说明，同时作为图注和无障碍替代文本。

图片与章节一起存进 IndexedDB，刷新、退出重进和离线阅读均无需重新下载。导入时自动读取图片真实宽高，阅读时提前保留空间，避免图片加载造成正文跳动。图片章节仍按原来的窗口机制按需加载和回收。

支持 PNG、JPEG、WebP、GIF；每张约 5 MB 以内、最多 4000 万像素、每章最多 30 张。无效位置、损坏图片及外部链接会拒绝整次导入，不覆盖旧书。浏览器清除网站数据仍会清除本地书籍，请保留原始 JSON 作为备份。

示例结构（省略号需替换为真实图片数据）：

```json
{
  "title": "图文示例书",
  "source": "illustrated-example",
  "chapters": [{
    "title": "第一章 示例",
    "content": "第一段。\n\n第二段。",
    "images": [{ "afterParagraph": 0, "dataUrl": "data:image/png;base64,...", "alt": "插图说明" }]
  }]
}
```
