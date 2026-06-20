import { handleRequest, type DemoRequest, type DemoResponse } from "./collectorStore.js";
import { WasmDb } from "./db.js";

/**
 * The page-side "store host". DuckDB-Wasm runs here (in the top demo page, which
 * always outlives the embedded iframes), not in the service worker — service
 * workers cannot reliably own a long-lived nested Worker. The SW therefore
 * forwards each intercepted collector request to this host over a MessageChannel
 * and relays the reply back to the iframe. This module owns that database and
 * answers those messages.
 */

let dbInstance: WasmDb | null = null;
let dbInit: Promise<WasmDb> | null = null;
let listening = false;

/** Create (once) and return the in-browser database, migrating on first use. */
export function ensureDb(): Promise<WasmDb> {
  if (dbInstance) return Promise.resolve(dbInstance);
  if (!dbInit) {
    dbInit = WasmDb.create().then((db) => {
      dbInstance = db;
      return db;
    });
  }
  return dbInit;
}

/** Whether the database has finished bootstrapping. */
export function isDbReady(): boolean {
  return dbInstance !== null;
}

interface HostMessage {
  type?: string;
  request?: DemoRequest;
}

async function onMessage(event: MessageEvent<HostMessage>): Promise<void> {
  const data = event.data;
  if (!data || data.type !== "uptimizr-request" || !data.request) return;
  const port = event.ports[0];
  if (!port) return;
  let response: DemoResponse;
  try {
    const db = await ensureDb();
    response = await handleRequest(db, data.request);
  } catch (err) {
    response = { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
  }
  port.postMessage(response);
}

/** Begin answering forwarded collector requests from the service worker. */
export function startHost(): void {
  if (listening || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", (event) => {
    void onMessage(event as MessageEvent<HostMessage>);
  });
  listening = true;
}

/** Clear all collected analytics while keeping the page alive (reset button). */
export async function resetData(): Promise<void> {
  const db = await ensureDb();
  await db.reset();
}

/** Proactively tear down the database + worker (last-tab teardown / leaving the demo). */
export async function disposeDb(): Promise<void> {
  if (dbInstance) {
    await dbInstance.dispose();
  }
  dbInstance = null;
  dbInit = null;
}
