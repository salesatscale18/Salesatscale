import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

// Local development: load .env.local (Vercel injects env vars directly).
config({ path: ".env.local", quiet: true });

export default defineConfig({
  dialect: "postgresql",
  schema: "./db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
  strict: true,
  verbose: true,
});
