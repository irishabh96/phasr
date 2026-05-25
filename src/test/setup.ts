import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Vitest doesn't auto-cleanup React Testing Library renders when
// `globals: false`; mount the explicit hook here so each test starts
// from an empty DOM.
afterEach(() => {
  cleanup();
});

// jsdom doesn't implement matchMedia — useShiki / theme code reads it
// to resolve `theme: "system"`. Provide a no-op shim.
if (typeof window !== "undefined" && !("matchMedia" in window)) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}
