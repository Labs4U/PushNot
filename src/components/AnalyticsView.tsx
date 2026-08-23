import React, { useState, useEffect } from 'react';
import { generateClient } from 'aws-amplify/data';
import type { Schema } from '../../amplify/data/resource';

const client = generateClient<Schema>();
const CURRENT_ASSOCIATION_ID = 'ASSOC#101';

const AnalyticsView: React.FC = () => {
  const [campaigns, setCampaigns] = useState<any[]>([]);
  const [runs, setRuns] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadAnalytics = async () => {
      setLoading(true);
      try {
        const { data } = await client.models.PushNotSystem.list(
          {
            filter: { pk: { eq: CURRENT_ASSOCIATION_ID } },
            authMode: 'apiKey',
          }
        );

        if (data) {
          const campList = data.filter((item) => item.entityType === 'CAMPAIGN');
          const runList = data.filter((item) => item.entityType === 'CAMPAIGN_RUN');
          setCampaigns(campList);
          setRuns(runList);
        }
      } catch (err) {
        console.error('Failed to load analytics:', err);
      } finally {
        setLoading(false);
      }
    };

    loadAnalytics();
  }, []);

  // Compute metrics
  const totalCollected = runs.reduce((acc, curr) => acc + (curr.paymentAmount || 0), 0);
  const totalTarget = campaigns.reduce((acc, curr) => acc + (curr.targetAmount || 0), 0);
  const totalSent = runs.length;
  const deliveredCount = runs.filter((r) => r.deliveryStatus && r.deliveryStatus !== 'QUEUED' && r.deliveryStatus !== 'FAILED').length;
  const readCount = runs.filter((r) => r.deliveryStatus === 'READ' || r.deliveryStatus === 'REPLIED').length;
  const replyCount = runs.filter((r) => r.deliveryStatus === 'REPLIED').length;

  const deliveryRate = totalSent > 0 ? Math.round((deliveredCount / totalSent) * 100) : 0;
  const readRate = totalSent > 0 ? Math.round((readCount / totalSent) * 100) : 0;
  const replyRate = totalSent > 0 ? Math.round((replyCount / totalSent) * 100) : 0;

  return (
    <div className="view-single-col">
      {/* Title & Refresh */}
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
          📊 Analytics Dashboard
        </h2>
        <button
          onClick={() => window.location.reload()}
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
            <div style={{ fontSize: '14px', marginBottom: '8px' }}>Calculating metrics...</div>
            <div style={{ animation: 'typing 1.4s infinite' }}>⏳</div>
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', gap: '16px', padding: '0 16px' }}>
          {/* KPI Metrics Grid - 4 Cards */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
              gap: '16px',
              flexShrink: 0,
            }}
          >
            {/* Total Sent */}
            <div className="panel" style={{ minHeight: '120px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              <div style={{ fontSize: '12px', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>
                Total Sent
              </div>
              <div style={{ fontSize: '32px', fontWeight: 700, color: '#3b82f6', marginBottom: '8px' }}>
                {totalSent}
              </div>
              <div style={{ fontSize: '11px', color: '#64748b' }}>Messages dispatched</div>
            </div>

            {/* Delivery Rate */}
            <div className="panel" style={{ minHeight: '120px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              <div style={{ fontSize: '12px', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>
                Delivery Rate
              </div>
              <div style={{ fontSize: '32px', fontWeight: 700, color: '#10b981', marginBottom: '8px' }}>
                {deliveryRate}%
              </div>
              <div style={{ fontSize: '11px', color: '#64748b' }}>
                {deliveredCount} of {totalSent} delivered
              </div>
            </div>

            {/* Read Rate */}
            <div className="panel" style={{ minHeight: '120px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              <div style={{ fontSize: '12px', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>
                Read Rate
              </div>
              <div style={{ fontSize: '32px', fontWeight: 700, color: '#f59e0b', marginBottom: '8px' }}>
                {readRate}%
              </div>
              <div style={{ fontSize: '11px', color: '#64748b' }}>
                {readCount} members read message
              </div>
            </div>

            {/* Reply/Engagement Rate */}
            <div className="panel" style={{ minHeight: '120px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              <div style={{ fontSize: '12px', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>
                Reply Rate
              </div>
              <div style={{ fontSize: '32px', fontWeight: 700, color: '#8b5cf6', marginBottom: '8px' }}>
                {replyRate}%
              </div>
              <div style={{ fontSize: '11px', color: '#64748b' }}>
                {replyCount} members engaged
              </div>
            </div>
          </div>

          {/* Fundraising Summary */}
          <div className="panel" style={{ flexShrink: 0 }}>
            <h3 style={{ margin: '0 0 12px 0', fontSize: '14px', fontWeight: 600, color: '#f1f5f9' }}>
              💰 Fundraising Summary
            </h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
              <div>
                <div style={{ fontSize: '12px', color: '#94a3b8', marginBottom: '4px' }}>Total Collected</div>
                <div style={{ fontSize: '24px', fontWeight: 700, color: '#10b981' }}>
                  ${totalCollected.toFixed(2)}
                </div>
              </div>
              <div>
                <div style={{ fontSize: '12px', color: '#94a3b8', marginBottom: '4px' }}>Active Goal</div>
                <div style={{ fontSize: '24px', fontWeight: 700, color: '#3b82f6' }}>
                  ${totalTarget.toFixed(2)}
                </div>
              </div>
            </div>
          </div>

          {/* Campaign Breakdown - Scrollable Table */}
          <div className="panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <h3 style={{ margin: '0 0 12px 0', fontSize: '14px', fontWeight: 600, color: '#f1f5f9', flexShrink: 0 }}>
              🎯 Campaign Breakdown
            </h3>
            <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
              {campaigns.length === 0 ? (
                <div style={{ padding: '16px', textAlign: 'center', color: '#94a3b8' }}>
                  No campaigns found.
                </div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                  <thead style={{ position: 'sticky', top: 0, backgroundColor: '#0f172a', zIndex: 10 }}>
                    <tr style={{ borderBottom: '2px solid #334155' }}>
                      <th style={{ padding: '12px 8px', textAlign: 'left', fontWeight: 600, color: '#94a3b8' }}>Campaign</th>
                      <th style={{ padding: '12px 8px', textAlign: 'right', fontWeight: 600, color: '#94a3b8' }}>Raised</th>
                      <th style={{ padding: '12px 8px', textAlign: 'right', fontWeight: 600, color: '#94a3b8' }}>Goal</th>
                      <th style={{ padding: '12px 8px', textAlign: 'center', fontWeight: 600, color: '#94a3b8' }}>Progress</th>
                    </tr>
                  </thead>
                  <tbody>
                    {campaigns.map((camp) => {
                      const campRuns = runs.filter((r) => r.sk?.startsWith(`${camp.sk}#`));
                      const campRaised = campRuns.reduce((acc, curr) => acc + (curr.paymentAmount || 0), 0);
                      const progress = camp.targetAmount ? Math.min(100, Math.round((campRaised / camp.targetAmount) * 100)) : 0;

                      return (
                        <tr key={camp.sk} style={{ borderBottom: '1px solid #334155', transition: 'background-color 0.2s' }}>
                          <td style={{ padding: '12px 8px', color: '#e2e8f0', fontWeight: 500 }}>
                            {camp.title || camp.sk}
                          </td>
                          <td style={{ padding: '12px 8px', textAlign: 'right', color: '#10b981', fontWeight: 600 }}>
                            ${campRaised.toFixed(2)}
                          </td>
                          <td style={{ padding: '12px 8px', textAlign: 'right', color: '#3b82f6' }}>
                            ${camp.targetAmount || 0}
                          </td>
                          <td style={{ padding: '12px 8px', textAlign: 'center' }}>
                            <div
                              style={{
                                display: 'inline-block',
                                padding: '4px 12px',
                                borderRadius: '12px',
                                backgroundColor: 'rgba(139, 92, 246, 0.1)',
                                color: '#d8b4fe',
                                fontSize: '12px',
                                fontWeight: 600,
                              }}
                            >
                              {progress}%
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AnalyticsView;
