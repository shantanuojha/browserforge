export interface ProBadgeProps {
  /** Override the label; defaults to "PRO". */
  label?: string;
  title?: string;
  className?: string;
}

export function ProBadge({
  label = "PRO",
  title = "Pro features unlocked",
  className,
}: ProBadgeProps) {
  const classes = ["bf-pro-badge", className].filter(Boolean).join(" ");
  return (
    <span className={classes} title={title} aria-label={title}>
      {label}
    </span>
  );
}
