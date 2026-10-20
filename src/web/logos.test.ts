import { describe, expect, it } from "vitest";
import { HARNESS_NAMES, LOGOS, logoFiles } from "./logos.ts";

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

  it("has a neutral Codex glyph (no OpenAI mark in simple-icons): one evenodd path, dark grey", () => {
    const svg = svgOf(LOGOS.codex.dataURL);
    expect(svg.match(/<path /g)).toHaveLength(1);
    expect(svg).toContain('fill="#343a40" fill-rule="evenodd"');
    expect(svg).not.toMatch(/script|href|on\w+=/i);
  });

  it("has the OpenCode mark from simple-icons, in black", () => {
    const svg = svgOf(LOGOS.opencode.dataURL);
    expect(svg.match(/<path /g)).toHaveLength(1);
    expect(svg).toContain('fill="#000000" d="M22 24H2V0h20zM17 4.8H7v14.4h10z"');
    expect(LOGOS.opencode.fileId).toBe("excaliagent-logo-opencode");
  });

  it("gives one Excalidraw file per logo, with a stable id", () => {
    const files = logoFiles(123);
    expect(files).toEqual([
      { id: LOGOS.claude.fileId, mimeType: "image/svg+xml", dataURL: LOGOS.claude.dataURL, created: 123 },
      { id: LOGOS.codex.fileId, mimeType: "image/svg+xml", dataURL: LOGOS.codex.dataURL, created: 123 },
      { id: LOGOS.opencode.fileId, mimeType: "image/svg+xml", dataURL: LOGOS.opencode.dataURL, created: 123 },
    ]);
    expect(LOGOS.claude.fileId).toBe("excaliagent-logo-claude");
    expect(LOGOS.codex.fileId).toBe("excaliagent-logo-codex");
  });

  it("names every harness", () => {
    expect(HARNESS_NAMES).toEqual({ claude: "Claude Code", codex: "Codex", opencode: "OpenCode" });
  });
});
