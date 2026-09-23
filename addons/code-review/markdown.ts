import { marked, type Token, type Tokens } from "marked";
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
/** Closed render allowlist. Raw HTML/images are text; only http(s) links are clickable. */
export function renderComment(markdown: string): string {
  if (Buffer.byteLength(markdown) > 16 * 1024)
    throw Error("Comment exceeds rendering limit.");
  const inline = (tokens: Token[]): string =>
    tokens
      .map((token) => {
        const t = token as any;
        switch (t.type) {
          case "text":
            return t.tokens ? inline(t.tokens) : escape(t.text || "");
          case "escape":
            return escape(t.text || "");
          case "codespan":
            return `<code>${escape(t.text)}</code>`;
          case "strong":
            return `<strong>${inline(t.tokens)}</strong>`;
          case "em":
            return `<em>${inline(t.tokens)}</em>`;
          case "del":
            return `<del>${inline(t.tokens)}</del>`;
          case "br":
            return "<br>";
          case "link": {
            let url;
            try {
              url = new URL(t.href);
            } catch {
              return inline(t.tokens);
            }
            if (!["http:", "https:"].includes(url.protocol))
              return inline(t.tokens);
            return `<a href="${escape(url.href)}" target="_blank" rel="noopener noreferrer" title="Open external evidence link">${inline(t.tokens)}</a>`;
          }
          default:
            return escape(t.raw || "");
        }
      })
      .join("");
  const block = (tokens: Token[], depth = 0): string => {
    if (depth > 20) return escape(tokens.map((t) => t.raw).join(""));
    return tokens
      .map((token) => {
        const t = token as any;
        switch (t.type) {
          case "space":
            return "";
          case "paragraph":
          case "text":
            return `<p>${t.tokens ? inline(t.tokens) : escape(t.text || "")}</p>`;
          case "heading":
            return `<strong>${inline(t.tokens)}</strong>`;
          case "code":
            return `<pre><code>${escape(t.text)}</code></pre>`;
          case "blockquote":
            return `<blockquote>${block(t.tokens, depth + 1)}</blockquote>`;
          case "list": {
            const tag = t.ordered ? "ol" : "ul";
            return `<${tag}>${t.items.map((item: any) => `<li>${block(item.tokens, depth + 1)}</li>`).join("")}</${tag}>`;
          }
          case "hr":
            return "<hr>";
          default:
            return `<p>${escape(t.raw || "")}</p>`;
        }
      })
      .join("");
  };
  return block(marked.lexer(markdown));
}
