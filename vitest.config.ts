import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    env: { DATABASE_URL: "file:./test.db", PAYMENT_WEBHOOK_SECRET: "s3cret" },
    globalSetup: "./tests/global-setup.ts",
    fileParallelism: false, // tests share one SQLite file
  },
});
