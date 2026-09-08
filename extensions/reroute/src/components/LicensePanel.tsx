import { useState } from "react";
import {
  ActivateLicenseDialog,
  Button,
  Callout,
  KeyValueList,
  ProBadge,
  formatDate,
  summarizeLicenseState,
  useLicense,
  type KeyValueItem,
} from "@browserforge/ui";
import type { LicenseClient } from "@browserforge/licensing";
import { LICENSING, PRO_PAGE_URL, getLicenseClient, openCheckout } from "../lib/licensing";

/**
 * Licence status, activate/manage dialog and the "Buy Pro" link for the options page Pro tab.
 * When the build has no Lemon Squeezy ids it shows a neutral "opening soon" note to end users
 * (and the developer-facing reason in dev builds).
 */
export function LicensePanel() {
  const client = getLicenseClient();
  return (
    <section className="rr-section">
      <h2>Licence</h2>
      {client ? <LicenseBody client={client} /> : <NotConfigured />}
    </section>
  );
}

function NotConfigured() {
  if (import.meta.env.DEV) {
    return (
      <div className="rr-stack">
        <Callout tone="info" title="Licensing not configured (development build).">
          No Lemon Squeezy store or variant id was set at build time, so licence keys cannot be
          activated here. See <code>.env.example</code>.
        </Callout>
      </div>
    );
  }
  return (
    <div className="rr-stack">
      <Callout tone="info" title="Pro purchases are opening soon.">
        Everything you see is free to use. Licence keys will be activated here once{" "}
        {LICENSING.productLabel} goes on sale.
      </Callout>
      <p className="rr-help">
        Follow along at{" "}
        <a href={PRO_PAGE_URL} target="_blank" rel="noreferrer">
          reroute.shantanuojha.com
        </a>
        .
      </p>
    </div>
  );
}

function LicenseBody({ client }: { client: LicenseClient }) {
  const { state, isPro } = useLicense(client);
  const [open, setOpen] = useState(false);
  const summary = summarizeLicenseState(state);

  const details: KeyValueItem[] =
    state && (state.kind === "pro" || state.kind === "grace")
      ? [
          { key: "Licence key", value: state.key, mono: true },
          { key: "Status", value: state.kind === "pro" ? "Active" : "Active (offline grace)" },
          { key: "Last checked", value: formatDate(state.lastValidatedAt) },
        ]
      : state?.kind === "invalid" && state.key
        ? [
            { key: "Licence key", value: state.key, mono: true },
            { key: "Status", value: "Not valid" },
          ]
        : [];

  return (
    <div className="rr-stack">
      {state === null ? <p className="rr-muted">Checking licence...</p> : null}
      {summary ? (
        <Callout tone={summary.tone} title={summary.title}>
          {summary.text}
        </Callout>
      ) : null}
      {details.length ? <KeyValueList items={details} /> : null}
      {!isPro && state !== null ? (
        <p className="rr-help">
          {LICENSING.productLabel} is a $9 one-time purchase. Already bought it? Enter the key from
          your order email.
        </p>
      ) : null}
      <div className="rr-row">
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
          {isPro ? "Manage licence" : "Enter licence key"}
        </Button>
        {!isPro ? (
          <Button size="sm" onClick={openCheckout}>
            Buy Pro
          </Button>
        ) : (
          <ProBadge />
        )}
      </div>
      {open ? (
        <ActivateLicenseDialog
          client={client}
          title={isPro ? LICENSING.productLabel : `Activate ${LICENSING.productLabel}`}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}
