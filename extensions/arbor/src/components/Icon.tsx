export type IconName =
  | "chevron"
  | "window"
  | "note"
  | "globe"
  | "close"
  | "restore"
  | "rename"
  | "trash"
  | "plus"
  | "search"
  | "more"
  | "undo"
  | "redo";

const PATHS: Record<IconName, string> = {
  chevron: "M4.5 2.5 8 6l-3.5 3.5",
  window: "M1.5 2.5h9v7h-9zM1.5 4.5h9",
  note: "M2.5 1.5h5l2 2v7h-7zM4 6h4M4 8h3",
  globe:
    "M6 1.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 1 0 0-9M1.5 6h9M6 1.5c-2 2.5-2 6.5 0 9M6 1.5c2 2.5 2 6.5 0 9",
  close: "M2.5 2.5l7 7M9.5 2.5l-7 7",
  restore: "M2.5 6a3.5 3.5 0 1 1 1 2.5M2.5 3v3h3",
  rename: "M8.5 1.5l2 2-6.5 6.5H2v-2zM7 3l2 2",
  trash: "M2 3h8M4.5 3V1.5h3V3M3 3l.5 7.5h5L9 3",
  plus: "M6 2v8M2 6h8",
  search: "M5 1.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 1 0 0-7M7.5 7.5l3 3",
  more: "M3 6h.01M6 6h.01M9 6h.01",
  undo: "M2.5 4.5h5a2.25 2.25 0 0 1 0 4.5H5M4.5 2.5l-2 2 2 2",
  redo: "M9.5 4.5h-5a2.25 2.25 0 0 0 0 4.5H7M7.5 2.5l2 2-2 2",
};

export interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
  title?: string;
}

export interface ContainerIconProps {
  /** The container is bound to an open browser window. */
  open: boolean;
  size?: number;
  className?: string;
  title?: string;
}

/**
 * The one glyph for containers (windows and groups are the same thing): a window frame, drawn
 * as an outline while the container is closed and with its title bar and body filled while its
 * browser window is open. Same shape either way, so the state reads as a state, not as a kind.
 */
export function ContainerIcon({ open, size = 12, className, title }: ContainerIconProps) {
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
      {open ? (
        <>
          <rect
            x="1.5"
            y="2.5"
            width="9"
            height="7"
            fill="currentColor"
            opacity="0.22"
            stroke="none"
          />
          <rect x="1.5" y="2.5" width="9" height="2" fill="currentColor" stroke="none" />
        </>
      ) : null}
      <path d={PATHS.window} />
    </svg>
  );
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
