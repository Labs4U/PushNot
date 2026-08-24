import React, { useState, useEffect } from 'react';
import { generateClient } from 'aws-amplify/data';
import type { Schema } from '../../amplify/data/resource';

const client = generateClient<Schema>();
const CURRENT_ASSOCIATION_ID = 'ASSOC#101';

const BillsView: React.FC = () => {
  const [records, setRecords] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState<string>('ALL');

  const fetchRecords = async () => {
    setLoading(true);
    try {
      const { data } = await client.models.PushNotSystem.list(
        {
          filter: {
            pk: { eq: CURRENT_ASSOCIATION_ID },
            entityType: { eq: 'CAMPAIGN_RUN' },
          },
          authMode: 'apiKey',
        }
      );

      if (data && Array.isArray(data)) {
        // Filter out null/undefined entries
        const validRecords = data.filter((item: any) => item != null);
        setRecords(validRecords);
        console.log('✅ Bills data loaded:', validRecords.length, 'records');
      }
    } catch (err) {
      console.error('❌ Error fetching contribution records:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRecords();
  }, []);

  const filtered = filterStatus === 'ALL'
    ? records
    : records.filter((r) => r && (r.paymentStatus === filterStatus || r.deliveryStatus === filterStatus));

  // Compute summary statistics with null-safety
  const totalContributions = records.reduce((acc, curr) => acc + (curr?.paymentAmount || 0), 0);
  const paidCount = records.filter((r) => r && r.paymentStatus === 'PAID').length;
  const pendingCount = records.filter((r) => r && (r.paymentStatus === 'PENDING' || r.paymentStatus === 'LINK_SENT')).length;

  return (
    <div className="view-single-col">
      {/* Header with Refresh Button */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '0 16px',
          flexShrink: 0,
        }}
      >
        <h2 style={{ margin: 0, fontSize: '20px', fontWeight: 600, color: '#f1f5f9' }}>
          💳 Member Contributions & Ledger
        </h2>
        <button
          onClick={fetchRecords}
          style={{
            background: '#3b82f6',
            color: '#f1f5f9',
            border: 'none',
            borderRadius: '6px',
            padding: '8px 16px',
            fontSize: '13px',
            fontWeight: 600,
            cursor: 'pointer',
            transition: 'all 0.2s ease-in-out',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#2563eb')}
          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = '#3b82f6')}
        >
          🔄 Refresh
        </button>
      </div>

      {loading ? (
        <div className="panel" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ textAlign: 'center', color: '#94a3b8' }}>
            <div style={{ fontSize: '14px', marginBottom: '8px' }}>Loading ledger records...</div>
            <div style={{ animation: 'typing 1.4s infinite' }}>⏳</div>
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', gap: '16px', padding: '0 16px' }}>
          {/* Summary Cards */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
              gap: '16px',
              flexShrink: 0,
            }}
          >
            {/* Total Contributions */}
            <div className="panel" style={{ minHeight: '100px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              <div style={{ fontSize: '12px', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>
                Total Contributions
              </div>
              <div style={{ fontSize: '28px', fontWeight: 700, color: '#10b981' }}>
                ${totalContributions.toFixed(2)}
              </div>
              <div style={{ fontSize: '11px', color: '#64748b' }}>{records.length} transactions</div>
            </div>

            {/* Paid Amount */}
            <div className="panel" style={{ minHeight: '100px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              <div style={{ fontSize: '12px', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>
                Payments Confirmed
              </div>
              <div style={{ fontSize: '28px', fontWeight: 700, color: '#3b82f6' }}>
                {paidCount}
              </div>
              <div style={{ fontSize: '11px', color: '#64748b' }}>Completed transactions</div>
            </div>

            {/* Pending Amount */}
            <div className="panel" style={{ minHeight: '100px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              <div style={{ fontSize: '12px', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>
                Awaiting Response
              </div>
              <div style={{ fontSize: '28px', fontWeight: 700, color: '#f59e0b' }}>
                {pendingCount}
              </div>
              <div style={{ fontSize: '11px', color: '#64748b' }}>Pending completion</div>
            </div>
          </div>

          {/* Filter Controls */}
          <div className="panel" style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 16px' }}>
            <label style={{ whiteSpace: 'nowrap', margin: 0, fontWeight: 600, color: '#94a3b8', fontSize: '13px' }}>
              Filter By Status:
            </label>
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
              style={{
                flex: 1,
                backgroundColor: '#0f172a',
                border: '1px solid #334155',
                borderRadius: '6px',
                color: '#e2e8f0',
                padding: '8px 12px',
                fontSize: '13px',
                cursor: 'pointer',
              }}
            >
              <option value="ALL">All Records</option>
              <option value="SENT">Sent</option>
              <option value="READ">Read</option>
              <option value="REPLIED">Replied</option>
              <option value="LINK_SENT">Payment Link Sent</option>
              <option value="PAID">Paid</option>
            </select>
          </div>

          {/* Ledger Table - Scrollable */}
          <div className="panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {filtered.length === 0 ? (
              <div style={{ padding: '24px', textAlign: 'center', color: '#94a3b8', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                No records found for current criteria.
              </div>
            ) : (
              <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                  <thead style={{ position: 'sticky', top: 0, backgroundColor: '#0f172a', zIndex: 10 }}>
                    <tr style={{ borderBottom: '2px solid #334155' }}>
                      <th style={{ padding: '12px 8px', textAlign: 'left', fontWeight: 600, color: '#94a3b8' }}>
                        Campaign Run / Phone
                      </th>
                      <th style={{ padding: '12px 8px', textAlign: 'center', fontWeight: 600, color: '#94a3b8' }}>
                        Delivery Status
                      </th>
                      <th style={{ padding: '12px 8px', textAlign: 'center', fontWeight: 600, color: '#94a3b8' }}>
                        Payment Status
                      </th>
                      <th style={{ padding: '12px 8px', textAlign: 'right', fontWeight: 600, color: '#94a3b8' }}>
                        Amount
                      </th>
                      <th style={{ padding: '12px 8px', textAlign: 'left', fontWeight: 600, color: '#94a3b8' }}>
                        Last Activity
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((item) => {
                      if (!item) return null; // Skip null entries

                      const deliveryColor =
                        item.deliveryStatus === 'READ'
                          ? '#10b981'
                          : item.deliveryStatus === 'REPLIED'
                          ? '#8b5cf6'
                          : item.deliveryStatus === 'SENT'
                          ? '#3b82f6'
                          : '#64748b';

                      const paymentColor =
                        item.paymentStatus === 'PAID'
                          ? '#10b981'
                          : item.paymentStatus === 'LINK_SENT'
                          ? '#f59e0b'
                          : '#64748b';

                      return (
                        <tr key={item.sk} style={{ borderBottom: '1px solid #334155', transition: 'background-color 0.2s' }}>
                          <td style={{ padding: '12px 8px', color: '#e2e8f0', fontWeight: 500, wordBreak: 'break-word' }}>
                            {item.sk}
                          </td>
                          <td style={{ padding: '12px 8px', textAlign: 'center' }}>
                            <span
                              style={{
                                display: 'inline-block',
                                padding: '4px 8px',
                                borderRadius: '4px',
                                fontSize: '11px',
                                fontWeight: 600,
                                backgroundColor: `${deliveryColor}20`,
                                color: deliveryColor,
                              }}
                            >
                              {item.deliveryStatus || 'QUEUED'}
                            </span>
                          </td>
                          <td style={{ padding: '12px 8px', textAlign: 'center' }}>
                            <span
                              style={{
                                display: 'inline-block',
                                padding: '4px 8px',
                                borderRadius: '4px',
                                fontSize: '11px',
                                fontWeight: 600,
                                backgroundColor: `${paymentColor}20`,
                                color: paymentColor,
                              }}
                            >
                              {item.paymentStatus || 'PENDING'}
                            </span>
                          </td>
                          <td style={{ padding: '12px 8px', textAlign: 'right', color: '#10b981', fontWeight: 600 }}>
                            ${(item.paymentAmount || 0).toFixed(2)}
                          </td>
                          <td style={{ padding: '12px 8px', color: '#64748b', fontSize: '12px' }}>
                            {item.inboundReplyText ? item.inboundReplyText.substring(0, 30) + '...' : '—'}
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
