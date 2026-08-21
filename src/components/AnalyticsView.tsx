import { useState, useEffect } from 'react';
import { generateClient } from 'aws-amplify/data';
import type { Schema } from '../../amplify/data/resource';

const client = generateClient<Schema>();

export default function AnalyticsView() {
  const [selectedCampaign, setSelectedCampaign] = useState<string>('CAMPRUN#A#1692374400');
  
  const [stats, setStats] = useState({
    sent: 0,
    delivered: 0,
    read: 0,
    replied: 0,
    paid: 0,
  });

  useEffect(() => {
    if (!selectedCampaign) return;

    const subscription = client.models.PushNotSystem.observeQuery({
      filter: {
        pk: { eq: selectedCampaign },
        sk: { beginsWith: 'MEMBER#' }
      }
    }).subscribe({
      next: ({ items }) => {
        const newStats = items.reduce((acc, item) => {
          if (item.deliveryStatus === 'SENT') acc.sent += 1;
          if (item.deliveryStatus === 'DELIVERED') acc.delivered += 1;
          if (item.deliveryStatus === 'READ') acc.read += 1;
          if (item.inboundReplyText) acc.replied += 1;
          if (item.paymentStatusSort && item.paymentStatusSort.includes('PAID')) acc.paid += 1; 
          return acc;
        }, { sent: 0, delivered: 0, read: 0, replied: 0, paid: 0 });

        setStats(newStats);
      },
      error: (err) => console.error('Subscription error:', err)
    });

    return () => subscription.unsubscribe();
  }, [selectedCampaign]);

  return (
    <div className="view-single-col">
      {/* Campaign Selector */}
      <div className="panel" style={{ flex: '0 0 auto' }}>
        <label>Campaign</label>
        <select 
          value={selectedCampaign}
          onChange={(e) => setSelectedCampaign(e.target.value)}
          style={{ width: '100%' }}
        >
          <option value="CAMPRUN#A#1692374400">📅 Campaign A (Back to School)</option>
          <option value="CAMPRUN#B#1692374500">🕌 Campaign B (Hajj Trip)</option>
          <option value="CAMPRUN#C#1692374600">🎉 Campaign C (Year End Sale)</option>
        </select>
      </div>

      {/* Charts Grid */}
      <div className="grid-2-col-charts">
        {/* Chart 1: Delivery Funnel */}
        <div className="panel">
          <h4 style={{ margin: '0 0 16px 0', color: '#f1f5f9', fontSize: '14px', fontWeight: '600', flexShrink: 0 }}>Delivery & Read Receipts</h4>
          <DynamicBarChart 
            data={[
              { label: 'Sent', value: stats.sent, color: '#94a3b8' },
              { label: 'Delivered', value: stats.delivered, color: '#3b82f6' },
              { label: 'Read', value: stats.read, color: '#2563eb' }
            ]} 
          />
        </div>

        {/* Chart 2: Engagement & Conversion */}
        <div className="panel">
          <h4 style={{ margin: '0 0 16px 0', color: '#f1f5f9', fontSize: '14px', fontWeight: '600', flexShrink: 0 }}>Engagement & Payments</h4>
          <DynamicBarChart 
            data={[
              { label: 'Read', value: stats.read, color: '#2563eb' },
              { label: 'Replied', value: stats.replied, color: '#8b5cf6' },
              { label: 'Paid', value: stats.paid, color: '#10b981' }
            ]} 
          />
        </div>
      </div>

      {/* Metrics Summary */}
      <div className="panel" style={{ flex: '0 0 auto' }}>
        <h4 style={{ margin: '0 0 12px 0', color: '#f1f5f9', fontSize: '13px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Real-Time Metrics</h4>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '12px' }}>
          <MetricCard label="SENT" value={stats.sent} color="#94a3b8" />
          <MetricCard label="DELV" value={stats.delivered} color="#3b82f6" />
          <MetricCard label="READ" value={stats.read} color="#2563eb" />
          <MetricCard label="RPLY" value={stats.replied} color="#8b5cf6" />
          <MetricCard label="PAID" value={stats.paid} color="#10b981" />
        </div>
      </div>
    </div>
  );
}

function MetricCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ 
      backgroundColor: '#0f172a', 
      border: `1px solid ${color}40`, 
      borderRadius: '6px', 
      padding: '12px', 
      textAlign: 'center' 
    }}>
      <div style={{ fontSize: '12px', color: '#94a3b8', marginBottom: '4px' }}>{label}</div>
      <div style={{ fontSize: '20px', fontWeight: '600', color: color }}>{value}</div>
    </div>
  );
}

function DynamicBarChart({ data }: { data: { label: string, value: number, color: string }[] }) {
  const maxValue = Math.max(...data.map(d => d.value), 10);
  const svgHeight = 200;
  const svgWidth = 320;
  const barWidth = 50;
  const gap = (svgWidth - (data.length * barWidth)) / (data.length + 1);

  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
      <svg width="100%" height="100%" viewBox={`0 0 ${svgWidth} ${svgHeight}`} preserveAspectRatio="xMidYMid meet">
        <line x1="0" y1={svgHeight - 30} x2={svgWidth} y2={svgHeight - 30} stroke="#334155" strokeWidth="2" />
        {data.map((item, index) => {
          const barHeight = (item.value / maxValue) * (svgHeight - 50);
          const x = gap + (index * (barWidth + gap));
          const y = (svgHeight - 30) - barHeight;

          return (
            <g key={item.label}>
              <rect 
                x={x} 
                y={y} 
                width={barWidth} 
                height={barHeight} 
                fill={item.color} 
                rx="3"
                style={{ transition: 'all 0.5s ease-in-out' }}
              />
              <text 
                x={x + (barWidth / 2)} 
                y={y - 8} 
                fill="#f1f5f9" 
                fontSize="12" 
                fontWeight="bold" 
                textAnchor="middle"
              >
                {item.value}
              </text>
              <text 
                x={x + (barWidth / 2)} 
                y={svgHeight - 10} 
                fill="#94a3b8" 
                fontSize="11" 
                textAnchor="middle"
              >
                {item.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
