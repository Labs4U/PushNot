import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { generateClient } from 'aws-amplify/data';
import type { Schema } from '../../amplify/data/resource';
import MemberDetailsModal from './MemberDetailsModal';

const client = generateClient<Schema>();

interface BillsViewProps { associationId: string; }

// ── Filter options ─────────────────────────────────────────────────────────
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
function parseLedgerSk(sk: string) {
  const parts = sk.split('#');
  return {
    campId:    parts[1] ?? '—',
    phone:     parts[3] ?? '—',
    timestamp: parts[4] ?? '',
  };
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(undefined, {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return iso; }
}

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
  // phone → MEM# profile map for modal KPI stats
  const [profileMap,    setProfileMap]    = useState<Record<string, any>>({});
  const [loading,       setLoading]       = useState(true);
  const [statusFilter,  setStatusFilter]  = useState<FilterValue>('ALL');

  // ── Phone search state ─────────────────────────────────────────────────────
  const [phoneSearch, setPhoneSearch] = useState('');

  // ── Modal state ────────────────────────────────────────────────────────────
  const [selectedRecord, setSelectedRecord] = useState<any | null>(null);
  const [isModalOpen,    setIsModalOpen]    = useState(false);

  // ── Data fetch ─────────────────────────────────────────────────────────────
  const fetchLedgers = useCallback(async () => {
    if (!associationId) return;
    setLoading(true);
    try {
      // Run both fetches concurrently — ledger records + member profiles
      const paginate = async (skPrefix: string) => {
        let items: any[] = [];
        let nextToken: string | null | undefined = undefined;
        do {
          const res: any = await client.models.PushNotSystem.list({
            filter: { pk: { eq: associationId }, sk: { beginsWith: skPrefix } },
            ...(nextToken ? { nextToken } : {}),
            authMode: 'userPool',
          });
          if (res.errors?.length) {
            const onlyTs = res.errors.every((e: any) =>
              e.message?.includes('createdAt') || e.message?.includes('updatedAt')
            );
            if (!onlyTs) console.error('❌ BillsView errors:', res.errors);
          }
          items = items.concat((res.data ?? []).filter(Boolean));
          nextToken = res.nextToken;
        } while (nextToken);
        return items;
      };

      const [allCamprun, allMem] = await Promise.all([
        paginate('CAMPRUN#'),
        paginate('MEM#'),
      ]);

      // Keep only per-member ledger records (exclude run summaries)
      const memberLedgers = allCamprun.filter(
        (item: any) => typeof item.sk === 'string' && item.sk.includes('#MEM#')
      );
      setLedgerRecords(memberLedgers);
      console.log(`✅ BillsView: ${memberLedgers.length} ledger records, ${allMem.length} profiles`);

      // Build phone → profile lookup map (key = raw phone digits, e.g. "97333787388")
      const map: Record<string, any> = {};
      for (const m of allMem) {
        const sk = m?.sk ?? '';
        // sk = MEM#<phone>
        const phone = sk.startsWith('MEM#') ? sk.slice(4) : sk;
        if (phone) map[phone] = m;
      }
      setProfileMap(map);

    } catch (err) {
      console.error('❌ BillsView fetch failed:', err);
    } finally {
      setLoading(false);
    }
  }, [associationId]);

  useEffect(() => { fetchLedgers(); }, [fetchLedgers]);

  // ── Summary metrics (always full dataset) ─────────────────────────────────
  const totalContributions = useMemo(() =>
    ledgerRecords.reduce((acc, r) => acc + (r?.paymentAmount ?? 0), 0), [ledgerRecords]);
  const paidCount     = useMemo(() => ledgerRecords.filter(r => r?.paymentStatus === 'PAID').length,           [ledgerRecords]);
  const awaitingCount = useMemo(() => ledgerRecords.filter(r => r?.paymentStatus === 'PENDING' || r?.paymentStatus === 'LINK_SENT').length, [ledgerRecords]);
  const intentCount   = useMemo(() => ledgerRecords.filter(r => r?.paymentStatus === 'INTENT_RECEIVED').length, [ledgerRecords]);

  // ── Filtered records: status filter + phone search (both applied) ──────────
  const filteredRecords = useMemo(() => {
    let rows = ledgerRecords;

    // Status filter
    if (statusFilter !== 'ALL') {
      rows = rows.filter(r => {
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
    }

    // Phone search filter — partial match against the parsed phone segment
    if (phoneSearch.trim()) {
      const q = phoneSearch.trim().replace(/^\+/, ''); // strip leading + if entered
      rows = rows.filter(r => {
        const { phone } = parseLedgerSk(r?.sk ?? '');
        return phone.includes(q);
      });
    }

    return rows;
  }, [ledgerRecords, statusFilter, phoneSearch]);

  // ── Handlers ───────────────────────────────────────────────────────────────
  function openModal(record: any) {
    setSelectedRecord(record);
    setIsModalOpen(true);
  }
  function closeModal() {
    setIsModalOpen(false);
    setSelectedRecord(null);
  }

  // ── Render ─────────────────────────────────────────────────────────────────
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
            <SummaryCard label="Total Contributions" value={`$${totalContributions.toFixed(2)}`}
              sub={`${ledgerRecords.length} ledger entries`} color="#10b981" />
            <SummaryCard label="Payments Confirmed"  value={paidCount.toString()}
              sub="Completed transactions"              color="#3b82f6" />
            <SummaryCard label="Intent Received"     value={intentCount.toString()}
              sub="Clicked contribute button"           color="#60a5fa" />
            <SummaryCard label="Awaiting Response"   value={awaitingCount.toString()}
              sub="Pending / link sent"                 color="#f59e0b" />
          </div>

          {/* ── Filter + phone search row ── */}
          <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            <label style={{ whiteSpace: 'nowrap', fontWeight: 600, color: '#94a3b8', fontSize: '13px' }}>
              Filter:
            </label>

            {/* Status dropdown */}
            <select value={statusFilter}
              onChange={e => setStatusFilter(e.target.value as FilterValue)}
              style={{ maxWidth: '220px', backgroundColor: '#0f172a',
                border: '1px solid #334155', borderRadius: '6px', color: '#e2e8f0',
                padding: '7px 12px', fontSize: '13px', cursor: 'pointer' }}>
              {FILTER_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>

            {/* Phone search input */}
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
              <span style={{
                position: 'absolute', left: '10px', color: '#475569',
                fontSize: '13px', pointerEvents: 'none',
              }}>🔍</span>
              <input
                type="text"
                placeholder="Search phone (e.g., 345)"
                value={phoneSearch}
                onChange={e => setPhoneSearch(e.target.value)}
                style={{
                  paddingLeft: '30px', paddingRight: '10px',
                  paddingTop: '7px', paddingBottom: '7px',
                  width: '200px', backgroundColor: '#0f172a',
                  border: '1px solid #334155', borderRadius: '6px',
                  color: '#e2e8f0', fontSize: '13px',
                  outline: 'none',
                  fontFamily: 'inherit',
                }}
                onFocus={e  => (e.target.style.borderColor = '#3b82f6')}
                onBlur={e   => (e.target.style.borderColor = '#334155')}
              />
              {phoneSearch && (
                <button
                  onClick={() => setPhoneSearch('')}
                  style={{
                    position: 'absolute', right: '8px', background: 'none',
                    border: 'none', color: '#64748b', cursor: 'pointer',
                    fontSize: '14px', padding: '0', lineHeight: 1,
                  }}
                  aria-label="Clear search"
                >✕</button>
              )}
            </div>

            {/* Record count */}
            <span style={{ fontSize: '12px', color: '#475569', whiteSpace: 'nowrap' }}>
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
                  : phoneSearch
                    ? `No records match phone "${phoneSearch}".`
                    : 'No records match the selected filter.'}
              </div>
            ) : (
              <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                  <thead style={{ position: 'sticky', top: 0, backgroundColor: '#0f172a', zIndex: 10 }}>
                    <tr style={{ borderBottom: '2px solid #334155' }}>
                      {['Phone', 'Campaign', 'Delivery', 'Payment', 'Amount', 'Last Activity'].map(h => (
                        <th key={h} style={{
                          padding: '10px 10px',
                          textAlign: h === 'Amount' ? 'right' : 'left',
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
                      const baseColor = idx % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)';

                      return (
                        <tr
                          key={item.sk}
                          onClick={() => openModal(item)}
                          onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'rgba(59,130,246,0.08)')}
                          onMouseLeave={e => (e.currentTarget.style.backgroundColor = baseColor)}
                          style={{
                            borderBottom: '1px solid #1e293b',
                            backgroundColor: baseColor,
                            cursor: 'pointer',
                            transition: 'background-color 0.12s',
                          }}
                        >
                          {/* Phone */}
                          <td style={{ padding: '10px 10px', color: '#cbd5e1',
                            fontFamily: 'monospace', fontSize: '12px', whiteSpace: 'nowrap' }}>
                            {/* Highlight matching digits */}
                            {phoneSearch && phone.includes(phoneSearch.replace(/^\+/, ''))
                              ? (() => {
                                  const q     = phoneSearch.replace(/^\+/, '');
                                  const start = phone.indexOf(q);
                                  return (
                                    <span>
                                      +{phone.slice(0, start)}
                                      <mark style={{ backgroundColor: 'rgba(59,130,246,0.35)',
                                        color: '#93c5fd', borderRadius: '2px', padding: '0 1px' }}>
                                        {phone.slice(start, start + q.length)}
                                      </mark>
                                      {phone.slice(start + q.length)}
                                    </span>
                                  );
                                })()
                              : `+${phone}`}
                          </td>

                          {/* Campaign */}
                          <td style={{ padding: '10px 10px', color: '#475569',
                            fontFamily: 'monospace', fontSize: '11px', whiteSpace: 'nowrap' }}>
                            {campId}
                          </td>

                          {/* Delivery */}
                          <td style={{ padding: '10px 10px' }}>
                            {deliveryBadge(item.deliveryStatus ?? '')}
                          </td>

                          {/* Payment */}
                          <td style={{ padding: '10px 10px' }}>
                            {paymentBadge(item.paymentStatus ?? '')}
                          </td>

                          {/* Amount */}
                          <td style={{ padding: '10px 10px', textAlign: 'right',
                            color: (item.paymentAmount ?? 0) > 0 ? '#10b981' : '#334155',
                            fontWeight: 600 }}>
                            ${((item.paymentAmount as number) ?? 0).toFixed(2)}
                          </td>

                          {/* Last Activity */}
                          <td style={{ padding: '10px 10px', color: '#64748b',
                            fontSize: '12px', whiteSpace: 'nowrap' }}>
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

      {/* ── Member Details Modal ── */}
      {isModalOpen && selectedRecord && (() => {
        const { phone } = parseLedgerSk(selectedRecord.sk ?? '');
        // Aggregate all ledger records across all campaigns for this phone.
        // This gives the modal cross-campaign LTV, true engagement/conversion
        // rates, and the most recent chatAnalysis — not just the clicked row.
        const memberHistory = ledgerRecords.filter(r => {
          const { phone: rPhone } = parseLedgerSk(r?.sk ?? '');
          return rPhone === phone;
        });
        return (
          <MemberDetailsModal
            ledgerRecord={selectedRecord}
            memberProfile={profileMap[phone]}
            memberHistory={memberHistory}
            phone={phone}
            onClose={closeModal}
          />
        );
      })()}

    </div>
  );
};

export default BillsView;
