// Opening and saving files: File System Access API (Chrome/Edge) when available, with an
// <input type=file> / download fallback for other browsers.

declare global {
  interface Window {
    showDirectoryPicker?: (opts?: { mode?: 'read' | 'readwrite'; id?: string }) => Promise<FileSystemDirectoryHandle>;
    showOpenFilePicker?: (opts?: unknown) => Promise<FileSystemFileHandle[]>;
    showSaveFilePicker?: (opts?: {
      suggestedName?: string;
      types?: { description: string; accept: Record<string, string[]> }[];
    }) => Promise<FileSystemFileHandle>;
  }
  interface FileSystemHandle {
    queryPermission?: (opts: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
    requestPermission?: (opts: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
  }
  interface DataTransferItem {
    getAsFileSystemHandle?: () => Promise<FileSystemHandle | null>;
  }
}

export const AUDIO_EXTS = ['.ogg', '.mp3', '.wav', '.flac', '.oga', '.opus', '.m4a', '.aac'];
export const SIMFILE_EXTS = ['.sm', '.ssc'];
export const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'];

export function ext(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}

export function baseName(name: string): string {
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  return name.slice(slash + 1);
}

/** Where the open simfile came from, used to find its music and to save it back. */
export class FileSource {
  dir: FileSystemDirectoryHandle | null = null;
  file: FileSystemFileHandle | null = null;
  readonly files = new Map<string, File>();

  static fromFiles(files: Iterable<File>): FileSource {
    const s = new FileSource();
    for (const f of files) s.files.set(f.name.toLowerCase(), f);
    return s;
  }

  async listNames(): Promise<string[]> {
    const names = [...this.files.values()].map((f) => f.name);
    if (this.dir) {
      for await (const [name, handle] of this.dir.entries()) {
        if (handle.kind === 'file' && !names.includes(name)) names.push(name);
      }
    }
    return names;
  }

  /** Finds a file by a path relative to the simfile (case-insensitive, sub-folders allowed). */
  async get(path: string): Promise<File | null> {
    if (!path) return null;
    const parts = path.replace(/\\/g, '/').split('/').filter((p) => p && p !== '.');
    const name = parts[parts.length - 1]?.toLowerCase();
    if (!name) return null;
    const loose = this.files.get(name);
    if (loose) return loose;
    if (!this.dir) return null;
    let dir: FileSystemDirectoryHandle = this.dir;
    for (let i = 0; i < parts.length; ++i) {
      const want = parts[i].toLowerCase();
      let found: FileSystemHandle | null = null;
      for await (const [n, h] of dir.entries()) {
        if (n.toLowerCase() === want) {
          found = h;
          break;
        }
      }
      if (!found) return null;
      if (i === parts.length - 1) return found.kind === 'file' ? (found as FileSystemFileHandle).getFile() : null;
      if (found.kind !== 'directory') return null;
      dir = found as FileSystemDirectoryHandle;
    }
    return null;
  }

  async findFirst(exts: string[]): Promise<string | null> {
    const names = await this.listNames();
    for (const e of exts) {
      const n = names.find((x) => ext(x) === e);
      if (n) return n;
    }
    return null;
  }
}

export interface OpenResult {
  source: FileSource;
  /** Name of the simfile to load, or null when only music was opened. */
  simfileName: string | null;
  simfileText: string | null;
  musicName: string | null;
}

/** Picks the simfile (or music file) to open from a source. */
export async function resolveSource(source: FileSource): Promise<OpenResult | null> {
  const simName = await source.findFirst(SIMFILE_EXTS);
  if (simName) {
    const file = await source.get(simName);
    if (!file) return null;
    if (source.dir && !source.file) {
      try {
        source.file = await source.dir.getFileHandle(simName);
      } catch {
        source.file = null;
      }
    }
    return { source, simfileName: simName, simfileText: await file.text(), musicName: null };
  }
  const music = await source.findFirst(AUDIO_EXTS);
  if (music) return { source, simfileName: null, simfileText: null, musicName: music };
  return null;
}

export async function pickDirectory(): Promise<FileSource | null> {
  if (!window.showDirectoryPicker) return null;
  try {
    const dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'simfile' });
    const s = new FileSource();
    s.dir = dir;
    return s;
  } catch {
    return null; // cancelled
  }
}

export function pickFiles(accept: string, multiple = true): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      resolve(input.files ? [...input.files] : []);
      input.remove();
    });
    input.addEventListener('cancel', () => {
      resolve([]);
      input.remove();
    });
    input.click();
  });
}

/** Builds a source from a drag-and-drop event (folders keep write access in Chrome). */
export async function sourceFromDrop(dt: DataTransfer): Promise<FileSource> {
  // DataTransfer contents are only readable synchronously inside the drop event.
  const files = [...dt.files];
  const items = [...dt.items].filter((i) => i.kind === 'file');
  const handles = await Promise.all(items.map((i) => (i.getAsFileSystemHandle ? i.getAsFileSystemHandle() : null)));
  const dirHandle = handles.find((h) => h && h.kind === 'directory') as FileSystemDirectoryHandle | undefined;
  if (dirHandle) {
    const s = new FileSource();
    s.dir = dirHandle;
    return s;
  }
  const s = FileSource.fromFiles(files);
  const simHandle = handles.find((h) => h && h.kind === 'file' && SIMFILE_EXTS.includes(ext(h.name)));
  if (simHandle) s.file = simHandle as FileSystemFileHandle;
  return s;
}

export async function ensureWritable(handle: FileSystemHandle): Promise<boolean> {
  if (!handle.queryPermission || !handle.requestPermission) return true;
  if ((await handle.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
  return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
}

export async function writeHandle(handle: FileSystemFileHandle, text: string): Promise<void> {
  const w = await handle.createWritable();
  await w.write(text);
  await w.close();
}

export function downloadText(name: string, text: string): void {
  const blob = new Blob([text], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export async function pickSaveHandle(suggestedName: string): Promise<FileSystemFileHandle | null> {
  if (!window.showSaveFilePicker) return null;
  try {
    return await window.showSaveFilePicker({
      suggestedName,
      types: [
        { description: 'StepMania simfile (.sm)', accept: { 'text/plain': ['.sm'] } },
        { description: 'StepMania 5 simfile (.ssc)', accept: { 'text/plain': ['.ssc'] } },
      ],
    });
  } catch {
    return null;
  }
}
