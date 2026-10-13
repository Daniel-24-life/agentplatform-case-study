import { expect, test } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { canStartProductPreview, ProductPreviewPanel } from "../../src/renderer/src/features/products/ProductPreviewPanel.js";

test("preview start eligibility enforces dirty, disabled, busy and active rules", () => {
  expect(canStartProductPreview(null, false, false, false).eligible).toBe(true);
  expect(canStartProductPreview(null, false, true, false).eligible).toBe(false);
  expect(canStartProductPreview(null, true, false, false).eligible).toBe(false);
  expect(canStartProductPreview(null, false, false, true).eligible).toBe(false);
  expect(canStartProductPreview({ status: "RUNNING" } as never, false, false, false).eligible).toBe(false);
});

test("preview panel exposes static preview controls and build choices", () => {
  const html = renderToStaticMarkup(React.createElement(ProductPreviewPanel, { productId: "p1", disabled: false, dirty: false }));
  expect(html).toContain("本地静态预览");
  expect(html).toContain("启动本地预览");
  expect(html).toContain("打开预览窗口");
  expect(html).toContain("刷新预览记录");
  expect(html).toContain("value=\"dist\"");
});
