import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import App from "./App";
import { setupReactBridge } from "./bridge";

const rootEl = document.getElementById("react-root");

if (rootEl) {
  const root = createRoot(rootEl);
  flushSync(() => {
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    );
  });
  setupReactBridge();
  window.__STAQ_REACT_BOOTED__ = true;
}
