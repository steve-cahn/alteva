// Next inlines NEXT_PUBLIC_* at build time, and only for this literal `process.env.NAME` form.
// Set it when running `next build` (compose passes it as a build arg).
export const API_BASE_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000").replace(/\/+$/, "");
