import type { ButtonHTMLAttributes, ReactNode } from "react";

/** Class names for a button, so a link can look like one too: `<Link className={buttonStyles("primary")}>`. */
export function buttonStyles(variant: "primary" | "secondary" | "ghost" | "danger" = "secondary", size: "md" | "lg" | "sm" = "md"): string {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-xl font-medium whitespace-nowrap transition-all duration-150 " +
    "disabled:cursor-not-allowed disabled:opacity-60 active:translate-y-px";
  const sizes = { sm: "h-8 px-3 text-xs", md: "h-10 px-4 text-sm", lg: "h-12 px-6 text-base" }[size];
  const looks = {
    primary: "bg-primary text-white shadow-sm shadow-primary/30 hover:bg-primary-hover hover:shadow-md hover:shadow-primary/30",
    secondary: "border border-line bg-surface text-ink shadow-sm hover:border-line-strong hover:bg-surface-2",
    ghost: "text-muted hover:bg-surface-2 hover:text-ink",
    danger: "border border-danger/30 bg-danger-soft text-danger hover:border-danger/60",
  }[variant];
  return `${base} ${sizes} ${looks}`;
}

export function Button({
  variant,
  size,
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Parameters<typeof buttonStyles>[0]; size?: Parameters<typeof buttonStyles>[1] }) {
  return <button type="button" {...rest} className={`${buttonStyles(variant, size)} ${className}`} />;
}

export function Card({ children, className = "", ...rest }: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className={`rounded-2xl border border-line bg-surface shadow-card ${className}`}>
      {children}
    </div>
  );
}

/** A card's title row: heading on the left, optional actions on the right. */
export function CardHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
      <div>
        <h2 className="text-base font-semibold tracking-tight">{title}</h2>
        {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden="true" className={`skeleton rounded-lg bg-surface-2 ${className}`} />;
}
