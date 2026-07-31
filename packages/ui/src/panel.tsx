import type { HTMLAttributes, ReactNode } from 'react';

import { cn } from './cn';

// `title` is omitted from the DOM attributes because this component renders it
// as a heading node, while HTMLAttributes types it as a plain tooltip string.
export interface PanelProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title?: ReactNode;
  children?: ReactNode;
}

/** Frosted container used for HUD overlays and menu cards. */
export function Panel({ title, className, children, ...rest }: PanelProps) {
  return (
    <div
      className={cn(
        'rounded-xl border border-slate-800/80 bg-slate-900/70 p-4 backdrop-blur-md',
        className,
      )}
      {...rest}
    >
      {title ? (
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-slate-400">
          {title}
        </h2>
      ) : null}
      {children}
    </div>
  );
}
