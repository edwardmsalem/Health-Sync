import AsyncStorage from "@react-native-async-storage/async-storage";
import type { KV } from "./kv.ts";

export class AsyncStorageKV implements KV {
  get(key: string): Promise<string | null> {
    return AsyncStorage.getItem(key);
  }

  set(key: string, value: string): Promise<void> {
    return AsyncStorage.setItem(key, value);
  }
}
