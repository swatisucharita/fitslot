import { execSync } from "node:child_process";
import { rmSync } from "node:fs";

// Start every run from a fresh, throwaway SQLite file.
export default function setup() {
  rmSync("test.db", { force: true });
  execSync("npx prisma db push", {
    env: { ...process.env, DATABASE_URL: "file:./test.db" },
    stdio: "ignore",
  });
}
