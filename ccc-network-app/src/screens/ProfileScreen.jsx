import { useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { Button, Card } from '@heroui/react';
import Topbar from '../components/Topbar';
import PersonDetailCard from '../components/PersonDetailCard';

export default function ProfileScreen({ person }) {
  const [showQR, setShowQR] = useState(false);
  const profileUrl = `${window.location.origin}/ccc-network/people/${person.uuid}`;

  return (
    <div>
      <Topbar person={person} />
      <div className="max-w-2xl mx-auto px-5 pb-20">
        <h1 className="font-display text-3xl font-bold mb-2">Your profile</h1>
        <p className="text-sm text-muted-foreground mb-7">This is what the rest of the roster sees once you&rsquo;re connected. Edit it any time in Settings.</p>

        <PersonDetailCard
          person={person}
          contactLabel="Your contact info"
          showCheckmark={false}
          actions={<RouterLink to="/settings"><Button variant="outline">Edit in Settings</Button></RouterLink>}
        />

        <Card variant="default" className="p-6 sm:p-7 mt-5 text-center">
          <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-3">Meet in person</div>
          {showQR ? (
            <div className="flex flex-col items-center gap-4">
              <div className="bg-white p-4 rounded-lg inline-block">
                <QRCodeSVG value={profileUrl} size={180} />
              </div>
              <p className="text-xs text-muted-foreground max-w-xs">Have someone scan this to pull up your profile and connect on the spot.</p>
              <Button variant="outline" size="sm" onPress={() => setShowQR(false)}>Hide QR code</Button>
            </div>
          ) : (
            <Button variant="primary" onPress={() => setShowQR(true)}>Show my QR code</Button>
          )}
        </Card>
      </div>
    </div>
  );
}
