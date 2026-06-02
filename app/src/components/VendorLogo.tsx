import { useState } from 'react';
import { logoUrl, fallbackLogoUrl, initialsFor } from '../lib/vendorContacts';

interface VendorLogoProps {
  domain: string;
  company: string;
  /** Box size in px. */
  size?: number;
  className?: string;
}

// Renders a company logo from its domain, degrading gracefully:
// Clearbit logo → Google favicon → navy initials box. Mirrors the
// onerror fallback chain from the original standalone page.
export function VendorLogo({ domain, company, size = 44, className = '' }: VendorLogoProps) {
  type Stage = 'primary' | 'fallback' | 'initials';
  const primary = logoUrl(domain);
  const fallback = fallbackLogoUrl(domain);

  const [stage, setStage] = useState<Stage>(primary ? 'primary' : 'initials');

  // Reset when the domain changes (e.g. switching between contacts) using the
  // recommended "adjust state during render" pattern instead of an effect.
  const [prevPrimary, setPrevPrimary] = useState(primary);
  if (primary !== prevPrimary) {
    setPrevPrimary(primary);
    setStage(primary ? 'primary' : 'initials');
  }

  const dims = { width: size, height: size };
  const radius = Math.max(6, Math.round(size * 0.18));

  if (stage === 'initials') {
    return (
      <div
        className={`flex items-center justify-center bg-navy text-white font-bold flex-shrink-0 ${className}`}
        style={{ ...dims, borderRadius: radius, fontSize: Math.round(size * 0.36) }}
      >
        {initialsFor(company)}
      </div>
    );
  }

  const src = stage === 'primary' ? primary : fallback;
  return (
    <img
      src={src}
      alt={company}
      className={`object-contain bg-white border border-border flex-shrink-0 ${className}`}
      style={{ ...dims, borderRadius: radius, padding: Math.max(3, Math.round(size * 0.09)) }}
      onError={() => setStage((s) => (s === 'primary' && fallback ? 'fallback' : 'initials'))}
    />
  );
}
