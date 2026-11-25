import { describe, expect, it } from "vitest";
import {
  BLOCK_LABELS, BLOCK_TYPES, DESIGN_MARK, beeToDesign, brandHeaderRow, contrastText, designHasContent, designTexts, emailDesignSchema, emptyDesign, fillTags, homeworksPictureTitle, homeworksPictures, recolorHeaderRow,
  htmlToDesign, isDesignedBody, isHomeworksPicture, linkedRow, newBlock, newRow, renderDesign, renderDesignBlock, safeHref, swapHomeworksPictures, unlinkRow, usedTags, usesSavedRow, videoThumb, withSavedRows,
  type EmailDesign,
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

describe("saved rows and the company's own header", () => {
  it("a saved row is the same in every design that uses it", () => {
    const header = { id: "hdr1", name: "Header", row: brandHeaderRow({ color: "#14532d", logoUrl: "https://x.test/logo.png", companyName: "Pro Spray" }) };
    const d: EmailDesign = { ...emptyDesign(), rows: [linkedRow(header), newRow([12], [newBlock("paragraph")])] };
    expect(d.rows[0].p).toMatchObject({ saved: "hdr1", savedName: "Header", contentBg: "#14532d" });
    expect(usesSavedRow(d, "hdr1")).toBe(1);
    expect(emailDesignSchema.safeParse(d).success).toBe(true);
    expect(withSavedRows(d, new Map([["hdr1", header]])).changed).toBe(false);
    // The saved row changes: the design follows, keeping its own row's id.
    const blue = { ...header, name: "Top", row: brandHeaderRow({ color: "#1d4ed8", companyName: "Pro Spray" }) };
    const next = withSavedRows(d, new Map([["hdr1", blue]]));
    expect(next.changed).toBe(true);
    expect(next.design.rows[0]).toMatchObject({ id: d.rows[0].id, p: { saved: "hdr1", savedName: "Top", contentBg: "#1d4ed8" } });
    expect(next.design.rows[0].columns[0].blocks[0]).toMatchObject({ type: "title", p: { html: "Pro Spray", color: "#ffffff" } });
    expect(next.design.rows[1]).toBe(d.rows[1]);
    // The saved row is deleted: the row stays, as the design's own.
    const gone = withSavedRows(d, new Map());
    expect(gone.changed).toBe(true);
    expect(gone.design.rows[0].p.saved).toBeUndefined();
    expect(gone.design.rows[0].columns[0].blocks[0].p.src).toBe("https://x.test/logo.png");
    expect(unlinkRow(d.rows[0]).p.savedName).toBeUndefined();
  });

  it("picks white or black words for a colour", () => {
    expect(contrastText("#14532d")).toBe("#ffffff");
    expect(contrastText("#fde047")).toBe("#111111");
    expect(contrastText("nonsense")).toBe("#111111");
  });

  it("swaps Homeworks' pictures for the company's header", () => {
    const hw = "https://prod-beefree-images.s3.amazonaws.com/images/copilot-template-builder-/";
    expect(isHomeworksPicture(`${hw}Customer%20Emails/Invoice%201.png`)).toBe(true);
    expect(isHomeworksPicture("https://x.test/mine.png")).toBe(false);
    expect(homeworksPictureTitle(`${hw}Internal%20Emails/Estimate%20Accepted.png`)).toBe("Estimate Accepted");
    expect(homeworksPictureTitle(`${hw}Internal%20Emails/Invoice%20Overdue%20Notice.png`)).toBe("Invoice Overdue Notice");
    expect(homeworksPictureTitle(`${hw}Customer%20Emails/Invoice%201.png`)).toBeNull();
    expect(homeworksPictureTitle(`${hw}Internal%20Emails/Copilot%20Header%20Light.png`)).toBeNull();
    expect(homeworksPictureTitle(`${hw}Customer%20Emails/Google%20Email.png`)).toBeNull();
    const image = (src: string) => ({ ...newBlock("image"), p: { ...newBlock("image").p, src } });
    const header = { id: "hdr1", name: "Header", row: brandHeaderRow({ color: "#14532d", companyName: "Pro Spray" }) };
    const d = design(image(`${hw}Internal%20Emails/Estimate%20Accepted.png`), newBlock("paragraph"), image("https://x.test/mine.png"), image(`${hw}Customer%20Emails/Service%204.png`));
    expect(homeworksPictures(d)).toBe(2);
    const { design: out, swapped } = swapHomeworksPictures(d, header);
    expect(swapped).toBe(2);
    expect(out.rows).toHaveLength(2);
    expect(out.rows[0].p.saved).toBe("hdr1");
    expect(out.rows[1].columns[0].blocks.map((b) => [b.type, b.p.html ?? b.p.src])).toEqual([["title", "Estimate Accepted"], ["paragraph", "<p>I'm a new paragraph block.</p>"], ["image", "https://x.test/mine.png"]]);
    expect(homeworksPictures(out)).toBe(0);
    // Nothing to swap: nothing changes, and the header isn't added twice.
    expect(swapHomeworksPictures(out, header)).toMatchObject({ swapped: 0 });
    expect(swapHomeworksPictures(out, header).design).toBe(out);
    expect(homeworksPictures(null)).toBe(0);
  });

  it("the company's header: its logo on a background, over a line of its colour", () => {
    // One colour: a band of it, and no line.
    expect(brandHeaderRow({ color: "#14532d", companyName: "Pro Spray" }).columns[0].blocks.map((b) => b.type)).toEqual(["title"]);
    const row = brandHeaderRow({ color: "#FFFFFF", accent: "#15803D", logoUrl: "https://x.test/logo.png", companyName: "Pro Spray" });
    expect(row.p.contentBg).toBe("#ffffff");
    expect(row.columns[0].blocks.map((b) => [b.type, b.p.src ?? b.p.color, b.p.padTop])).toEqual([["image", "https://x.test/logo.png", 18], ["divider", "#15803d", 0]]);
    const html = renderDesign({ ...emptyDesign(), rows: [row] });
    expect(html).toContain("border-top:4px solid #15803d");
    expect(html).toContain('alt="Pro Spray"');
    // Other colours: the background and the line follow, the words stay readable, and what was added stays.
    const named = brandHeaderRow({ color: "#14532d", companyName: "Pro Spray" });
    const mine = { ...named, columns: [{ ...named.columns[0], blocks: [...named.columns[0].blocks, { ...newBlock("paragraph"), p: { ...newBlock("paragraph").p, html: "<p>Since 1998</p>", color: "#ff0000" } }] }] };
    const light = recolorHeaderRow(mine, "#FEF9C3", "#a16207");
    expect(light.p.contentBg).toBe("#fef9c3");
    expect(light.columns[0].blocks.map((b) => [b.type, b.p.color])).toEqual([["title", "#111111"], ["paragraph", "#ff0000"], ["divider", "#a16207"]]);
    // Again: the line it has is recoloured, not doubled. With no accent given, lines are left alone.
    expect(recolorHeaderRow(light, "#1e3a8a", "#f59e0b").columns[0].blocks.map((b) => [b.type, b.p.color])).toEqual([["title", "#ffffff"], ["paragraph", "#ff0000"], ["divider", "#f59e0b"]]);
    expect(recolorHeaderRow(light, "#1e3a8a").columns[0].blocks.map((b) => b.p.color)).toEqual(["#ffffff", "#ff0000", "#a16207"]);
  });
});
