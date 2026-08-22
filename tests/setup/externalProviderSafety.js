import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

const INSTALL_KEY = Symbol.for("callbackiq.externalProviderSafety.installed");

const BLOCKED_PROVIDER_SUFFIXES = Object.freeze([
  "twilio.com",
  "stripe.com",
  "openai.com",
  "googleapis.com",
  "resend.com",
]);

const BLOCKED_PROVIDER_HOSTS = new Set([
  "accounts.google.com",
  "oauth2.googleapis.com",
  "smtp.gmail.com",
]);

const normalizeHostname = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");

export const isBlockedProviderHost = (hostname) => {
  const host = normalizeHostname(hostname);
  if (!host) return false;

  if (BLOCKED_PROVIDER_HOSTS.has(host)) return true;

  return BLOCKED_PROVIDER_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
};

const blockedError = (hostname) => {
  const error = new Error(
    `External provider network access is blocked during CallBackIQ tests: ${hostname}. ` +
      "Mock the provider boundary instead of making a live request.",
  );
  error.code = "EXTERNAL_PROVIDER_NETWORK_BLOCKED";
  error.hostname = hostname;
  return error;
};

const extractHostnameFromUrlLike = (input, protocol = "https:") => {
  if (!input) return "";

  if (input instanceof URL) {
    return input.hostname;
  }

  if (typeof input === "string") {
    if (input.startsWith("/")) return "";
    try {
      return new URL(input).hostname;
    } catch {
      return "";
    }
  }

  if (typeof input === "object") {
    if (typeof input.url === "string") {
      try {
        return new URL(input.url).hostname;
      } catch {
        // Continue to the normal options-object handling below.
      }
    }

    if (input.hostname) return input.hostname;
    if (input.host) {
      return String(input.host).replace(/:\d+$/, "");
    }

    if (input.href) {
      try {
        return new URL(input.href).hostname;
      } catch {
        return "";
      }
    }

    if (input.path && input.protocol && input.hostname) {
      try {
        return new URL(
          `${input.protocol || protocol}//${input.hostname}${input.path}`,
        ).hostname;
      } catch {
        return "";
      }
    }
  }

  return "";
};

export const assertExternalProviderUrlAllowed = (input, protocol = "https:") => {
  const hostname = normalizeHostname(
    extractHostnameFromUrlLike(input, protocol),
  );

  if (hostname && isBlockedProviderHost(hostname)) {
    throw blockedError(hostname);
  }

  return true;
};

const socketHostname = (args) => {
  const first = args[0];

  if (first && typeof first === "object") {
    return first.host || first.hostname || "";
  }

  if (typeof first === "number") {
    return typeof args[1] === "string" ? args[1] : "localhost";
  }

  return "";
};

const installHttpGuard = (module, protocol) => {
  const originalRequest = module.request;
  const originalGet = module.get;

  module.request = function guardedRequest(...args) {
    assertExternalProviderUrlAllowed(args[0], protocol);
    return originalRequest.apply(this, args);
  };

  module.get = function guardedGet(...args) {
    assertExternalProviderUrlAllowed(args[0], protocol);
    return originalGet.apply(this, args);
  };
};

const installSocketGuard = (module, methodName) => {
  const original = module[methodName];
  if (typeof original !== "function") return;

  module[methodName] = function guardedSocketConnection(...args) {
    const hostname = normalizeHostname(socketHostname(args));
    if (hostname && isBlockedProviderHost(hostname)) {
      throw blockedError(hostname);
    }
    return original.apply(this, args);
  };
};

export const installExternalProviderNetworkGuard = () => {
  if (globalThis[INSTALL_KEY]) return;
  globalThis[INSTALL_KEY] = true;

  /*
   * Defense in depth:
   * 1. Certification runners replace provider credentials with inert test values.
   * 2. Provider SDKs are mocked by the behavioral tests.
   * 3. This guard blocks provider network access even if a mock is accidentally
   *    removed later.
   */
  installHttpGuard(http, "http:");
  installHttpGuard(https, "https:");

  if (typeof globalThis.fetch === "function") {
    const originalFetch = globalThis.fetch.bind(globalThis);

    globalThis.fetch = async function guardedFetch(input, init) {
      assertExternalProviderUrlAllowed(input, "https:");
      return originalFetch(input, init);
    };
  }

  installSocketGuard(net, "connect");
  installSocketGuard(net, "createConnection");
  installSocketGuard(tls, "connect");
};

installExternalProviderNetworkGuard();
