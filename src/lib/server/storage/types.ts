/**
 * Where projects, clips, job records and counters live. Keys are
 * slash-separated paths like `projects/<id>/project.json`.
 */
export interface StorageDriver {
  readonly name: "local" | "blob";
  readJson<T>(key: string): Promise<T | null>;
  writeJson(key: string, value: unknown): Promise<void>;
  /** Store bytes, or a local file (which may be moved into place). */
  put(key: string, data: Buffer | { path: string }, contentType: string): Promise<void>;
  /** A local filesystem path with the object's bytes (remote drivers download to a cache). */
  localPath(key: string): Promise<string>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  /** Keys under a prefix. */
  list(prefix: string): Promise<string[]>;
  /** Answer a browser GET for the object, honouring Range. */
  serve(key: string, req: Request, headers: Headers): Promise<Response>;
}
