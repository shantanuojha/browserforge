import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createLicenseClient,
  type LicenseState,
  type LicenseStorage,
} from "@browserforge/licensing";
import {
  ActivateLicenseDialog,
  Badge,
  Button,
  Callout,
  EmptyState,
  IconButton,
  KeyValueList,
  Panel,
  ProBadge,
  ProGate,
  Section,
  Select,
  TextInput,
  Toggle,
  cx,
  hasRestorableKey,
  openExternal,
  summarizeLicenseState,
  useLicense,
} from "./index";

function memoryStorage(): LicenseStorage {
  const data = new Map<string, unknown>();
  return {
    async get(keys) {
      const out: Record<string, unknown> = {};
      for (const k of typeof keys === "string" ? [keys] : keys)
        if (data.has(k)) out[k] = data.get(k);
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) data.set(k, v);
    },
    async remove(keys) {
      for (const k of typeof keys === "string" ? [keys] : keys) data.delete(k);
    },
  };
}

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

  it("cx joins truthy class names", () => {
    expect(cx("a", false, undefined, null, "b")).toBe("a b");
  });
});

describe("IconButton", () => {
  it("always has an accessible name and hides the icon", () => {
    const html = renderToStaticMarkup(
      <IconButton label="Close" size="sm">
        <svg />
      </IconButton>,
    );
    expect(html).toContain('aria-label="Close"');
    expect(html).toContain('title="Close"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("bf-icon-button--sm");
    expect(html).toContain('type="button"');
  });
});

describe("Toggle", () => {
  it("renders a switch wired to its label and description", () => {
    const html = renderToStaticMarkup(
      <Toggle checked label="Auto-clean" description="Runs on close" onChange={() => {}} id="t1" />,
    );
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('id="t1"');
    expect(html).toContain('for="t1"');
    expect(html).toContain('aria-labelledby="t1-label"');
    expect(html).toContain('aria-describedby="t1-description"');
    expect(html).toContain("bf-toggle--on");
  });

  it("reflects the unchecked and disabled states", () => {
    const html = renderToStaticMarkup(
      <Toggle checked={false} disabled label="X" onChange={() => {}} />,
    );
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain("disabled");
    expect(html).toContain("bf-toggle--disabled");
    expect(html).not.toContain("aria-describedby");
  });
});

describe("TextInput", () => {
  it("links label, hint and error to the input", () => {
    const html = renderToStaticMarkup(
      <TextInput id="k" label="Licence key" hint="Paste it" error="Too short" mono />,
    );
    expect(html).toContain('for="k"');
    expect(html).toContain('id="k"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="k-hint k-error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("bf-input--mono");
    expect(html).toContain("bf-field--invalid");
  });

  it("can visually hide the label while keeping it in the DOM", () => {
    const html = renderToStaticMarkup(<TextInput label="Search" hideLabel />);
    expect(html).toContain("bf-visually-hidden");
    expect(html).toContain("Search");
    expect(html).not.toContain("aria-describedby");
  });
});

describe("Select", () => {
  it("renders a native select with options and a label", () => {
    const html = renderToStaticMarkup(
      <Select
        id="s"
        label="Mode"
        value="b"
        onChange={() => {}}
        options={[
          { value: "a", label: "Alpha" },
          { value: "b", label: "Beta", disabled: true },
        ]}
        hint="Pick one"
      />,
    );
    expect(html).toContain("<select");
    expect(html).toContain('for="s"');
    expect(html).toContain('aria-describedby="s-hint"');
    expect(html).toContain('<option value="a">Alpha</option>');
    expect(html).toContain('<option value="b" disabled="" selected="">Beta</option>');
  });
});

describe("Badge / Callout", () => {
  it("renders tones as modifier classes", () => {
    expect(renderToStaticMarkup(<Badge tone="success">On</Badge>)).toContain("bf-badge--success");
    expect(renderToStaticMarkup(<Badge>Neutral</Badge>)).toContain("bf-badge--neutral");
  });

  it("uses alert semantics for warning/danger and status otherwise", () => {
    const danger = renderToStaticMarkup(
      <Callout tone="danger" title="Failed" action={<Button size="sm">Retry</Button>}>
        Details
      </Callout>,
    );
    expect(danger).toContain('role="alert"');
    expect(danger).toContain("bf-callout--danger");
    expect(danger).toContain("bf-callout__title");
    expect(danger).toContain("bf-callout__action");
    expect(renderToStaticMarkup(<Callout>Hi</Callout>)).toContain('role="status"');
    expect(renderToStaticMarkup(<Callout tone="warning">Hi</Callout>)).toContain('role="alert"');
    expect(renderToStaticMarkup(<Callout tone="success">Hi</Callout>)).toContain('role="status"');
  });
});

describe("EmptyState / Section / KeyValueList", () => {
  it("renders EmptyState parts", () => {
    const html = renderToStaticMarkup(
      <EmptyState
        title="No rules yet"
        description="Add one"
        icon={<svg />}
        action={<Button>Add</Button>}
      />,
    );
    expect(html).toContain("bf-empty__title");
    expect(html).toContain("No rules yet");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("bf-empty__action");
  });

  it("labels a Section by its heading", () => {
    const html = renderToStaticMarkup(
      <Section id="sec" title="Backups" description="Daily" actions={<ProBadge />}>
        body
      </Section>,
    );
    expect(html).toContain('aria-labelledby="sec-title"');
    expect(html).toContain('aria-describedby="sec-description"');
    expect(html).toContain('<h2 class="bf-section__title" id="sec-title">Backups</h2>');
    expect(html).toContain("bf-section__actions");
    expect(html).toContain("body");
  });

  it("renders a definition list", () => {
    const html = renderToStaticMarkup(
      <KeyValueList
        items={[
          { key: "Key", value: "XXXX-…-1234", mono: true },
          { key: "Email", value: "a@b.c" },
        ]}
      />,
    );
    expect(html).toContain("<dl");
    expect(html).toContain("<dt");
    expect(html).toContain("bf-kv__value--mono");
    expect(html).toContain("a@b.c");
  });
});

describe("ProGate", () => {
  const props = { price: "$9 one-time", checkoutUrl: "https://store.example/checkout/abc" };

  it("renders children when the feature is allowed", () => {
    const html = renderToStaticMarkup(
      <ProGate feature="backups" can={() => true} {...props}>
        <span>secret</span>
      </ProGate>,
    );
    expect(html).toBe("<span>secret</span>");
  });

  it("renders a compact upsell row otherwise", () => {
    const html = renderToStaticMarkup(
      <ProGate feature="backups" can={(f) => f !== "backups"} featureLabel="Backups" {...props}>
        <span>secret</span>
      </ProGate>,
    );
    expect(html).not.toContain("secret");
    expect(html).toContain("bf-pro-gate");
    expect(html).toContain('data-feature="backups"');
    expect(html).toContain("$9 one-time");
    expect(html).toContain("Unlock");
    expect(html).toContain("bf-pro-badge");
    expect(html).not.toContain("<script");
  });

  describe("openExternal", () => {
    const original = (globalThis as { window?: unknown }).window;
    afterEach(() => {
      (globalThis as { window?: unknown }).window = original;
    });

    it("opens the checkout in a new tab without an opener", () => {
      const open = vi.fn();
      (globalThis as { window?: unknown }).window = { open };
      openExternal(props.checkoutUrl);
      expect(open).toHaveBeenCalledWith(props.checkoutUrl, "_blank", "noopener");
    });

    it("is a no-op without a window", () => {
      delete (globalThis as { window?: unknown }).window;
      expect(() => openExternal(props.checkoutUrl)).not.toThrow();
    });
  });
});

describe("ActivateLicenseDialog", () => {
  const client = createLicenseClient({
    productName: "arbor",
    storage: memoryStorage(),
    fetch: async () => new Response("{}", { status: 500 }),
  });

  it("renders the activation form for an unknown/free state", () => {
    const html = renderToStaticMarkup(<ActivateLicenseDialog client={client} onClose={() => {}} />);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toMatch(/aria-labelledby="([^"]+)"[\s\S]*id="\1"/);
    expect(html).toContain("Activate Pro");
    expect(html).toContain("Licence key");
    expect(html).toContain('type="submit"');
    expect(html).toContain("Restore purchase");
    expect(html).toContain('aria-label="Close"');
    expect(html).toContain("bf-input--mono");
    // Activate is disabled until something key-shaped is pasted.
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""/);
    expect(html).not.toContain("Deactivate this browser");
  });

  it("summarises licence states for banners", () => {
    const pro: LicenseState = {
      kind: "pro",
      key: "XXXX-…-1234",
      instanceId: "i",
      instanceName: "arbor@chrome-abc123",
      lastValidatedAt: 0,
    };
    expect(summarizeLicenseState(null)).toBeNull();
    expect(summarizeLicenseState({ kind: "free" })).toBeNull();
    expect(summarizeLicenseState(pro)?.tone).toBe("success");
    expect(summarizeLicenseState({ ...pro, kind: "grace", graceEndsAt: 0 })?.tone).toBe("warning");
    expect(summarizeLicenseState({ kind: "invalid", reason: "expired" })).toMatchObject({
      tone: "danger",
      text: expect.stringMatching(/expired/i),
    });
    expect(summarizeLicenseState({ kind: "free", reason: "grace_expired" })?.tone).toBe("warning");
    expect(summarizeLicenseState({ kind: "free", reason: "deactivated" })?.tone).toBe("info");
  });

  it("knows when Restore purchase can re-validate a stored key", () => {
    expect(hasRestorableKey(null)).toBe(false);
    expect(hasRestorableKey({ kind: "free" })).toBe(false);
    expect(hasRestorableKey({ kind: "free", reason: "grace_expired" })).toBe(true);
    expect(hasRestorableKey({ kind: "invalid", reason: "expired" })).toBe(true);
  });
});

describe("useLicense", () => {
  it("starts unresolved and not pro before effects run", () => {
    const client = createLicenseClient({ productName: "arbor", storage: memoryStorage() });
    function Probe() {
      const { state, isPro } = useLicense(client);
      return <span data-pro={String(isPro)}>{state ? state.kind : "loading"}</span>;
    }
    expect(renderToStaticMarkup(<Probe />)).toBe('<span data-pro="false">loading</span>');
  });
});
