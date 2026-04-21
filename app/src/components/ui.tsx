// Shared layout primitives used across pages: Eyebrow, Card, PageHeader.
// Page-specific composites (PhaseRibbon, ProjectHeader) live alongside their
// pages but compose these primitives.

import type { ReactNode } from 'react';

interface EyebrowProps {
  children: ReactNode;
  className?: string;
  /** Override accent color (default: orange). */
  color?: string;
}

export function Eyebrow({ children, className = '', color }: EyebrowProps) {
  return (
    <div
      className={`text-[10px] font-bold uppercase tracking-[0.15em] ${className}`}
      style={color ? { color } : { color: 'var(--color-orange)' }}
    >
      {children}
    </div>
  );
}

interface CardProps {
  children: ReactNode;
  /** Optional title rendered with a header strip. */
  title?: ReactNode;
  /** Optional eyebrow text shown above the title. */
  eyebrow?: ReactNode;
  /** Action node rendered on the right of the title bar. */
  action?: ReactNode;
  className?: string;
  /** Skip the inner padding so children control their own spacing. */
  flush?: boolean;
}

export function Card({ children, title, eyebrow, action, className = '', flush }: CardProps) {
  return (
    <div className={`bg-white border border-border rounded-xl shadow-sm overflow-hidden ${className}`}>
      {(title || eyebrow || action) && (
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border">
          <div>
            {eyebrow && <Eyebrow className="mb-0.5">{eyebrow}</Eyebrow>}
            {title && <h2 className="text-base font-semibold text-navy m-0">{title}</h2>}
          </div>
          {action}
        </div>
      )}
      <div className={flush ? '' : 'p-5'}>{children}</div>
    </div>
  );
}

interface PageHeaderProps {
  /** Eyebrow line above the title. */
  eyebrow?: ReactNode;
  title: ReactNode;
  /** One-line subhead under the title. */
  subtitle?: ReactNode;
  /** Right-side actions (buttons). */
  actions?: ReactNode;
  className?: string;
}

export function PageHeader({ eyebrow, title, subtitle, actions, className = '' }: PageHeaderProps) {
  return (
    <div className={`flex items-end justify-between gap-4 mb-6 ${className}`}>
      <div className="min-w-0">
        {eyebrow && <Eyebrow className="mb-1.5">{eyebrow}</Eyebrow>}
        <h1 className="text-[28px] font-bold text-navy tracking-[-0.01em] m-0 leading-tight">
          {title}
        </h1>
        {subtitle && <p className="text-sm text-fg-2 mt-1 m-0">{subtitle}</p>}
      </div>
      {actions && <div className="flex gap-2.5 flex-shrink-0">{actions}</div>}
    </div>
  );
}
