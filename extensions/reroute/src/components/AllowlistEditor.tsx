import { normalizeHost } from "@browserforge/shared";
import { Button } from "@browserforge/ui";
import { useState } from "react";

export interface AllowlistEditorProps {
  allowlist: string[];
  onChange: (next: string[]) => void;
}

export function normalizeAllowlistEntry(input: string): string | null {
  const host = normalizeHost(input).replace(/\/.*$/, "");
  if (!host) return null;
  if (!/^\*?\.?[a-z0-9.-]+$/i.test(host)) return null;
  return host;
}

export function AllowlistEditor({ allowlist, onChange }: AllowlistEditorProps) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const add = () => {
    const host = normalizeAllowlistEntry(value);
    if (!host) {
      setError("Enter a hostname such as example.com or *.example.com");
      return;
    }
    if (allowlist.includes(host)) {
      setError("Already on the allowlist.");
      return;
    }
    onChange([...allowlist, host]);
    setValue("");
    setError(null);
  };

  return (
    <div className="rr-stack">
      <p className="rr-help">
        Reroute does nothing on these sites: no redirect rules, no tracking-parameter cleanup. Use{" "}
        <span className="rr-mono">*.example.com</span> for subdomains only or{" "}
        <span className="rr-mono">*example.com</span> for the apex and all subdomains. The popup
        toggles the current site here.
      </p>
      <form
        className="rr-row"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input
          className="rr-input rr-input--mono"
          style={{ flex: 1 }}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="example.com"
          aria-label="Hostname to allow"
          spellCheck={false}
        />
        <Button type="submit">Add</Button>
      </form>
      {error ? (
        <div className="rr-notice rr-notice--error" role="alert">
          {error}
        </div>
      ) : null}
      {allowlist.length === 0 ? (
        <p className="rr-muted">No sites allowlisted.</p>
      ) : (
        <table className="rr-table">
          <tbody>
            {allowlist.map((host) => (
              <tr key={host}>
                <td className="rr-mono">{host}</td>
                <td style={{ textAlign: "right" }}>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onChange(allowlist.filter((h) => h !== host))}
                  >
                    Remove
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
