"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { ApiRequestError, createJob } from "@/lib/api";
import { DEFAULT_DEPTH, DepthPicker } from "./DepthPicker";
import { AlertIcon, ArrowRightIcon, GlobeIcon } from "./Icons";
import { Button } from "./ui";

const EXAMPLES = [
  { label: "books.toscrape.com", url: "https://books.toscrape.com/" },
  { label: "quotes.toscrape.com", url: "https://quotes.toscrape.com/" },
  { label: "info.cern.ch", url: "http://info.cern.ch/" },
];

export function NewCrawlForm() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [maxDepth, setMaxDepth] = useState(DEFAULT_DEPTH);
  const [submitting, setSubmitting] = useState(false);
  const [navigating, startNavigation] = useTransition();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<ApiRequestError | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setFieldErrors({});
    setFormError(null);
    try {
      const { jobId } = await createJob({ url: url.trim(), maxDepth });
      // The transition keeps the button disabled until navigation finishes, then resets on its
      // own. The form's state can outlive navigation, so it must not stay "submitting" forever.
      startNavigation(() => router.push(`/jobs/${jobId}`));
      setSubmitting(false);
      // The page is kept alive when you leave it, so clear what was submitted: coming back to
      // "New crawl" should show an empty form, not the last address.
      setUrl("");
      setMaxDepth(DEFAULT_DEPTH);
    } catch (err) {
      const error = err instanceof ApiRequestError ? err : new ApiRequestError(0, "UNKNOWN", "Something went wrong.");
      // Field problems show next to their input; anything else (network, 503, a field this form
      // does not have, ...) shows above the form so a failure is never silent.
      const byField = Object.fromEntries(error.details.map((d) => [d.field, d.message]));
      setFieldErrors(byField);
      if (!byField.url && !byField.maxDepth) setFormError(error);
      setSubmitting(false);
    }
  }

  const busy = submitting || navigating;

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-6">
      {formError && (
        <div role="alert" className="flex gap-3 rounded-xl border border-danger/30 bg-danger-soft p-3.5 text-sm">
          <span className="mt-0.5 text-danger">
            <AlertIcon size={18} />
          </span>
          <div>
            <p className="font-medium text-danger">{formError.message}</p>
            {formError.correlationId && <p className="mt-1 font-mono text-xs text-muted">Reference: {formError.correlationId}</p>}
          </div>
        </div>
      )}

      <div>
        <label htmlFor="url" className="mb-2 block text-sm font-medium">
          Website URL
        </label>
        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="relative flex-1">
            <span className="pointer-events-none absolute inset-y-0 left-4 grid place-items-center text-faint">
              <GlobeIcon size={18} />
            </span>
            <input
              id="url"
              name="url"
              type="text"
              inputMode="url"
              autoComplete="url"
              spellCheck={false}
              placeholder="https://example.com"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              aria-invalid={Boolean(fieldErrors.url)}
              aria-describedby={fieldErrors.url ? "url-error" : undefined}
              className="h-12 w-full rounded-xl border border-line-strong bg-surface pl-11 pr-4 text-base shadow-sm outline-none transition-shadow
                         placeholder:text-faint focus:border-primary focus:ring-4 focus:ring-primary/15 aria-[invalid=true]:border-danger aria-[invalid=true]:ring-danger/15"
            />
          </div>
          <Button type="submit" variant="primary" size="lg" disabled={busy} className="sm:min-w-40">
            {busy ? "Starting…" : "Start crawl"}
            {!busy && <ArrowRightIcon size={18} />}
          </Button>
        </div>
        {fieldErrors.url ? (
          <p id="url-error" className="mt-2 text-sm text-danger">
            URL {fieldErrors.url}
          </p>
        ) : (
          <p className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm text-muted">
            <span>Try</span>
            {EXAMPLES.map((example) => (
              <button
                key={example.url}
                type="button"
                onClick={() => setUrl(example.url)}
                className="rounded-full border border-line bg-surface px-2.5 py-1 text-xs font-medium text-ink transition-colors hover:border-primary/50 hover:bg-primary-soft hover:text-primary-ink"
              >
                {example.label}
              </button>
            ))}
          </p>
        )}
      </div>

      <DepthPicker value={maxDepth} onChange={setMaxDepth} error={fieldErrors.maxDepth} />
    </form>
  );
}
