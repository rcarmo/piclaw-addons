import { test, expect } from "bun:test";
import { renderComment } from "./markdown.js";
test("CR-082 safe Markdown allowlist formats guidance without executable HTML", () => {
  const html = renderComment(
    "**Keep** `validate()` before I/O.\n\n- Check blank input\n- Check whitespace\n\n[Evidence](https://example.invalid/check)",
  );
  expect(html).toContain("<strong>Keep</strong>");
  expect(html).toContain("<code>validate()</code>");
  expect(html).toContain("<ul>");
  expect(html).toContain('rel="noopener noreferrer"');
  for (const source of [
    "<img src=x onerror=alert(1)>",
    "[x](javascript:alert(1))",
    "![x](https://example.invalid/tracker)",
    "<script>alert(1)</script>",
  ]) {
    const rendered = renderComment(source);
    expect(rendered).not.toContain("<img");
    expect(rendered).not.toContain("<script");
    expect(rendered).not.toContain('href="javascript:');
  }
  expect(() => renderComment("x".repeat(16385))).toThrow();
});
