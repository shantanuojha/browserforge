import { Button } from "@browserforge/ui";
import type { Toast } from "@/hooks/useToast";
import { UpsellRow } from "../UpsellRow";

export interface PanelFooterProps {
  toast: Toast | null;
  /** Whether the toast's Undo button has anything to undo. */
  canUndo: boolean;
  onUndo(): void;
  pro: boolean | null;
  onOptions(): void;
}

function FooterMessage({ toast, canUndo, onUndo, pro }: Omit<PanelFooterProps, "onOptions">) {
  if (toast) {
    return (
      <span className="toast" role="status">
        <span className="toast__text">{toast.text}</span>
        {toast.undo && canUndo ? (
          <Button size="sm" variant="ghost" onClick={onUndo}>
            Undo
          </Button>
        ) : null}
      </span>
    );
  }
  if (pro === false) return <UpsellRow compact feature="Scheduled backups." />;
  return <span>Arrows move, Enter opens, Delete closes and saves, Ctrl+Z undoes.</span>;
}

export function PanelFooter({ onOptions, ...message }: PanelFooterProps) {
  return (
    <footer className="app__footer">
      <FooterMessage {...message} />
      <Button size="sm" variant="ghost" onClick={onOptions}>
        Options
      </Button>
    </footer>
  );
}
