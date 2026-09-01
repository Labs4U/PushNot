/**
 * MemberDetailsModal
 *
 * Displays member statistics, AI chat analysis, and a performance funnel.
 *
 * Props:
 *   ledgerRecord   — the specific CAMPRUN ledger row that was clicked
 *   memberProfile  — the MEM# profile record (name, address, persona, etc.)
 *   memberHistory  — ALL ledger records for this phone across all campaigns
 *                    (optional; when provided, stats are calculated from it
 *                     instead of relying on potentially stale MEM# fields)
 *   phone          — raw phone digits (no leading +)
 *   onClose        — callback to dismiss the modal
 */

import React from 'react';

// ── Value extractors (handle both Amplify-normalised and raw DynamoDB formats) ─
function pct(val: any): number {
  if (val == null) return 0;
  if (typeof val === 'object' && val.N) return parseFloat(val.N) || 0;
  const n = parseFloat(String(val));
  return isNaN(n) ? 0 : Math.min(100, Math.max(0, n));
}

function money(val: any): number {
  if (val == null) return 0;
  if (typeof val === 'object' && val.N) return parseFloat(val.N) || 0;
  const n = parseFloat(String(val));
  return isNaN(n) ? 0 : n;
}

function str(val: any): string {
  if (val == null) return '—';
  if (typeof val === 'object' && val.S) return val.S;
  const s = String(val);
  return s === 'null' || s === 'undefined' ? '—' : s;
}

// ── Sentiment badge ───────────────────────────────────────────────────────────
const SENTIMENT_STYLE: Record<string, { bg: string; color: string }> = {
  POSITIVE:   { bg: 'rgba(16,185,129,0.15)',  color: '#10b981' },
  NEUTRAL:    { bg: 'rgba(148,163,184,0.15)', color: '#94a3b8' },
  NEGATIVE:   { bg: 'rgba(239,68,68,0.15)',   color: '#f87171' },
  FRUSTRATED: { bg: 'rgba(251,146,60,0.15)',  color: '#fb923c' },
  'N/A':      { bg: 'rgba(100,116,139,0.12)', color: '#64748b' },
};

function SentimentBadge({ sentiment }: { sentiment: string }) {
  const s = SENTIMENT_STYLE[sentiment] ?? SENTIMENT_STYLE.NEUTRAL;
  return (
    <span style={{
      padding: '3px 10px', borderRadius: '12px', fontSize: '12px',
      fontWeight: 700, backgroundColor: s.bg, color: s.color,
      letterSpacing: '0.4px',
    }}>
      {sentiment || 'N/A'}
    </span>
  );
}

// ── Inline stat row ───────────────────────────────────────────────────────────
function StatRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '9px 0', borderBottom: '1px solid #1e293b',
    }}>
      <span style={{ fontSize: '13px', fontWeight: 600, color: '#64748b' }}>{label}</span>
      <span style={{ fontSize: '14px', fontWeight: 700, color: '#f1f5f9' }}>{value}</span>
    </div>
  );
}

// ── Bar chart row (width driven by percentage) ────────────────────────────────
function BarRow({ label, value, color }: { label: string; value: number; color: string }) {
  const clamped = Math.min(100, Math.max(0, value));
  return (
    <div style={{ marginBottom: '14px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between',
        marginBottom: '5px', fontSize: '12px', color: '#94a3b8' }}>
        <span>{label}</span>
        <span style={{ fontWeight: 700, color }}>{clamped.toFixed(1)}%</span>
      </div>
      <div style={{ width: '100%', height: '10px', backgroundColor: '#0f172a',
        borderRadius: '5px', overflow: 'hidden' }}>
        <div style={{
          width: `${clamped}%`, height: '100%',
          backgroundColor: color, borderRadius: '5px',
          transition: 'width 0.6s ease',
        }} />
      </div>
    </div>
  );
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface MemberDetailsModalProps {
  ledgerRecord:   any;              // the clicked CAMPRUN ledger row
  memberProfile?: any;              // MEM# profile (name, address, persona)
  memberHistory?: any[];            // ALL ledger rows for this phone — used for aggregate stats
  phone:          string;
  onClose:        () => void;
}

// ── chatAnalysis parser ───────────────────────────────────────────────────────
function parseAnalysis(raw: any) {
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────

export default function MemberDetailsModal({
  ledgerRecord,
  memberProfile,
  memberHistory,
  phone,
  onClose,
}: MemberDetailsModalProps) {

  // ── Aggregate stats from memberHistory ────────────────────────────────────
  // When memberHistory is available (Billing Tab) we derive all numeric KPIs
  // from the actual ledger records rather than from the potentially stale MEM#
  // profile fields. This gives true cross-campaign LTV, engagement, and rates.
  const hasHistory = Array.isArray(memberHistory) && memberHistory.length > 0;

  const totalCampaigns = hasHistory
    ? memberHistory.length
    : (memberProfile ? (memberProfile.totalCampaignsReceived ?? 0) : 0);

  const engagementCount = hasHistory
    ? memberHistory.filter(r => r?.hasReplied === true || r?.isRead === true).length
    : 0;

  const conversionCount = hasHistory
    ? memberHistory.filter(r => r?.paymentStatus === 'PAID' || r?.hasPaid === true).length
    : 0;

  // Rates: derived from history when available; fall back to MEM# profile fields
  const engagementRate = hasHistory
    ? (totalCampaigns > 0 ? (engagementCount / totalCampaigns) * 100 : 0)
    : pct(memberProfile?.engagementRatePercent);

  const conversionRate = hasHistory
    ? (totalCampaigns > 0 ? (conversionCount / totalCampaigns) * 100 : 0)
    : pct(memberProfile?.conversionRatePercent);

  // Financials: always sum from ledger records when available
  const ltv = hasHistory
    ? memberHistory.reduce((acc, r) => acc + money(r?.paymentAmount), 0)
    : money(memberProfile?.lifetimeContributionAmount);

  const avgContribution = hasHistory
    ? (conversionCount > 0 ? ltv / conversionCount : 0)
    : money(memberProfile?.averageContributionAmount);

  // ── Profile display fields (name/address/persona from MEM# record) ─────────
  const member  = memberProfile ?? {};
  const name    = str(member.name);
  const region  = str(member.address);
  const persona = str(member.interactionPersona);

  // ── AI Chat Analysis: find the most recent record with chatAnalysis ────────
  // Sort by updatedAt descending and pick the first record that has a populated
  // chatAnalysis field. This ensures the modal always shows the latest sentiment.
  let analysis: { sentiment: string; summary: string; lastInteraction?: string } = {
    sentiment: 'N/A',
    summary: 'No recent chat recorded.',
  };

  if (hasHistory) {
    const sorted = [...memberHistory].sort((a, b) => {
      const ta = a?.updatedAt ?? a?.createdAt ?? '';
      const tb = b?.updatedAt ?? b?.createdAt ?? '';
      return tb.localeCompare(ta); // descending
    });
    for (const r of sorted) {
      const parsed = parseAnalysis(r?.chatAnalysis);
      if (parsed?.summary) {
        analysis = parsed;
        break;
      }
    }
  } else {
    // Single record path (MessagesView)
    const parsed = parseAnalysis(ledgerRecord?.chatAnalysis);
    if (parsed) analysis = parsed;
  }

  // ── Current record's delivery/payment status (from the clicked row) ────────
  const deliveryStatus = str(ledgerRecord?.deliveryStatus);
  const paymentStatus  = str(ledgerRecord?.paymentStatus);

  // ─────────────────────────────────────────────────────────────────────────────
  return (
    /* ── Overlay ── */
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        backgroundColor: 'rgba(0,0,0,0.65)',
        backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '16px',
      }}
    >
      {/* ── Card ── */}
      <div
        onClick={e => e.stopPropagation()}
        style={{
          backgroundColor: '#1e293b', border: '1px solid #334155',
          borderRadius: '12px', width: '100%', maxWidth: '560px',
          maxHeight: '90vh', overflowY: 'auto',
          boxShadow: '0 24px 48px rgba(0,0,0,0.5)',
          display: 'flex', flexDirection: 'column',
        }}
      >
        {/* ── Header ── */}
        <div style={{
          padding: '18px 20px 14px', borderBottom: '1px solid #334155',
          display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
          flexShrink: 0,
        }}>
          <div>
            <div style={{ fontSize: '17px', fontWeight: 700, color: '#f1f5f9' }}>
              {name !== '—' ? name : `+${phone}`}
            </div>
            <div style={{ fontSize: '13px', color: '#64748b', marginTop: '3px', fontFamily: 'monospace' }}>
              +{phone}{region !== '—' ? ` · ${region}` : ''}
            </div>
            {hasHistory && (
              <div style={{ fontSize: '11px', color: '#475569', marginTop: '3px' }}>
                {totalCampaigns} campaign{totalCampaigns !== 1 ? 's' : ''} across all history
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'none', border: '1px solid #334155', borderRadius: '6px',
              color: '#94a3b8', fontSize: '16px', cursor: 'pointer',
              width: '32px', height: '32px', display: 'flex',
              alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}
            aria-label="Close"
          >✕</button>
        </div>

        {/* ── Body ── */}
        <div style={{ padding: '16px 20px 20px', display: 'flex', flexDirection: 'column', gap: '20px' }}>

          {/* ── Section 1: AI Chat Analysis ── */}
          <div>
            <div style={{ fontSize: '11px', fontWeight: 700, color: '#475569',
              textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: '10px' }}>
              AI Chat Analysis
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
              <SentimentBadge sentiment={analysis.sentiment} />
              {analysis.lastInteraction && (
                <span style={{ fontSize: '11px', color: '#475569' }}>
                  Last: {new Date(analysis.lastInteraction).toLocaleString(undefined, {
                    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
                  })}
                </span>
              )}
              {hasHistory && (
                <span style={{ fontSize: '11px', color: '#334155', marginLeft: 'auto' }}>
                  most recent of {totalCampaigns}
                </span>
              )}
            </div>
            <div style={{
              padding: '10px 14px', borderRadius: '6px', fontSize: '13px',
              backgroundColor: 'rgba(59,130,246,0.06)', border: '1px solid #1e3a5f',
              color: '#cbd5e1', lineHeight: '1.5',
            }}>
              {analysis.summary}
            </div>
          </div>

          {/* ── Section 2: Aggregate KPIs ── */}
          <div>
            <div style={{ fontSize: '11px', fontWeight: 700, color: '#475569',
              textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: '10px' }}>
              Member Statistics{hasHistory ? ' (aggregated across all campaigns)' : ''}
            </div>
            <div style={{ backgroundColor: '#0f172a', borderRadius: '8px', padding: '0 12px' }}>
              <StatRow
                label="Total Campaigns Received"
                value={totalCampaigns > 0 ? totalCampaigns : '—'} />
              <StatRow
                label={hasHistory ? `Engagements (replied/read)` : 'Engagement Rate'}
                value={
                  hasHistory
                    ? <span style={{ color: '#3b82f6' }}>
                        {engagementCount} <span style={{ fontSize: '12px', color: '#475569' }}>
                          ({engagementRate.toFixed(1)}%)
                        </span>
                      </span>
                    : <span style={{ color: '#3b82f6' }}>{engagementRate.toFixed(1)}%</span>
                } />
              <StatRow
                label={hasHistory ? `Conversions (paid)` : 'Conversion Rate'}
                value={
                  hasHistory
                    ? <span style={{ color: '#10b981' }}>
                        {conversionCount} <span style={{ fontSize: '12px', color: '#475569' }}>
                          ({conversionRate.toFixed(1)}%)
                        </span>
                      </span>
                    : <span style={{ color: '#10b981' }}>{conversionRate.toFixed(1)}%</span>
                } />
              <StatRow
                label="Avg. Contribution per Payment"
                value={avgContribution > 0 ? `$${avgContribution.toFixed(2)}` : '—'} />
              <StatRow
                label="Lifetime Value (LTV)"
                value={ltv > 0
                  ? <span style={{ color: '#a78bfa' }}>${ltv.toFixed(2)}</span>
                  : '—'} />
              {persona !== '—' && (
                <StatRow
                  label="Interaction Persona"
                  value={
                    <span style={{ fontSize: '12px', padding: '2px 8px', borderRadius: '4px',
                      backgroundColor: 'rgba(139,92,246,0.12)', color: '#a78bfa' }}>
                      {persona}
                    </span>
                  } />
              )}
              <StatRow label="Last Delivery Status" value={deliveryStatus} />
              <StatRow label="Last Payment Status"  value={paymentStatus} />
            </div>
          </div>

          {/* ── Section 3: Performance Funnel ── */}
          <div>
            <div style={{ fontSize: '11px', fontWeight: 700, color: '#475569',
              textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: '14px' }}>
              Performance Funnel{hasHistory ? ' — cross-campaign rates' : ''}
            </div>

            {/* Individual bars — width driven by calculated percentages */}
            <BarRow label="Engagement Rate" value={engagementRate} color="#3b82f6" />
            <BarRow label="Conversion Rate" value={conversionRate} color="#10b981" />

            {/* Stacked comparative view */}
            <div style={{ marginTop: '8px' }}>
              <div style={{ fontSize: '11px', color: '#475569', marginBottom: '6px' }}>
                Comparative view
              </div>
              <div style={{ width: '100%', height: '18px', backgroundColor: '#0f172a',
                borderRadius: '9px', overflow: 'hidden', position: 'relative' }}>
                {/* Engagement baseline — semi-transparent blue */}
                <div style={{
                  position: 'absolute', left: 0, top: 0,
                  width: `${Math.min(100, engagementRate)}%`, height: '100%',
                  backgroundColor: 'rgba(59,130,246,0.35)', borderRadius: '9px',
                }} />
                {/* Conversion overlay — solid green, always narrower */}
                <div style={{
                  position: 'absolute', left: 0, top: 0,
                  width: `${Math.min(100, conversionRate)}%`, height: '100%',
                  backgroundColor: '#10b981', borderRadius: '9px',
                }} />
              </div>
              <div style={{ display: 'flex', gap: '16px', marginTop: '6px', fontSize: '11px' }}>
                <span style={{ color: 'rgba(59,130,246,0.7)' }}>■ Engagement {engagementRate.toFixed(1)}%</span>
                <span style={{ color: '#10b981' }}>■ Conversion {conversionRate.toFixed(1)}%</span>
              </div>
            </div>

            {/* Ledger breakdown — only shown when history is available */}
            {hasHistory && (
              <div style={{
                marginTop: '16px', padding: '10px 14px', borderRadius: '6px',
                backgroundColor: 'rgba(15,23,42,0.6)', border: '1px solid #1e293b',
                display: 'flex', gap: '20px', flexWrap: 'wrap',
              }}>
                {[
                  { label: 'Campaigns', value: totalCampaigns,    color: '#94a3b8' },
                  { label: 'Replied/Read', value: engagementCount, color: '#3b82f6' },
                  { label: 'Paid',          value: conversionCount, color: '#10b981' },
                  { label: 'LTV',           value: `$${ltv.toFixed(2)}`, color: '#a78bfa' },
                ].map(({ label, value, color }) => (
                  <div key={label} style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                    <span style={{ fontSize: '10px', color: '#475569', textTransform: 'uppercase',
                      letterSpacing: '0.4px' }}>{label}</span>
                    <span style={{ fontSize: '16px', fontWeight: 700, color }}>{value}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

        </div>
      </div>
    </div>
  );
}
