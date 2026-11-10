export const DEFAULT_DEPTH = 2;
/** The API accepts any depth up to the page limit; these are the ones worth offering. */
const DEPTHS = [0, 1, 2, 3, 4, 5] as const;

const DESCRIPTIONS: Record<number, string> = {
  0: "Only the page you enter. Its links are listed and measured, but not followed.",
  1: "Only the page you enter and the pages it links to.",
  2: "Also the pages those lead to. A good default.",
  3: "Three hops out. Bigger sites will reach the 200-page limit.",
  4: "Four hops out. Most sites will reach the 200-page limit.",
  5: "Five hops out. Almost any site will reach the 200-page limit.",
};

/** A segmented 0-5 control (real radio buttons underneath, so it works with a keyboard and a screen reader). */
export function DepthPicker({ value, onChange, error }: { value: number; onChange: (depth: number) => void; error?: string }) {
  return (
    <fieldset aria-describedby="depth-hint">
      <legend className="mb-2 text-sm font-medium">Max depth</legend>
      <div className="inline-flex rounded-xl border border-line bg-surface-2 p-1" role="presentation">
        {DEPTHS.map((depth) => (
          <label key={depth} className="relative">
            <input
              type="radio"
              name="maxDepth"
              value={depth}
              checked={value === depth}
              onChange={() => onChange(depth)}
              className="peer sr-only"
            />
            <span
              className="grid h-9 w-11 cursor-pointer place-items-center rounded-lg text-sm font-medium tabular-nums text-muted transition-all
                         hover:text-ink peer-checked:bg-surface peer-checked:text-primary-ink peer-checked:shadow-sm
                         peer-checked:ring-1 peer-checked:ring-line peer-focus-visible:outline-2 peer-focus-visible:outline-primary"
            >
              {depth}
            </span>
          </label>
        ))}
      </div>
      <p id="depth-hint" className={`mt-2 text-sm ${error ? "text-danger" : "text-muted"}`}>
        {error ? `Max depth ${error}` : DESCRIPTIONS[value]}
        {!error && value === DEFAULT_DEPTH && <span className="ml-1.5 rounded-md bg-primary-soft px-1.5 py-0.5 text-xs font-medium text-primary-ink">default</span>}
      </p>
    </fieldset>
  );
}
