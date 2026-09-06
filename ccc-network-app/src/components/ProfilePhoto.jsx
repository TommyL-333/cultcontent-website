import { useState } from 'react';
import { Avatar } from '@heroui/react';
import { initialsOf, colorOf } from '../lib/avatar';

/**
 * A member's photo, falling back to the existing initials avatar.
 *
 * photo_url is a link the member pastes in themselves, so it can 404, be
 * hotlink-blocked, or stop resolving at any point. onError swaps back to
 * initials rather than leaving a broken-image icon in the directory.
 */
export default function ProfilePhoto({ person, size = 'md', className = '' }) {
  const [broken, setBroken] = useState(false);
  const px = { sm: 32, md: 48, lg: 72 }[size] ?? 48;

  if (person?.photo_url && !broken) {
    return (
      <img
        src={person.photo_url}
        alt=""
        width={px}
        height={px}
        loading="lazy"
        onError={() => setBroken(true)}
        className={`shrink-0 rounded-full object-cover bg-card ${className}`}
        style={{ width: px, height: px }}
      />
    );
  }

  return (
    <Avatar color={colorOf(person)} size={size === 'sm' ? 'sm' : 'md'} className={`shrink-0 ${className}`}>
      <Avatar.Fallback>{initialsOf(person)}</Avatar.Fallback>
    </Avatar>
  );
}
