/**
 * Typed wrappers for the Jarvis-layer user memory IPC commands.
 * Mirrors `desktop/src-tauri/src/ipc/user_memory.rs`.
 */

import { invoke } from "@tauri-apps/api/core";

// ── Types (mirror Rust structs) ─────────────────────────────────────────────
//
// Wire format is lowercase to match Rust's `#[serde(rename_all = "lowercase")]`
// on `FactType` and `FactSource`. ts-rs-generated mirrors live at
// `src/lib/types/{FactType,FactSource,FactRow}.ts` once cargo tests run;
// these hand-written types must stay in sync with that wire shape.

export type FactType = "identity" | "preference" | "pattern" | "context" | "skill";
export type FactSource = "explicit" | "inferred" | "observed";

export interface MemoryFact {
  id: number;
  fact_type: FactType;
  content: string;
  confidence: number;
  source: FactSource;
  created_at: number;
  last_seen_at: number;
  expires_at: number | null;
}

export interface UpsertFactInput {
  fact_type: FactType;
  content: string;
  confidence: number;
  source: FactSource;
  expires_at?: number | null;
}

export interface MemoryStats {
  total_facts: number;
  by_identity: number;
  by_preference: number;
  by_pattern: number;
  by_context: number;
  by_skill: number;
}

// ── Commands ────────────────────────────────────────────────────────────────

/** All non-expired facts, ordered by type then recency. */
export async function userMemoryList(): Promise<MemoryFact[]> {
  return invoke<MemoryFact[]>("user_memory_list");
}

/** Insert or update a fact. Dedup key = (fact_type, content). */
export async function userMemoryUpsert(input: UpsertFactInput): Promise<MemoryFact> {
  return invoke<MemoryFact>("user_memory_upsert", { input });
}

/** Delete one fact by id. Returns true if a row was removed. */
export async function userMemoryDelete(id: number): Promise<boolean> {
  return invoke<boolean>("user_memory_delete", { id });
}

/** Wipe all facts. Returns the count of removed rows. */
export async function userMemoryWipe(): Promise<number> {
  return invoke<number>("user_memory_wipe");
}

/**
 * Render all facts as a markdown profile string.
 * Returns null when there are no facts yet.
 */
export async function userMemoryRendered(): Promise<string | null> {
  return invoke<string | null>("user_memory_rendered");
}

/**
 * Extract facts from a user chat message (rule-based, < 1 ms).
 * Persists any extracted facts and returns the new/updated rows.
 * Call fire-and-forget after each user turn.
 */
export async function userMemoryExtract(message: string): Promise<MemoryFact[]> {
  return invoke<MemoryFact[]>("user_memory_extract", { message });
}

/** Stats snapshot for the Settings panel. */
export async function userMemoryStats(): Promise<MemoryStats> {
  return invoke<MemoryStats>("user_memory_stats");
}
