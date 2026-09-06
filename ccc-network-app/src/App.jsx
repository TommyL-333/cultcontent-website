import { useCallback, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Toaster } from 'sonner';
import { me } from './api';
import SignupScreen from './screens/SignupScreen';
import LoginScreen from './screens/LoginScreen';
import HomeScreen from './screens/HomeScreen';
import ProfileScreen from './screens/ProfileScreen';
import SettingsScreen from './screens/SettingsScreen';
import DirectoryScreen from './screens/DirectoryScreen';
import ConnectionsScreen from './screens/ConnectionsScreen';
import PersonProfileScreen from './screens/PersonProfileScreen';
import InboxScreen from './screens/InboxScreen';
import ScheduleScreen from './screens/ScheduleScreen';
import MapScreen from './screens/MapScreen';
import ChallengesScreen from './screens/ChallengesScreen';
import TermsScreen from './screens/TermsScreen';

// Client-side routing only decides *which screen to show* — it is not the
// security boundary. Every protected API call (directory.json, connect,
// connections, people/:uuid, inbox, messages, settings/*) still runs
// through requireNetworkSession on the server, unchanged from v1.
export default function App() {
  const [person, setPerson] = useState(undefined); // undefined = still loading

  const refresh = useCallback(async () => {
    setPerson(await me());
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  if (person === undefined) {
    return <div className="min-h-screen flex items-center justify-center text-sm text-zinc-500">Loading…</div>;
  }

  return (
    <BrowserRouter basename="/ccc-network">
      <Toaster theme="dark" richColors position="top-center" />
      <Routes>
        <Route path="/" element={person ? <Navigate to="/home" replace /> : <SignupScreen />} />
        <Route path="/login" element={person ? <Navigate to="/home" replace /> : <LoginScreen />} />
        <Route path="/home" element={person ? <HomeScreen person={person} /> : <Navigate to="/login" replace />} />
        <Route path="/directory" element={person ? <DirectoryScreen person={person} /> : <Navigate to="/login" replace />} />
        <Route path="/connections" element={person ? <ConnectionsScreen person={person} /> : <Navigate to="/login" replace />} />
        <Route path="/people/:uuid" element={person ? <PersonProfileScreen person={person} /> : <Navigate to="/login" replace />} />
        <Route path="/inbox" element={person ? <InboxScreen person={person} /> : <Navigate to="/login" replace />} />
        <Route path="/inbox/:uuid" element={person ? <InboxScreen person={person} /> : <Navigate to="/login" replace />} />
        <Route path="/schedule" element={person ? <ScheduleScreen person={person} /> : <Navigate to="/login" replace />} />
        <Route path="/map" element={person ? <MapScreen person={person} /> : <Navigate to="/login" replace />} />
        <Route path="/challenges" element={person ? <ChallengesScreen person={person} /> : <Navigate to="/login" replace />} />
        {/* Public — has to be readable before you agree to it on the signup form. */}
        <Route path="/terms" element={<TermsScreen />} />
        <Route path="/profile" element={person ? <ProfileScreen person={person} /> : <Navigate to="/login" replace />} />
        <Route path="/settings" element={person ? <SettingsScreen person={person} onSaved={refresh} /> : <Navigate to="/login" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
