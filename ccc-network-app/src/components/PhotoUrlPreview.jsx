import { useEffect, useState } from 'react';

/**
 * Live preview for the profile-photo URL field.
 *
 * The previous version hid itself on error, which meant pasting a link that
 * isn't a direct image — a Drive share page, a Dropbox page, a LinkedIn
 * profile — looked exactly like pasting nothing. You saved, saw no photo, and
 * had no way to tell whether it hadn't saved or hadn't loaded.
 *
 * Loads on a debounce so it isn't firing a request per keystroke.
 */
export default function PhotoUrlPreview({ url }) {
  const [state, setState] = useState('idle'); // idle | loading | ok | error
  const [shown, setShown] = useState('');

  useEffect(() => {
    const trimmed = (url || '').trim();
    if (!trimmed) { setState('idle'); setShown(''); return undefined; }
    setState('loading');
    const t = setTimeout(() => setShown(trimmed), 500);
    return () => clearTimeout(t);
  }, [url]);

  if (state === 'idle') return null;

  return (
    <div className="mt-2.5 flex items-start gap-3">
      <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-full border border-border bg-card">
        {shown && (
          <img
            key={shown}
            src={shown}
            alt=""
            className="h-full w-full object-cover"
            onLoad={() => setState('ok')}
            onError={() => setState('error')}
            style={{ visibility: state === 'ok' ? 'visible' : 'hidden' }}
          />
        )}
      </div>

      <div className="min-w-0 flex-1 pt-1">
        {state === 'loading' && <p className="text-xs text-muted-foreground">Checking that link…</p>}
        {state === 'ok' && (
          <p className="text-xs font-semibold" style={{ color: 'var(--color-accent-2)' }}>
            Looks good — this is what people will see.
          </p>
        )}
        {state === 'error' && (
          <>
            <p className="text-xs font-semibold" style={{ color: 'var(--color-accent)' }}>
              That link didn&rsquo;t load as an image.
            </p>
            <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">
              It needs to point straight at the image file, not at a page showing it. In most apps:
              right-click the photo &rarr; <em>Copy image address</em>. A link ending in .jpg or .png is
              usually right. Private or sign-in-only files won&rsquo;t load for anyone else either.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
