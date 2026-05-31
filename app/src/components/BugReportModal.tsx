import { useState, useRef } from 'react';
import { Loader2, ImagePlus, X, CheckCircle2 } from 'lucide-react';
import { Modal } from './Modal';
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';

interface Props {
  open: boolean;
  onClose: () => void;
}

export function BugReportModal({ open, onClose }: Props) {
  const { user } = useAuth();
  const [title, setTitle]               = useState('');
  const [body, setBody]                 = useState('');
  const [image, setImage]               = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [submitting, setSubmitting]     = useState(false);
  const [error, setError]               = useState<string | null>(null);
  const [success, setSuccess]           = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const pageUrl = window.location.pathname;

  const reset = () => {
    setTitle('');
    setBody('');
    setImage(null);
    setImagePreview(null);
    setError(null);
    setSuccess(false);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImage(file);
    const reader = new FileReader();
    reader.onload = (ev) => setImagePreview(ev.target?.result as string);
    reader.readAsDataURL(file);
  };

  const removeImage = () => {
    setImage(null);
    setImagePreview(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !body.trim()) return;
    if (!isSupabaseConfigured()) {
      setError('Supabase not configured — cannot submit bug reports in demo mode.');
      return;
    }

    setSubmitting(true);
    setError(null);

    let imageUrl: string | null = null;

    if (image) {
      const ext = image.name.split('.').pop() ?? 'png';
      const path = `${crypto.randomUUID()}.${ext}`;
      const { error: uploadError } = await supabase.storage
        .from('bug-screenshots')
        .upload(path, image, { contentType: image.type });
      if (uploadError) {
        setError(`Screenshot upload failed: ${uploadError.message}`);
        setSubmitting(false);
        return;
      }
      const { data: urlData } = supabase.storage.from('bug-screenshots').getPublicUrl(path);
      imageUrl = urlData.publicUrl;
    }

    const { error: insertError } = await supabase.from('bug_reports').insert({
      reporter_id: user?.id ?? null,
      title:       title.trim(),
      body:        body.trim(),
      image_url:   imageUrl,
      page_url:    pageUrl,
      status:      'open',
    });

    if (insertError) {
      setError(insertError.message);
      setSubmitting(false);
      return;
    }

    setSuccess(true);
    setSubmitting(false);
    setTimeout(handleClose, 2000);
  };

  return (
    <Modal open={open} onClose={handleClose} title="Report a Bug">
      {success ? (
        <div className="py-10 flex flex-col items-center gap-3 text-center">
          <CheckCircle2 size={36} className="text-green-500" />
          <div className="text-base font-semibold text-text-primary">Report submitted — thanks!</div>
          <p className="text-sm text-text-secondary max-w-xs">
            We'll look into it and you'll be notified when there's an update.
          </p>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <label className="block">
            <span className="text-sm font-medium text-text-primary">
              Title <span className="text-red-500">*</span>
            </span>
            <input
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="input mt-1.5"
              placeholder="Brief summary of the issue"
              autoFocus
            />
          </label>

          <label className="block">
            <span className="text-sm font-medium text-text-primary">
              Description <span className="text-red-500">*</span>
            </span>
            <textarea
              required
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={5}
              className="input mt-1.5"
              placeholder="What happened? What were you trying to do? Steps to reproduce if you know them."
            />
          </label>

          <div>
            <span className="text-sm font-medium text-text-primary block mb-1.5">
              Screenshot{' '}
              <span className="text-text-secondary text-xs font-normal">(optional)</span>
            </span>
            {imagePreview ? (
              <div className="relative inline-block">
                <img
                  src={imagePreview}
                  alt="Preview"
                  className="max-h-40 rounded-lg border border-border object-contain"
                />
                <button
                  type="button"
                  onClick={removeImage}
                  className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-red-500 text-white flex items-center justify-center hover:bg-red-600 transition-colors"
                >
                  <X size={11} />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="flex items-center gap-2 px-3 py-2 border border-dashed border-border rounded-lg text-sm text-text-secondary hover:border-navy/40 hover:text-navy transition-colors"
              >
                <ImagePlus size={15} />
                Attach a screenshot
              </button>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              onChange={handleImageChange}
              className="hidden"
            />
          </div>

          {error && (
            <div className="p-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
              {error}
            </div>
          )}

          <div className="flex items-center justify-between pt-3 border-t border-border">
            <span className="text-[11px] text-text-secondary font-mono">
              Page: {pageUrl}
            </span>
            <div className="flex gap-2">
              <button type="button" onClick={handleClose} className="btn-secondary text-sm">
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting || !title.trim() || !body.trim()}
                className="btn-primary text-sm disabled:opacity-50 flex items-center gap-1.5"
              >
                {submitting && <Loader2 size={14} className="animate-spin" />}
                {submitting ? 'Submitting…' : 'Submit Report'}
              </button>
            </div>
          </div>
        </form>
      )}
    </Modal>
  );
}
