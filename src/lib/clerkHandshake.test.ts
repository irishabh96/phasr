import { describe, expect, it } from "vitest";
import {
  applyClerkHandshakeCookies,
  decodeClerkHandshake,
  fallbackCookieDirectiveForWebview,
  handshakeCookieValue,
  normalizeHandshakeCookieDirective,
} from "./clerkHandshake";

function base64UrlEncode(value: string) {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function handshakeJwt(payload: unknown) {
  return [
    base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" })),
    base64UrlEncode(JSON.stringify(payload)),
    "signature",
  ].join(".");
}

describe("Clerk handshake helpers", () => {
  it("decodes cookie directives from Clerk handshake JWT payloads", () => {
    expect(
      decodeClerkHandshake(
        handshakeJwt({
          handshake: [
            "__session=jwt; Path=/; Secure; SameSite=None",
            "__client_uat=123; Path=/; Domain=phasr-auth-bridge.vercel.app; Max-Age=315360000; Secure; SameSite=None",
          ],
        }),
      ),
    ).toEqual([
      "__session=jwt; Path=/; Secure; SameSite=None",
      "__client_uat=123; Path=/; Domain=phasr-auth-bridge.vercel.app; Max-Age=315360000; Secure; SameSite=None",
    ]);
  });

  it("strips cookie attributes that cannot be applied to the app origin", () => {
    expect(
      normalizeHandshakeCookieDirective(
        "__refresh=token; Path=/; Domain=phasr-auth-bridge.vercel.app; Expires=Sun, 23 May 2027 21:31:42 GMT; HttpOnly; Secure; SameSite=None",
      ),
    ).toEqual({
      name: "__refresh",
      directive:
        "__refresh=token; Path=/; Expires=Sun, 23 May 2027 21:31:42 GMT; Secure; SameSite=None",
    });
  });

  it("can produce a fallback directive for non-https webviews", () => {
    expect(
      fallbackCookieDirectiveForWebview({
        name: "__session",
        directive: "__session=jwt; Path=/; Secure; SameSite=None",
      }),
    ).toBe("__session=jwt; Path=/");
  });

  it("extracts the session token from handshake cookie directives", () => {
    const result = applyClerkHandshakeCookies(
      handshakeJwt({
        handshake: [
          "__client_uat=123; Path=/; Secure; SameSite=None",
          "__session=jwt-token; Path=/; Secure; SameSite=None",
        ],
      }),
    );

    expect(handshakeCookieValue(result.cookies, "__session")).toBe("jwt-token");
  });
});
