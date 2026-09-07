export type IconName =
  | "chevron"
  | "window"
  | "folder"
  | "note"
  | "globe"
  | "close"
  | "restore"
  | "trash"
  | "plus"
  | "search"
  | "more";

const PATHS: Record<IconName, string> = {
  chevron: "M4.5 2.5 8 6l-3.5 3.5",
  window: "M1.5 2.5h9v7h-9zM1.5 4.5h9",
  folder: "M1.5 3h3l1 1h5v5.5h-9z",
  note: "M2.5 1.5h5l2 2v7h-7zM4 6h4M4 8h3",
  globe:
    "M6 1.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 1 0 0-9M1.5 6h9M6 1.5c-2 2.5-2 6.5 0 9M6 1.5c2 2.5 2 6.5 0 9",
  close: "M2.5 2.5l7 7M9.5 2.5l-7 7",
  restore: "M2.5 6a3.5 3.5 0 1 1 1 2.5M2.5 3v3h3",
  trash: "M2 3h8M4.5 3V1.5h3V3M3 3l.5 7.5h5L9 3",
  plus: "M6 2v8M2 6h8",
  search: "M5 1.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 1 0 0-7M7.5 7.5l3 3",
  more: "M3 6h.01M6 6h.01M9 6h.01",
};

export interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
  title?: string;
}

/** Tiny stroke icons so the UI needs no icon font, images or emoji. */
export function Icon({ name, size = 12, className, title }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
    >
      {title ? <title>{title}</title> : null}
      <path d={PATHS[name]} />
    </svg>
  );
}
