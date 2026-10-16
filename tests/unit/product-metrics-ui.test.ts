import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProductMetricsPanel } from "../../src/renderer/src/features/products/ProductMetricsPanel.js";

describe("product metrics panel", () => {
  it("labels historical task denominator, confirmations, duration and usage coverage", () => {
    const html = renderToStaticMarkup(React.createElement(ProductMetricsPanel, { productId: "P1" }));
    for (const text of ["历史运行指标", "统计当前产品关联的全部历史任务", "不代表产品目标完成、业务验收", "只读", "刷新指标"]) expect(html).toContain(text);
  });
  it("is read only and does not offer task or model actions", () => {
    const html = renderToStaticMarkup(React.createElement(ProductMetricsPanel, { productId: "P1" }));
    expect(html).toContain("只读");
    expect(html).not.toContain("启动任务");
    expect(html).not.toContain("生成");
  });
});
