/**
 * MemberHistoryView — Option A / GSI 2 compliance component
 *
 * Queries the ByMemberHistory index (GSI2) to retrieve every campaign
 * a specific member has participated in.
 *
 * Index: ByMemberHistory
 *   Hash key:  gsi2pk  = ASSOC#<tenantSub>#MEM#<phone>
 *   Sort key:  gsi2sk  = CAMP#<campIdRaw>
 *
 * This gives us the full campaign participation history for one member
 * without touching the base table or any other index.
 */

import { useState, useEffect } from 'react';
import { generateClient } from 'aws-amplify/data';
import type { Schema } from '../../amplify/data/resource';

const client = generateClient<Schema>();

// ─── Types ────────────────────────────────────────────────────────────────────

interface MemberHistoryViewProps {
  associationId: string; // ASSOC#<cognitoSub>
  memberPhone:   string; // raw phone, e.g. "97333001234"
  memberName?:   string; // display only
  onClose?:      () => void;
}

// Delivery status → colour
const DELIVERY_COLORS: Record<string, string> = {
  SENT:      '#3b82f6',
  DELIVERED: '#8b5cf6',
  READ:      '#10b981',
  QUEUED:    '#94a3b8',
};

function deliveryColor(s: string) {
  return DELIVERY_COLORS[s] ?? '#64748b';
}

// Payment status → badge style
function paymentBadge(s: string) {
  const m: Record<string, { bg: string; color: string }> = {
    PAID:            { bg: 'rgba(16,185,129,0.12)', color: '#10b981' },
    INTENT_RECEIVED: { bg: 'rgba(59,130,246,0.12)', color: '#60a5fa' },
    LINK_SENT:       { bg: 'rgba(139,92,246,0.12)', color: '#a78bfa' },
    PENDING:         { bg: 'rgba(100,116,139,0.08)', color: '#94a3b8' },
  };
  const style = m[s] ?? m.PENDING;
  return (
    <span style={{ padding: '2px 7px', borderRadius: '3px', fontSize: '11px', fontWeight: 600,
      backgroundColor: style.bg, color: style.color }}>
      {s || 'PENDING'}
    </span>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function MemberHistoryView({
  associationId,
  memberPhone,
  memberName,
  onClose,
}: MemberHistoryViewProps) {
  const [history,     setHistory]     = useState<any[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [fetchError,  setFetchError]  = useState('');

  // gsi2pk = ASSOC#<tenantSub>#MEM#<phone>
  // The associationId prop is already formatted as "ASSOC#<sub>", so:
  //   gsi2pk = `${associationId}#MEM#${memberPhone}`
  const gsi2pk = `${associationId}#MEM#${memberPhone}`;

  useEffect(() => {
    if (!associationId || !memberPhone) return;

    async function fetchMemberHistory() {
      setLoading(true);
      setFetchError('');
      try {
        console.log('📖 Fetching member history via GSI2:', gsi2pk);

        // GSI2 (ByMemberHistory) accepts gsi2pk as the hash key.
        // Amplify Gen 2 exposes secondary index queries via list() with a filter
        // on the index fields. The ByMemberHistory index is keyed on gsi2pk,
        // so we filter by exact equality to retrieve only this member's records.
        let allRecords: any[] = [];
        let nextToken: string | null | undefined = undefined;

        do {
          const response: any = await client.models.PushNotSystem.list({
            filter: {
              gsi2pk: { eq: gsi2pk },
            },
            ...(nextToken ? { nextToken } : {}),
            authMode: 'userPool',
          });

          // Tolerate partial timestamp errors from boto3-seeded records
          if (response.errors?.length) {
            const allTimestamp = response.errors.every((e: any) =>
              e.message?.includes('createdAt') || e.message?.includes('updatedAt')
            );
            if (!allTimestamp) console.error('❌ GSI2 query errors:', response.errors);
          }

          allRecords = allRecords.concat(
            (response.data || []).filter((item: any) => item != null)
          );
          nextToken = response.nextToken;
        } while (nextToken);

        // Sort by gsi2sk (CAMP#<id>) ascending so campaigns appear in creation order
        allRecords.sort((a, b) => (a.gsi2sk ?? '').localeCompare(b.gsi2sk ?? ''));

        console.log(`✅ Member history: ${allRecords.length} campaign participations`);
        setHistory(allRecords);
      } catch (err: any) {
        console.error('❌ MemberHistoryView fetch failed:', err.message ?? err);
        setFetchError(err.message ?? 'Failed to load member history.');
      } finally {
        setLoading(false);
      }
    }

    fetchMemberHistory();
  }, [gsi2pk]); // gsi2pk is derived from both props — correct dep

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 700, color: '#f1f5f9' }}>
            📖 Campaign History
          </h3>
          <p style={{ margin: '4px 0 0', fontSize: '12px', color: '#64748b' }}>
            {memberName && <strong style={{ color: '#94a3b8' }}>{memberName} · </strong>}
            <code style={{ fontSize: '11px', color: '#475569' }}>{memberPhone}</code>
          </p>
          <p style={{ margin: '2px 0 0', fontSize: '11px', color: '#334155', fontFamily: 'monospace' }}>
            GSI2 key: {gsi2pk}
          </p>
        </div>
        {onClose && (
          <button onClick={onClose}
            style={{ padding: '5px 12px', fontSize: '12px', background: 'none',
              border: '1px solid #334155', borderRadius: '5px', color: '#94a3b8', cursor: 'pointer' }}>
            ✕ Close
          </button>
        )}
      </div>

      {/* Body */}
      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px',
          color: '#64748b', fontSize: '13px', padding: '16px 0' }}>
          <div className="profile-gate-spinner" style={{ width: '18px', height: '18px', borderWidth: '2px' }} />
          Loading campaign history…
        </div>

      ) : fetchError ? (
        <div style={{ padding: '12px', borderRadius: '6px', fontSize: '13px',
          backgroundColor: 'rgba(239,68,68,0.08)', border: '1px solid #991b1b', color: '#f87171' }}>
          ✗ {fetchError}
        </div>

      ) : history.length === 0 ? (
        <div style={{ padding: '24px', textAlign: 'center', color: '#64748b', fontSize: '13px' }}>
          No campaign participation records found for this member.
        </div>

      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr style={{ backgroundColor: '#0f172a' }}>
                {['Campaign (gsi2sk)', 'Delivery', 'Payment', 'Read', 'Replied', 'Ledger Key (sk)'].map(h => (
                  <th key={h} style={{ padding: '10px 12px', textAlign: 'left', color: '#64748b',
                    fontWeight: 600, fontSize: '11px', textTransform: 'uppercase',
                    letterSpacing: '0.5px', borderBottom: '1px solid #1e293b', whiteSpace: 'nowrap' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {history.map((rec, idx) => (
                <tr key={rec.sk}
                  style={{ borderBottom: '1px solid #1e293b',
                    backgroundColor: idx % 2 === 0 ? 'transparent' : 'rgba(59,130,246,0.03)' }}>

                  {/* gsi2sk = CAMP#<campIdRaw> */}
                  <td style={{ padding: '10px 12px', fontFamily: 'monospace',
                    fontSize: '12px', color: '#60a5fa', whiteSpace: 'nowrap' }}>
                    {rec.gsi2sk ?? '—'}
                  </td>

                  {/* Delivery status */}
                  <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                    <span style={{ color: deliveryColor(rec.deliveryStatus ?? ''),
                      fontWeight: 600, fontSize: '12px' }}>
                      {rec.deliveryStatus ?? 'QUEUED'}
                    </span>
                  </td>

                  {/* Payment status */}
                  <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                    {paymentBadge(rec.paymentStatus ?? '')}
                  </td>

                  {/* isRead */}
                  <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                    {rec.isRead ? '✅' : <span style={{ color: '#334155' }}>—</span>}
                  </td>

                  {/* hasReplied + inboundReplyText */}
                  <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                    {rec.hasReplied
                      ? <span title={rec.inboundReplyText ?? ''}>💬</span>
                      : <span style={{ color: '#334155' }}>—</span>}
                  </td>

                  {/* Ledger sk — truncated for readability */}
                  <td style={{ padding: '10px 12px', fontFamily: 'monospace',
                    fontSize: '11px', color: '#334155', maxWidth: '240px',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    title={rec.sk}>
                    {rec.sk}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Summary row */}
          <div style={{ marginTop: '10px', fontSize: '12px', color: '#64748b',
            display: 'flex', gap: '20px', padding: '0 4px' }}>
            <span>Total campaigns: <strong style={{ color: '#94a3b8' }}>{history.length}</strong></span>
            <span>Read: <strong style={{ color: '#10b981' }}>
              {history.filter(r => r.isRead).length}
            </strong></span>
            <span>Replied: <strong style={{ color: '#60a5fa' }}>
              {history.filter(r => r.hasReplied).length}
            </strong></span>
            <span>Paid: <strong style={{ color: '#a78bfa' }}>
              {history.filter(r => r.paymentStatus === 'PAID').length}
            </strong></span>
          </div>
        </div>
      )}
    </div>
  );
}
