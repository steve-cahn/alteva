"use client";

import { useEffect } from "react";

// Last-resort boundary for rendering crashes. Failed API calls are handled in the components.
export default function Error({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950">
      <h1 className="font-semibold text-red-800 dark:text-red-200">Something went wrong</h1>
      <p className="mt-1 text-sm text-red-700 dark:text-red-300">An unexpected error occurred while showing this page.</p>
      <button onClick={() => retry()} className="mt-3 rounded-md bg-red-700 px-3 py-1.5 text-sm text-white hover:bg-red-800">
        Try again
      </button>
    </div>
  );
}
