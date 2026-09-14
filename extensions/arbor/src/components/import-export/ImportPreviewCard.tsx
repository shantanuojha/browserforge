import type { ImportPreview } from "@/lib/io/imported";

export function ImportPreviewCard({ preview }: { preview: ImportPreview }) {
  const c = preview.counts;
  return (
    <div className="preview">
      <div className="preview__counts">
        <span className="preview__count">{c.windows} windows or groups</span>
        <span className="preview__count">{c.tabs} tabs</span>
        <span className="preview__count">{c.notes} notes</span>
        <span className="preview__count">{c.total} total</span>
      </div>
      {preview.sample.length ? (
        <ul className="preview__sample">
          {preview.sample.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
          {c.total > preview.sample.length ? (
            <li>and {c.total - preview.sample.length} more</li>
          ) : null}
        </ul>
      ) : null}
      {preview.warnings.length ? (
        <div className="notice notice--warn">
          <ul>
            {preview.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
