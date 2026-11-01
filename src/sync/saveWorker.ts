/// <reference lib="webworker" />
// Parses a save off the main thread (a big save takes a few seconds).
import { readSave } from '../engine/saveReader';

self.onmessage = (e: MessageEvent<{ id: number; bytes: ArrayBuffer; name: string }>) => {
  const { id, bytes, name } = e.data;
  try {
    const summary = readSave(bytes, name, (progress) => postMessage({ id, progress }));
    postMessage({ id, summary });
  } catch (err) {
    postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
