import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Button, Panel, ProBadge } from "./index";

describe("@browserforge/ui", () => {
  it("renders a Button with variant/size classes", () => {
    const html = renderToStaticMarkup(
      <Button variant="secondary" size="sm">
        Save
      </Button>,
    );
    expect(html).toContain('type="button"');
    expect(html).toContain("bf-button--secondary");
    expect(html).toContain("bf-button--sm");
    expect(html).toContain("Save");
  });

  it("renders a ProBadge with default label", () => {
    const html = renderToStaticMarkup(<ProBadge />);
    expect(html).toContain("bf-pro-badge");
    expect(html).toContain("PRO");
  });

  it("renders a Panel with title, actions and body", () => {
    const html = renderToStaticMarkup(
      <Panel title="Arbor" actions={<ProBadge />}>
        hello
      </Panel>,
    );
    expect(html).toContain("<h1");
    expect(html).toContain("Arbor");
    expect(html).toContain("bf-panel__actions");
    expect(html).toContain("hello");
  });
});
