import { useCallback, useEffect, useState } from "react";
import type { WxtStorageItem } from "wxt/utils/storage";

/**
 * Subscribes a component to a WXT storage item. Returns the current value (the
 * item's fallback until loaded), a setter that writes through, and a loaded flag.
 */
export function useStorageItem<T>(
  item: WxtStorageItem<T, Record<string, unknown>>,
): [T, (next: T) => Promise<void>, boolean] {
  const [value, setValue] = useState<T>(item.fallback);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void item.getValue().then((v) => {
      if (!cancelled) {
        setValue(v);
        setLoaded(true);
      }
    });
    const unwatch = item.watch((next) => {
      if (!cancelled) setValue(next ?? item.fallback);
    });
    return () => {
      cancelled = true;
      unwatch();
    };
  }, [item]);

  const write = useCallback(
    async (next: T) => {
      setValue(next);
      await item.setValue(next);
    },
    [item],
  );

  return [value, write, loaded];
}
