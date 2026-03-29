import { useState } from 'react';
import { Settings } from 'lucide-react';

export function SettingsPage() {
  const [company, setCompany] = useState({ name: 'Instrata / Premiere Communications', phone: '(212) 555-0100', email: 'support@instrata-av.com', address: 'New York, NY' });

  return (
    <div className="p-8 max-w-3xl">
      <h1 className="text-2xl font-bold text-navy mb-6">Settings</h1>

      <div className="bg-white rounded-xl border border-border shadow-sm p-6 mb-6">
        <h2 className="text-base font-semibold text-navy mb-4">Company Information</h2>
        <div className="space-y-4">
          <label className="block">
            <span className="text-sm font-medium text-text-primary">Company Name</span>
            <input value={company.name} onChange={(e) => setCompany({ ...company, name: e.target.value })} className="input mt-1.5" />
          </label>
          <div className="grid grid-cols-2 gap-4">
            <label className="block">
              <span className="text-sm font-medium text-text-primary">Phone</span>
              <input value={company.phone} onChange={(e) => setCompany({ ...company, phone: e.target.value })} className="input mt-1.5" />
            </label>
            <label className="block">
              <span className="text-sm font-medium text-text-primary">Email</span>
              <input value={company.email} onChange={(e) => setCompany({ ...company, email: e.target.value })} className="input mt-1.5" />
            </label>
          </div>
          <label className="block">
            <span className="text-sm font-medium text-text-primary">Address</span>
            <input value={company.address} onChange={(e) => setCompany({ ...company, address: e.target.value })} className="input mt-1.5" />
          </label>
        </div>
        <div className="flex justify-end mt-6 pt-4 border-t border-border">
          <button className="btn-primary">Save Changes</button>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-border shadow-sm p-6 mb-6">
        <h2 className="text-base font-semibold text-navy mb-4">PDF Export Defaults</h2>
        <div className="space-y-4">
          <label className="block">
            <span className="text-sm font-medium text-text-primary">Default Prepared By</span>
            <input defaultValue="" className="input mt-1.5" placeholder="Name shown as preparer on exports" />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-text-primary">Company Tagline</span>
            <input defaultValue="Technology Solutions for Modern Spaces" className="input mt-1.5" />
          </label>
        </div>
        <div className="flex justify-end mt-6 pt-4 border-t border-border">
          <button className="btn-primary">Save Changes</button>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-border shadow-sm p-6">
        <h2 className="text-base font-semibold text-navy mb-4">About</h2>
        <div className="space-y-2 text-sm text-text-secondary">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-orange rounded-lg flex items-center justify-center">
              <span className="text-white font-bold">I</span>
            </div>
            <div>
              <div className="font-semibold text-text-primary">Instrata Project Tools</div>
              <div>v1.0.0 — March 2026</div>
            </div>
          </div>
          <p className="mt-3">AV project documentation toolset for Instrata field engineers and project managers. Submittal packages, RFI tracking, closeout documentation, and owner manuals.</p>
        </div>
      </div>
    </div>
  );
}
