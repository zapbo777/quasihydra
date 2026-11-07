import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";

export function createTestDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const dir = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(dir).filter((file) => file.endsWith(".sql")).sort()) {
    db.exec(readFileSync(new URL(name, dir), "utf8"));
  }
  return wrap(db);
}

export function wrap(db) {
  return {
    prepare(sql) {
      return {
        bind(...params) {
          const stmt = db.prepare(sql);
          return {
            async run() {
              const info = stmt.run(...params);
              return { success: true, meta: { changes: info.changes } };
            },
            async all() {
              return { results: stmt.all(...params) };
            },
            async first() {
              return stmt.get(...params) ?? null;
            },
          };
        },
      };
    },
  };
}
