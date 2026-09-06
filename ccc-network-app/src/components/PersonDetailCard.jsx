import { Card, Chip } from '@heroui/react';
import ProfilePhoto from './ProfilePhoto';
import { displayName, orgOf } from '../lib/avatar';
import { zoneLabel } from '../lib/booth-zones';

// Shared full-profile presentation — used by both the read-only ProfileScreen
// (viewing yourself) and PersonProfileScreen (viewing someone else via the
// directory or a scanned QR code). `person` may or may not include
// email/phone depending on connection state; this just renders whatever's there.
export default function PersonDetailCard({ person, actions, extra, contactLabel = 'Connected — here’s their info', showCheckmark = true }) {
  const org = orgOf(person);
  return (
    <Card variant="default" className="p-6 sm:p-8">
      <div className="flex items-start gap-4 mb-5">
        <ProfilePhoto person={person} size="lg" />
        <div className="flex-1 min-w-0">
          <Chip color={person.role === 'brand' ? 'warning' : 'accent'} size="sm">{person.role === 'brand' ? 'Brand' : 'Creator'}</Chip>
          <div className="text-xl font-bold mt-2">{displayName(person)}</div>
          {org && <div className="text-sm text-muted-foreground">{org}</div>}
          {person.category && <div className="text-xs text-muted-foreground mt-0.5">{person.category}</div>}
          {person.role === 'brand' && zoneLabel(person) && (
            <div className="mt-1.5 inline-flex items-center gap-1.5 text-xs font-bold" style={{ color: 'var(--color-gold)' }}>
              <span aria-hidden>📍</span>{zoneLabel(person)}
            </div>
          )}
        </div>
      </div>

      {person.bio && (
        <div className="mb-4">
          <div className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground mb-1.5">Bio</div>
          <div className="text-sm text-foreground leading-relaxed">{person.bio}</div>
        </div>
      )}

      {person.looking_for && (
        <div className="mb-4">
          <div className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground mb-1.5">Looking for</div>
          <div className="text-sm text-foreground leading-relaxed">{person.looking_for}</div>
        </div>
      )}

      {person.links?.length > 0 && (
        <div className="mb-4">
          <div className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground mb-1.5">Links</div>
          <div className="flex flex-col gap-1">
            {person.links.map((l, i) => (
              <a key={i} href={l.url} target="_blank" rel="noreferrer" className="text-sm text-primary hover:underline truncate">{l.url}</a>
            ))}
          </div>
        </div>
      )}

      {(person.rate_price || person.rate_videos || person.rate_terms) && (
        <div className="mb-4 rounded-md border border-border bg-background/40 px-4 py-3.5">
          <div className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground mb-2">Rates &amp; terms</div>
          {person.rate_price && (
            <div className="text-sm text-foreground mb-1">Rate: <span className="font-semibold">{person.rate_price}</span></div>
          )}
          {person.rate_videos && (
            <div className="text-sm text-foreground mb-1">Typical package: <span className="font-semibold">{person.rate_videos}</span></div>
          )}
          {person.rate_terms && (
            <div className="text-sm text-foreground/85 leading-relaxed mt-1.5">{person.rate_terms}</div>
          )}
          <p className="text-[11px] text-muted-foreground mt-2.5">A starting point, not a quote — agree the details between yourselves.</p>
        </div>
      )}

      {person.email && (
        <div className="mb-4 rounded-md border border-accent-2/40 bg-accent-2/10 px-4 py-3">
          <div className="flex items-center gap-1.5 text-accent-2 font-bold text-sm mb-1.5">{showCheckmark && <span>✓</span>}<span>{contactLabel}</span></div>
          <div className="text-sm text-foreground">Email: <span className="font-medium">{person.email}</span></div>
          {person.phone && <div className="text-sm text-foreground">Phone: <span className="font-medium">{person.phone}</span></div>}
        </div>
      )}

      {extra}
      {actions && <div className="flex flex-wrap items-center gap-3 mt-2">{actions}</div>}
    </Card>
  );
}
