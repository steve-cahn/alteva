import { progressPercent } from "@/lib/format";

export function ProgressBar({ processed, discovered, done }: { processed: number; discovered: number; done: boolean }) {
  const percent = done ? 100 : progressPercent(processed, discovered);
  return (
    <div>
      <div
        role="progressbar"
        aria-label="Pages processed"
        aria-valuemin={0}
        aria-valuemax={discovered}
        aria-valuenow={processed}
        className="h-2.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
      >
        <div className="h-full rounded-full bg-blue-600 transition-[width] duration-300" style={{ width: `${percent}%` }} />
      </div>
      <p className="mt-1.5 text-sm text-zinc-600 dark:text-zinc-400">
        {processed} of {discovered} pages processed ({percent}%)
      </p>
    </div>
  );
}
