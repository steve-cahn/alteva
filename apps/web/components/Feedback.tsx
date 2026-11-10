import type { ReactNode } from "react";
import { ApiRequestError } from "@/lib/api";
import { AlertIcon, InboxIcon, RefreshIcon } from "./Icons";
import { Button } from "./ui";

export function Loading({ label }: { label: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-3 py-12 text-sm text-muted">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-line-strong border-t-primary motion-reduce:animate-none" aria-hidden />
      {label}
    </div>
  );
}

export function EmptyState({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-2xl border border-dashed border-line-strong px-6 py-12 text-center">
      <span className="mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-primary-soft text-primary-ink">{icon ?? <InboxIcon size={22} />}</span>
      <p className="font-semibold tracking-tight">{title}</p>
      {children && <div className="mt-1.5 max-w-sm text-sm text-muted">{children}</div>}
    </div>
  );
}

/** An error with the api's message, a support reference when there is one, and an optional retry. */
export function ErrorMessage({ error, title, onRetry }: { error: Error; title: string; onRetry?: () => void }) {
  const reference = error instanceof ApiRequestError ? error.correlationId : undefined;
  return (
    <div role="alert" className="flex gap-3 rounded-2xl border border-danger/30 bg-danger-soft p-4">
      <span className="mt-0.5 text-danger">
        <AlertIcon size={20} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-danger">{title}</p>
        <p className="mt-1 text-sm text-ink/80">{error.message}</p>
        {reference && <p className="mt-1 font-mono text-xs text-muted">Reference: {reference}</p>}
        {onRetry && (
          <Button onClick={onRetry} variant="secondary" size="sm" className="mt-3">
            <RefreshIcon size={14} />
            Try again
          </Button>
        )}
      </div>
    </div>
  );
}
