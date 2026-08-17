import { Avatar, Card, Chip } from '@heroui/react';
import { initialsOf, colorOf, displayName, orgOf } from '../lib/avatar';

// Shared full-profile presentation — used by both the read-only ProfileScreen
// (viewing yourself) and PersonProfileScreen (viewing someone else via the
// directory or a scanned QR code). `person` may or may not include
// email/phone depending on connection state; this just renders whatever's there.
export default function PersonDetailCard({ person, actions, extra, contactLabel = 'Connected — here’s their info', showCheckmark = true }) {
  const org = orgOf(person);
  return (
    <Card variant="default" className="p-6 sm:p-8">
      <div className="flex items-start gap-4 mb-5">
        <Avatar color={colorOf(person)} size="lg">
          <Avatar.Fallback>{initialsOf(person)}</Avatar.Fallback>
        </Avatar>
        <div className="flex-1 min-w-0">
          <Chip color={person.role === 'brand' ? 'warning' : 'accent'} size="sm">{person.role === 'brand' ? 'Brand' : 'Creator'}</Chip>
          <div className="text-xl font-bold mt-2">{displayName(person)}</div>
          {org && <div className="text-sm text-zinc-400">{org}</div>}
          {person.category && <div className="text-xs text-zinc-500 mt-0.5">{person.category}</div>}
        </div>
      </div>

      {person.bio && (
        <div className="mb-4">
          <div className="text-[11px] font-bold uppercase tracking-wide text-zinc-500 mb-1.5">Bio</div>
          <div className="text-sm text-zinc-200 leading-relaxed">{person.bio}</div>
        </div>
      )}

      {person.looking_for && (
        <div className="mb-4">
          <div className="text-[11px] font-bold uppercase tracking-wide text-zinc-500 mb-1.5">Looking for</div>
          <div className="text-sm text-zinc-200 leading-relaxed">{person.looking_for}</div>
        </div>
      )}

      {person.links?.length > 0 && (
        <div className="mb-4">
          <div className="text-[11px] font-bold uppercase tracking-wide text-zinc-500 mb-1.5">Links</div>
          <div className="flex flex-col gap-1">
            {person.links.map((l, i) => (
              <a key={i} href={l.url} target="_blank" rel="noreferrer" className="text-sm text-primary hover:underline truncate">{l.url}</a>
            ))}
          </div>
        </div>
      )}

      {person.email && (
        <div className="mb-4 rounded-md border border-cyan-400 bg-cyan-950 px-4 py-3">
          <div className="flex items-center gap-1.5 text-cyan-300 font-bold text-sm mb-1.5">{showCheckmark && <span>✓</span>}<span>{contactLabel}</span></div>
          <div className="text-sm text-zinc-100">Email: <span className="font-medium">{person.email}</span></div>
          {person.phone && <div className="text-sm text-zinc-100">Phone: <span className="font-medium">{person.phone}</span></div>}
        </div>
      )}

      {extra}
      {actions && <div className="flex flex-wrap items-center gap-3 mt-2">{actions}</div>}
    </Card>
  );
}
