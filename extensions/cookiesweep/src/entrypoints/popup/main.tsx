import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@browserforge/ui/styles.css";
import "../../styles/app.css";
import { App } from "./App.js";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
