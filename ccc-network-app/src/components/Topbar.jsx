import { Link as RouterLink } from 'react-router-dom';
import { Link } from '@heroui/react';

const navLinkCls = 'text-zinc-400 hover:text-zinc-100 transition-colors';

export default function Topbar({ person }) {
  const showExport = person.role === 'brand' && ['priority', 'executive'].includes(person.tier);
  return (
    <div className="max-w-3xl mx-auto flex items-center justify-between px-5 py-5">
      <a href="https://cultcontent.cc" className="flex items-center gap-2.5">
        <img
          src="https://assets.cdn.filesafe.space/c216j58Vx9XxYa7WYMiA/media/68529ceff63e1913ceb4e2e0.png"
          alt="Cult Content"
          className="h-5"
        />
        <span className="text-[11px] font-bold uppercase tracking-[.14em] text-zinc-400">Creator Carnival</span>
      </a>
      <div className="flex items-center gap-5 text-[13px] font-medium">
        <RouterLink to="/directory" className={navLinkCls}>Directory</RouterLink>
        <RouterLink to="/profile" className={navLinkCls}>My Profile</RouterLink>
        {showExport && <Link href="/ccc-network/contacts.csv" className={navLinkCls}>Export Contacts</Link>}
        <Link href="/ccc-network/logout" className={navLinkCls}>Log out</Link>
      </div>
    </div>
  );
}
