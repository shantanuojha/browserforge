import { Button } from "@browserforge/ui";
import { useEffect, useState } from "react";
import type { DnrRule } from "../lib/dnr";
import { cleanUrl } from "../lib/tracking/clean";
import { loadTrackingMeta, loadTrackingRules, type TrackingMeta } from "../lib/tracking/load";
import { Toggle } from "./Toggle";

export interface TrackingPanelProps {
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
}

export function TrackingPanel({ enabled, onToggle }: TrackingPanelProps) {
  const [meta, setMeta] = useState<TrackingMeta | null>(null);
  const [rules, setRules] = useState<DnrRule[]>([]);
  const [test, setTest] = useState("");
  const [showProviders, setShowProviders] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadTrackingMeta().then((m) => {
      if (!cancelled) setMeta(m);
    });
    void loadTrackingRules().then((r) => {
      if (!cancelled) setRules(r);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const result = test ? cleanUrl(test, rules) : null;

  return (
    <div className="rr-stack">
      <Toggle
        checked={enabled}
        onChange={onToggle}
        label={<strong>Strip tracking parameters from page and frame navigations</strong>}
      />
      <p className="rr-help">
        A static declarativeNetRequest ruleset removes parameters such as utm_*, fbclid and gclid
        before the request leaves the browser. It is compiled at build time from the ClearURLs
        catalog (LGPL-3.0) and is never fetched at runtime. Allowlisted sites are exempt.
      </p>

      {meta ? (
        <table className="rr-table" style={{ maxWidth: 520 }}>
          <tbody>
            <tr>
              <th>Providers</th>
              <td>
                {meta.providersUsed} of {meta.providersTotal} in the catalog{" "}
                <Button size="sm" variant="ghost" onClick={() => setShowProviders((s) => !s)}>
                  {showProviders ? "Hide list" : "Show list"}
                </Button>
              </td>
            </tr>
            <tr>
              <th>Rules</th>
              <td>
                {meta.rulesGenerated} ({meta.removeParamRules} parameter removers,{" "}
                {meta.exceptionRules} exceptions)
              </td>
            </tr>
            <tr>
              <th>Generated</th>
              <td>
                {new Date(meta.generatedAt).toLocaleDateString()}
                {meta.usedFallback ? " (bundled fallback set)" : ""}
              </td>
            </tr>
          </tbody>
        </table>
      ) : (
        <p className="rr-muted">Ruleset metadata unavailable.</p>
      )}

      {showProviders && meta ? (
        <div className="rr-small rr-muted" style={{ columns: 3 }}>
          {meta.providers.map((p) => (
            <div key={p}>{p}</div>
          ))}
        </div>
      ) : null}

      <div className="rr-field">
        <label htmlFor="tracking-test">Try it</label>
        <input
          id="tracking-test"
          className="rr-input rr-input--mono"
          value={test}
          onChange={(e) => setTest(e.target.value)}
          placeholder="https://example.com/?utm_source=newsletter&id=1"
          spellCheck={false}
        />
        {result ? (
          <div className={`rr-result ${result.changed ? "rr-result--hit" : ""}`}>
            {result.changed ? (
              <>
                <div className="rr-mono">{result.url}</div>
                <div className="rr-small rr-muted">Removed: {result.removed.join(", ")}</div>
              </>
            ) : (
              <div>Nothing to remove.</div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
