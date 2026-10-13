import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProductDeliveryPanel } from "../../src/renderer/src/features/products/ProductDeliveryPanel.js";

describe("product delivery UI", () => {
  it("renders the business acceptance and publication boundaries", () => {
    const html = renderToStaticMarkup(React.createElement(ProductDeliveryPanel, { productId: "p1", goalRevision: 2 }));
    expect(html).toContain("验收与未发布交付");
    expect(html).toContain("产品验收标准");
    expect(html).toContain("关联任务 AC");
    expect(html).toContain("保存验收与交付记录");
    expect(html).toContain("保存不会运行、发布或启动模型");
  });
});
