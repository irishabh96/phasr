import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { setupReactBridge } from "./bridge";

const rootEl = document.getElementById("react-root");

if (rootEl) {
  const root = createRoot(rootEl);
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
  setupReactBridge();
}
