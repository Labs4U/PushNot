import { useState, useEffect } from 'react';
import { generateClient } from 'aws-amplify/data';
import type { Schema } from '../../amplify/data/resource';

const client = generateClient<Schema>();

// Sentinel written during auto-provisioning. Displayed as empty in the form
// so the admin sees a blank field rather than a confusing placeholder string.
const PENDING_SETUP = 'PENDING_SETUP';

function fromDb(value: string | null | undefined): string {
  if (!value || value === PENDING_SETUP) return '';
  return value;
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface SettingsViewProps {
  associationId: string; // e.g. "ASSOC#<cognitoSub>"
}

interface ProfileForm {
  name:         string;
  phone:        string;
  address:      string;
  contactEmail: string;
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

// ─── Component ───────────────────────────────────────────────────────────────

export default function SettingsView({ associationId }: SettingsViewProps) {
  const [form, setForm]           = useState<ProfileForm>({ name: '', phone: '', address: '', contactEmail: '' });
  const [loading, setLoading]     = useState(true);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [saveError, setSaveError] = useState('');

  // ── Fetch existing profile on mount ──────────────────────────────────────
  useEffect(() => {
    async function loadProfile() {
      setLoading(true);
      try {
        const { data, errors } = await client.models.PushNotSystem.get(
          { pk: associationId, sk: 'PROFILE' },
          { authMode: 'userPool' }
        );

        if (errors && errors.length > 0) {
          console.error('❌ Failed to load profile:', errors);
        }

        if (data) {
          setForm({
            name:         fromDb(data.name),
            phone:        fromDb(data.phone),
            address:      fromDb(data.address),
            contactEmail: fromDb(data.contactEmail),
          });
        }
      } catch (err: any) {
        console.error('❌ Profile load exception:', err.message ?? err);
      } finally {
        setLoading(false);
      }
    }

    loadProfile();
  }, [associationId]);

  // ── Field change handler ──────────────────────────────────────────────────
  function handleChange(field: keyof ProfileForm, value: string) {
    setSaveStatus('idle'); // clear previous save feedback on any edit
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  // ── Save handler ──────────────────────────────────────────────────────────
  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaveStatus('saving');
    setSaveError('');

    try {
      const { errors } = await client.models.PushNotSystem.update(
        {
          // Composite key — required by Amplify to target the correct record
          pk: associationId,
          sk: 'PROFILE',
          // Write PENDING_SETUP for any field left blank so the record stays
          // consistent; the form will render blank again on next load.
          name:         form.name.trim()         || PENDING_SETUP,
          phone:        form.phone.trim()        || PENDING_SETUP,
          address:      form.address.trim()      || PENDING_SETUP,
          contactEmail: form.contactEmail.trim() || PENDING_SETUP,
        },
        { authMode: 'userPool' }
      );

      if (errors && errors.length > 0) {
        throw new Error(errors.map((e) => e.message).join('; '));
      }

      setSaveStatus('saved');
      // Auto-clear the success badge after 3 s
      setTimeout(() => setSaveStatus('idle'), 3000);

    } catch (err: any) {
      console.error('❌ Profile save failed:', err.message ?? err);
      setSaveError(err.message ?? 'An unexpected error occurred. Please try again.');
      setSaveStatus('error');
    }
  }

  // ── Derived: are any fields still un-configured? ──────────────────────────
  const hasPendingFields =
    !form.name.trim() ||
    !form.phone.trim() ||
    !form.address.trim() ||
    !form.contactEmail.trim();

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="view-single-col" style={{ overflowY: 'auto' }}>

      {/* ── Page heading ── */}
      <div style={{ flexShrink: 0 }}>
        <h2 style={{ margin: 0, fontSize: '20px', fontWeight: 700, color: '#f1f5f9' }}>
          ⚙️ Association Settings
        </h2>
        <p style={{ margin: '6px 0 0', fontSize: '13px', color: '#64748b' }}>
          Tenant: <code style={{ color: '#94a3b8', fontSize: '12px' }}>{associationId}</code>
        </p>
      </div>

      {/* ── Pending-setup banner ── */}
      {!loading && hasPendingFields && (
        <div style={{
          padding: '12px 16px',
          borderRadius: '6px',
          backgroundColor: 'rgba(251, 146, 60, 0.08)',
          border: '1px solid rgba(251, 146, 60, 0.35)',
          color: '#fbbf24',
          fontSize: '13px',
          flexShrink: 0,
        }}>
          ⚠️ Some fields are still set to the auto-provisioned placeholder. Fill them in below so your campaigns display the correct association details.
        </div>
      )}

      {/* ── Profile form ── */}
      <div className="panel" style={{ flex: '0 0 auto', overflow: 'visible' }}>
        <h3 style={{ margin: '0 0 20px', fontSize: '15px', fontWeight: 600, color: '#f1f5f9' }}>
          Association Profile
        </h3>

        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', color: '#94a3b8', fontSize: '14px', padding: '8px 0' }}>
            <div className="profile-gate-spinner" style={{ width: '20px', height: '20px', borderWidth: '2px' }} />
            Loading profile…
          </div>
        ) : (
          <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

            {/* 2-column grid on desktop, stacked on mobile */}
            <div className="form-grid-3col" style={{ gridTemplateColumns: '1fr 1fr' }}>

              {/* Association / Organisation Name */}
              <div>
                <label htmlFor="settings-name">Organisation Name</label>
                <input
                  id="settings-name"
                  type="text"
                  placeholder="e.g. Al Noor Association"
                  value={form.name}
                  onChange={(e) => handleChange('name', e.target.value)}
                  disabled={saveStatus === 'saving'}
                />
              </div>

              {/* WhatsApp Contact Phone */}
              <div>
                <label htmlFor="settings-phone">WhatsApp Phone Number</label>
                <input
                  id="settings-phone"
                  type="text"
                  placeholder="e.g. +97336xxxxxx"
                  value={form.phone}
                  onChange={(e) => handleChange('phone', e.target.value)}
                  disabled={saveStatus === 'saving'}
                />
              </div>

              {/* Contact Email */}
              <div>
                <label htmlFor="settings-email">Contact Email</label>
                <input
                  id="settings-email"
                  type="text"
                  placeholder="e.g. admin@association.org"
                  value={form.contactEmail}
                  onChange={(e) => handleChange('contactEmail', e.target.value)}
                  disabled={saveStatus === 'saving'}
                />
              </div>

              {/* Address / Region */}
              <div>
                <label htmlFor="settings-address">Address / Region</label>
                <input
                  id="settings-address"
                  type="text"
                  placeholder="e.g. Manama, Bahrain"
                  value={form.address}
                  onChange={(e) => handleChange('address', e.target.value)}
                  disabled={saveStatus === 'saving'}
                />
              </div>
            </div>

            {/* ── Save feedback ── */}
            {saveStatus === 'saved' && (
              <div style={{
                padding: '10px 14px',
                borderRadius: '6px',
                backgroundColor: 'rgba(16, 185, 129, 0.08)',
                border: '1px solid rgba(16, 185, 129, 0.35)',
                color: '#34d399',
                fontSize: '13px',
                fontWeight: 500,
              }}>
                ✓ Profile saved successfully.
              </div>
            )}

            {saveStatus === 'error' && (
              <div style={{
                padding: '10px 14px',
                borderRadius: '6px',
                backgroundColor: 'rgba(239, 68, 68, 0.08)',
                border: '1px solid rgba(239, 68, 68, 0.35)',
                color: '#f87171',
                fontSize: '13px',
                fontWeight: 500,
              }}>
                ✗ {saveError}
              </div>
            )}

            {/* ── Submit ── */}
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                type="submit"
                className="btn-submit"
                disabled={saveStatus === 'saving'}
                style={{ width: 'auto', minWidth: '160px' }}
              >
                {saveStatus === 'saving' ? (
                  <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                    <span
                      style={{
                        display: 'inline-block',
                        width: '14px', height: '14px',
                        border: '2px solid rgba(241,245,249,0.3)',
                        borderTopColor: '#f1f5f9',
                        borderRadius: '50%',
                        animation: 'spin 0.8s linear infinite',
                      }}
                    />
                    Saving…
                  </span>
                ) : 'Save Profile'}
              </button>
            </div>

          </form>
        )}
      </div>

      {/* ── Read-only info panel ── */}
      <div className="panel" style={{ flex: '0 0 auto' }}>
        <h3 style={{ margin: '0 0 14px', fontSize: '14px', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          Account Information
        </h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <InfoRow label="Tenant ID (pk)" value={associationId} mono />
          <InfoRow label="Profile Record (sk)" value="PROFILE" mono />
          <InfoRow label="Entity Type" value="ADMIN_PROFILE" mono />
        </div>
      </div>

    </div>
  );
}

// ─── Small read-only display row ─────────────────────────────────────────────

function InfoRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: '12px' }}>
      <span style={{ fontSize: '12px', fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px', minWidth: '160px', flexShrink: 0 }}>
        {label}
      </span>
      <span style={{ fontSize: '13px', color: '#94a3b8', fontFamily: mono ? 'monospace' : 'inherit' }}>
        {value}
      </span>
    </div>
  );
}
