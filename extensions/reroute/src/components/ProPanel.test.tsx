import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProPanel } from "./ProPanel";

const render = (pro: boolean | null, syncEnabled: boolean) =>
  renderToStaticMarkup(
    <ProPanel
      pro={pro}
      syncEnabled={syncEnabled}
      onSyncToggle={() => undefined}
      onInstallPack={() => undefined}
    />,
  );

/** The sync switch is the only checkbox in the panel. */
function syncSwitch(html: string): string {
  const m = /<input[^>]*type="checkbox"[^>]*>/.exec(html);
  if (!m) throw new Error("sync switch not rendered");
  return m[0];
}

describe("ProPanel sync switch", () => {
  it("cannot be turned on without Pro", () => {
    expect(syncSwitch(render(false, false))).toContain("disabled");
  });
  it("can always be turned off, even after the licence lapsed", () => {
    const html = syncSwitch(render(false, true));
    expect(html).toContain('checked=""');
    expect(html).not.toContain("disabled");
  });
  it("is enabled for Pro users", () => {
    expect(syncSwitch(render(true, false))).not.toContain("disabled");
  });
});
