/** Minimal async key-value interface so storage is injectable in tests. */

export interface KV {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export class MemoryKV implements KV {
  private map = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
}
