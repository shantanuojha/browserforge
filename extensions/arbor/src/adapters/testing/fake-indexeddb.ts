/**
 * A deliberately tiny in-memory IndexedDB stand-in for unit tests. It implements only what
 * `IndexedDbLogBackend` uses: open/upgrade, object stores with a `keyPath`, and put/get/getAll/
 * getAllKeys/delete/clear with optional key ranges. Requests complete asynchronously and a
 * transaction "commits" once no requests are pending. Not for production use.
 */

type Key = number | string;

function compareKeys(a: Key, b: Key): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

export class FakeKeyRange {
  constructor(
    readonly lower: Key | undefined,
    readonly upper: Key | undefined,
    readonly lowerOpen: boolean,
    readonly upperOpen: boolean,
  ) {}

  static lowerBound(lower: Key, open = false): FakeKeyRange {
    return new FakeKeyRange(lower, undefined, open, false);
  }

  static upperBound(upper: Key, open = false): FakeKeyRange {
    return new FakeKeyRange(undefined, upper, false, open);
  }

  static bound(lower: Key, upper: Key, lowerOpen = false, upperOpen = false): FakeKeyRange {
    return new FakeKeyRange(lower, upper, lowerOpen, upperOpen);
  }

  static only(value: Key): FakeKeyRange {
    return new FakeKeyRange(value, value, false, false);
  }

  includes(key: Key): boolean {
    if (this.lower !== undefined) {
      const c = compareKeys(key, this.lower);
      if (c < 0 || (c === 0 && this.lowerOpen)) return false;
    }
    if (this.upper !== undefined) {
      const c = compareKeys(key, this.upper);
      if (c > 0 || (c === 0 && this.upperOpen)) return false;
    }
    return true;
  }
}

class FakeRequest<T> {
  result!: T;
  error: DOMException | null = null;
  onsuccess: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  constructor(private readonly tx: FakeTransaction | null) {}

  resolveLater(compute: () => T): void {
    this.tx?.begin();
    queueMicrotask(() => {
      try {
        this.result = compute();
        this.onsuccess?.(new Event("success"));
      } catch (e) {
        this.error = e instanceof DOMException ? e : new DOMException(String(e), "UnknownError");
        this.onerror?.(new Event("error"));
      } finally {
        this.tx?.end();
      }
    });
  }
}

class FakeStoreData {
  readonly records = new Map<Key, unknown>();
  constructor(readonly keyPath: string) {}

  sortedKeys(range?: FakeKeyRange): Key[] {
    return [...this.records.keys()]
      .filter((k) => (range ? range.includes(k) : true))
      .sort(compareKeys);
  }
}

class FakeObjectStore {
  constructor(
    private readonly data: FakeStoreData,
    private readonly tx: FakeTransaction,
  ) {}

  private assertWritable(): void {
    if (this.tx.mode === "readonly") {
      throw new DOMException("read-only transaction", "ReadOnlyError");
    }
  }

  private keyOf(value: unknown): Key {
    const k = (value as Record<string, unknown>)[this.data.keyPath];
    if (typeof k !== "number" && typeof k !== "string") {
      throw new DOMException("invalid key", "DataError");
    }
    return k;
  }

  put(value: unknown): FakeRequest<Key> {
    const req = new FakeRequest<Key>(this.tx);
    req.resolveLater(() => {
      this.assertWritable();
      const key = this.keyOf(value);
      this.data.records.set(key, structuredClone(value));
      return key;
    });
    return req;
  }

  get(key: Key): FakeRequest<unknown> {
    const req = new FakeRequest<unknown>(this.tx);
    req.resolveLater(() => {
      const v = this.data.records.get(key);
      return v === undefined ? undefined : structuredClone(v);
    });
    return req;
  }

  getAll(range?: FakeKeyRange): FakeRequest<unknown[]> {
    const req = new FakeRequest<unknown[]>(this.tx);
    req.resolveLater(() =>
      this.data.sortedKeys(range).map((k) => structuredClone(this.data.records.get(k))),
    );
    return req;
  }

  getAllKeys(range?: FakeKeyRange): FakeRequest<Key[]> {
    const req = new FakeRequest<Key[]>(this.tx);
    req.resolveLater(() => this.data.sortedKeys(range));
    return req;
  }

  delete(keyOrRange: Key | FakeKeyRange): FakeRequest<undefined> {
    const req = new FakeRequest<undefined>(this.tx);
    req.resolveLater(() => {
      this.assertWritable();
      if (keyOrRange instanceof FakeKeyRange) {
        for (const k of this.data.sortedKeys(keyOrRange)) this.data.records.delete(k);
      } else {
        this.data.records.delete(keyOrRange);
      }
      return undefined;
    });
    return req;
  }

  clear(): FakeRequest<undefined> {
    const req = new FakeRequest<undefined>(this.tx);
    req.resolveLater(() => {
      this.assertWritable();
      this.data.records.clear();
      return undefined;
    });
    return req;
  }
}

class FakeTransaction {
  error: DOMException | null = null;
  oncomplete: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onabort: ((ev: Event) => void) | null = null;
  private pending = 0;
  private finished = false;
  private started = false;

  constructor(
    private readonly db: FakeDatabase,
    private readonly names: string[],
    readonly mode: IDBTransactionMode,
  ) {
    // A transaction with no requests still completes.
    setTimeout(() => this.maybeComplete(), 0);
  }

  objectStore(name: string): FakeObjectStore {
    if (!this.names.includes(name)) throw new DOMException(`store ${name}`, "NotFoundError");
    if (this.finished) throw new DOMException("transaction finished", "TransactionInactiveError");
    const data = this.db.stores.get(name);
    if (!data) throw new DOMException(`store ${name}`, "NotFoundError");
    return new FakeObjectStore(data, this);
  }

  begin(): void {
    if (this.finished) throw new DOMException("transaction finished", "TransactionInactiveError");
    this.started = true;
    this.pending++;
  }

  end(): void {
    this.pending--;
    setTimeout(() => this.maybeComplete(), 0);
  }

  private maybeComplete(): void {
    if (this.finished || this.pending > 0) return;
    if (!this.started) {
      // Give the caller one tick to issue requests before auto-committing.
      this.started = true;
      setTimeout(() => this.maybeComplete(), 0);
      return;
    }
    this.finished = true;
    this.oncomplete?.(new Event("complete"));
  }
}

class FakeDOMStringList {
  constructor(private readonly items: () => string[]) {}
  contains(name: string): boolean {
    return this.items().includes(name);
  }
  get length(): number {
    return this.items().length;
  }
  item(i: number): string | null {
    return this.items()[i] ?? null;
  }
}

class FakeDatabase {
  readonly objectStoreNames = new FakeDOMStringList(() => [...this.stores.keys()]);

  constructor(
    readonly name: string,
    public version: number,
    readonly stores: Map<string, FakeStoreData>,
  ) {}

  createObjectStore(name: string, options: { keyPath: string }): void {
    if (this.stores.has(name)) throw new DOMException(`store ${name}`, "ConstraintError");
    this.stores.set(name, new FakeStoreData(options.keyPath));
  }

  transaction(names: string | string[], mode: IDBTransactionMode = "readonly"): FakeTransaction {
    return new FakeTransaction(this, Array.isArray(names) ? names : [names], mode);
  }

  close(): void {
    // no-op
  }
}

class FakeOpenRequest {
  result!: FakeDatabase;
  error: DOMException | null = null;
  onsuccess: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onblocked: ((ev: Event) => void) | null = null;
  onupgradeneeded: ((ev: Event) => void) | null = null;
}

export class FakeIDBFactory {
  private readonly databases = new Map<
    string,
    { version: number; stores: Map<string, FakeStoreData> }
  >();

  open(name: string, version = 1): FakeOpenRequest {
    const req = new FakeOpenRequest();
    setTimeout(() => {
      let entry = this.databases.get(name);
      const isNew = !entry;
      if (!entry) {
        entry = { version: 0, stores: new Map() };
        this.databases.set(name, entry);
      }
      const db = new FakeDatabase(name, version, entry.stores);
      req.result = db;
      if (isNew || entry.version < version) {
        entry.version = version;
        req.onupgradeneeded?.(new Event("upgradeneeded"));
      }
      req.onsuccess?.(new Event("success"));
    }, 0);
    return req;
  }

  deleteDatabase(name: string): FakeOpenRequest {
    const req = new FakeOpenRequest();
    setTimeout(() => {
      this.databases.delete(name);
      req.onsuccess?.(new Event("success"));
    }, 0);
    return req;
  }

  /** Direct access for assertions: raw records of a store. */
  peek(dbName: string, store: string): unknown[] {
    const data = this.databases.get(dbName)?.stores.get(store);
    return data ? data.sortedKeys().map((k) => data.records.get(k)) : [];
  }

  /** Corrupt a record in place (tests). */
  poke(dbName: string, store: string, key: Key, value: unknown): void {
    this.databases.get(dbName)?.stores.get(store)?.records.set(key, value);
  }
}

/** Install the fake as `globalThis.indexedDB` / `IDBKeyRange`. Returns a restore function. */
export function installFakeIndexedDb(): { factory: FakeIDBFactory; restore: () => void } {
  const g = globalThis as Record<string, unknown>;
  const prevFactory = g.indexedDB;
  const prevRange = g.IDBKeyRange;
  const factory = new FakeIDBFactory();
  g.indexedDB = factory;
  g.IDBKeyRange = FakeKeyRange;
  return {
    factory,
    restore: () => {
      g.indexedDB = prevFactory;
      g.IDBKeyRange = prevRange;
    },
  };
}

export function asIdbFactory(factory: FakeIDBFactory): IDBFactory {
  return factory as unknown as IDBFactory;
}
