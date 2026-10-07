import React, { Fragment } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkGemoji from 'remark-gemoji';

/**
 * 按段落渲染的受限 Markdown（仅 "format": "markdown" 的书使用）：
 * - 段落本身由外层 <p data-paragraph> 承担，内部的 p 解包为 Fragment
 * - h1-h3 / blockquote / pre / hr 等块级元素降级为带 class 的 span，不改变段落结构
 * - 不支持的标签一律解包，只保留文字；输出 React 元素，不经过 HTML
 * 该模块通过 React.lazy 动态加载，纯文本书籍不会下载这部分代码。
 */
export default function InlineMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkGemoji]}
      allowedElements={['em', 'strong', 'del', 'code', 'a', 'br', 'h1', 'h2', 'h3', 'blockquote', 'pre', 'hr', 'p']}
      unwrapDisallowed
      components={{
        p: ({ children }) => <Fragment>{children}</Fragment>,
        h1: ({ children }) => <span className="md-h1">{children}</span>,
        h2: ({ children }) => <span className="md-h2">{children}</span>,
        h3: ({ children }) => <span className="md-h3">{children}</span>,
        blockquote: ({ children }) => <span className="md-quote">{children}</span>,
        pre: ({ children }) => <span className="md-pre">{children}</span>,
        hr: () => <span className="md-hr" />,
        a: ({ children, href }) => (
          <a href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
