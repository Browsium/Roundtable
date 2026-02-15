// Single source of truth is frontend/package.json version (wired through next.config.ts env).
export const FRONTEND_VERSION = process.env.NEXT_PUBLIC_FRONTEND_VERSION || '0.0.0';
export const BUILD_DATE = process.env.NEXT_PUBLIC_BUILD_DATE || '';
export const BUILD_DATE_ET = process.env.NEXT_PUBLIC_BUILD_DATE_ET || '';
