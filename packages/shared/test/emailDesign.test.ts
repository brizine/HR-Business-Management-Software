import { describe, expect, it } from "vitest";
import {
  BLOCK_LABELS, BLOCK_TYPES, DESIGN_MARK, beeToDesign, designHasContent, designTexts, emailDesignSchema, emptyDesign, fillTags, htmlToDesign, isDesignedBody, newBlock, newRow,
  renderDesign, renderDesignBlock, safeHref, usedTags, videoThumb, type EmailDesign,
} from "../src";

const design = (...blocks: ReturnType<typeof newBlock>[]): EmailDesign => ({ ...emptyDesign(), rows: [newRow([12], blocks)] });

describe("email designs", () => {
  it("has Homeworks' content tiles, each with a starting block that renders", () => {
    expect(BLOCK_TYPES.map((t) => BLOCK_LABELS[t])).toEqual(["Title", "Paragraph", "List", "Image", "Button", "Table", "Divider", "Spacer", "Social", "HTML", "Video", "Icons", "Menu", "Text"]);
    for (const t of BLOCK_TYPES) {
      const b = newBlock(t);
      expect(emailDesignSchema.safeParse(design(b)).success, t).toBe(true);
      expect(typeof renderDesignBlock(b, emptyDesign()), t).toBe("string");
    }
  });

  it("renders rows, columns and blocks as email tables that stack on a phone", () => {
    const d = emptyDesign();
    const title = { ...newBlock("title"), p: { ...newBlock("title").p, html: "Hello {{CUSTOMER_FIRST_NAME}}", align: "center" } };
    const para = { ...newBlock("paragraph"), p: { ...newBlock("paragraph").p, html: '<p>One</p><p>Two <a href="https://x.test">link</a></p>', paraSpacing: 12 } };
    const button = { ...newBlock("button"), p: { ...newBlock("button").p, text: "View <it>", href: "{{ESTIMATE_LINK}}" } };
    d.rows = [newRow([12], [title]), newRow([4, 8], [para])];
    d.rows[1].columns[1].blocks.push(button);
    d.p.preheader = "Peek & see";
    const html = renderDesign(d);
    expect(isDesignedBody(html)).toBe(true);
    expect(html.startsWith(DESIGN_MARK)).toBe(true);
    expect(html).toContain("Peek &amp; see");
    expect(html).toContain('<h1 style="margin:0;');
    expect(html).toContain("text-align:center");
    expect(html).toContain('class="cd-row cd-stack" width="500"');
    expect(html).toContain('width="33.3%"');
    expect(html).toContain('width="66.7%"');
    // Paragraph gaps and link colours are written inline; the last paragraph has no gap.
    expect(html).toContain('<p style="margin:0 0 12px 0">One</p><p style="margin:0">Two <a style="color:#0068a5;text-decoration:underline" href="https://x.test">link</a></p>');
    expect(html).toContain('<a href="{{ESTIMATE_LINK}}" target="_blank"');
    expect(html).toContain("View &lt;it&gt;</a>");
    // Tags are filled in the usual way, links included.
    const filled = fillTags(html, { CUSTOMER_FIRST_NAME: "Ann", ESTIMATE_LINK: "https://x.test/e/1" }, { html: true });
    expect(filled).toContain("Hello Ann");
    expect(filled).toContain('href="https://x.test/e/1"');
    expect(usedTags(...designTexts(d))).toEqual(["CUSTOMER_FIRST_NAME", "ESTIMATE_LINK"]);
  });

  it("never lets a setting put anything else into the email", () => {
    const b = newBlock("paragraph");
    b.p = { ...b.p, color: 'red;background:url(javascript:alert(1))', size: "999" as never, align: '"><script>', font: "Evil, font", lineHeight: "x" as never, padTop: -5 };
    const img = { ...newBlock("image"), p: { ...newBlock("image").p, src: "javascript:alert(1)", alt: '"><b>' } };
    const img2 = { ...newBlock("image"), p: { ...newBlock("image").p, src: "https://x.test/a.png", alt: '"><b>', href: "data:text/html,x" } };
    const html = renderDesign(design(b, img, img2));
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("Evil");
    expect(html).toContain("color:#000000");
    expect(html).toContain("font-size:120px");
    expect(html).toContain('alt="&quot;&gt;&lt;b&gt;"');
    expect(html).not.toContain("data:text");
    expect(safeHref("{{INVOICES_LINKS}}")).toBe("{{INVOICES_LINKS}}");
    expect(safeHref("mailto:a@b.test")).toBe("mailto:a@b.test");
    expect(safeHref(" JaVaScript:x")).toBe("");
    expect(emailDesignSchema.safeParse({ v: 1, p: {}, rows: [{ id: "a", p: {}, columns: [{ id: "b", span: 13, p: {}, blocks: [] }] }] }).success).toBe(false);
    expect(emailDesignSchema.safeParse({ v: 1, p: { "bad key": 1 }, rows: [] }).success).toBe(false);
  });

  it("knows when there's nothing to send", () => {
    expect(designHasContent(emptyDesign())).toBe(false);
    expect(designHasContent(design({ ...newBlock("paragraph"), p: { html: "<p> &nbsp;</p>" } }, newBlock("divider"), newBlock("spacer")))).toBe(false);
    expect(designHasContent(design(newBlock("image")))).toBe(false);
    expect(designHasContent(design({ ...newBlock("image"), p: { src: "https://x.test/a.png" } }))).toBe(true);
    expect(designHasContent(design(newBlock("paragraph")))).toBe(true);
  });

  it("opens a design made in Homeworks' builder as the same blocks", () => {
    const code = (n: string, t: string) => `<code spellcheck="false" data-bee-type="mergetag" data-bee-code="" data-bee-name="${n}">${t}</code>`;
    const bee = { page: {
      body: { container: { style: { "background-color": "#FFFFFF" } }, content: { computedStyle: { linkColor: "#0068A5", messageBackgroundColor: "transparent", messageWidth: "700px" }, style: { color: "#000000", "font-family": "Arial, Helvetica Neue, Helvetica, sans-serif" } } },
      rows: [{
        container: { style: { "background-color": "#dcdfe6" } }, content: { computedStyle: { rowColStackOnMobile: true, verticalAlign: "top", hideContentOnMobile: false }, style: { "background-color": "transparent", width: "700px" } },
        columns: [{ "grid-columns": 12, style: { "background-color": "transparent", "border-top": "0 solid transparent", "padding-top": "5px", "padding-bottom": "5px", "padding-left": "0", "padding-right": "0" }, modules: [
          { type: "mailup-bee-newsletter-modules-image", descriptor: { style: { "padding-top": "0px", width: "100%" }, computedStyle: { class: "center autowidth", width: "500px" }, image: { src: "https://img.test/header.png", href: "", alt: "" } } },
          { type: "mailup-bee-newsletter-modules-heading", descriptor: { heading: { title: "h1", text: `${code("CUSTOMER NAME", "{{CUSTOMER_NAME}}")} Added a Bank Account`, style: { color: "#555555", "font-size": "23px", "font-family": "inherit", "line-height": "120%", "text-align": "center", "font-weight": "700", "letter-spacing": "0px", "link-color": "#0068A5" } }, style: { "padding-top": "0px", "padding-right": "0px", "padding-bottom": "0px", "padding-left": "0px" } } },
          { type: "mailup-bee-newsletter-modules-paragraph", descriptor: { paragraph: { html: `<p><u><strong>Details:</strong></u></p>\n<p>👤 ${code("CUSTOMER FIRST NAME", "{{CUSTOMER_FIRST_NAME}}")}</p>`, style: { color: "#000000", "font-size": "14px", "font-family": "inherit", "font-weight": "400", "line-height": "120%", "text-align": "left", "letter-spacing": "0px" }, computedStyle: { linkColor: "#0068A5", paragraphSpacing: "16px" } }, style: { "padding-top": "30px", "padding-right": "10px", "padding-bottom": "10px", "padding-left": "10px" } } },
          { type: "mailup-bee-newsletter-modules-list", descriptor: { list: { tag: "ul", html: "<ul><li>One</li></ul>", style: { "font-size": "14px" } }, style: {} } },
          { type: "mailup-bee-newsletter-modules-carousel", descriptor: {} },
        ] }],
      }],
    } };
    const { design: d, skipped } = beeToDesign(bee);
    expect(skipped).toBe(1);
    expect(emailDesignSchema.safeParse(d).success).toBe(true);
    expect(d.p).toMatchObject({ width: 700, bg: "#FFFFFF", contentBg: "transparent", font: "Arial", linkColor: "#0068A5" });
    expect(d.rows).toHaveLength(1);
    expect(d.rows[0].p).toMatchObject({ bg: "#dcdfe6", stack: true });
    const [image, title, para, list] = d.rows[0].columns[0].blocks;
    expect(d.rows[0].columns[0]).toMatchObject({ span: 12, p: { padTop: 5, padBottom: 5, padLeft: 0, borderWidth: 0 } });
    expect(image).toMatchObject({ type: "image", p: { src: "https://img.test/header.png", autoWidth: true, align: "center", padTop: 0 } });
    expect(title).toMatchObject({ type: "title", p: { level: "h1", html: "{{CUSTOMER_NAME}} Added a Bank Account", size: 23, color: "#555555", weight: "700", align: "center", lineHeight: 1.2, font: "" } });
    expect(para).toMatchObject({ type: "paragraph", p: { size: 14, paraSpacing: 16, padTop: 30, padLeft: 10 } });
    expect(para.p.html).toBe("<p><u><strong>Details:</strong></u></p>\n<p>👤 {{CUSTOMER_FIRST_NAME}}</p>");
    expect(list).toMatchObject({ type: "list", p: { listType: "ul" } });
    const html = renderDesign(d);
    expect(html).toContain('width="700"');
    expect(html).toContain("background:#dcdfe6");
    expect(html).not.toContain("<code");
    expect(beeToDesign(null)).toMatchObject({ skipped: 0, design: { rows: [] } });
  });

  it("opens an earlier plain template as blocks, with the logo on top", () => {
    const d = htmlToDesign('<h2 style="text-align:center">Hi</h2><p>One</p><p>Two</p><ul><li><p>A</p></li></ul><hr><p>Bye</p>loose', { logoUrl: "https://x.test/logo" });
    expect(d.p).toMatchObject({ width: 600, bg: "#f5f6f8" });
    expect(d.rows[0].columns[0].blocks.map((b) => b.type)).toEqual(["image", "title", "paragraph", "list", "divider", "paragraph"]);
    expect(d.rows[0].columns[0].blocks[1].p).toMatchObject({ level: "h2", align: "center", html: "Hi" });
    expect(d.rows[0].columns[0].blocks[2].p.html).toBe("<p>One</p><p>Two</p>");
    expect(d.rows[0].columns[0].blocks[5].p.html).toBe("<p>Bye</p><p>loose</p>");
    expect(htmlToDesign("").rows).toEqual([]);
    expect(emailDesignSchema.safeParse(d).success).toBe(true);
  });

  it("finds YouTube's picture for a video", () => {
    expect(videoThumb("https://www.youtube.com/watch?v=abc123XYZ_-")).toBe("https://img.youtube.com/vi/abc123XYZ_-/hqdefault.jpg");
    expect(videoThumb("https://youtu.be/abc123XYZ_-?t=4")).toBe("https://img.youtube.com/vi/abc123XYZ_-/hqdefault.jpg");
    expect(videoThumb("https://vimeo.com/123")).toBeNull();
  });
});
