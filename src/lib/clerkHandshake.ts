type HandshakePayload = {
  handshake?: string[];
};

export type AppliedHandshakeCookie = {
  name: string;
  directive: string;
};

export type ClerkHandshakeResult = {
  cookies: AppliedHandshakeCookie[];
  storedCookieNames: string[];
};

function decodeBase64Url(value: string) {
  const padded = value.padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");

  if (typeof atob === "function") {
    return atob(base64);
  }

  return Buffer.from(base64, "base64").toString("binary");
}

export function decodeClerkHandshake(handshakeJwt: string) {
  const [, payload] = handshakeJwt.split(".");
  if (!payload) {
    throw new Error("Clerk handshake is missing a JWT payload.");
  }

  const decoded = decodeBase64Url(payload);
  const parsed = JSON.parse(decoded) as HandshakePayload;

  if (!Array.isArray(parsed.handshake)) {
    throw new Error("Clerk handshake payload is missing cookie directives.");
  }

  return parsed.handshake;
}

export function normalizeHandshakeCookieDirective(cookie: string) {
  const parts = cookie
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => {
      const [name = ""] = part.split("=");
      const normalizedName = name.toLowerCase();
      return normalizedName !== "domain" && normalizedName !== "httponly";
    });

  const [nameValue] = parts;
  const [name] = nameValue?.split("=") ?? [];
  if (!name) {
    throw new Error("Clerk handshake contained an invalid cookie directive.");
  }

  return {
    name,
    directive: parts.join("; "),
  };
}

export function fallbackCookieDirectiveForWebview(cookie: AppliedHandshakeCookie) {
  const parts = cookie.directive
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => {
      const normalized = part.toLowerCase();
      return normalized !== "secure" && normalized !== "samesite=none";
    });

  return parts.join("; ");
}

function cookieWasApplied(name: string) {
  return document.cookie
    .split(";")
    .map((cookie) => cookie.trim())
    .some((cookie) => cookie.startsWith(`${name}=`));
}

export function storedHandshakeCookieNames(cookies: AppliedHandshakeCookie[]) {
  return cookies
    .filter((cookie) => cookieWasApplied(cookie.name))
    .map((cookie) => cookie.name);
}

export function handshakeCookieValue(
  cookies: AppliedHandshakeCookie[],
  cookieName: string,
) {
  const cookie = cookies.find(({ name }) => name === cookieName);
  const [nameValue] = cookie?.directive.split(";") ?? [];
  const value = nameValue?.slice(`${cookieName}=`.length);
  return value || null;
}

export function applyClerkHandshakeCookies(handshakeJwt: string) {
  const cookies = decodeClerkHandshake(handshakeJwt).map(
    normalizeHandshakeCookieDirective,
  );

  for (const cookie of cookies) {
    document.cookie = cookie.directive;
    if (!cookieWasApplied(cookie.name)) {
      document.cookie = fallbackCookieDirectiveForWebview(cookie);
    }
  }

  return {
    cookies,
    storedCookieNames: storedHandshakeCookieNames(cookies),
  } satisfies ClerkHandshakeResult;
}
