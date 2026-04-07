import { Mail, Loader2 } from 'lucide-react';

interface Props {
  onConnect: () => void;
  isConnecting?: boolean;
  error?: string | null;
}

export function ConnectEmailBanner({ onConnect, isConnecting, error }: Props) {
  return (
    <div className="bg-white rounded-xl border border-border p-8 shadow-sm text-center max-w-lg mx-auto mt-12">
      <div className="w-14 h-14 bg-blue-50 rounded-full flex items-center justify-center mx-auto mb-4">
        <Mail size={28} className="text-blue-600" />
      </div>
      <h3 className="text-lg font-semibold text-primary mb-2">Connect Your Email</h3>
      <p className="text-sm text-secondary mb-6">
        Link your Microsoft 365 account to enable email triage. Only inbox read
        access is requested — no emails will be sent or modified.
      </p>
      <button
        onClick={onConnect}
        disabled={isConnecting}
        className="inline-flex items-center gap-2 px-5 py-2.5 bg-navy text-white text-sm font-medium rounded-lg hover:bg-navy/90 transition-colors disabled:opacity-50"
      >
        {isConnecting ? (
          <>
            <Loader2 size={16} className="animate-spin" />
            Connecting…
          </>
        ) : (
          <>
            <Mail size={16} />
            Connect Microsoft Email
          </>
        )}
      </button>
      {error && (
        <p className="mt-3 text-xs text-red-600">{error}</p>
      )}
    </div>
  );
}
