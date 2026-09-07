import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Panel } from "@browserforge/ui";

function Options() {
  return (
    <Panel title="Arbor options">
      <p>Settings will appear here. This extension is in development.</p>
    </Panel>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Options />
  </StrictMode>,
);
