import { useCallback, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { me } from './api';
import SignupScreen from './screens/SignupScreen';
import LoginScreen from './screens/LoginScreen';
import ProfileScreen from './screens/ProfileScreen';
import DirectoryScreen from './screens/DirectoryScreen';

// Client-side routing only decides *which screen to show* — it is not the
// security boundary. Every protected API call (directory.json, connect,
// contacts.csv, profile POST) still runs through requireNetworkSession on
// the server, unchanged from the previous server-rendered version.
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
      <Routes>
        <Route path="/" element={person ? <Navigate to="/directory" replace /> : <SignupScreen />} />
        <Route path="/login" element={person ? <Navigate to="/directory" replace /> : <LoginScreen />} />
        <Route path="/profile" element={person ? <ProfileScreen person={person} onSaved={refresh} /> : <Navigate to="/login" replace />} />
        <Route path="/directory" element={person ? <DirectoryScreen person={person} /> : <Navigate to="/login" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
