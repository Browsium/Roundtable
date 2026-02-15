import type { NextConfig } from "next";
import pkg from "./package.json";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type BuildMeta = { build_date?: string } | null;

function readBuildMeta(): BuildMeta {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, ".build-meta.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as BuildMeta;
  } catch {
    // ignore
  }
  return null;
}

const BUILD_META = readBuildMeta();
const BUILD_DATE =
  process.env.NEXT_PUBLIC_BUILD_DATE ||
  (typeof BUILD_META?.build_date === "string" ? BUILD_META.build_date : "") ||
  "unknown";

const nextConfig: NextConfig = {
  output: 'export',
  distDir: 'dist',
  images: {
    unoptimized: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  env: {
    // Single source of truth is frontend/package.json version.
    NEXT_PUBLIC_FRONTEND_VERSION: pkg.version,
    // IMPORTANT: must be deterministic across server prerender + client bundle to avoid hydration mismatch.
    NEXT_PUBLIC_BUILD_DATE: BUILD_DATE,
  },
};

export default nextConfig;
