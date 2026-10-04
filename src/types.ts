export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  TOKEN_SECRET: string;
  PUBLIC_BASE_URL: string;
  /** Lets our own scout script file reports as source "scout" (weighted lower, exempt from per-IP caps). */
  ADMIN_SECRET?: string;
  /** Optional: when set, domains with no docs door get one found via Exa search. */
  EXA_API_KEY?: string;
}
