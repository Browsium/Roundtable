import type { NextConfig } from "next";
import pkg from "./package.json";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type BuildMeta = { build_date?: string; build_date_et?: string } | null;

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
const BUILD_DATE_UTC =
  process.env.NEXT_PUBLIC_BUILD_DATE ||
  (typeof BUILD_META?.build_date === "string" ? BUILD_META.build_date : "") ||
  "unknown";

function formatEtFromUtc(utcIso: string): string {
  try {
    if (!utcIso || utcIso === "unknown") return "";
    const d = new Date(utcIso);
    if (Number.isNaN(d.getTime()) || d.getTime() <= 0) return "";
    return (
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
        hour12: true,
        timeZoneName: "short",
      }).format(d) || ""
    );
  } catch {
    return "";
  }
}

const BUILD_DATE_ET =
  process.env.NEXT_PUBLIC_BUILD_DATE_ET ||
  (typeof BUILD_META?.build_date_et === "string" ? BUILD_META.build_date_et : "") ||
  formatEtFromUtc(BUILD_DATE_UTC) ||
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
    NEXT_PUBLIC_BUILD_DATE: BUILD_DATE_UTC,
    NEXT_PUBLIC_BUILD_DATE_ET: BUILD_DATE_ET,
  },
};

export default nextConfig;
