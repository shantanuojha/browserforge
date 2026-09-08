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
import { LICENSING, getLicenseClient, openCheckout } from "@/lib/licensing";

/**
 * Options-page "Pro" section: licence status, activate/manage dialog and the "Buy Pro" link.
 * Renders a "not configured" notice when the build has no Lemon Squeezy ids.
 */
export function LicenseSection() {
  const client = getLicenseClient();
  return (
    <section className="section">
      <div className="section__header">
        <h2 className="section__title">Pro</h2>
      </div>
      <div className="section__body">
        {client ? <LicenseBody client={client} /> : <NotConfigured />}
      </div>
    </section>
  );
}

function NotConfigured() {
  return (
    <>
      <Callout tone="info" title="Licensing not configured.">
        This build was made without a Lemon Squeezy store, so licence keys cannot be activated here.
        Install Arbor from the store to unlock Pro.
      </Callout>
      <p>{LICENSING.productLabel} is a $15 one-time purchase.</p>
      <div className="button-row">
        <Button size="sm" variant="secondary" onClick={openCheckout}>
          Learn about Pro
        </Button>
      </div>
    </>
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
    <>
      {state === null ? <p>Checking licence...</p> : null}
      {summary ? (
        <Callout tone={summary.tone} title={summary.title}>
          {summary.text}
        </Callout>
      ) : null}
      {details.length ? <KeyValueList items={details} /> : null}
      {!isPro && state !== null ? (
        <p>
          {LICENSING.productLabel} is a $15 one-time purchase. Already bought it? Enter the key from
          your order email.
        </p>
      ) : null}
      <div className="button-row">
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
    </>
  );
}
