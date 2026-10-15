import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const pagePath = path.join(root, "case-study", "index.html");
const html = readFileSync(pagePath, "utf8");
const css = readFileSync(path.join(root, "case-study", "styles.css"), "utf8");

describe("static case study", () => {
  it("keeps the stopped status and evidence boundaries explicit", () => {
    expect(html).toContain("已停止开发");
    expect(html).toContain("RUNTIME_<br />NOT_QUALIFIED");
    expect(html).toContain("模型调用 / 开发 Task / AgentRun");
    expect(html).toContain("0 / 0 / 0");
    expect(html).toContain("动态多 Agent");
    expect(html).toContain("未实现");
    expect(html.match(/离线合成夹具/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("uses native document structure and has a single h1", () => {
    expect(html).toMatch(/<html lang="zh-CN">/);
    expect(html).toContain("<header class=\"site-header\">");
    expect(html).toContain("<nav aria-label=\"案例页导航\">");
    expect(html).toContain("<main id=\"main-content\">");
    expect(html).toContain("<footer>");
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).not.toMatch(/<(button|input|select|textarea)\b/);
  });

  it("keeps every local file reference resolvable and loads no network resource", () => {
    const references = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map(match => match[1]);
    expect(references.some(reference => /^(?:https?:)?\/\//.test(reference))).toBe(false);
    for (const reference of references.filter(reference => !reference.startsWith("#"))) {
      const [file] = reference.split("#");
      expect(existsSync(path.resolve(path.dirname(pagePath), file)), reference).toBe(true);
    }
  });

  it("pins the requested visual tokens, readable text sizes, focus, reflow, and reduced motion", () => {
    expect(css).toContain("--canvas: #f3f6f8");
    expect(css).toContain("--ink: #102536");
    expect(css).toContain("--accent: #12685f");
    expect(css).toContain("font-size: 16px");
    expect(css).toMatch(/font-size: 0\.8125rem/g);
    expect(css).toContain(":focus-visible");
    expect(css).toContain("@media (max-width: 40rem)");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).not.toMatch(/(?:width:\s*100vw|50vw)/);
    expect(css).not.toContain("letter-spacing: 0.12em");
  });
});
