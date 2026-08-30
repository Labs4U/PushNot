import { useState, useEffect } from 'react';
import { Authenticator } from '@aws-amplify/ui-react';
import { generateClient } from 'aws-amplify/data';
import type { Schema } from '../amplify/data/resource';
import './App.css';
import MessagesView from './components/MessagesView';
import CampaignsView from './components/CampaignsView';
import AnalyticsView from './components/AnalyticsView';
import BillsView from './components/BillsView';
import SettingsView from './components/SettingsView';

const client = generateClient<Schema>();

// Placeholder value written to all string fields on a first-time profile creation.
// A future "Setup" tab will let the admin replace these with real values.
const PENDING_SETUP = 'PENDING_SETUP';

/**
 * DynamoDB rejects create() with a conditional check failure when the item
 * already exists (implicit attribute_not_exists guard on PutItem).
 * This is a success state — the record is confirmed to be present.
 * Amplify can surface this either as an errors[] entry or a thrown exception.
 */
function isConditionalCheckFailure(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('conditional') || lower.includes('conditioncheck');
}

// ─── Root: mounts the Amplify-hosted login screen ────────────────────────────

export default function App() {
  return (
    <Authenticator>
      {({ signOut, user }) => (
        <AppShell
          userId={user?.userId ?? ''}
          userEmail={user?.signInDetails?.loginId ?? ''}
          signOut={signOut}
        />
      )}
    </Authenticator>
  );
}

// ─── Profile verification states ─────────────────────────────────────────────

type ProfileStatus = 'checking' | 'ready' | 'error';

// ─── AppShell: runs profile probe on mount, then renders the dashboard ────────

interface AppShellProps {
  userId: string;
  userEmail: string;
  signOut?: () => void;
}

function AppShell({ userId, userEmail, signOut }: AppShellProps) {
  const [activeTab, setActiveTab] = useState<'messages' | 'campaigns' | 'analytics' | 'bills' | 'settings'>('messages');
  const [profileStatus, setProfileStatus] = useState<ProfileStatus>('checking');
  const [profileError, setProfileError] = useState<string>('');

  // associationId is the DynamoDB partition key for this tenant.
  // It is derived from the Cognito sub so each admin is fully isolated.
  const associationId = `ASSOC#${userId}`;

  // ── Profile probe: runs once when the authenticated userId is available ──
  useEffect(() => {
    if (!userId) return; // Guard: userId arrives from Amplify synchronously, but be safe

    async function verifyOrProvisionProfile() {
      setProfileStatus('checking');
      try {
        // Optimistic upsert: attempt create() directly.
        // If the record already exists, DynamoDB returns ConditionalCheckFailedException
        // (HTTP 400). We catch that and treat it as confirmation the profile is present.
        // This is race-condition-safe and auth-mode-mismatch-safe.
        const { errors: createErrors } = await client.models.PushNotSystem.create(
          {
            pk: associationId,
            sk: 'PROFILE',
            entityType: 'ADMIN_PROFILE',
            name:         PENDING_SETUP,
            phone:        PENDING_SETUP,
            address:      PENDING_SETUP,
            contactEmail: PENDING_SETUP,
          },
          { authMode: 'userPool' }
        );

        if (createErrors && createErrors.length > 0) {
          const errorMessage = createErrors.map((e: any) => e.message).join('; ');
          if (isConditionalCheckFailure(errorMessage)) {
            // Record already exists — treat as success
            console.log(`✅ Profile already exists for ${associationId} (conditional check)`);
            setProfileStatus('ready');
            return;
          }
          throw new Error(errorMessage);
        }

        console.log(`✅ Placeholder profile created for ${associationId}`);
        setProfileStatus('ready');

      } catch (err: any) {
        const msg = err.message ?? '';
        if (isConditionalCheckFailure(msg)) {
          // Amplify surfaced the conditional failure as a thrown exception
          console.log(`✅ Profile already exists for ${associationId} (exception path)`);
          setProfileStatus('ready');
          return;
        }
        console.error('❌ Profile verification failed:', msg || err);
        setProfileError(msg || 'Unknown error during profile setup.');
        setProfileStatus('error');
      }
    }

    verifyOrProvisionProfile();
  }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps
  // associationId is deterministically derived from userId — no additional dep needed

  // ── Render: gate the dashboard behind the profile check ──────────────────
  if (profileStatus === 'checking') {
    return (
      <div className="profile-gate">
        <div className="profile-gate-card">
          <div className="profile-gate-spinner" />
          <p className="profile-gate-text">Verifying your account…</p>
        </div>
      </div>
    );
  }

  if (profileStatus === 'error') {
    return (
      <div className="profile-gate">
        <div className="profile-gate-card profile-gate-card--error">
          <p className="profile-gate-title">Setup Failed</p>
          <p className="profile-gate-text">{profileError}</p>
          <button
            className="btn-sign-out"
            style={{ marginTop: '16px' }}
            onClick={signOut}
          >
            Sign Out &amp; Retry
          </button>
        </div>
      </div>
    );
  }

  // profileStatus === 'ready' — full dashboard
  return (
    <div className="app">
      {/* ── Header ── */}
      <div className="app-header">
        <div className="app-title">📢 Push Notification Dashboard</div>

        <nav className="tab-nav">
          <button
            className={`tab-button ${activeTab === 'messages' ? 'active' : ''}`}
            onClick={() => setActiveTab('messages')}
          >
            Messages
          </button>
          <button
            className={`tab-button ${activeTab === 'campaigns' ? 'active' : ''}`}
            onClick={() => setActiveTab('campaigns')}
          >
            Campaigns
          </button>
          <button
            className={`tab-button ${activeTab === 'analytics' ? 'active' : ''}`}
            onClick={() => setActiveTab('analytics')}
          >
            Analytics
          </button>
          <button
            className={`tab-button ${activeTab === 'bills' ? 'active' : ''}`}
            onClick={() => setActiveTab('bills')}
          >
            Billing
          </button>

          {/* Separator + Settings — visually distinct from operational tabs */}
          <span style={{ width: '1px', backgroundColor: '#334155', margin: '12px 4px', alignSelf: 'stretch', flexShrink: 0 }} />
          <button
            className={`tab-button ${activeTab === 'settings' ? 'active' : ''}`}
            onClick={() => setActiveTab('settings')}
            title="Association Settings"
          >
            ⚙️ Settings
          </button>
        </nav>

        {/* User identity + Sign Out */}
        <div className="header-user-section">
          {userEmail && (
            <span className="header-user-email" title={associationId}>
              {userEmail}
            </span>
          )}
          <button className="btn-sign-out" onClick={signOut}>
            Sign Out
          </button>
        </div>
      </div>

      {/* ── Main Content ── */}
      <div className="app-content">
        <div className="view-container">
          {activeTab === 'messages'  && <MessagesView  associationId={associationId} />}
          {activeTab === 'campaigns' && <CampaignsView associationId={associationId} />}
          {activeTab === 'analytics' && <AnalyticsView associationId={associationId} />}
          {activeTab === 'bills'     && <BillsView     associationId={associationId} />}
          {activeTab === 'settings'  && <SettingsView  associationId={associationId} />}
        </div>
      </div>
    </div>
  );
}
