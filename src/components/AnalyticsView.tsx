import React, { useState, useEffect } from 'react';
import { generateClient } from 'aws-amplify/data';
import type { Schema } from '../../amplify/data/resource';

const client = generateClient<Schema>();
const CURRENT_ASSOCIATION_ID = 'ASSOC#101';

export const AnalyticsView: React.FC = () => {
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
            authMode: 'apiKey'
          },
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

  const totalCollected = runs.reduce((acc, curr) => acc + (curr.paymentAmount || 0), 0);
  const totalTarget = campaigns.reduce((acc, curr) => acc + (curr.targetAmount || 0), 0);
  const readCount = runs.filter((r) => r.deliveryStatus === 'READ' || r.deliveryStatus === 'REPLIED').length;
  const replyCount = runs.filter((r) => r.deliveryStatus === 'REPLIED' || r.paymentStatus === 'LINK_SENT').length;

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '24px', fontFamily: 'sans-serif' }}>
      <h2>📊 Association Campaign & Community Analytics</h2>

      {loading ? (
        <p>Calculating metrics...</p>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '16px', margin: '20px 0' }}>
            <div style={{ background: '#f8f9fa', padding: '16px', borderRadius: '8px', border: '1px solid #e0e0e0' }}>
              <div style={{ fontSize: '12px', color: '#5f6368' }}>TOTAL RAISED</div>
              <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#137333' }}>${totalCollected}</div>
            </div>

            <div style={{ background: '#f8f9fa', padding: '16px', borderRadius: '8px', border: '1px solid #e0e0e0' }}>
              <div style={{ fontSize: '12px', color: '#5f6368' }}>ACTIVE GOAL</div>
              <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#1a73e8' }}>${totalTarget}</div>
            </div>

            <div style={{ background: '#f8f9fa', padding: '16px', borderRadius: '8px', border: '1px solid #e0e0e0' }}>
              <div style={{ fontSize: '12px', color: '#5f6368' }}>MESSAGES READ</div>
              <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#b06000' }}>
                {runs.length > 0 ? Math.round((readCount / runs.length) * 100) : 0}%
              </div>
            </div>

            <div style={{ background: '#f8f9fa', padding: '16px', borderRadius: '8px', border: '1px solid #e0e0e0' }}>
              <div style={{ fontSize: '12px', color: '#5f6368' }}>BUTTON ENGAGEMENT</div>
              <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#8430ce' }}>{replyCount} Taps</div>
            </div>
          </div>

          <h3>Campaign Breakdown</h3>
          {campaigns.map((camp) => {
            const campRuns = runs.filter((r) => r.sk?.startsWith(`${camp.sk}#`));
            const campRaised = campRuns.reduce((acc, curr) => acc + (curr.paymentAmount || 0), 0);
            const progress = camp.targetAmount ? Math.min(100, Math.round((campRaised / camp.targetAmount) * 100)) : 0;

            return (
              <div
                key={camp.sk}
                style={{
                  background: '#fff',
                  border: '1px solid #ddd',
                  borderRadius: '6px',
                  padding: '16px',
                  marginBottom: '12px',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <strong>{camp.title || camp.sk}</strong>
                  <span>
                    ${campRaised} / ${camp.targetAmount || 0} ({progress}%)
                  </span>
                </div>
                <div style={{ background: '#e0e0e0', borderRadius: '4px', height: '10px', overflow: 'hidden' }}>
                  <div style={{ width: `${progress}%`, background: '#34a853', height: '100%' }} />
                </div>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
};

export default AnalyticsView;