const LOOKS: Record<string, { pill: string; dot: string; live?: boolean }> = {
  Pending: { pill: "bg-surface-2 text-muted ring-line-strong", dot: "bg-faint" },
  Running: { pill: "bg-info-soft text-info ring-info/25", dot: "bg-info", live: true },
  Completed: { pill: "bg-success-soft text-success ring-success/25", dot: "bg-success" },
  Failed: { pill: "bg-danger-soft text-danger ring-danger/25", dot: "bg-danger" },
  Canceled: { pill: "bg-warning-soft text-warning ring-warning/25", dot: "bg-warning" },
};

/** Job status as a pill with a dot. The text carries the meaning; colour and the live pulse only reinforce it. */
export function StatusBadge({ status, size = "md" }: { status: string; size?: "md" | "lg" }) {
  const look = LOOKS[status] ?? LOOKS.Pending;
  const sizing = size === "lg" ? "px-3.5 py-1.5 text-sm" : "px-2.5 py-1 text-xs";
  return (
    <span className={`inline-flex items-center gap-2 rounded-full font-medium ring-1 ring-inset ${sizing} ${look.pill}`}>
      <span className={`relative inline-block h-1.5 w-1.5 rounded-full ${look.dot} ${look.live ? "animate-pulse-ring text-info" : ""}`} aria-hidden="true" />
      {status}
    </span>
  );
}
