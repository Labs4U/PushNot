import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { generateClient } from 'aws-amplify/data';
import type { Schema } from '../../amplify/data/resource';

const client = generateClient<Schema>();

interface BillsViewProps { associationId: string; }

// ── Filter options — values must match the filter predicate switch below ──────
const FILTER_OPTIONS = [
  { value: 'ALL',       label: 'All Records' },
  { value: 'SENT',      label: 'Sent' },
  { value: 'DELIVERED', label: 'Delivered' },
  { value: 'READ',      label: 'Read' },
  { value: 'REPLIED',   label: 'Replied' },
  { value: 'LINK_SENT', label: 'Payment Link Sent' },
  { value: 'PAID',      label: 'Paid' },
] as const;

type FilterValue = typeof FILTER_OPTIONS[number]['value'];

// ── Parse Option A ledger sk: CAMPRUN#<campId>#MEM#<phone>#<timestamp> ────────
function parseLedgerSk(sk: string): { campId: string; phone: string; timestamp: string } {
  // sk.split('#') → ['CAMPRUN', campId, 'MEM', phone, timestamp]
  const parts = sk.split('#');
  return {
    campId:    parts[1] ?? '—',          // index 1
    phone:     parts[3] ?? '—',          // index 3
    timestamp: parts[4] ?? '',           // index 4 (ms epoch)
  };
}

// ── Format ISO 8601 → human-readable local date/time ─────────────────────────
function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(undefined, {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

// ── Coloured status badge ─────────────────────────────────────────────────────
function Badge({ text, color }: { text: string; color: string }) {
  return (
    <span style={{
      display: 'inline-block', padding: '3px 8px', borderRadius: '4px',
      fontSize: '11px', fontWeight: 600,
      backgroundColor: `${color}22`, color,
    }}>
      {text}
    </span>
  );
}

function deliveryBadge(status: string) {
  const map: Record<string, string> = {
    SENT: '#3b82f6', DELIVERED: '#8b5cf6', READ: '#10b981', QUEUED: '#64748b',
  };
  return <Badge text={status || 'QUEUED'} color={map[status] ?? '#64748b'} />;
}

function paymentBadge(status: string) {
  const map: Record<string, string> = {
    PAID: '#10b981', LINK_SENT: '#f59e0b', INTENT_RECEIVED: '#60a5fa', PENDING: '#64748b',
  };
  return <Badge text={status || 'PENDING'} color={map[status] ?? '#64748b'} />;
}

// ── Summary card ──────────────────────────────────────────────────────────────
function SummaryCard({ label, value, sub, color }: {
  label: string; value: string; sub: string; color: string;
}) {
  return (
    <div className="panel" style={{ minHeight: '100px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
      <div style={{ fontSize: '11px', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>
        {label}
      </div>
      <div style={{ fontSize: '28px', fontWeight: 700, color, marginBottom: '4px' }}>{value}</div>
      <div style={{ fontSize: '11px', color: '#64748b' }}>{sub}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

const BillsView: React.FC<BillsViewProps> = ({ associationId }) => {
  const [ledgerRecords, setLedgerRecords] = useState<any[]>([]);
  const [loading,       setLoading]       = useState(true);
  const [statusFilter,  setStatusFilter]  = useState<FilterValue>('ALL');

  // ── Fetch all per-member ledger records for this tenant ───────────────────
  // Option A base table pattern:
  //   pk  = associationId  (ASSOC#<sub>)
  //   sk  beginsWith  CAMPRUN#
  //   then keep only records that contain #MEM# (excludes run summary records)
  const fetchLedgers = useCallback(async () => {
    if (!associationId) return;
    setLoading(true);
    try {
      let items: any[] = [];
      let nextToken: string | null | undefined = undefined;

      do {
        const res: any = await client.models.PushNotSystem.list({
          filter: {
            pk: { eq: associationId },
            sk: { beginsWith: 'CAMPRUN#' },
          },
          ...(nextToken ? { nextToken } : {}),
          authMode: 'userPool',
        });

        // Tolerate records missing createdAt (Lambda-written via UpdateItem)
        if (res.errors?.length) {
          const onlyTimestamp = res.errors.every((e: any) =>
            e.message?.includes('createdAt') || e.message?.includes('updatedAt')
          );
          if (!onlyTimestamp) console.error('❌ BillsView AppSync errors:', res.errors);
          else console.warn(`⚠️ ${res.errors.length} record(s) missing createdAt — redeploy processOutboundQueue to fix`);
        }

        const page = (res.data ?? []).filter(Boolean);
        items = items.concat(page);
        nextToken = res.nextToken;
      } while (nextToken);

      // Keep only per-member ledger records; skip run summaries (sk = CAMPRUN#<id>)
      const memberLedgers = items.filter(
        (item: any) => typeof item.sk === 'string' && item.sk.includes('#MEM#')
      );

      console.log(`✅ BillsView: ${memberLedgers.length} ledger records loaded`);
      setLedgerRecords(memberLedgers);
    } catch (err) {
      console.error('❌ BillsView fetch failed:', err);
    } finally {
      setLoading(false);
    }
  }, [associationId]);

  useEffect(() => {
    fetchLedgers();
  }, [fetchLedgers]); // fetchLedgers memoised on associationId

  // ── Summary card metrics (always across all records, not filtered) ─────────
  const totalContributions = useMemo(() =>
    ledgerRecords.reduce((acc, r) => acc + (r?.paymentAmount ?? 0), 0),
  [ledgerRecords]);

  const paidCount = useMemo(() =>
    ledgerRecords.filter(r => r?.paymentStatus === 'PAID').length,
  [ledgerRecords]);

  const awaitingCount = useMemo(() =>
    ledgerRecords.filter(r =>
      r?.paymentStatus === 'PENDING' || r?.paymentStatus === 'LINK_SENT'
    ).length,
  [ledgerRecords]);

  const intentCount = useMemo(() =>
    ledgerRecords.filter(r => r?.paymentStatus === 'INTENT_RECEIVED').length,
  [ledgerRecords]);

  // ── Filtered table rows ────────────────────────────────────────────────────
  const filteredRecords = useMemo(() => {
    if (statusFilter === 'ALL') return ledgerRecords;
    return ledgerRecords.filter(r => {
      if (!r) return false;
      switch (statusFilter) {
        case 'SENT':      return r.deliveryStatus === 'SENT';
        case 'DELIVERED': return r.deliveryStatus === 'DELIVERED';
        case 'READ':      return r.isRead === true;
        case 'REPLIED':   return r.hasReplied === true;
        case 'LINK_SENT': return r.paymentStatus === 'LINK_SENT';
        case 'PAID':      return r.paymentStatus === 'PAID';
        default:          return true;
      }
    });
  }, [ledgerRecords, statusFilter]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="view-single-col">

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '0 16px', flexShrink: 0 }}>
        <h2 style={{ margin: 0, fontSize: '20px', fontWeight: 600, color: '#f1f5f9' }}>
          💳 Member Contributions &amp; Ledger
        </h2>
        <button onClick={fetchLedgers}
          style={{ background: '#1e293b', color: '#94a3b8', border: '1px solid #334155',
            borderRadius: '6px', padding: '8px 16px', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}>
          🔄 Refresh
        </button>
      </div>

      {loading ? (
        <div className="panel" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ textAlign: 'center', color: '#94a3b8' }}>
            <div className="profile-gate-spinner" style={{ margin: '0 auto 12px' }} />
            <div style={{ fontSize: '14px' }}>Loading ledger records…</div>
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', gap: '16px', padding: '0 16px' }}>

          {/* ── Summary cards ── */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
            gap: '16px', flexShrink: 0 }}>
            <SummaryCard
              label="Total Contributions"
              value={`$${totalContributions.toFixed(2)}`}
              sub={`${ledgerRecords.length} ledger entries`}
              color="#10b981" />
            <SummaryCard
              label="Payments Confirmed"
              value={paidCount.toString()}
              sub="Completed transactions"
              color="#3b82f6" />
            <SummaryCard
              label="Intent Received"
              value={intentCount.toString()}
              sub="Clicked contribute button"
              color="#60a5fa" />
            <SummaryCard
              label="Awaiting Response"
              value={awaitingCount.toString()}
              sub="Pending / link sent"
              color="#f59e0b" />
          </div>

          {/* ── Filter row ── */}
          <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: '12px' }}>
            <label style={{ whiteSpace: 'nowrap', fontWeight: 600, color: '#94a3b8', fontSize: '13px' }}>
              Filter:
            </label>
            <select value={statusFilter}
              onChange={e => setStatusFilter(e.target.value as FilterValue)}
              style={{ flex: 1, maxWidth: '280px', backgroundColor: '#0f172a',
                border: '1px solid #334155', borderRadius: '6px', color: '#e2e8f0',
                padding: '8px 12px', fontSize: '13px', cursor: 'pointer' }}>
              {FILTER_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
            <span style={{ fontSize: '12px', color: '#475569' }}>
              {filteredRecords.length} of {ledgerRecords.length} records
            </span>
          </div>

          {/* ── Ledger table ── */}
          <div className="panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {filteredRecords.length === 0 ? (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: '#64748b', fontSize: '13px' }}>
                {ledgerRecords.length === 0
                  ? 'No ledger records found. Broadcast a campaign to populate this view.'
                  : 'No records match the selected filter.'}
              </div>
            ) : (
              <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                  <thead style={{ position: 'sticky', top: 0, backgroundColor: '#0f172a', zIndex: 10 }}>
                    <tr style={{ borderBottom: '2px solid #334155' }}>
                      {['Phone', 'Campaign', 'Delivery', 'Payment', 'Amount', 'Last Activity'].map(h => (
                        <th key={h} style={{
                          padding: '10px 10px', textAlign: ['Amount'].includes(h) ? 'right' : 'left',
                          fontWeight: 600, color: '#94a3b8', fontSize: '11px',
                          textTransform: 'uppercase', letterSpacing: '0.4px',
                        }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRecords.map((item, idx) => {
                      if (!item) return null;
                      const { campId, phone } = parseLedgerSk(item.sk ?? '');

                      return (
                        <tr key={item.sk}
                          style={{
                            borderBottom: '1px solid #1e293b',
                            backgroundColor: idx % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)',
                          }}>

                          {/* Phone number — parsed from sk parts[3] */}
                          <td style={{ padding: '10px 10px', color: '#cbd5e1',
                            fontFamily: 'monospace', fontSize: '12px', whiteSpace: 'nowrap' }}>
                            +{phone}
                          </td>

                          {/* Campaign ID — parsed from sk parts[1] */}
                          <td style={{ padding: '10px 10px', color: '#475569',
                            fontFamily: 'monospace', fontSize: '11px', whiteSpace: 'nowrap' }}>
                            {campId}
                          </td>

                          {/* Delivery status */}
                          <td style={{ padding: '10px 10px' }}>
                            {deliveryBadge(item.deliveryStatus ?? '')}
                          </td>

                          {/* Payment status */}
                          <td style={{ padding: '10px 10px' }}>
                            {paymentBadge(item.paymentStatus ?? '')}
                          </td>

                          {/* Amount — defaults to $0.00 if undefined */}
                          <td style={{ padding: '10px 10px', textAlign: 'right',
                            color: (item.paymentAmount ?? 0) > 0 ? '#10b981' : '#334155',
                            fontWeight: 600 }}>
                            ${((item.paymentAmount as number) ?? 0).toFixed(2)}
                          </td>

                          {/* Last activity — updatedAt formatted as local date/time */}
                          <td style={{ padding: '10px 10px', color: '#64748b', fontSize: '12px',
                            whiteSpace: 'nowrap' }}>
                            {formatDate(item.updatedAt)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

        </div>
      )}
    </div>
  );
};

export default BillsView;
