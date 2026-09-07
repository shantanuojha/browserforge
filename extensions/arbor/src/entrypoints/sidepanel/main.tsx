import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@browserforge/ui/styles.css";
import "@/styles/arbor.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
