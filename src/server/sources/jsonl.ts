// Incremental JSONL folding, shared by the harness adapters: keeps a byte
// offset per file and parses only appended bytes (a partial trailing line is
// kept for the next scan; a replaced, shrunk or rewritten file is rescanned).
// Each adapter supplies a fold: what to keep from a line, never the content.
// `.zst` files (Codex compresses old rollouts) are read whole and decompressed
// when this Node has zstd (22.15+), else skipped with a warning.
import { open, readFile, stat } from "node:fs/promises";
import * as zlib from "node:zlib";
import { onceLogger, type Logger, type Warn } from "./log.ts";

export interface JsonlFold<Acc, Info> {
  empty(): Acc;
  /** Sees every complete line before parsing (e.g. a cheap timestamp grab). Optional. */
  raw?(acc: Acc, line: string): void;
  /** Cheap prefilter: lines failing it are never parsed. */
  interesting(line: string): boolean;
  /** Folds one parsed line (a JSON object) into the accumulator. */
  apply(acc: Acc, o: Record<string, unknown>): void;
  snapshot(acc: Acc): Info;
}

interface FileState<Acc> {
  ino: number;
  dev: number;
  mtimeMs: number;
  offset: number;
  bytesRead: number;
  partial: Buffer;
  acc: Acc;
}

const CHUNK = 1 << 20;
const NL = 0x0a;

type ZstdAsync = (buf: Buffer, opts: { maxOutputLength: number }, cb: (err: Error | null, out: Buffer) => void) => void;
const zstdDecompress: ZstdAsync | undefined = (zlib as unknown as { zstdDecompress?: ZstdAsync }).zstdDecompress;
/** A decompressed rollout larger than this is skipped (Codex rollouts are a few MB). */
export const MAX_DECOMPRESSED = 256 * 1024 * 1024;

function unzstd(data: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    zstdDecompress!(data, { maxOutputLength: MAX_DECOMPRESSED }, (err, out) => (err ? reject(err) : resolve(out))),
  );
}

export class JsonlScanner<Acc, Info> {
  private files = new Map<string, FileState<Acc>>();
  private inflight = new Map<string, Promise<Info | undefined>>();
  protected warn: Warn;
  private noun: string;

  private fold: JsonlFold<Acc, Info>;

  constructor(fold: JsonlFold<Acc, Info>, opts: { log?: Logger; warn?: Warn; noun?: string } = {}) {
    this.fold = fold;
    this.warn = opts.warn ?? onceLogger(opts.log ?? console.warn);
    this.noun = opts.noun ?? "file";
  }

  /** Scans new bytes of `path` and returns the folded info, or undefined if the file is gone. */
  scan(path: string): Promise<Info | undefined> {
    const running = this.inflight.get(path);
    if (running) return running;
    const p = this.doScan(path).finally(() => this.inflight.delete(path));
    this.inflight.set(path, p);
    return p;
  }

  /** Read bookkeeping, for tests. */
  stats(path: string): { offset: number; bytesRead: number } | undefined {
    const s = this.files.get(path);
    return s && { offset: s.offset, bytesRead: s.bytesRead };
  }

  forget(path: string): void {
    this.files.delete(path);
  }

  private async doScan(path: string): Promise<Info | undefined> {
    let st;
    try {
      st = await stat(path);
    } catch {
      this.files.delete(path);
      return undefined;
    }
    let s = this.files.get(path);
    const replaced = !s || s.ino !== st.ino || s.dev !== st.dev;
    const shrunk = !!s && st.size < s.offset;
    // Same size but touched: rewritten in place (appends always grow the file).
    const rewritten = !!s && st.size === s.offset && st.mtimeMs !== s.mtimeMs;
    if (!s || replaced || shrunk || rewritten) {
      s = { ino: st.ino, dev: st.dev, mtimeMs: st.mtimeMs, offset: 0, bytesRead: s?.bytesRead ?? 0, partial: Buffer.alloc(0), acc: this.fold.empty() };
      this.files.set(path, s);
    }
    if (st.size > s.offset) {
      try {
        if (path.endsWith(".zst")) await this.readCompressed(path, s, st.size);
        else await this.readFrom(path, s, st.size);
      } catch (e) {
        this.warn(`excaliagent: cannot read ${this.noun} ${path}: ${(e as Error).message}`, path);
      }
    }
    s.mtimeMs = st.mtimeMs;
    return this.fold.snapshot(s.acc);
  }

  private async readFrom(path: string, s: FileState<Acc>, end: number): Promise<void> {
    const fh = await open(path, "r");
    try {
      const buf = Buffer.allocUnsafe(Math.min(CHUNK, end - s.offset));
      while (s.offset < end) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, end - s.offset), s.offset);
        if (bytesRead === 0) break;
        s.offset += bytesRead;
        s.bytesRead += bytesRead;
        this.consume(path, s, buf.subarray(0, bytesRead));
      }
    } finally {
      await fh.close();
    }
  }

  /** A compressed file is immutable: decompress it once, whole. */
  private async readCompressed(path: string, s: FileState<Acc>, size: number): Promise<void> {
    s.offset = size;
    if (!zstdDecompress) {
      this.warn("excaliagent: this Node has no zstd (needs 22.15+); compressed .zst files are skipped", "no-zstd");
      return;
    }
    const data = await readFile(path);
    s.bytesRead += data.length;
    this.consume(path, s, await unzstd(data));
    if (s.partial.length) {
      this.parseLine(path, s.acc, s.partial);
      s.partial = Buffer.alloc(0);
    }
  }

  private consume(path: string, s: FileState<Acc>, chunk: Buffer): void {
    let start = 0;
    let nl = chunk.indexOf(NL, start);
    while (nl !== -1) {
      const piece = chunk.subarray(start, nl);
      const line = s.partial.length ? Buffer.concat([s.partial, piece]) : piece;
      s.partial = Buffer.alloc(0);
      this.parseLine(path, s.acc, line);
      start = nl + 1;
      nl = chunk.indexOf(NL, start);
    }
    if (start < chunk.length) s.partial = Buffer.concat([s.partial, chunk.subarray(start)]);
  }

  private parseLine(path: string, acc: Acc, line: Buffer): void {
    if (line.length === 0) return;
    const text = line.toString("utf8");
    this.fold.raw?.(acc, text);
    if (!this.fold.interesting(text)) return;
    let o: unknown;
    try {
      o = JSON.parse(text);
    } catch {
      this.warn(`excaliagent: skipping malformed line(s) in ${path}`, path);
      return;
    }
    if (o && typeof o === "object" && !Array.isArray(o)) this.fold.apply(acc, o as Record<string, unknown>);
  }
}
