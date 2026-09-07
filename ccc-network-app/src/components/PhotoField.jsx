import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { uploadProfilePhoto } from '../api';
import PhotoUrlPreview from './PhotoUrlPreview';

const UPLOAD_ERRORS = {
  file_too_large: 'That image is too large — 8MB is the limit.',
  not_an_image: 'That file isn’t an image we can read. Try a JPG or PNG.',
  upload_failed: 'Upload failed. Try again.',
};

/**
 * Profile photo: upload a file, or paste a link.
 *
 * Upload leads because asking for a URL turned out to be a trap — a Drive or
 * Dropbox share link serves an HTML page rather than an image, so it saved
 * fine and then showed nothing. Pasting a link still works and is kept behind
 * a disclosure for anyone who already has a working one.
 */
export default function PhotoField({ value, onChange, isBrand }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [showLink, setShowLink] = useState(false);

  const uploaded = (value || '').startsWith('/uploads/ccc-avatars/');

  async function pick(e) {
    const file = e.target.files?.[0];
    e.target.value = ''; // so choosing the same file twice still fires
    if (!file) return;

    setBusy(true);
    const r = await uploadProfilePhoto(file);
    setBusy(false);
    if (!r.ok) return toast.error(UPLOAD_ERRORS[r.error] ?? 'Upload failed.');
    onChange(r.photo_url);
    toast.success('Photo updated.');
  }

  return (
    <div>
      <span className="block text-sm font-medium mb-2">
        {isBrand ? 'Logo or photo' : 'Headshot'}
      </span>

      <div className="flex items-center gap-3.5">
        {value ? (
          <img
            src={value}
            alt=""
            className="h-16 w-16 shrink-0 rounded-full object-cover border border-border bg-card"
          />
        ) : (
          <div className="h-16 w-16 shrink-0 rounded-full border border-dashed border-border" aria-hidden />
        )}

        <div className="min-w-0">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            className="rounded-lg px-4 py-2 text-sm font-extrabold disabled:opacity-50"
            style={{ background: 'var(--color-accent-2)', color: 'var(--color-accent-2-foreground)' }}
          >
            {busy ? 'Uploading…' : value ? 'Replace photo' : 'Upload a photo'}
          </button>
          <p className="text-[11px] text-muted-foreground mt-1.5">JPG or PNG, up to 8MB.</p>
        </div>

        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          onChange={pick}
          className="hidden"
          aria-label="Choose a photo to upload"
        />
      </div>

      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          className="mt-2.5 text-[11px] text-muted-foreground hover:text-foreground underline"
        >
          Remove photo
        </button>
      )}

      {/* Kept for anyone whose photo already lives somewhere that serves it
          properly — an Instagram CDN link, their own site. */}
      {!showLink ? (
        <button
          type="button"
          onClick={() => setShowLink(true)}
          className="block mt-2.5 text-[11px] text-muted-foreground hover:text-foreground underline"
        >
          or paste a link instead
        </button>
      ) : (
        <div className="mt-3">
          <input
            value={uploaded ? '' : value || ''}
            onChange={(e) => onChange(e.target.value)}
            placeholder="https://…"
            className="w-full rounded-lg border border-border bg-background px-3.5 py-2.5 text-sm focus:border-primary focus:outline-none"
          />
          <p className="text-[11px] text-muted-foreground mt-1.5 leading-relaxed">
            It has to point straight at the image file — right-click a photo and choose
            &ldquo;Copy image address&rdquo;. Drive and Dropbox share links are converted automatically.
          </p>
          {!uploaded && <PhotoUrlPreview url={value} />}
        </div>
      )}
    </div>
  );
}
