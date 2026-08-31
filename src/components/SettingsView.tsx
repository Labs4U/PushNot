import { useState, useEffect, useRef } from 'react';
import { generateClient } from 'aws-amplify/data';
import type { Schema } from '../../amplify/data/resource';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { fetchAuthSession } from 'aws-amplify/auth';

const client = generateClient<Schema>();

const PENDING_SETUP   = 'PENDING_SETUP';
const RAG_BUCKET      = 'push-notifications-bh';
const RAG_BUCKET_REGION = 'us-east-1';

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

type SaveStatus   = 'idle' | 'saving'    | 'saved'    | 'error';
type UploadStatus = 'idle' | 'uploading' | 'uploaded' | 'error';

// ─── Component ───────────────────────────────────────────────────────────────

export default function SettingsView({ associationId }: SettingsViewProps) {
  // ── Profile form state ────────────────────────────────────────────────────
  const [form,       setForm]       = useState<ProfileForm>({ name: '', phone: '', address: '', contactEmail: '' });
  const [loading,    setLoading]    = useState(true);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [saveError,  setSaveError]  = useState('');

  // ── Knowledge base upload state ───────────────────────────────────────────
  const [uploadStatus, setUploadStatus] = useState<UploadStatus>('idle');
  const [uploadError,  setUploadError]  = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── S3 key for this tenant's knowledge document ───────────────────────────
  // Format: ASSOC#<cognitoSub>/mission.txt  — matches chatAgent handler exactly
  const ragS3Key = `${associationId}/mission.txt`;

  // ── Fetch existing profile on mount ──────────────────────────────────────
  useEffect(() => {
    async function loadProfile() {
      setLoading(true);
      try {
        const { data, errors } = await client.models.PushNotSystem.get(
          { pk: associationId, sk: 'PROFILE' },
          { authMode: 'userPool' }
        );
        if (errors?.length) console.error('❌ Failed to load profile:', errors);
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

  // ── Profile field change ──────────────────────────────────────────────────
  function handleChange(field: keyof ProfileForm, value: string) {
    setSaveStatus('idle');
    setForm(prev => ({ ...prev, [field]: value }));
  }

  // ── Profile save ──────────────────────────────────────────────────────────
  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaveStatus('saving');
    setSaveError('');
    try {
      const { errors } = await client.models.PushNotSystem.update(
        {
          pk: associationId,
          sk: 'PROFILE',
          name:         form.name.trim()         || PENDING_SETUP,
          phone:        form.phone.trim()        || PENDING_SETUP,
          address:      form.address.trim()      || PENDING_SETUP,
          contactEmail: form.contactEmail.trim() || PENDING_SETUP,
        },
        { authMode: 'userPool' }
      );
      if (errors?.length) throw new Error(errors.map(e => e.message).join('; '));

      // ── Set gsi1pk = PHONE#<displayPhone> on the ADMIN_PROFILE record ────────
      // The webhook's Tier 3 resolver queries ByStatusOrWamid with this key:
      //   gsi1pk = PHONE#<display_phone_number>
      // Meta sends display_phone_number without a leading '+', so we store it
      // in the same format (no normalisation needed).
      const savedPhone = form.phone.trim();
      if (savedPhone && savedPhone !== PENDING_SETUP) {
        // Strip any leading '+' to match Meta's format in display_phone_number
        const metaPhone = savedPhone.startsWith('+') ? savedPhone.slice(1) : savedPhone;
        await client.models.PushNotSystem.update(
          {
            pk:     associationId,
            sk:     'PROFILE',
            gsi1pk: `PHONE#${metaPhone}`,
            // gsi1sk left as undefined — index only needs the hash key for this lookup
          },
          { authMode: 'userPool' }
        ).catch((err: any) => {
          // Non-fatal — the profile save succeeded; the GSI key is best-effort
          console.warn('⚠️ Failed to set gsi1pk on PROFILE:', err.message);
        });
      }

            setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 3000);
    } catch (err: any) {
      console.error('❌ Profile save failed:', err.message ?? err);
      setSaveError(err.message ?? 'An unexpected error occurred. Please try again.');
      setSaveStatus('error');
    }
  }

  // ── Knowledge base upload ─────────────────────────────────────────────────
  // Uses Cognito session credentials to PUT directly to the external S3 bucket.
  // The authenticated Cognito role has s3:PutObject on
  //   arn:aws:s3:::push-notifications-bh/ASSOC#*/mission.txt
  // (granted in amplify/backend.ts section E).
  async function handleMissionUpload(file: File) {
    if (!associationId) return;
    setUploadStatus('uploading');
    setUploadError('');
    try {
      const session     = await fetchAuthSession();
      const credentials = session.credentials;
      if (!credentials) throw new Error('No active session credentials — please sign out and back in.');

      const s3 = new S3Client({
        region: RAG_BUCKET_REGION,
        credentials: {
          accessKeyId:     credentials.accessKeyId,
          secretAccessKey: credentials.secretAccessKey,
          sessionToken:    credentials.sessionToken,
        },
      });

      const fileText = await file.text();

      await s3.send(new PutObjectCommand({
        Bucket:      RAG_BUCKET,
        Key:         ragS3Key,
        Body:        fileText,
        ContentType: 'text/plain; charset=utf-8',
      }));

      console.log(`✅ Knowledge base uploaded: s3://${RAG_BUCKET}/${ragS3Key}`);
      setUploadStatus('uploaded');
      setTimeout(() => setUploadStatus('idle'), 5000);
    } catch (err: any) {
      console.error('❌ Upload failed:', err.message ?? err);
      setUploadError(err.message ?? 'Upload failed. Check bucket CORS and IAM permissions.');
      setUploadStatus('error');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  // ── Derived ───────────────────────────────────────────────────────────────
  const hasPendingFields =
    !form.name.trim() || !form.phone.trim() ||
    !form.address.trim() || !form.contactEmail.trim();

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
        <div style={{ padding: '12px 16px', borderRadius: '6px', flexShrink: 0,
          backgroundColor: 'rgba(251,146,60,0.08)', border: '1px solid rgba(251,146,60,0.35)',
          color: '#fbbf24', fontSize: '13px' }}>
          ⚠️ Some fields are still set to the auto-provisioned placeholder. Fill them in below so your campaigns display the correct association details.
        </div>
      )}

      {/* ── Profile form ── */}
      <div className="panel" style={{ flex: '0 0 auto', overflow: 'visible' }}>
        <h3 style={{ margin: '0 0 20px', fontSize: '15px', fontWeight: 600, color: '#f1f5f9' }}>
          Association Profile
        </h3>

        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px',
            color: '#94a3b8', fontSize: '14px', padding: '8px 0' }}>
            <div className="profile-gate-spinner" style={{ width: '20px', height: '20px', borderWidth: '2px' }} />
            Loading profile…
          </div>
        ) : (
          <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div className="form-grid-3col" style={{ gridTemplateColumns: '1fr 1fr' }}>
              <div>
                <label htmlFor="settings-name">Organisation Name</label>
                <input id="settings-name" type="text" placeholder="e.g. Al Noor Association"
                  value={form.name} onChange={e => handleChange('name', e.target.value)}
                  disabled={saveStatus === 'saving'} />
              </div>
              <div>
                <label htmlFor="settings-phone">WhatsApp Phone Number</label>
                <input id="settings-phone" type="text" placeholder="e.g. +97336xxxxxx"
                  value={form.phone} onChange={e => handleChange('phone', e.target.value)}
                  disabled={saveStatus === 'saving'} />
              </div>
              <div>
                <label htmlFor="settings-email">Contact Email</label>
                <input id="settings-email" type="text" placeholder="e.g. admin@association.org"
                  value={form.contactEmail} onChange={e => handleChange('contactEmail', e.target.value)}
                  disabled={saveStatus === 'saving'} />
              </div>
              <div>
                <label htmlFor="settings-address">Address / Region</label>
                <input id="settings-address" type="text" placeholder="e.g. Manama, Bahrain"
                  value={form.address} onChange={e => handleChange('address', e.target.value)}
                  disabled={saveStatus === 'saving'} />
              </div>
            </div>

            {saveStatus === 'saved' && (
              <div style={{ padding: '10px 14px', borderRadius: '6px', fontSize: '13px', fontWeight: 500,
                backgroundColor: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.35)', color: '#34d399' }}>
                ✓ Profile saved successfully.
              </div>
            )}
            {saveStatus === 'error' && (
              <div style={{ padding: '10px 14px', borderRadius: '6px', fontSize: '13px', fontWeight: 500,
                backgroundColor: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.35)', color: '#f87171' }}>
                ✗ {saveError}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              
            </div>
          </form>
        )}
      </div>

      {/* ── Global AI Knowledge Base ── */}
      <div className="panel" style={{ flex: '0 0 auto' }}>
        <h3 style={{ margin: '0 0 8px', fontSize: '15px', fontWeight: 600, color: '#f1f5f9' }}>
          🤖 Global AI Knowledge Base
        </h3>
        <p style={{ margin: '0 0 16px', fontSize: '13px', color: '#64748b', lineHeight: '1.5' }}>
          Upload a plain-text document describing your association's mission, campaigns, and common member FAQs.
          The Bedrock chat agent injects this file verbatim into its system prompt whenever a member sends a
          free-text WhatsApp reply, giving it accurate, association-specific context.
        </p>

        {/* S3 path indicator */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px',
          padding: '8px 12px', borderRadius: '6px', backgroundColor: 'rgba(59,130,246,0.06)',
          border: '1px solid #1e3a5f' }}>
          <span style={{ fontSize: '11px', color: '#64748b', fontWeight: 600, textTransform: 'uppercase',
            letterSpacing: '0.4px', flexShrink: 0 }}>
            S3 destination
          </span>
          <code style={{ fontSize: '12px', color: '#60a5fa', wordBreak: 'break-all' }}>
            s3://{RAG_BUCKET}/{ragS3Key}
          </code>
        </div>

        {/* Upload controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>

          {/* Hidden file input — only .txt accepted */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".txt,text/plain"
            style={{ display: 'none' }}
            onChange={e => {
              const file = e.target.files?.[0];
              if (file) handleMissionUpload(file);
            }}
          />

          {/* Upload trigger */}
          <button
            onClick={() => { setUploadError(''); fileInputRef.current?.click(); }}
            disabled={uploadStatus === 'uploading'}
            style={{
              padding: '8px 18px', fontSize: '13px', fontWeight: 600, borderRadius: '6px',
              cursor: uploadStatus === 'uploading' ? 'not-allowed' : 'pointer',
              backgroundColor: uploadStatus === 'uploading' ? '#1e293b' : '#1d4ed8',
              color: uploadStatus === 'uploading' ? '#64748b' : '#f1f5f9',
              border: `1px solid ${uploadStatus === 'uploading' ? '#334155' : '#2563eb'}`,
              display: 'flex', alignItems: 'center', gap: '8px',
              transition: 'all 0.15s',
            }}>
            {uploadStatus === 'uploading' ? (
              <>
                <span style={{ display: 'inline-block', width: '13px', height: '13px',
                  border: '2px solid rgba(241,245,249,0.25)', borderTopColor: '#94a3b8',
                  borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                Uploading…
              </>
            ) : '📄 Upload mission.txt'}
          </button>

          {/* Status feedback */}
          {uploadStatus === 'uploaded' && (
            <span style={{ fontSize: '13px', color: '#34d399', fontWeight: 500 }}>
              ✓ Document uploaded — chatAgent will use it on the next member inquiry.
            </span>
          )}
          {uploadStatus === 'error' && (
            <span style={{ fontSize: '13px', color: '#f87171', fontWeight: 500 }}
              title={uploadError}>
              ✗ {uploadError.length > 80 ? uploadError.slice(0, 77) + '…' : uploadError}
            </span>
          )}
        </div>

        {/* Guidance note */}
        <div style={{ marginTop: '14px', padding: '10px 12px', borderRadius: '6px',
          backgroundColor: 'rgba(100,116,139,0.06)', border: '1px solid #1e293b',
          fontSize: '12px', color: '#64748b', lineHeight: '1.6' }}>
          <strong style={{ color: '#94a3b8' }}>Requirements:</strong> Plain text (.txt), UTF-8 encoded.
          Recommended max size: 8 KB (~4,000 words). Uploading a new file overwrites the previous one
          immediately — no re-deploy required. If no file exists, the agent falls back to DynamoDB
          member history only.
        </div>
      </div>

      {/* ── Read-only account info ── */}
      <div className="panel" style={{ flex: '0 0 auto' }}>
        <h3 style={{ margin: '0 0 14px', fontSize: '14px', fontWeight: 600, color: '#94a3b8',
          textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          Account Information
        </h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <InfoRow label="Tenant ID (pk)"     value={associationId} mono />
          <InfoRow label="Profile Record (sk)" value="PROFILE"       mono />
          <InfoRow label="Entity Type"         value="ADMIN_PROFILE"  mono />
          <button type="submit" className="btn-submit"
                disabled={saveStatus === 'saving'} style={{ width: 'auto', minWidth: '160px' }}>
                {saveStatus === 'saving' ? (
                  <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                    <span style={{ display: 'inline-block', width: '14px', height: '14px',
                      border: '2px solid rgba(241,245,249,0.3)', borderTopColor: '#f1f5f9',
                      borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                    Saving…
                  </span>
                ) : 'Save Profile'}
              </button>
        </div>
      </div>

    </div>
  );
}

// ─── Small read-only display row ─────────────────────────────────────────────

function InfoRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: '12px' }}>
      <span style={{ fontSize: '12px', fontWeight: 600, color: '#64748b', textTransform: 'uppercase',
        letterSpacing: '0.5px', minWidth: '160px', flexShrink: 0 }}>
        {label}
      </span>
      <span style={{ fontSize: '13px', color: '#94a3b8', fontFamily: mono ? 'monospace' : 'inherit' }}>
        {value}
      </span>
    </div>
  );
}
