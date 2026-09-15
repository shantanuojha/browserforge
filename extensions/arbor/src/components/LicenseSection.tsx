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
import type { LicenseClient, LicenseState } from "@browserforge/licensing";
import { LICENSING, PRO_PAGE_URL, getLicenseClient, openCheckout } from "@/adapters/licensing";

/** The detail rows shown for a licence state: key and status while there is a key to show. */
function licenseDetails(state: LicenseState | null): KeyValueItem[] {
  if (!state) return [];
  if (state.kind === "pro" || state.kind === "grace") {
    return [
      { key: "Licence key", value: state.key, mono: true },
      { key: "Status", value: state.kind === "pro" ? "Active" : "Active (offline grace)" },
      { key: "Last checked", value: formatDate(state.lastValidatedAt) },
    ];
  }
  if (state.kind === "invalid" && state.key) {
    return [
      { key: "Licence key", value: state.key, mono: true },
      { key: "Status", value: "Not valid" },
    ];
  }
  return [];
}

/**
 * Options-page "Pro" section: licence status, activate/manage dialog and the "Buy Pro" link.
 * When the build has no licence-provider ids it shows a neutral "opening soon" note to end users
 * (and the developer-facing reason in dev builds).
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
  if (import.meta.env.DEV) {
    return (
      <Callout tone="info" title="Licensing not configured (development build).">
        No licence-provider ids were set at build time (provider: {LICENSING.provider}), so licence
        keys cannot be activated here. See <code>.env.example</code>.
      </Callout>
    );
  }
  return (
    <>
      <Callout tone="info" title="Pro purchases are opening soon.">
        Everything you see is free to use. Licence keys will be activated here once{" "}
        {LICENSING.productLabel} goes on sale.
      </Callout>
      <p>
        Follow along at{" "}
        <a href={PRO_PAGE_URL} target="_blank" rel="noreferrer">
          arbor.shantanuojha.com
        </a>
        .
      </p>
    </>
  );
}

/** "Manage licence" for Pro users, "Enter licence key" + "Buy Pro" for everyone else. */
function LicenseButtons({ isPro, onOpen }: { isPro: boolean; onOpen(): void }) {
  return (
    <div className="button-row">
      <Button size="sm" variant="secondary" onClick={onOpen}>
        {isPro ? "Manage licence" : "Enter licence key"}
      </Button>
      {isPro ? (
        <ProBadge />
      ) : (
        <Button size="sm" onClick={openCheckout}>
          Buy Pro
        </Button>
      )}
    </div>
  );
}

function LicenseBody({ client }: { client: LicenseClient }) {
  const { state, isPro } = useLicense(client);
  const [open, setOpen] = useState(false);
  const summary = summarizeLicenseState(state);
  const details = licenseDetails(state);

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
      <LicenseButtons isPro={isPro} onOpen={() => setOpen(true)} />
      {open ? (
        <ActivateLicenseDialog
          client={client}
          title={isPro ? LICENSING.productLabel : `Activate ${LICENSING.productLabel}`}
          restoreUrl={LICENSING.restoreUrl}
          restoreHint={LICENSING.restoreHint}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
