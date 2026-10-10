// PROTOTYPE(agent-secrets): design review only, mock data, not wired to the server.
import { useSyncExternalStore } from "react";

export interface PrototypeSecret {
  readonly name: string;
  readonly updatedAt: string;
}

const STORAGE_KEY = "t3.prototype.agentSecrets";
const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const SECRET_NAME_MAX_LENGTH = 64;

const listeners = new Set<() => void>();
let secrets: ReadonlyArray<PrototypeSecret> | null = null;

function byName(a: PrototypeSecret, b: PrototypeSecret) {
  return a.name.localeCompare(b.name);
}

function seed(): ReadonlyArray<PrototypeSecret> {
  const updatedAt = new Date().toISOString();
  return [
    { name: "CLOUDFLARE_API_TOKEN", updatedAt },
    { name: "GITHUB_TOKEN", updatedAt },
  ];
}

function load(): ReadonlyArray<PrototypeSecret> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return seed();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return seed();
    return parsed
      .flatMap((entry: unknown): PrototypeSecret[] => {
        if (typeof entry !== "object" || entry === null) return [];
        const { name, updatedAt } = entry as Record<string, unknown>;
        return typeof name === "string" && typeof updatedAt === "string"
          ? [{ name, updatedAt }]
          : [];
      })
      .toSorted(byName);
  } catch {
    return seed();
  }
}

function getSnapshot() {
  secrets ??= load();
  return secrets;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function commit(next: ReadonlyArray<PrototypeSecret>) {
  secrets = next.toSorted(byName);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(secrets));
  } catch {
    // Storage can be unavailable (private mode, quota); the in-memory list still works.
  }
  for (const listener of listeners) listener();
}

export function usePrototypeSecrets() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Only the name and a timestamp are kept; callers must not pass the value in. */
export function savePrototypeSecret(name: string) {
  const updatedAt = new Date().toISOString();
  commit([...getSnapshot().filter((secret) => secret.name !== name), { name, updatedAt }]);
}

export function deletePrototypeSecret(name: string) {
  commit(getSnapshot().filter((secret) => secret.name !== name));
}

/** Uppercases and turns spaces and `-` into `_`, as the user types. */
export function normalizeSecretName(input: string) {
  return input.toUpperCase().replace(/[\s-]/g, "_");
}

export function isValidSecretName(name: string) {
  return name.length <= SECRET_NAME_MAX_LENGTH && SECRET_NAME_PATTERN.test(name);
}
