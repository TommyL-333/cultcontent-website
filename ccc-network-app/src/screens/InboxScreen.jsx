import { useEffect, useRef, useState } from 'react';
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';
import { Avatar, Button, Card } from '@heroui/react';
import Topbar from '../components/Topbar';
import { getInbox, getThread, sendMessageTo } from '../api';
import { initialsOf, colorOf, displayName } from '../lib/avatar';

const POLL_MS = 4000;

function ConversationRow({ c, active, onClick }) {
  return (
    <div
      onClick={onClick}
      className={`flex items-center gap-3 p-3 rounded-lg cursor-pointer transition-colors ${active ? 'bg-secondary' : 'hover:bg-secondary/60'}`}
    >
      <Avatar color={colorOf(c)} size="sm"><Avatar.Fallback>{initialsOf(c)}</Avatar.Fallback></Avatar>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-bold truncate flex items-center gap-2">
          {displayName(c)}
          {c.unread > 0 && <span className="inline-flex items-center justify-center min-w-[16px] h-[16px] px-1 rounded-full bg-primary text-primary-foreground text-[9px] font-bold">{c.unread}</span>}
        </div>
        <div className="text-xs text-zinc-500 truncate">{c.lastMessage ? `${c.lastMessage.fromMe ? 'You: ' : ''}${c.lastMessage.body}` : 'Say hi — no messages yet'}</div>
      </div>
    </div>
  );
}

export default function InboxScreen({ person }) {
  const { uuid } = useParams();
  const navigate = useNavigate();
  const [conversations, setConversations] = useState(null);
  const [thread, setThread] = useState(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const bottomRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    const poll = () => getInbox().then((j) => { if (!cancelled && j.ok) setConversations(j.conversations); });
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  useEffect(() => {
    if (!uuid) { setThread(null); return undefined; }
    let cancelled = false;
    const poll = () => getThread(uuid).then((j) => { if (!cancelled && j.ok) setThread(j); });
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [uuid]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [thread?.messages?.length]);

  async function handleSend(e) {
    e.preventDefault();
    const body = draft.trim();
    if (!body) return;
    setSending(true);
    setDraft('');
    const j = await sendMessageTo(uuid, body);
    setSending(false);
    if (j.ok) {
      getThread(uuid).then((t) => t.ok && setThread(t));
      getInbox().then((c) => c.ok && setConversations(c.conversations));
    }
  }

  return (
    <div>
      <Topbar person={person} />
      <div className="max-w-4xl mx-auto px-5 pb-20">
        <h1 className="text-3xl font-extrabold tracking-tight mb-5">Inbox</h1>
        <div className="grid grid-cols-1 md:grid-cols-[280px_1fr] gap-5">
          <div className={`${uuid ? 'hidden md:block' : ''}`}>
            {conversations === null ? (
              <div className="text-sm text-zinc-500 py-6 text-center">Loading…</div>
            ) : conversations.length === 0 ? (
              <div className="text-sm text-zinc-500 py-6 text-center">No conversations yet — connect with someone first.</div>
            ) : (
              <div className="flex flex-col gap-1">
                {conversations.map((c) => (
                  <ConversationRow key={c.uuid} c={c} active={c.uuid === uuid} onClick={() => navigate(`/inbox/${c.uuid}`)} />
                ))}
              </div>
            )}
          </div>

          <div className={uuid ? '' : 'hidden md:flex md:items-center md:justify-center'}>
            {!uuid ? (
              <div className="text-sm text-zinc-500">Pick a conversation to start messaging.</div>
            ) : !thread ? (
              <div className="text-sm text-zinc-500 py-6 text-center">Loading…</div>
            ) : (
              <Card variant="default" className="flex flex-col h-[70vh]">
                <div className="flex items-center gap-3 p-4 border-b border-border">
                  <RouterLink to="/inbox" className="md:hidden text-zinc-400 hover:text-foreground">&larr;</RouterLink>
                  <Avatar color={colorOf(thread.otherPerson)} size="sm"><Avatar.Fallback>{initialsOf(thread.otherPerson)}</Avatar.Fallback></Avatar>
                  <RouterLink to={`/people/${uuid}`} className="text-sm font-bold hover:text-primary transition-colors">{displayName(thread.otherPerson)}</RouterLink>
                </div>
                <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2.5">
                  {thread.messages.length === 0 && <div className="text-sm text-zinc-500 text-center py-6">No messages yet — say hi.</div>}
                  {thread.messages.map((m) => {
                    const fromMe = m.from_person_id === person?.id;
                    return (
                      <div key={m.id} className={`max-w-[75%] px-3.5 py-2 rounded-lg text-sm ${fromMe ? 'self-end bg-primary text-primary-foreground' : 'self-start bg-secondary text-foreground'}`}>
                        {m.body}
                      </div>
                    );
                  })}
                  <div ref={bottomRef} />
                </div>
                <form onSubmit={handleSend} className="flex items-center gap-2 p-3 border-t border-border">
                  <input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="Write a message…"
                    className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  <Button type="submit" variant="primary" size="sm" isDisabled={sending || !draft.trim()}>Send</Button>
                </form>
              </Card>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
