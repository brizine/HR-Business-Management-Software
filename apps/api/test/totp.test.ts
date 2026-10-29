import { describe, expect, it } from "vitest";
import { codeAt, base32Decode, base32Encode, newTotpSecret, otpauthUri, verifyTotp } from "../src/lib/totp";
import { decrypt, encrypt } from "../src/lib/crypto";

// RFC 6238 Appendix B, SHA-1 secret "12345678901234567890".
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));

describe("TOTP", () => {
  it("matches the RFC 6238 test vectors (last 6 digits)", () => {
    expect(codeAt(RFC_SECRET, Math.floor(59 / 30), 8)).toBe("94287082");
    expect(codeAt(RFC_SECRET, Math.floor(1111111109 / 30), 8)).toBe("07081804");
    expect(codeAt(RFC_SECRET, Math.floor(1234567890 / 30), 8)).toBe("89005924");
    expect(codeAt(RFC_SECRET, Math.floor(59 / 30))).toBe("287082");
  });

  it("round-trips base32", () => {
    const buf = Buffer.from("crewdesk!");
    expect(base32Decode(base32Encode(buf))).toEqual(buf);
    expect(newTotpSecret()).toMatch(/^[A-Z2-7]{32}$/);
  });

  it("accepts the current code and one step of drift, nothing else", () => {
    const secret = newTotpSecret();
    const now = Date.UTC(2030, 0, 1, 12, 0, 15);
    const step = Math.floor(now / 30000);
    expect(verifyTotp(secret, codeAt(secret, step), now)).toBe(step);
    expect(verifyTotp(secret, codeAt(secret, step - 1), now)).toBe(step - 1);
    expect(verifyTotp(secret, codeAt(secret, step + 1), now)).toBe(step + 1);
    expect(verifyTotp(secret, codeAt(secret, step - 2), now)).toBeNull();
    expect(verifyTotp(secret, "12345", now)).toBeNull();
    expect(verifyTotp(secret, "abcdef", now)).toBeNull();
  });

  it("builds an otpauth link", () => {
    expect(otpauthUri("ABC", "pia@prospray.biz", "Biz Management Software (ProSpray)")).toBe(
      "otpauth://totp/Biz%20Management%20Software%20(ProSpray)%3Apia%40prospray.biz?secret=ABC&issuer=Biz%20Management%20Software%20(ProSpray)&algorithm=SHA1&digits=6&period=30",
    );
  });
});

describe("encryption at rest", () => {
  it("round-trips and detects tampering", () => {
    const sealed = encrypt("JBSWY3DPEHPK3PXP");
    expect(sealed).not.toContain("JBSWY3DPEHPK3PXP");
    expect(decrypt(sealed)).toBe("JBSWY3DPEHPK3PXP");
    const parts = sealed.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decrypt(parts.join("."))).toThrow();
  });
});
