import { describe, expect, it } from "vitest";
import { LOGOS, logoFiles } from "./logos.ts";

const svgOf = (dataURL: string) => {
  const [head, b64] = dataURL.split(",");
  expect(head).toBe("data:image/svg+xml;base64");
  return atob(b64!);
};

describe("logos", () => {
  it("has a Claude mark: a single filled path in Claude's orange, sized for crisp scaling", () => {
    const svg = svgOf(LOGOS.claude.dataURL);
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 24 24" width="256" height="256">/);
    expect(svg.match(/<path /g)).toHaveLength(1);
    expect(svg).toContain('fill="#D97757"');
    expect(svg).not.toMatch(/script|href|on\w+=/i);
  });

  it("gives one Excalidraw file per logo, with a stable id", () => {
    const files = logoFiles(123);
    expect(files).toEqual([{ id: LOGOS.claude.fileId, mimeType: "image/svg+xml", dataURL: LOGOS.claude.dataURL, created: 123 }]);
    expect(LOGOS.claude.fileId).toBe("excaliagent-logo-claude");
  });
});
