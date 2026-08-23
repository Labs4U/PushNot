import React, { useState, useEffect } from 'react';
import { generateClient } from 'aws-amplify/data';
import type { Schema } from '../../amplify/data/resource';

const client = generateClient<Schema>();
const CURRENT_ASSOCIATION_ID = 'ASSOC#101';

export const BillsView: React.FC = () => {
  const [records, setRecords] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState<string>('ALL');

  const fetchRecords = async () => {
    setLoading(true);
    try {
      const { data, errors } = await client.models.PushNotSystem.list(
        {
          filter: {
            pk: { eq: CURRENT_ASSOCIATION_ID },
            entityType: { eq: 'CAMPAIGN_RUN' },
          },
          authMode: 'apiKey'
        },

      );

      if (!errors && data) {
        setRecords(data);
      }
    } catch (err) {
      console.error('Error fetching contribution records:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRecords();
  }, []);

  const filtered = filterStatus === 'ALL'
    ? records
    : records.filter((r) => r.paymentStatus === filterStatus || r.deliveryStatus === filterStatus);

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '24px', fontFamily: 'sans-serif' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>💳 Member Contributions & Delivery Ledger</h2>
        <button onClick={fetchRecords} style={{ padding: '8px 14px', cursor: 'pointer' }}>
          🔄 Refresh
        </button>
      </div>

      <div style={{ margin: '16px 0' }}>
        <label style={{ marginRight: '8px', fontWeight: 'bold' }}>Filter By Status:</label>
        <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
          <option value="ALL">All Records</option>
          <option value="SENT">Sent</option>
          <option value="READ">Read</option>
          <option value="REPLIED">Replied</option>
          <option value="LINK_SENT">Payment Link Sent</option>
          <option value="PAID">Paid</option>
        </select>
      </div>

      {loading ? (
        <p>Loading ledger records...</p>
      ) : filtered.length === 0 ? (
        <p>No records found for current criteria.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
          <thead>
            <tr style={{ background: '#f1f3f4', borderBottom: '2px solid #ddd' }}>
              <th style={{ padding: '10px' }}>Campaign Run / Phone</th>
              <th style={{ padding: '10px' }}>Delivery</th>
              <th style={{ padding: '10px' }}>Payment Status</th>
              <th style={{ padding: '10px' }}>Amount</th>
              <th style={{ padding: '10px' }}>Last Reply</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((item) => (
              <tr key={item.sk} style={{ borderBottom: '1px solid #eee' }}>
                <td style={{ padding: '10px' }}>
                  <strong>{item.sk}</strong>
                </td>
                <td style={{ padding: '10px' }}>
                  <span
                    style={{
                      padding: '4px 8px',
                      borderRadius: '4px',
                      fontSize: '12px',
                      background: item.deliveryStatus === 'READ' ? '#cbf0f8' : item.deliveryStatus === 'REPLIED' ? '#ceead6' : '#e8eaed',
                    }}
                  >
                    {item.deliveryStatus || 'QUEUED'}
                  </span>
                </td>
                <td style={{ padding: '10px' }}>
                  <span
                    style={{
                      padding: '4px 8px',
                      borderRadius: '4px',
                      fontSize: '12px',
                      fontWeight: 'bold',
                      background: item.paymentStatus === 'PAID' ? '#ceead6' : item.paymentStatus === 'LINK_SENT' ? '#feefe3' : '#f1f3f4',
                      color: item.paymentStatus === 'PAID' ? '#137333' : item.paymentStatus === 'LINK_SENT' ? '#b06000' : '#5f6368',
                    }}
                  >
                    {item.paymentStatus || 'PENDING'}
                  </span>
                </td>
                <td style={{ padding: '10px' }}>${item.paymentAmount || 0}</td>
                <td style={{ padding: '10px', color: '#5f6368' }}>{item.inboundReplyText || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};

export default BillsView;