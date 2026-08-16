import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { Markdown } from "@/components/markdown";

/** streamdown 接入后的关键行为:GFM 表格、块级/行内代码分流、嵌套列表、
 *  流式半截 fence 补全、sanitize。renderToString 即可断言 DOM 结构,
 *  不需要 jsdom / testing-library。 */

describe("Markdown (streamdown)", () => {
  it("GFM 表格渲染为 table + 自带 wrapper", () => {
    const html = renderToString(<Markdown text={"| a | b |\n| --- | --- |\n| 1 | 2 |"} />);
    expect(html).toContain("<table");
    expect(html).toContain("<th");
    expect(html).toContain('data-streamdown="table-wrapper"');
  });

  it("块级代码走 md-codeblock,行内代码走 md-inline", () => {
    const html = renderToString(<Markdown text={"```ts\nconst a = 1;\n```\n\nfoo `bar` baz"} />);
    expect(html).toContain("md-codeblock");
    expect(html).toContain("const a = 1;");
    expect(html).toContain("md-inline");
  });

  it("嵌套列表保留层级(旧手写解析器会拍平)", () => {
    const html = renderToString(<Markdown text={"- a\n  - b\n- c"} />);
    expect(html.match(/<ul/g)?.length).toBe(2);
    expect(html).toContain("<li");
  });

  it("有序/无序混排不断开列表", () => {
    const html = renderToString(<Markdown text={"- a\n- b\n1. c"} />);
    expect(html).toContain("<ul");
    expect(html).toContain("<ol");
  });

  it("流式半截 fence 不吞内容(remend 补全)", () => {
    const html = renderToString(<Markdown text={"正文\n\n```ts\nconst a = 1;"} />);
    expect(html).toContain("const a = 1;");
  });

  it("不注入原始 HTML 属性(sanitize 生效)", () => {
    const html = renderToString(<Markdown text={'<img src=x onerror="alert(1)">'} />);
    expect(html).not.toContain("onerror");
  });

  it("GFM 删除线与任务列表渲染", () => {
    const html = renderToString(<Markdown text={"~~gone~~\n\n- [ ] todo"} />);
    expect(html).toContain("<del");
    expect(html).toContain("checkbox");
  });
});
