import { useId, useState, type FormEvent, type KeyboardEvent } from "react";
import {
  looksLikeLicenseKey,
  type LicenseClient,
  type LicenseInvalidReason,
  type LicenseState,
} from "@browserforge/licensing";
import { Button } from "./Button.js";
import { Callout, type CalloutTone } from "./Callout.js";
import { IconButton } from "./IconButton.js";
import { KeyValueList, type KeyValueItem } from "./KeyValueList.js";
import { ProBadge } from "./ProBadge.js";
import { TextInput } from "./TextInput.js";
import { openExternal } from "./ProGate.js";
import { useLicense } from "./useLicense.js";
import { cx } from "./classNames.js";

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

const INVALID_REASON_TEXT: Record<LicenseInvalidReason, string> = {
  expired: "This licence has expired. Renew it, then choose Restore purchase.",
  disabled: "This licence has been disabled by the store.",
  wrong_product: "This key belongs to a different BrowserForge product.",
  not_found: "This key no longer exists on the store.",
  deactivated: "This browser was deactivated from another device.",
  unknown: "The licence could not be verified.",
};

export interface LicenseSummary {
  tone: CalloutTone;
  title: string;
  text?: string;
}

/** Human-readable summary of a licence state for banners. `null` when nothing needs saying. */
export function summarizeLicenseState(state: LicenseState | null): LicenseSummary | null {
  if (!state) return null;
  switch (state.kind) {
    case "pro":
      return { tone: "success", title: "Pro is active in this browser." };
    case "grace":
      return {
        tone: "warning",
        title: "Could not reach the licence server.",
        text: `Pro stays on until ${formatDate(state.graceEndsAt)}. Reconnect to keep it.`,
      };
    case "invalid":
      return {
        tone: "danger",
        title: "Licence not valid.",
        text: INVALID_REASON_TEXT[state.reason],
      };
    case "free":
      if (state.reason === "grace_expired") {
        return {
          tone: "warning",
          title: "Your licence could not be confirmed for a while.",
          text: "Reconnect to the internet and choose Restore purchase.",
        };
      }
      if (state.reason === "deactivated") {
        return {
          tone: "info",
          title: "This browser was deactivated.",
          text: "The seat is free for another profile or device.",
        };
      }
      return null;
  }
}

export function formatDate(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** True when a key is on disk that "Restore purchase" can re-validate instead of opening the store. */
export function hasRestorableKey(state: LicenseState | null): boolean {
  return state?.kind === "invalid" || (state?.kind === "free" && state.reason === "grace_expired");
}

type Busy = "activate" | "deactivate" | "restore" | null;

interface Notice {
  tone: CalloutTone;
  text: string;
}

export function ActivateLicenseDialog({
  client,
  onClose,
  title = "Activate Pro",
  restoreUrl = DEFAULT_RESTORE_URL,
  className,
}: ActivateLicenseDialogProps) {
  const { state, isPro, refresh } = useLicense(client);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const titleId = useId();

  const summary = notice ? null : summarizeLicenseState(state);

  async function handleActivate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy("activate");
    setNotice(null);
    try {
      const result = await client.activate(key);
      if (result.ok) {
        setKey("");
        setNotice({ tone: "success", text: "Pro activated in this browser." });
      } else {
        setNotice({ tone: "danger", text: result.error.message });
      }
    } finally {
      setBusy(null);
    }
  }

  async function handleDeactivate() {
    if (busy) return;
    setBusy("deactivate");
    setNotice(null);
    try {
      const result = await client.deactivate();
      setNotice(
        result.ok
          ? {
              tone: "info",
              text: "This browser was deactivated. The seat is free for another profile.",
            }
          : { tone: "danger", text: result.error.message },
      );
    } finally {
      setBusy(null);
    }
  }

  async function handleRestore() {
    if (busy) return;
    if (!hasRestorableKey(state)) {
      openExternal(restoreUrl);
      return;
    }
    setBusy("restore");
    setNotice(null);
    try {
      const next = await refresh();
      if (next.kind === "pro") setNotice({ tone: "success", text: "Your purchase was restored." });
      else if (next.kind === "grace") {
        setNotice({
          tone: "warning",
          text: "Could not reach the licence server. Try again later.",
        });
      }
    } finally {
      setBusy(null);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
    }
  }

  const details: KeyValueItem[] =
    state && (state.kind === "pro" || state.kind === "grace")
      ? [
          { key: "Licence key", value: state.key, mono: true },
          ...(state.email ? [{ key: "Email", value: state.email }] : []),
          { key: "Expires", value: state.expiresAt ? formatDate(state.expiresAt) : "Never" },
          { key: "Last checked", value: formatDate(state.lastValidatedAt) },
          { key: "This browser", value: state.instanceName, mono: true },
        ]
      : [];

  return (
    <div className="bf-dialog-backdrop" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cx("bf-dialog", className)}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <header className="bf-dialog__header">
          <h2 className="bf-dialog__title" id={titleId}>
            {title}
            {isPro ? <ProBadge /> : null}
          </h2>
          <IconButton label="Close" onClick={onClose} size="sm">
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
          </IconButton>
        </header>

        <div className="bf-dialog__body">
          {notice ? <Callout tone={notice.tone}>{notice.text}</Callout> : null}
          {summary ? (
            <Callout tone={summary.tone} title={summary.title}>
              {summary.text}
            </Callout>
          ) : null}

          {isPro ? (
            <>
              <KeyValueList items={details} />
              <div className="bf-dialog__actions">
                <Button variant="secondary" onClick={handleDeactivate} disabled={busy !== null}>
                  {busy === "deactivate" ? "Deactivating…" : "Deactivate this browser"}
                </Button>
                <Button variant="ghost" onClick={handleRestore} disabled={busy !== null}>
                  {busy === "restore" ? "Checking…" : "Re-check licence"}
                </Button>
              </div>
            </>
          ) : (
            <form className="bf-dialog__form" onSubmit={handleActivate}>
              <TextInput
                label="Licence key"
                mono
                value={key}
                onChange={(event) => setKey(event.currentTarget.value)}
                placeholder="XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX"
                autoComplete="off"
                spellCheck={false}
                autoFocus
                disabled={busy !== null}
                hint="Paste the key from your purchase email or Lemon Squeezy order page."
              />
              <div className="bf-dialog__actions">
                <Button type="submit" disabled={busy !== null || !looksLikeLicenseKey(key)}>
                  {busy === "activate" ? "Activating…" : "Activate"}
                </Button>
                <Button variant="secondary" onClick={handleRestore} disabled={busy !== null}>
                  {busy === "restore" ? "Checking…" : "Restore purchase"}
                </Button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
