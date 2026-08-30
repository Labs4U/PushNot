import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { generateClient } from 'aws-amplify/data';
import type { Schema } from '../../amplify/data/resource';
import MemberHistoryView from './MemberHistoryView';

const client = generateClient<Schema>();

// ── Inline info icon ──────────────────────────────────────────────────────────
const InfoIcon: React.FC<{ tooltip: string }> = ({ tooltip }) => {
  const [show, setShow] = useState(false);
  return (
    <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
        style={{ cursor: 'pointer', color: '#3b82f6', marginLeft: '6px', opacity: show ? 1 : 0.8 }}
        onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
        <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" fill="none" />
        <text x="8" y="10.5" textAnchor="middle" fill="currentColor" fontSize="10"
          fontWeight="bold" fontFamily="system-ui,-apple-system,sans-serif">i</text>
      </svg>
      {show && (
        <div style={{ position: 'absolute', bottom: '100%', left: '-80px', marginBottom: '8px',
          width: '200px', padding: '8px 12px', backgroundColor: '#334155', border: '1px solid #475569',
          borderRadius: '6px', fontSize: '12px', color: '#e2e8f0', lineHeight: '1.4',
          zIndex: 1000, boxShadow: '0 4px 12px rgba(0,0,0,0.3)', whiteSpace: 'normal' }}>
          {tooltip}
          <div style={{ position: 'absolute', top: '100%', left: '50%', transform: 'translateX(-50%)',
            width: 0, height: 0, borderLeft: '6px solid transparent',
            borderRight: '6px solid transparent', borderTop: '6px solid #334155' }} />
        </div>
      )}
    </div>
  );
};

// ── DynamoDB value extractors (handles both AppSync and raw boto3 formats) ────
const extractNumber = (val: any): number => {
  if (val == null || val === '') return 0;
  if (typeof val === 'object' && val.N !== undefined) return parseFloat(val.N);
  const n = parseFloat(String(val));
  return isNaN(n) ? 0 : n;
};
const extractString = (val: any): string => {
  if (val == null) return '';
  if (typeof val === 'object' && val.S !== undefined) return String(val.S);
  return String(val);
};

// ── Delivery status colour ────────────────────────────────────────────────────
const DELIVERY_COLORS: Record<string, string> = {
  SENT: '#3b82f6', DELIVERED: '#8b5cf6', READ: '#10b981', QUEUED: '#94a3b8',
};
const deliveryColor = (s: string) => DELIVERY_COLORS[s] ?? '#64748b';

// ── Paginated list helper ─────────────────────────────────────────────────────
async function paginatedList(filter: Record<string, any>, label = ''): Promise<any[]> {
  let items: any[] = [];
  let nextToken: string | null | undefined = undefined;
  do {
    const res: any = await client.models.PushNotSystem.list({
      filter,
      ...(nextToken ? { nextToken } : {}),
      authMode: 'userPool',
    });

    if (res.errors?.length) {
      const onlyTimestamp = res.errors.every((e: any) =>
        e.message?.includes('createdAt') || e.message?.includes('updatedAt')
      );
      if (onlyTimestamp) {
        // Records written by Lambda (UpdateItem) are missing the auto-managed
        // createdAt field. AppSync resolves it as null, violating the non-nullable
        // constraint and dropping the item. The fix is in processOutboundQueue —
        // adding createdAt = if_not_exists(createdAt, :now) to the UpdateExpression.
        // Until existing records are rewritten, warn but continue processing data.
        console.warn(
          `⚠️ [${label}] ${res.errors.length} record(s) missing createdAt (Lambda-written via UpdateItem). ` +
          `data returned: ${(res.data ?? []).length} items. ` +
          'Deploy updated processOutboundQueue to fix future records.'
        );
      } else {
        console.error(`❌ [${label}] AppSync errors:`, res.errors);
      }
    }

    const page = (res.data ?? []).filter(Boolean);
    items = items.concat(page);
    nextToken = res.nextToken;
  } while (nextToken);
  return items;
}

// ─────────────────────────────────────────────────────────────────────────────

interface MessagesViewProps { associationId: string; }

const MessagesView: React.FC<MessagesViewProps> = ({ associationId }) => {

  // ── Campaign selection ────────────────────────────────────────────────────
  const [campaigns,         setCampaigns]         = useState<any[]>([]);
  const [campaignSearch,    setCampaignSearch]    = useState('');
  const [filteredCampaigns, setFilteredCampaigns] = useState<any[]>([]);
  const [selectedCampaign,  setSelectedCampaign]  = useState<any | null>(null);
  const [messageContent,    setMessageContent]    = useState('');
  const [targetAmount,      setTargetAmount]      = useState<number | ''>('');
  const [isSubmitting,      setIsSubmitting]      = useState(false);
  const [isDropdownOpen,    setIsDropdownOpen]    = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error' | null; text: string }>({ type: null, text: '' });

  // ── Member roster (for audience targeting / pre-broadcast) ────────────────
  const [allMembers,     setAllMembers]     = useState<any[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(true);

  // ── Targeting filters ─────────────────────────────────────────────────────
  const [minEngagementRate, setMinEngagementRate] = useState(0);
  const [minConversionRate, setMinConversionRate] = useState(0);
  const [targetRegion,      setTargetRegion]      = useState('All Regions');
  const [targetGenders,     setTargetGenders]     = useState<string[]>(['MALE', 'FEMALE']);

  // ── Campaign ledger (CAMPRUN# records — post-broadcast delivery roster) ───
  // Option A base table pattern:
  //   pk  = associationId
  //   sk  beginsWith  CAMPRUN#<campIdRaw>#
  const [ledgerRecords,  setLedgerRecords]  = useState<any[]>([]);
  const [loadingLedger,  setLoadingLedger]  = useState(false);
  const [activeTab,      setActiveTab]      = useState<'compose' | 'roster'>('compose');

  // ── Member history drill-down (GSI2) ─────────────────────────────────────
  const [historyMember, setHistoryMember] = useState<{ phone: string; name: string } | null>(null);

  // ── Fetch member roster ───────────────────────────────────────────────────
  useEffect(() => {
    if (!associationId) return;
    let cancelled = false;

    async function fetchMembers() {
      setLoadingMembers(true);
      setAllMembers([]);
      try {
        console.log('🔄 Fetching members for tenant:', associationId);
        const items = await paginatedList({
          pk: { eq: associationId },
          sk: { beginsWith: 'MEM#' },
        }, 'members');
        if (!cancelled) {
          console.log('✅ Members fetched:', items.length);
          setAllMembers(items);
        }
      } catch (err: any) {
        if (!cancelled) {
          console.error('❌ Member fetch failed:', err.message ?? err);
          setAllMembers([]);
        }
      } finally {
        if (!cancelled) setLoadingMembers(false);
      }
    }

    fetchMembers();
    return () => { cancelled = true; };
  }, [associationId]);

  // ── Fetch campaign ledger for the selected campaign ───────────────────────
  // Option A base table query:
  //   pk: { eq: associationId }
  //   sk: { beginsWith: `CAMPRUN#${campIdRaw}#` }
  //
  // campIdRaw strips the "CAMP#" prefix from the campaign sk so the prefix
  // matches the exact format written by processOutboundQueue:
  //   sk = CAMPRUN#<campIdRaw>#MEM#<phone>#<timestamp>
  const fetchLedger = useCallback(async (campaign: any) => {
    if (!associationId || !campaign?.sk) return;

    // campaign.sk = "CAMP#<raw>" e.g. "CAMP#1751234567890"
    const campIdRaw = (campaign.sk as string).replace(/^CAMP#/, '');
    const skPrefix  = `CAMPRUN#${campIdRaw}#`;

    console.log(`📋 Fetching ledger: pk=${associationId}, sk beginsWith ${skPrefix}`);
    setLoadingLedger(true);
    setLedgerRecords([]);

    try {
      const items = await paginatedList({
        pk: { eq: associationId },
        sk: { beginsWith: skPrefix },
      }, 'ledger');
      console.log(`✅ Ledger records: ${items.length}`);
      setLedgerRecords(items);
    } catch (err: any) {
      console.error('❌ Ledger fetch failed:', err.message ?? err);
      setLedgerRecords([]);
    } finally {
      setLoadingLedger(false);
    }
  }, [associationId]);

  // Auto-fetch ledger when a campaign is selected and user switches to roster tab
  useEffect(() => {
    if (selectedCampaign && activeTab === 'roster') {
      fetchLedger(selectedCampaign);
    }
  }, [selectedCampaign, activeTab, fetchLedger]);

  // ── Fetch campaigns ───────────────────────────────────────────────────────
  const fetchCampaigns = useCallback(async () => {
    try {
      const items = await paginatedList({
        pk: { eq: associationId },
        sk: { beginsWith: 'CAMP#' },
      }, 'campaigns');
      setCampaigns(items);
      setFilteredCampaigns(items);
    } catch (err) {
      console.error('❌ fetchCampaigns error:', err);
    }
  }, [associationId]);

  useEffect(() => {
    if (associationId) fetchCampaigns();
  }, [associationId, fetchCampaigns]);

  // ── Campaign search filter ────────────────────────────────────────────────
  useEffect(() => {
    if (!campaignSearch.trim()) {
      setFilteredCampaigns(campaigns);
    } else {
      const q = campaignSearch.toLowerCase();
      setFilteredCampaigns(campaigns.filter(c =>
        (c?.title ?? '').toLowerCase().includes(q) ||
        (c?.sk ?? '').toLowerCase().includes(q)
      ));
    }
  }, [campaignSearch, campaigns]);

  // ── Gender toggle ─────────────────────────────────────────────────────────
  const handleToggleGender = (g: string) =>
    setTargetGenders(prev => prev.includes(g) ? prev.filter(x => x !== g) : [...prev, g]);

  // ── Audience size (reactive, useMemo) ─────────────────────────────────────
  const estimatedAudienceSize = useMemo(() => {
    if (!allMembers.length) return 0;
    return allMembers.filter(member => {
      if (!member) return false;
      const region     = extractString(member.address).trim();
      const gender     = extractString(member.gender).toUpperCase();
      const engagement = extractNumber(member.engagementRatePercent);
      const conversion = extractNumber(member.conversionRatePercent);

      if (targetRegion !== 'All Regions' && region !== targetRegion.trim()) return false;
      if (engagement < minEngagementRate) return false;
      if (conversion < minConversionRate) return false;
      if (targetGenders.length > 0 && !targetGenders.includes(gender)) return false;
      return true;
    }).length;
  }, [allMembers, minEngagementRate, minConversionRate, targetRegion, targetGenders]);

  // ── Campaign selection handlers ───────────────────────────────────────────
  const handleSelectCampaign = (camp: any) => {
    setSelectedCampaign(camp);
    setCampaignSearch(camp.title || camp.sk);
    setMessageContent(camp.description || '');
    setIsDropdownOpen(false);
    setLedgerRecords([]);      // clear stale ledger from previous selection
    setHistoryMember(null);
  };

  const handleClearSelection = () => {
    setSelectedCampaign(null);
    setCampaignSearch('');
    setMessageContent('');
    setTargetAmount('');
    setIsDropdownOpen(false);
    setLedgerRecords([]);
    setHistoryMember(null);
    setActiveTab('compose');
  };

  // ── Broadcast submit ──────────────────────────────────────────────────────
  const handleSubmit = async () => {
    const isNew = !selectedCampaign && campaignSearch.trim();
    if (!isNew && !selectedCampaign) {
      setFeedback({ type: 'error', text: 'Select an existing campaign or type a new name.' });
      return;
    }
    setIsSubmitting(true);
    setFeedback({ type: null, text: '' });

    try {
      let activeSk = selectedCampaign?.sk;

      if (isNew) {
        const campId = `CAMP#${Date.now()}`; // full timestamp — must match dispatchBroadcast's campIdRaw derivation
        activeSk = campId;
        const { errors } = await client.models.PushNotSystem.create({
          pk: associationId, sk: campId,
          entityType: 'CAMPAIGN',
          gsi1pk: associationId, gsi1sk: 'STATUS#RUNNING',
          title: campaignSearch.trim() || 'Untitled Campaign',
          description: messageContent.trim(),
          type: 'FUNDRAISER',
          templateName: 'campaign_msg',
          status: 'RUNNING',
          targetAmount: targetAmount ? Number(targetAmount) : 0,
        }, { authMode: 'userPool' });
        if (errors?.length) throw new Error(errors[0].message);
      }

      const response = await client.mutations.triggerCampaignBroadcast({
        associationId,
        campaignRunId: activeSk,
        minEngagementRate,
        minConversionRate,
        targetRegion: targetRegion !== 'All Regions' ? targetRegion : undefined,
        targetGenders: targetGenders.length > 0 ? targetGenders : undefined,
      }, { authMode: 'userPool' });

      if (response.errors?.length) throw new Error(response.errors[0].message);

      const resp = response.data ? JSON.parse(response.data as string) : {};
      setFeedback({
        type: 'success',
        text: `✅ Dispatched ${activeSk} — queued ${resp.queuedCount ?? 0} messages to ${estimatedAudienceSize} targeted members.`,
      });
      handleClearSelection();
      await fetchCampaigns();
    } catch (err: any) {
      setFeedback({ type: 'error', text: err.message || 'Dispatch failed.' });
    } finally {
      setIsSubmitting(false);
    }
  };

  // ── Helpers ───────────────────────────────────────────────────────────────

  // Extract phone from a ledger sk: CAMPRUN#<id>#MEM#<phone>#<ts>
  const phoneFromLedgerSk = (sk: string): string => {
    const parts = sk.split('#');
    const idx   = parts.indexOf('MEM');
    return idx >= 0 ? parts[idx + 1] : '—';
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="view-single-col">

      {/* Feedback toast */}
      {feedback.text && (
        <div style={{
          padding: '12px 16px', borderRadius: '6px', flexShrink: 0,
          backgroundColor: feedback.type === 'success' ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)',
          borderLeft: `3px solid ${feedback.type === 'success' ? '#10b981' : '#ef4444'}`,
          color: feedback.type === 'success' ? '#86efac' : '#fca5a5',
          fontSize: '14px', fontWeight: 500,
        }}>
          {feedback.text}
        </div>
      )}

      {/* 2-col grid */}
      <div className="grid-2-col" style={{ flex: 1, overflow: 'hidden', padding: '16px', gap: '16px' }}>

        {/* ── LEFT: Campaign selection + targeting filters ── */}
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
          <div className="panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
            <h3 style={{ margin: '0 0 16px', fontSize: '16px', fontWeight: 600, color: '#f1f5f9', flexShrink: 0 }}>
              📋 Campaign Selection
            </h3>

            {/* Campaign search / autocomplete */}
            <div className="campaign-search-wrapper" style={{ flexShrink: 0, marginBottom: '16px' }}>
              <label>Campaign Identifier / Title</label>
              <div className="campaign-search-input-container" style={{ position: 'relative', overflow: 'visible' }}>
                <input type="text"
                  placeholder="Search existing or type new campaign name..."
                  value={campaignSearch}
                  onChange={e => { setCampaignSearch(e.target.value); setIsDropdownOpen(true); }}
                  onFocus={() => setIsDropdownOpen(true)}
                  onBlur={() => setTimeout(() => setIsDropdownOpen(false), 150)}
                  style={{ paddingRight: selectedCampaign ? '32px' : '12px' }}
                />
                {selectedCampaign && (
                  <button onClick={handleClearSelection} style={{
                    position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)',
                    background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: '16px', padding: '0 4px',
                  }}>✕</button>
                )}
                {isDropdownOpen && (
                  <div className="campaign-suggestions-dropdown">
                    {filteredCampaigns.length === 0
                      ? <div className="campaign-suggestion-item" style={{ color: '#94a3b8' }}>No existing campaigns found.</div>
                      : filteredCampaigns.map(camp => (
                        <div key={camp?.sk || Math.random()} className="campaign-suggestion-item"
                          onClick={() => handleSelectCampaign(camp)}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <strong>{camp?.title || camp?.sk || 'Untitled'}</strong>
                            <span style={{ fontSize: '11px', color: '#64748b' }}>{camp?.status || 'DRAFT'}</span>
                          </div>
                        </div>
                      ))}
                  </div>
                )}
              </div>
            </div>

            {/* Selected campaign badge */}
            {selectedCampaign && (
              <div className="campaign-selected-badge existing" style={{ marginBottom: '16px', flexShrink: 0 }}>
                <strong>Relaunch:</strong> {selectedCampaign.title || selectedCampaign.sk}
              </div>
            )}

            {/* Target amount for new campaigns */}
            {!selectedCampaign && campaignSearch && (
              <div style={{ marginBottom: '16px', flexShrink: 0 }}>
                <label>Target Contribution Goal ($)</label>
                <input type="number" placeholder="e.g. 5000"
                  value={targetAmount}
                  onChange={e => setTargetAmount(e.target.value ? Number(e.target.value) : '')}
                  min="0" step="100" />
              </div>
            )}

            {/* Campaign metadata */}
            {selectedCampaign && (
              <div style={{ marginBottom: '16px', paddingBottom: '16px', borderBottom: '1px solid #334155', flexShrink: 0 }}>
                <div style={{ marginBottom: '12px' }}>
                  <div style={{ fontSize: '12px', color: '#94a3b8', fontWeight: 600, marginBottom: '4px' }}>Target Goal</div>
                  <div style={{ fontSize: '18px', fontWeight: 600, color: '#3b82f6' }}>${selectedCampaign.targetAmount || 0}</div>
                </div>
                <div>
                  <div style={{ fontSize: '12px', color: '#94a3b8', fontWeight: 600, marginBottom: '4px' }}>Status</div>
                  <span style={{
                    display: 'inline-block', padding: '4px 8px', borderRadius: '4px', fontSize: '12px', fontWeight: 600,
                    backgroundColor: selectedCampaign.status === 'RUNNING' ? 'rgba(16,185,129,0.1)' : 'rgba(100,116,139,0.1)',
                    color: selectedCampaign.status === 'RUNNING' ? '#86efac' : '#cbd5e1',
                  }}>{selectedCampaign.status || 'DRAFT'}</span>
                </div>
              </div>
            )}

            {/* Audience targeting section header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px', flexShrink: 0 }}>
              <h4 style={{ margin: 0, fontSize: '13px', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                🎯 Audience Targeting & Filters
              </h4>
              <InfoIcon tooltip="Filter members by engagement, conversion rate, region and gender. Only matching members receive the broadcast." />
            </div>

            {loadingMembers && (
              <div style={{ marginBottom: '12px', flexShrink: 0, fontSize: '12px', color: '#94a3b8' }}>
                ⏳ Loading members…
              </div>
            )}

            {/* Min engagement rate */}
            <div style={{ marginBottom: '12px', flexShrink: 0 }}>
              <label style={{ fontSize: '12px', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Min. Engagement Rate
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input type="number" min="0" max="100" value={minEngagementRate}
                  onChange={e => setMinEngagementRate(Math.max(0, Math.min(100, Number(e.target.value))))}
                  style={{ flex: 1, backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '6px', color: '#e2e8f0', padding: '8px 12px', fontSize: '13px' }} />
                <span style={{ color: '#cbd5e1', fontWeight: 600, fontSize: '13px' }}>%</span>
              </div>
            </div>

            {/* Min conversion rate */}
            <div style={{ marginBottom: '12px', flexShrink: 0 }}>
              <label style={{ fontSize: '12px', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Min. Conversion Rate
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input type="number" min="0" max="100" value={minConversionRate}
                  onChange={e => setMinConversionRate(Math.max(0, Math.min(100, Number(e.target.value))))}
                  style={{ flex: 1, backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '6px', color: '#e2e8f0', padding: '8px 12px', fontSize: '13px' }} />
                <span style={{ color: '#cbd5e1', fontWeight: 600, fontSize: '13px' }}>%</span>
              </div>
            </div>

            {/* Region */}
            <div style={{ marginBottom: '12px', flexShrink: 0 }}>
              <label style={{ fontSize: '12px', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Region / Cluster
              </label>
              <select value={targetRegion} onChange={e => setTargetRegion(e.target.value)}
                style={{ width: '100%', backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '6px', color: '#e2e8f0', padding: '8px 12px', fontSize: '13px', cursor: 'pointer' }}>
                <option value="All Regions">All Regions</option>
                <option value="A'ali">A'ali</option>
                <option value="Manama">Manama</option>
                <option value="Muharraq">Muharraq</option>
                <option value="Riffa">Riffa</option>
                <option value="Isa Town">Isa Town</option>
                <option value="Hamad Town">Hamad Town</option>
                <option value="Sitra">Sitra</option>
                <option value="Budaiya">Budaiya</option>
              </select>
            </div>

            {/* Gender */}
            <div style={{ marginBottom: '12px', flexShrink: 0 }}>
              <label style={{ fontSize: '12px', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.5px', display: 'block', marginBottom: '8px' }}>
                Gender
              </label>
              <div style={{ display: 'flex', gap: '16px' }}>
                {['MALE', 'FEMALE'].map(g => (
                  <label key={g} style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', margin: 0, color: '#e2e8f0', fontSize: '13px', fontWeight: 400 }}>
                    <input type="checkbox" checked={targetGenders.includes(g)} onChange={() => handleToggleGender(g)} style={{ cursor: 'pointer' }} />
                    {g.charAt(0) + g.slice(1).toLowerCase()}
                  </label>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* ── RIGHT: Compose / Roster tabs ── */}
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
          <div className="panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

            {/* Tab switcher — only show Roster tab when a campaign is selected */}
            <div style={{ display: 'flex', gap: '4px', marginBottom: '16px', flexShrink: 0,
              borderBottom: '1px solid #1e293b', paddingBottom: '12px' }}>
              {(['compose', 'roster'] as const).map(tab => {
                const isRoster = tab === 'roster';
                const disabled = isRoster && !selectedCampaign;
                return (
                  <button key={tab}
                    onClick={() => !disabled && setActiveTab(tab)}
                    style={{
                      padding: '6px 14px', fontSize: '13px', fontWeight: 600, borderRadius: '5px',
                      cursor: disabled ? 'not-allowed' : 'pointer',
                      border: 'none',
                      backgroundColor: activeTab === tab ? '#1e40af' : 'transparent',
                      color: disabled ? '#334155' : (activeTab === tab ? '#93c5fd' : '#64748b'),
                      opacity: disabled ? 0.4 : 1,
                      transition: 'all 0.15s',
                    }}>
                    {tab === 'compose' ? '✍️ Compose' : `📋 Target Roster ${ledgerRecords.length > 0 ? `(${ledgerRecords.length})` : ''}`}
                  </button>
                );
              })}
            </div>

            {/* ── Compose tab ── */}
            {activeTab === 'compose' && (
              <>
                <h3 style={{ margin: '0 0 16px', fontSize: '16px', fontWeight: 600, color: '#f1f5f9', flexShrink: 0 }}>
                  ✍️ Message Content
                </h3>
                <label style={{ marginBottom: '8px', flexShrink: 0 }}>Campaign Message / Outreach Content</label>
                <textarea
                  placeholder="Enter message details or noble cause appeal..."
                  value={messageContent}
                  onChange={e => setMessageContent(e.target.value)}
                  style={{ flex: 1, minHeight: '120px', resize: 'none', marginBottom: '16px', padding: '12px' }}
                />

                {/* Debug counter */}
                <div style={{ fontSize: '11px', color: '#475569', marginBottom: '6px' }}>
                  {loadingMembers ? '⏳ Loading…' : `DB: ${allMembers.length} members loaded`}
                </div>

                {/* Member history panel (GSI2) */}
                {historyMember && (
                  <div style={{ marginBottom: '12px', padding: '12px', borderRadius: '6px',
                    border: '1px solid #334155', backgroundColor: '#0f172a', flexShrink: 0,
                    maxHeight: '260px', overflowY: 'auto' }}>
                    <MemberHistoryView
                      associationId={associationId}
                      memberPhone={historyMember.phone}
                      memberName={historyMember.name}
                      onClose={() => setHistoryMember(null)}
                    />
                  </div>
                )}

                {/* Audience badge */}
                <div style={{
                  padding: '12px 16px', marginBottom: '16px', borderRadius: '6px', flexShrink: 0,
                  backgroundColor: 'rgba(139,92,246,0.1)', border: '1px solid #8b5cf6',
                  color: '#d8b4fe', fontSize: '13px', fontWeight: 600,
                  display: 'flex', alignItems: 'center', gap: '8px',
                }}>
                  <span>📊</span>
                  <span>
                    {loadingMembers
                      ? 'Loading member data…'
                      : `Estimated Target Audience: ${estimatedAudienceSize.toLocaleString()} Members`}
                  </span>
                </div>

                <button onClick={handleSubmit}
                  disabled={isSubmitting || (!selectedCampaign && !campaignSearch.trim()) || loadingMembers}
                  className="btn-submit"
                  style={{ flexShrink: 0, padding: '12px 16px', fontSize: '15px' }}>
                  {isSubmitting ? '⏳ Dispatching…' : '🚀 Submit & Broadcast to WhatsApp'}
                </button>
              </>
            )}

            {/* ── Target Roster tab ── */}
            {activeTab === 'roster' && selectedCampaign && (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                {/* Roster header */}
                <div style={{ flexShrink: 0, marginBottom: '12px' }}>
                  <div style={{ fontSize: '13px', fontWeight: 600, color: '#f1f5f9' }}>
                    {selectedCampaign.title || selectedCampaign.sk}
                  </div>
                  <div style={{ fontSize: '11px', color: '#475569', fontFamily: 'monospace', marginTop: '2px' }}>
                    pk = {associationId} · sk beginsWith CAMPRUN#{(selectedCampaign.sk as string).replace(/^CAMP#/, '')}#
                  </div>
                  <div style={{ marginTop: '8px', display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <span style={{ fontSize: '12px', color: '#64748b' }}>
                      {loadingLedger ? '⏳ Loading…' : `${ledgerRecords.length} records`}
                    </span>
                    <button onClick={() => fetchLedger(selectedCampaign)}
                      disabled={loadingLedger}
                      style={{ fontSize: '11px', padding: '3px 10px', background: 'none',
                        border: '1px solid #334155', borderRadius: '4px', color: '#94a3b8',
                        cursor: loadingLedger ? 'not-allowed' : 'pointer' }}>
                      ↺ Refresh
                    </button>
                  </div>
                </div>

                {/* Roster table */}
                {loadingLedger ? (
                  <div style={{ textAlign: 'center', padding: '32px', color: '#64748b', flexShrink: 0 }}>
                    ⏳ Loading delivery records…
                  </div>
                ) : ledgerRecords.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '32px', color: '#64748b', fontSize: '13px', flexShrink: 0 }}>
                    No delivery records yet. Broadcast this campaign to populate the roster.
                  </div>
                ) : (
                  <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                      <thead style={{ position: 'sticky', top: 0, backgroundColor: '#0f172a', zIndex: 5 }}>
                        <tr>
                          {['Phone', 'Delivery', 'Payment', 'Read', 'Replied', 'History'].map(h => (
                            <th key={h} style={{ padding: '9px 10px', textAlign: 'left',
                              color: '#64748b', fontWeight: 600, fontSize: '11px',
                              textTransform: 'uppercase', letterSpacing: '0.4px',
                              borderBottom: '1px solid #1e293b' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {ledgerRecords.map((rec, idx) => {
                          const phone = phoneFromLedgerSk(rec.sk ?? '');
                          return (
                            <tr key={rec.sk}
                              style={{ borderBottom: '1px solid #1e293b',
                                backgroundColor: idx % 2 === 0 ? 'transparent' : 'rgba(59,130,246,0.03)' }}>
                              <td style={{ padding: '9px 10px', color: '#cbd5e1', fontFamily: 'monospace', fontSize: '12px' }}>
                                {phone}
                              </td>
                              <td style={{ padding: '9px 10px' }}>
                                <span style={{ color: deliveryColor(rec.deliveryStatus ?? ''), fontWeight: 600, fontSize: '12px' }}>
                                  {rec.deliveryStatus ?? 'QUEUED'}
                                </span>
                              </td>
                              <td style={{ padding: '9px 10px', color: '#94a3b8', fontSize: '12px' }}>
                                {rec.paymentStatus ?? '—'}
                              </td>
                              <td style={{ padding: '9px 10px', textAlign: 'center' }}>
                                {rec.isRead ? '✅' : <span style={{ color: '#334155' }}>—</span>}
                              </td>
                              <td style={{ padding: '9px 10px', textAlign: 'center' }}>
                                {rec.hasReplied
                                  ? <span title={rec.inboundReplyText ?? ''}>💬</span>
                                  : <span style={{ color: '#334155' }}>—</span>}
                              </td>
                              <td style={{ padding: '9px 10px' }}>
                                <button
                                  onClick={() => setHistoryMember({ phone, name: rec.name ?? phone })}
                                  style={{ fontSize: '11px', padding: '2px 8px', background: 'none',
                                    border: '1px solid #1e40af', borderRadius: '3px',
                                    color: '#3b82f6', cursor: 'pointer' }}>
                                  View
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Roster summary */}
                {ledgerRecords.length > 0 && (
                  <div style={{ flexShrink: 0, paddingTop: '10px', display: 'flex', gap: '20px',
                    fontSize: '12px', color: '#64748b', borderTop: '1px solid #1e293b', marginTop: '4px' }}>
                    <span>Total: <strong style={{ color: '#94a3b8' }}>{ledgerRecords.length}</strong></span>
                    <span>Read: <strong style={{ color: '#10b981' }}>{ledgerRecords.filter(r => r.isRead).length}</strong></span>
                    <span>Replied: <strong style={{ color: '#60a5fa' }}>{ledgerRecords.filter(r => r.hasReplied).length}</strong></span>
                    <span>Paid: <strong style={{ color: '#a78bfa' }}>
                      {ledgerRecords.filter(r => r.paymentStatus === 'PAID').length}
                    </strong></span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default MessagesView;
