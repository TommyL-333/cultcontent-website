import { useEffect, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { Avatar, Dropdown } from '@heroui/react';
import { getInbox } from '../api';
import { initialsOf, colorOf } from '../lib/avatar';

const navLinkCls = ({ isActive }) => `text-[13px] font-medium transition-colors ${isActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`;

export default function Topbar({ person }) {
  const navigate = useNavigate();
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const poll = () => getInbox().then((j) => { if (!cancelled && j.ok) setUnread(j.unread); }).catch(() => {});
    poll();
    const id = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  function handleMenuAction(key) {
    if (key === 'profile') navigate('/profile');
    else if (key === 'settings') navigate('/settings');
    else if (key === 'logout') window.location.href = '/ccc-network/logout';
  }

  return (
    <div className="max-w-3xl mx-auto flex items-center justify-between px-5 py-5 gap-4">
      <Dropdown>
        <Dropdown.Trigger>
          <button type="button" aria-label="Account menu" className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <Avatar color={colorOf(person)} size="sm">
              <Avatar.Fallback>{initialsOf(person)}</Avatar.Fallback>
            </Avatar>
          </button>
        </Dropdown.Trigger>
        <Dropdown.Popover>
          <Dropdown.Menu onAction={handleMenuAction}>
            <Dropdown.Item id="profile">View Profile</Dropdown.Item>
            <Dropdown.Item id="settings">Settings</Dropdown.Item>
            <Dropdown.Item id="logout">Log out</Dropdown.Item>
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>

      <div className="flex items-center gap-5">
        <NavLink to="/home" className={navLinkCls}>Home</NavLink>
        <NavLink to="/directory" className={navLinkCls}>Directory</NavLink>
        <NavLink to="/connections" className={navLinkCls}>Connections</NavLink>
        <NavLink to="/inbox" className={navLinkCls}>
          Inbox{unread > 0 && <span className="ml-1.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-primary text-primary-foreground text-[10px] font-bold">{unread}</span>}
        </NavLink>
      </div>
    </div>
  );
}
