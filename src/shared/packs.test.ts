import { describe, expect, it } from "vitest";
import { BUILT_IN_PACKS, DEFAULT_PACK, PACK_NAME, emojiFileId, emojiFromFileId, validEmoji } from "./packs.ts";

describe("built-in packs", () => {
  it("are 24–40 distinct, valid emoji each, with ids that cannot be folder names", () => {
    expect(BUILT_IN_PACKS.map((p) => p.id)).toContain(DEFAULT_PACK);
    for (const p of BUILT_IN_PACKS) {
      expect(p.id.startsWith("@")).toBe(true);
      expect(PACK_NAME.test(p.id)).toBe(false);
      expect(p.characters.length).toBeGreaterThanOrEqual(24);
      expect(p.characters.length).toBeLessThanOrEqual(40);
      expect(new Set(p.characters.map((c) => c.id)).size).toBe(p.characters.length);
      for (const c of p.characters) {
        expect(validEmoji(c.id), c.id).toBe(true);
        // broad font support: no ZWJ sequences or variation selectors
        expect(c.id).not.toMatch(/[‍️]/);
        expect(emojiFromFileId(c.fileId)).toBe(c.id);
      }
    }
  });
});

describe("validEmoji", () => {
  it.each(["🐱", "🐈‍⬛", "👍🏽", "🇲🇰", "⚓", "❤️"])("accepts %s", (e) => expect(validEmoji(e)).toBe(true));
  it.each(["", "a", "ab", "🐱🐶", " 🐱", "🐱\n", "<svg>", "x".repeat(40), 5, null])("refuses %j", (e) =>
    expect(validEmoji(e)).toBe(false),
  );
});

describe("emoji file ids", () => {
  it("encode the code points and round-trip", () => {
    expect(emojiFileId("🐱")).toBe("excaliagent-emoji-1f431");
    expect(emojiFromFileId(emojiFileId("🐈‍⬛"))).toBe("🐈‍⬛");
    expect(emojiFileId("🐈‍⬛")).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
  });
  it("reject anything else", () => {
    for (const id of ["excaliagent-emoji-", "excaliagent-emoji-zz", "excaliagent-emoji-61", "excaliagent-logo-claude", "excaliagent-emoji-110000"])
      expect(emojiFromFileId(id)).toBeUndefined();
  });
});
