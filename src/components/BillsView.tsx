export default function BillsView() {
  const mockBillingData = [
    { id: 1, date: '2024-08-15', campaign: 'Campaign A', messages: 60000, rate: 0.005, total: 300.00, status: 'Paid' },
    { id: 2, date: '2024-08-08', campaign: 'Campaign B', messages: 45000, rate: 0.005, total: 225.00, status: 'Paid' },
    { id: 3, date: '2024-08-01', campaign: 'Campaign C', messages: 32500, rate: 0.005, total: 162.50, status: 'Paid' },
    { id: 4, date: '2024-07-25', campaign: 'Campaign D', messages: 50000, rate: 0.005, total: 250.00, status: 'Paid' },
    { id: 5, date: '2024-07-18', campaign: 'Campaign E', messages: 28000, rate: 0.005, total: 140.00, status: 'Pending' },
  ];

  const totalSpent = mockBillingData
    .filter(item => item.status === 'Paid')
    .reduce((sum, item) => sum + item.total, 0);

  return (
    <div className="view-single-col">
      {/* Billing Summary Panel */}
      <div className="panel" style={{ flex: '0 0 auto' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px' }}>
          <BillingMetric label="Total Spent" value={`$${totalSpent.toFixed(2)}`} color="#10b981" />
          <BillingMetric label="Messages Sent" value="215,500" color="#3b82f6" />
          <BillingMetric label="Avg. Cost/1k" value="$5.00" color="#8b5cf6" />
        </div>
      </div>

      {/* Billing History Table */}
      <div className="panel" style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <h4 style={{ margin: '0 0 12px 0', color: '#f1f5f9', fontSize: '14px', fontWeight: '600', flexShrink: 0 }}>Transaction History</h4>
        <div style={{ flex: 1, overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead style={{ position: 'sticky', top: 0, backgroundColor: '#0f172a', borderBottom: '1px solid #334155' }}>
              <tr>
                <th style={{ padding: '12px', textAlign: 'left', color: '#94a3b8', fontWeight: '600' }}>Date</th>
                <th style={{ padding: '12px', textAlign: 'left', color: '#94a3b8', fontWeight: '600' }}>Campaign</th>
                <th style={{ padding: '12px', textAlign: 'right', color: '#94a3b8', fontWeight: '600' }}>Messages</th>
                <th style={{ padding: '12px', textAlign: 'right', color: '#94a3b8', fontWeight: '600' }}>Cost</th>
                <th style={{ padding: '12px', textAlign: 'center', color: '#94a3b8', fontWeight: '600' }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {mockBillingData.map((item, idx) => (
                <tr 
                  key={item.id} 
                  style={{ 
                    borderBottom: '1px solid #334155',
                    backgroundColor: idx % 2 === 0 ? 'transparent' : 'rgba(59, 130, 246, 0.05)'
                  }}
                >
                  <td style={{ padding: '12px', color: '#cbd5e1' }}>{item.date}</td>
                  <td style={{ padding: '12px', color: '#cbd5e1' }}>{item.campaign}</td>
                  <td style={{ padding: '12px', textAlign: 'right', color: '#cbd5e1' }}>{item.messages.toLocaleString()}</td>
                  <td style={{ padding: '12px', textAlign: 'right', color: '#10b981', fontWeight: '600' }}>${item.total.toFixed(2)}</td>
                  <td style={{ padding: '12px', textAlign: 'center' }}>
                    <span style={{
                      padding: '4px 8px',
                      borderRadius: '4px',
                      fontSize: '12px',
                      fontWeight: '600',
                      backgroundColor: item.status === 'Paid' ? 'rgba(16, 185, 129, 0.1)' : 'rgba(251, 146, 60, 0.1)',
                      color: item.status === 'Paid' ? '#10b981' : '#f97316'
                    }}>
                      {item.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function BillingMetric({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{
      backgroundColor: '#0f172a',
      border: `1px solid ${color}40`,
      borderRadius: '6px',
      padding: '16px',
      textAlign: 'center'
    }}>
      <div style={{ fontSize: '12px', color: '#94a3b8', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
        {label}
      </div>
      <div style={{ fontSize: '24px', fontWeight: '700', color: color }}>
        {value}
      </div>
    </div>
  );
}
