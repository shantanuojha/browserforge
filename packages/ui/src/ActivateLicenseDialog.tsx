import { useId, useState, type FormEvent } from "react";
import { looksLikeLicenseKey, type LicenseClient } from "@browserforge/licensing";
import { Button } from "./Button.js";
import { Callout } from "./Callout.js";
import { IconButton } from "./IconButton.js";
import { KeyValueList } from "./KeyValueList.js";
import { ProBadge } from "./ProBadge.js";
import { TextInput } from "./TextInput.js";
import { cx } from "./classNames.js";
import { licenseDetailItems, summarizeLicenseState } from "./licenseSummary.js";
import { useLicense } from "./useLicense.js";
import { useLicenseActions, type LicenseActions } from "./useLicenseActions.js";
import { useModalFocus } from "./useModalFocus.js";

/** Lemon Squeezy's customer page where buyers can find their licence keys again. */
export const DEFAULT_RESTORE_URL = "https://app.lemonsqueezy.com/my-orders";

export interface ActivateLicenseDialogProps {
  client: LicenseClient;
  onClose: () => void;
  title?: string;
  /** Opened by "Restore purchase" when no key is stored in this browser. */
  restoreUrl?: string;
  className?: string;
}

function CloseIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
    >
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

function ProActions({ actions }: { actions: LicenseActions }) {
  const disabled = actions.busy !== null;
  return (
    <div className="bf-dialog__actions">
      <Button variant="secondary" onClick={() => void actions.deactivate()} disabled={disabled}>
        {actions.busy === "deactivate" ? "Deactivating…" : "Deactivate this browser"}
      </Button>
      <Button variant="ghost" onClick={() => void actions.restore()} disabled={disabled}>
        {actions.busy === "restore" ? "Checking…" : "Re-check licence"}
      </Button>
    </div>
  );
}

function ActivationForm({ actions }: { actions: LicenseActions }) {
  const [key, setKey] = useState("");
  const disabled = actions.busy !== null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await actions.activate(key)) setKey("");
  }

  return (
    <form className="bf-dialog__form" onSubmit={(event) => void submit(event)}>
      <TextInput
        label="Licence key"
        mono
        value={key}
        onChange={(event) => setKey(event.currentTarget.value)}
        placeholder="XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX"
        autoComplete="off"
        spellCheck={false}
        autoFocus
        disabled={disabled}
        hint="Paste the key from your purchase email or Lemon Squeezy order page."
      />
      <div className="bf-dialog__actions">
        <Button type="submit" disabled={disabled || !looksLikeLicenseKey(key)}>
          {actions.busy === "activate" ? "Activating…" : "Activate"}
        </Button>
        <Button variant="secondary" onClick={() => void actions.restore()} disabled={disabled}>
          {actions.busy === "restore" ? "Checking…" : "Restore purchase"}
        </Button>
      </div>
    </form>
  );
}

export function ActivateLicenseDialog({
  client,
  onClose,
  title = "Activate Pro",
  restoreUrl = DEFAULT_RESTORE_URL,
  className,
}: ActivateLicenseDialogProps) {
  const { state, isPro, refresh } = useLicense(client);
  const actions = useLicenseActions({ client, state, refresh, restoreUrl });
  const { dialogRef, onKeyDown } = useModalFocus(onClose);
  const titleId = useId();
  const summary = actions.notice ? null : summarizeLicenseState(state);

  return (
    <div className="bf-dialog-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cx("bf-dialog", className)}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <header className="bf-dialog__header">
          <h2 className="bf-dialog__title" id={titleId}>
            {title}
            {isPro ? <ProBadge /> : null}
          </h2>
          <IconButton label="Close" onClick={onClose} size="sm">
            <CloseIcon />
          </IconButton>
        </header>

        <div className="bf-dialog__body">
          {actions.notice ? (
            <Callout tone={actions.notice.tone}>{actions.notice.text}</Callout>
          ) : null}
          {summary ? (
            <Callout tone={summary.tone} title={summary.title}>
              {summary.text}
            </Callout>
          ) : null}
          {isPro ? (
            <>
              <KeyValueList items={licenseDetailItems(state)} />
              <ProActions actions={actions} />
            </>
          ) : (
            <ActivationForm actions={actions} />
          )}
        </div>
      </div>
    </div>
  );
}
