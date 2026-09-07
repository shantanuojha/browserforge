import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Panel } from "@browserforge/ui";
import "@browserforge/ui/styles.css";

function Options() {
  return (
    <Panel title="Reroute settings">
      <p>Rule editor coming in Phase 4.</p>
    </Panel>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Options />
  </StrictMode>,
);
