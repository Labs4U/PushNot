import { useState, useEffect } from 'react';
import { generateClient } from 'aws-amplify/data';
import type { Schema } from '../../amplify/data/resource';

const client = generateClient<Schema>();

interface CampaignsViewProps { associationId: string; }

// ── Status badge helper ───────────────────────────────────────────────────────
function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { bg: string; color: string }> = {
    RUNNING:   { bg: 'rgba(16,185,129,0.12)',  color: '#10b981' },
    ACTIVE:    { bg: 'rgba(16,185,129,0.12)',  color: '#10b981' },
    SCHEDULED: { bg: 'rgba(59,130,246,0.12)',  color: '#3b82f6' },
    COMPLETED: { bg: 'rgba(107,114,128,0.12)', color: '#6b7280' },
    DRAFT:     { bg: 'rgba(251,146,60,0.12)',  color: '#f97316' },
  };
  const s = map[status] ?? map.DRAFT;
  return (
    <span style={{ padding: '3px 8px', borderRadius: '3px', fontSize: '11px', fontWeight: 600, backgroundColor: s.bg, color: s.color }}>
      {status || 'DRAFT'}
    </span>
  );
}

// ── Delivery status colour ────────────────────────────────────────────────────
function deliveryColor(status: string) {
  const m: Record<string, string> = { SENT: '#3b82f6', DELIVERED: '#8b5cf6', READ: '#10b981', QUEUED: '#94a3b8' };
  return m[status] ?? '#64748b';
}

export default function CampaignsView({ associationId }: CampaignsViewProps) {
  // ── Form state ────────────────────────────────────────────────────────────
  const [title,        setTitle]        = useState('');
  const [description,  setDescription]  = useState('');
  const [targetAmount, setTargetAmount] = useState('');
  const [language,     setLanguage]     = useState('en');
  const [launchDate,   setLaunchDate]   = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error' | null; text: string }>({ type: null, text: '' });

  // ── Campaign list state ───────────────────────────────────────────────────
  const [campaigns,        setCampaigns]        = useState<any[]>([]);
  const [loadingCampaigns, setLoadingCampaigns] = useState(true);

  // ── Campaign detail drill-down state ─────────────────────────────────────
  const [selectedCampaign,    setSelectedCampaign]    = useState<any | null>(null);
  const [ledgerRecords,       setLedgerRecords]       = useState<any[]>([]);
  const [loadingLedger,       setLoadingLedger]       = useState(false);

  const templateMap: Record<string, string> = { en: 'campaign_msg', ar: 'campaign_msg_ar' };

  // ── Fetch all campaigns ───────────────────────────────────────────────────
  const fetchCampaigns = async () => {
    setLoadingCampaigns(true);
    try {
      let allItems: any[] = [];
      let nextToken: string | null | undefined = undefined;
      do {
        const response: any = await client.models.PushNotSystem.list({
          filter: { pk: { eq: associationId }, sk: { beginsWith: 'CAMP#' } },
          ...(nextToken ? { nextToken } : {}),
          authMode: 'userPool',
        });
        allItems = allItems.concat((response.data || []).filter((i: any) => i != null));
        nextToken = response.nextToken;
      } while (nextToken);

      setCampaigns(allItems.filter((i: any) => i.entityType === 'CAMPAIGN'));
    } catch (err) {
      console.error('❌ fetchCampaigns error:', err);
      setCampaigns([]);
    } finally {
      setLoadingCampaigns(false);
    }
  };

  useEffect(() => { if (associationId) fetchCampaigns(); }, [associationId]);

  // ── Fetch ledger for a specific campaign ─────────────────────────────────
  // Queries base table: pk = associationId, sk beginsWith CAMPRUN#<campIdRaw>#
  // This returns all per-member ledger records written by processOutboundQueue.
  const fetchLedger = async (campaign: any) => {
    setSelectedCampaign(campaign);
    setLedgerRecords([]);
    setLoadingLedger(true);
    try {
      // campIdRaw strips the "CAMP#" prefix (e.g. "CAMP#433345" → "433345")
      const campIdRaw  = (campaign.sk as string).replace(/^CAMP#/, '');
      const skPrefix   = `CAMPRUN#${campIdRaw}#`;

      let allLedger: any[] = [];
      let nextToken: string | null | undefined = undefined;
      do {
        const response: any = await client.models.PushNotSystem.list({
          filter: {
            pk: { eq: associationId },
            sk: { beginsWith: skPrefix },
          },
          ...(nextToken ? { nextToken } : {}),
          authMode: 'userPool',
        });
        allLedger = allLedger.concat((response.data || []).filter((i: any) => i != null));
        nextToken = response.nextToken;
      } while (nextToken);

      console.log(`📋 Ledger for ${campaign.sk}: ${allLedger.length} records`);
      setLedgerRecords(allLedger);
    } catch (err) {
      console.error('❌ fetchLedger error:', err);
      setLedgerRecords([]);
    } finally {
      setLoadingLedger(false);
    }
  };

  // ── Computed KPIs ─────────────────────────────────────────────────────────
  const activeCampaigns = campaigns.filter(c => c.status === 'ACTIVE' || c.status === 'RUNNING').length;
  const totalRecipients = campaigns.reduce((acc, c) => acc + (c.recipientCount || 0), 0);

  // ── Campaign create ───────────────────────────────────────────────────────
  const handleCreateCampaign = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim())                          { setFeedback({ type: 'error', text: 'Campaign title is required.' }); return; }
    if (!description.trim())                    { setFeedback({ type: 'error', text: 'Campaign description is required.' }); return; }
    if (!targetAmount || isNaN(Number(targetAmount))) { setFeedback({ type: 'error', text: 'Target amount must be a valid number.' }); return; }
    if (!launchDate)                            { setFeedback({ type: 'error', text: 'Launch date is required.' }); return; }

    setIsSubmitting(true);
    setFeedback({ type: null, text: '' });
    try {
      const campId = `CAMP#${Date.now()}`;
      const { errors } = await client.models.PushNotSystem.create({
        pk: associationId, sk: campId,
        entityType: 'CAMPAIGN',
        gsi1pk: associationId, gsi1sk: 'STATUS#RUNNING',
        title, description,
        type: 'FUNDRAISER',
        templateName: templateMap[language],
        status: 'SCHEDULED',
        targetAmount: Number(targetAmount),
      }, { authMode: 'userPool' });

      if (errors?.length) throw new Error(errors[0].message);

      setFeedback({ type: 'success', text: `Campaign "${title}" created and scheduled for ${new Date(launchDate).toLocaleDateString()}` });
      setTitle(''); setDescription(''); setTargetAmount(''); setLanguage('en'); setLaunchDate('');
      await fetchCampaigns();
    } catch (err: any) {
      setFeedback({ type: 'error', text: err.message || 'Failed to create campaign.' });
    } finally {
      setIsSubmitting(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="view-single-col">

      {/* ── Campaign creation form ── */}
      <div className="panel" style={{ flex: '0 0 auto', overflow: 'visible' }}>
        <h2 style={{ margin: '0 0 16px', fontSize: '18px', fontWeight: 700, color: '#f1f5f9' }}>
          Create New Campaign
        </h2>
        <form onSubmit={handleCreateCampaign} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div>
            <label>Campaign Title</label>
            <input type="text" placeholder="e.g., Back to School 2024" value={title}
              onChange={e => setTitle(e.target.value)} disabled={isSubmitting} />
          </div>
          <div>
            <label>Outreach Description (Template Variable: {`{{2}}`})</label>
            <textarea rows={3} placeholder="Message content sent via WhatsApp…" value={description}
              onChange={e => setDescription(e.target.value)} disabled={isSubmitting}
              style={{ width: '100%', padding: '8px 12px', fontFamily: 'inherit' }} />
          </div>
          <div className="form-grid-3col">
            <div>
              <label>Target Amount</label>
              <input type="number" placeholder="e.g., 50000" value={targetAmount}
                onChange={e => setTargetAmount(e.target.value)} disabled={isSubmitting} min="1" />
            </div>
            <div>
              <label>Language / Template</label>
              <select value={language} onChange={e => setLanguage(e.target.value)} disabled={isSubmitting}>
                <option value="en">🇬🇧 English (campaign_msg)</option>
                <option value="ar">🇸🇦 Arabic (campaign_msg_ar)</option>
              </select>
            </div>
            <div>
              <label>Scheduled Launch Date</label>
              <input type="datetime-local" value={launchDate}
                onChange={e => setLaunchDate(e.target.value)} disabled={isSubmitting} />
            </div>
          </div>
          {feedback.type && (
            <div style={{ padding: '10px 12px', borderRadius: '6px', fontSize: '13px',
              backgroundColor: feedback.type === 'error' ? '#7f1d1d' : '#064e3b',
              color: feedback.type === 'error' ? '#fca5a5' : '#86efac',
              border: `1px solid ${feedback.type === 'error' ? '#991b1b' : '#047857'}` }}>
              {feedback.text}
            </div>
          )}
          <button type="submit" className="btn-submit" disabled={isSubmitting} style={{ marginTop: '4px' }}>
            {isSubmitting ? 'Creating…' : 'Create & Schedule Campaign'}
          </button>
        </form>
      </div>

      {/* ── KPI metrics row ── */}
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        gap: '24px', padding: '0 16px', flexShrink: 0 }}>
        {[
          { label: 'Total Campaigns',  value: loadingCampaigns ? '—' : campaigns.length,                  color: '#3b82f6' },
          { label: 'Active Campaigns', value: loadingCampaigns ? '—' : activeCampaigns,                    color: '#10b981' },
          { label: 'Total Recipients', value: loadingCampaigns ? '—' : totalRecipients.toLocaleString(),   color: '#8b5cf6' },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '12px', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{label}:</span>
            <strong style={{ fontSize: '16px', fontWeight: 700, color }}>{value}</strong>
          </div>
        ))}
      </div>

      {/* ── Campaign list table ── */}
      <div className="panel" style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <h3 style={{ margin: '0 0 12px', fontSize: '14px', fontWeight: 600, color: '#f1f5f9', flexShrink: 0 }}>
          Recent Campaigns {loadingCampaigns ? '(Loading…)' : `(${campaigns.length})`}
          {selectedCampaign && (
            <button onClick={() => { setSelectedCampaign(null); setLedgerRecords([]); }}
              style={{ marginLeft: '12px', fontSize: '11px', padding: '2px 8px', background: 'none',
                border: '1px solid #334155', borderRadius: '4px', color: '#94a3b8', cursor: 'pointer' }}>
              ← Back to all campaigns
            </button>
          )}
        </h3>

        <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>

          {/* ── Drill-down: per-member ledger view ── */}
          {selectedCampaign ? (
            <div>
              <div style={{ marginBottom: '12px', padding: '10px 14px', borderRadius: '6px',
                backgroundColor: 'rgba(59,130,246,0.08)', border: '1px solid #1e40af', color: '#93c5fd', fontSize: '13px' }}>
                <strong>{selectedCampaign.title || selectedCampaign.sk}</strong>
                &nbsp;·&nbsp;{ledgerRecords.length} recipients loaded
                {loadingLedger && ' · loading…'}
              </div>

              {loadingLedger ? (
                <div style={{ textAlign: 'center', padding: '32px', color: '#64748b' }}>⏳ Loading delivery records…</div>
              ) : ledgerRecords.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '32px', color: '#64748b', fontSize: '13px' }}>
                  No delivery records found. This campaign hasn't been broadcast yet.
                </div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                  <thead style={{ position: 'sticky', top: 0, backgroundColor: '#0f172a', zIndex: 10 }}>
                    <tr>
                      {['Recipient', 'Delivery', 'Payment', 'Read', 'Replied', 'Record Key'].map(h => (
                        <th key={h} style={{ padding: '10px 12px', textAlign: 'left', color: '#94a3b8',
                          fontWeight: 600, borderBottom: '1px solid #334155' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {ledgerRecords.map((rec, idx) => {
                      // sk = CAMPRUN#<campId>#MEM#<phone>#<ts>  — extract phone
                      const skParts  = (rec.sk as string).split('#');
                      const memIdx   = skParts.indexOf('MEM');
                      const phone    = memIdx >= 0 ? skParts[memIdx + 1] : '—';

                      return (
                        <tr key={rec.sk} style={{ borderBottom: '1px solid #1e293b',
                          backgroundColor: idx % 2 === 0 ? 'transparent' : 'rgba(59,130,246,0.04)' }}>
                          <td style={{ padding: '10px 12px', color: '#cbd5e1' }}>{rec.name || phone}</td>
                          <td style={{ padding: '10px 12px' }}>
                            <span style={{ color: deliveryColor(rec.deliveryStatus || ''), fontWeight: 500, fontSize: '12px' }}>
                              {rec.deliveryStatus || 'QUEUED'}
                            </span>
                          </td>
                          <td style={{ padding: '10px 12px', color: '#94a3b8', fontSize: '12px' }}>
                            {rec.paymentStatus || '—'}
                          </td>
                          <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                            {rec.isRead ? '✅' : '—'}
                          </td>
                          <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                            {rec.hasReplied ? '💬' : '—'}
                          </td>
                          <td style={{ padding: '10px 12px', color: '#475569', fontSize: '11px', fontFamily: 'monospace' }}>
                            {(rec.sk as string).slice(0, 40)}…
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

          ) : (
            /* ── Campaign list ── */
            campaigns.length === 0 ? (
              <div style={{ padding: '32px 16px', textAlign: 'center', color: '#94a3b8', fontSize: '14px' }}>
                {loadingCampaigns ? '⏳ Loading campaigns…' : '📭 No campaigns yet. Create one above!'}
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                <thead style={{ position: 'sticky', top: 0, backgroundColor: '#0f172a', zIndex: 10 }}>
                  <tr>
                    {['Title', 'Status', 'Recipients', 'Language', 'View'].map(h => (
                      <th key={h} style={{ padding: '12px', textAlign: h === 'Recipients' ? 'right' : 'left',
                        color: '#94a3b8', fontWeight: 600, borderBottom: '1px solid #334155' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {campaigns.map((camp, idx) => (
                    <tr key={camp.sk} style={{ borderBottom: '1px solid #334155',
                      backgroundColor: idx % 2 === 0 ? 'transparent' : 'rgba(59,130,246,0.05)' }}>
                      <td style={{ padding: '12px', color: '#cbd5e1' }}>{camp.title || 'Untitled'}</td>
                      <td style={{ padding: '12px' }}><StatusBadge status={camp.status} /></td>
                      <td style={{ padding: '12px', textAlign: 'right', color: '#cbd5e1' }}>
                        {camp.recipientCount > 0 ? camp.recipientCount.toLocaleString() : '—'}
                      </td>
                      <td style={{ padding: '12px', textAlign: 'center', color: '#cbd5e1' }}>
                        {camp.templateName?.includes('ar') ? '🇸🇦' : '🇬🇧'}
                      </td>
                      <td style={{ padding: '12px' }}>
                        <button onClick={() => fetchLedger(camp)}
                          style={{ padding: '4px 10px', fontSize: '12px', background: 'none',
                            border: '1px solid #334155', borderRadius: '4px', color: '#3b82f6', cursor: 'pointer' }}>
                          View Targets
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}
        </div>
      </div>
    </div>
  );
}
