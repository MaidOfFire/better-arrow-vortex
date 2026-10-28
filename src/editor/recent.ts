// Recently opened songs, kept in IndexedDB together with their folder handles so they can be
// reopened after a reload (Chrome / Edge). Songs opened as loose files have no folder handle and
// are not remembered.

export interface RecentSong {
  id: string;
  title: string;
  artist: string;
  /** Folder name as the browser reports it (the full path is not available to web pages). */
  folder: string;
  openedAt: number;
  dir: FileSystemDirectoryHandle;
}

const DB = 'better-arrow-vortex';
const STORE = 'recent';
const LIMIT = 10;

function openDb(): Promise<IDBDatabase | null> {
  if (!('indexedDB' in globalThis)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise((resolve) => {
        if (!db) return resolve(null);
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => {
          db.close();
          resolve(req ? req.result : null);
        };
        tx.onerror = tx.onabort = () => {
          db.close();
          resolve(null);
        };
      }),
  );
}

/** Most recent first. */
export async function listRecent(): Promise<RecentSong[]> {
  const all = (await run<RecentSong[]>('readonly', (s) => s.getAll())) ?? [];
  return all.sort((a, b) => b.openedAt - a.openedAt);
}

/** Adds a song, or moves it to the top when its folder is already listed. */
export async function rememberRecent(song: Omit<RecentSong, 'id' | 'openedAt'>): Promise<void> {
  const list = await listRecent();
  let id: string = crypto.randomUUID();
  for (const r of list) {
    try {
      if (await r.dir.isSameEntry(song.dir)) id = r.id;
    } catch {
      // a handle that can no longer be compared: leave it
    }
  }
  const kept = list.filter((r) => r.id !== id).slice(0, LIMIT - 1);
  const dropped = list.filter((r) => r.id !== id && !kept.includes(r));
  await run('readwrite', (s) => {
    s.put({ ...song, id, openedAt: Date.now() });
    for (const r of dropped) s.delete(r.id);
  });
}

export async function forgetRecent(id: string): Promise<void> {
  await run('readwrite', (s) => s.delete(id));
}
