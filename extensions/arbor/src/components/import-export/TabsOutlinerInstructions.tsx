import { TABS_OUTLINER_STORAGE_KEY } from "@/lib/io/tabs-outliner";

/** How to get a Tabs Outliner session out of its extension page. */
export function TabsOutlinerInstructions() {
  return (
    <section className="section">
      <div className="section__header">
        <h2 className="section__title">Recovering a Tabs Outliner tree</h2>
      </div>
      <div className="section__body">
        <p>Tabs Outliner keeps its last session in the extension page storage. To get it out:</p>
        <ol>
          <li>
            Open <code>chrome://extensions</code>, enable Developer mode and note Tabs
            Outliner&apos;s ID.
          </li>
          <li>
            Open <code>chrome-extension://&lt;ID&gt;/activesessionview.html</code> in a tab (or any
            page of the extension) and press F12 to open DevTools.
          </li>
          <li>
            In the Console run{" "}
            <code>copy(localStorage.getItem(&quot;{TABS_OUTLINER_STORAGE_KEY}&quot;))</code>.
          </li>
          <li>
            Paste into the box above and press Analyse. Exported .tree files work the same way.
          </li>
        </ol>
        <p>
          The importer is deliberately permissive: it looks for anything shaped like a window, tab
          or note and shows you the result before importing.
        </p>
      </div>
    </section>
  );
}
