"use client";

/**
 * Tiny IndexedDB store for interview recordings that couldn't be analyzed because
 * the daily Gemini quota was exhausted (AI_DESIGN §1.8 graceful degradation).
 *
 * When /api/interview/feedback returns 429, we stash the recorded blob here so the
 * user can re-submit it after the Pacific-midnight reset without re-recording.
 * This is client-only, opportunistic, and best-effort — every function swallows
 * errors so a flaky/absent IndexedDB never breaks recording.
 *
 * IMPORTANT: this only ever holds audio the user themselves recorded and chose to
 * retry; it is never uploaded anywhere except back to our own analyze route, and
 * it is deleted on a successful retry. It is NOT a transcript store.
 */

const DB_NAME = "talasin-interview";
const STORE = "pending";
const DB_VERSION = 1;

export interface PendingRecording {
  id: string;
  blob: Blob;
  mimeType: string;
  durationSeconds: number;
  promptId: string | null;
  promptText: string;
  createdAt: number;
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

export async function savePending(rec: PendingRecording): Promise<boolean> {
  const db = await openDb();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(rec);
      tx.oncomplete = () => {
        db.close();
        resolve(true);
      };
      tx.onerror = () => {
        db.close();
        resolve(false);
      };
    } catch {
      db.close();
      resolve(false);
    }
  });
}

export async function listPending(): Promise<PendingRecording[]> {
  const db = await openDb();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => {
        db.close();
        resolve((req.result as PendingRecording[]) ?? []);
      };
      req.onerror = () => {
        db.close();
        resolve([]);
      };
    } catch {
      db.close();
      resolve([]);
    }
  });
}

export async function deletePending(id: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
    } catch {
      db.close();
      resolve();
    }
  });
}
