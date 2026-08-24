import { useState, useEffect } from 'react';
import { generateClient } from 'aws-amplify/data';
import type { Schema } from '../../amplify/data/resource';

const client = generateClient<Schema>();
const CURRENT_ASSOCIATION_ID = 'ASSOC#101';

export default function CampaignsView() {
  // Form state
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [targetAmount, setTargetAmount] = useState('');
  const [language, setLanguage] = useState('en');
  const [launchDate, setLaunchDate] = useState('');
  
  // UI state
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error' | null; text: string }>({ type: null, text: '' });

  // Campaign data state
  const [campaigns, setCampaigns] = useState<any[]>([]);
  const [loadingCampaigns, setLoadingCampaigns] = useState(true);

  const templateMap: { [key: string]: string } = {
    'en': 'campaign_msg',
    'ar': 'campaign_msg_ar'
  };

  // ==================== FETCH CAMPAIGNS FROM BACKEND ====================
  useEffect(() => {
    fetchCampaigns();
  }, []);

  const fetchCampaigns = async () => {
    setLoadingCampaigns(true);
    try {
      console.log('🔄 Fetching campaigns for association:', CURRENT_ASSOCIATION_ID);

      // Optimal query: pk + sk with beginsWith for CAMP# records
      const { data, errors } = await client.models.PushNotSystem.list({
        filter: {
          pk: { eq: CURRENT_ASSOCIATION_ID },
          sk: { beginsWith: 'CAMP#' }
        },
        authMode: 'apiKey',
      });

      if (errors && errors.length > 0) {
        console.error('❌ Backend errors:', errors);
      }

      // Defensive filtering
      const validCampaigns = (data || [])
        .filter((item: any) => item != null)
        .filter((item: any) => item.entityType === 'CAMPAIGN');

      console.log('✅ Fetched campaigns:', validCampaigns.length);
      console.log('📋 Sample campaign structure:', validCampaigns[0] || 'No campaigns');

      setCampaigns(validCampaigns);
    } catch (error) {
      console.error('❌ Error fetching campaigns:', error);
      setCampaigns([]);
    } finally {
      setLoadingCampaigns(false);
    }
  };

  // ==================== COMPUTE DYNAMIC METRICS ====================
  const totalCampaigns = campaigns.length;
  const activeCampaigns = campaigns.filter((c) => c.status === 'ACTIVE' || c.status === 'RUNNING').length;
  const totalRecipients = campaigns.reduce((acc, c) => acc + (c.totalCampaignsReceived || 0), 0);

  const handleCreateCampaign = async (e: React.FormEvent) => {
    e.preventDefault();

    // Validation
    if (!title.trim()) {
      setFeedback({ type: 'error', text: 'Campaign title is required.' });
      return;
    }
    if (!description.trim()) {
      setFeedback({ type: 'error', text: 'Campaign description is required.' });
      return;
    }
    if (!targetAmount || isNaN(Number(targetAmount))) {
      setFeedback({ type: 'error', text: 'Target amount must be a valid number.' });
      return;
    }
    if (!launchDate) {
      setFeedback({ type: 'error', text: 'Launch date is required.' });
      return;
    }

    setIsSubmitting(true);
    setFeedback({ type: null, text: '' });

    try {
      const campaignId = `CAMP#${Date.now()}`;

      // Create campaign in PushNotSystem
      const { errors } = await client.models.PushNotSystem.create({
        pk: CURRENT_ASSOCIATION_ID,
        sk: campaignId,
        entityType: 'CAMPAIGN',
        gsi2pk: CURRENT_ASSOCIATION_ID,
        gsi2sk: new Date().toISOString(),
        title: title,
        type: 'OUTREACH',
        templateName: templateMap[language],
        status: 'SCHEDULED',
        targetAmount: targetAmount ? Number(targetAmount) : 0,
      });

      if (errors && errors.length > 0) {
        throw new Error(errors[0].message);
      }

      setFeedback({
        type: 'success',
        text: `Campaign "${title}" created successfully and scheduled for ${new Date(launchDate).toLocaleDateString()}`
      });

      // Reset form
      setTitle('');
      setDescription('');
      setTargetAmount('');
      setLanguage('en');
      setLaunchDate('');

      // Refresh campaigns list
      await fetchCampaigns();

    } catch (error: any) {
      console.error('Campaign creation failed:', error);
      setFeedback({
        type: 'error',
        text: error.message || 'Failed to create campaign. Please try again.'
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="view-single-col">
      {/* Campaign Creation Form - OPTIMIZED LAYOUT */}
      <div className="panel" style={{ flex: '0 0 auto', overflow: 'visible' }}>
        <h2 style={{ margin: '0 0 16px 0', fontSize: '18px', fontWeight: '700', color: '#f1f5f9' }}>
          Create New Campaign
        </h2>

        <form onSubmit={handleCreateCampaign} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {/* Campaign Title */}
          <div>
            <label>Campaign Title</label>
            <input
              type="text"
              placeholder="e.g., Back to School 2024"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={isSubmitting}
            />
          </div>

          {/* Campaign Description */}
          <div>
            <label>Outreach Description (Template Variable: {`{{2}}`})</label>
            <textarea
              rows={3}
              placeholder="Enter the message content that will be sent via WhatsApp..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={isSubmitting}
              style={{ width: '100%', padding: '8px 12px', fontFamily: 'inherit' }}
            />
          </div>

          {/* 3-COLUMN FORM GRID: Target Amount, Language, Launch Date */}
          <div className="form-grid-3col">
            {/* Target Amount */}
            <div>
              <label>Target Amount</label>
              <input
                type="number"
                placeholder="e.g., 50000"
                value={targetAmount}
                onChange={(e) => setTargetAmount(e.target.value)}
                disabled={isSubmitting}
                min="1"
              />
            </div>

            {/* Language / Template Selector */}
            <div>
              <label>Language / Template</label>
              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                disabled={isSubmitting}
              >
                <option value="en">🇬🇧 English (campaign_msg - en)</option>
                <option value="ar">🇸🇦 Arabic (campaign_msg_ar - ar)</option>
              </select>
            </div>

            {/* Launch Date */}
            <div>
              <label>Scheduled Launch Date</label>
              <input
                type="datetime-local"
                value={launchDate}
                onChange={(e) => setLaunchDate(e.target.value)}
                disabled={isSubmitting}
              />
            </div>
          </div>

          {/* Feedback Message */}
          {feedback.type && (
            <div style={{
              padding: '10px 12px',
              borderRadius: '6px',
              fontSize: '13px',
              backgroundColor: feedback.type === 'error' ? '#7f1d1d' : '#064e3b',
              color: feedback.type === 'error' ? '#fca5a5' : '#86efac',
              border: `1px solid ${feedback.type === 'error' ? '#991b1b' : '#047857'}`
            }}>
              {feedback.text}
            </div>
          )}

          {/* Submit Button */}
          <button
            type="submit"
            className="btn-submit"
            disabled={isSubmitting}
            style={{ marginTop: '4px' }}
          >
            {isSubmitting ? 'Creating Campaign...' : 'Create & Schedule Campaign'}
          </button>
        </form>
      </div>

      {/* OPTIMIZED KPI METRICS - DYNAMIC FROM BACKEND DATA */}
      <div style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '24px',
        padding: '0 16px',
        flex: '0 0 auto',
        height: 'auto',
        minHeight: '40px',
      }}>
        {/* Total Campaigns */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '12px', fontWeight: '600', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Total Campaigns:
          </span>
          <strong style={{ fontSize: '16px', fontWeight: '700', color: '#3b82f6' }}>
            {loadingCampaigns ? '—' : totalCampaigns}
          </strong>
        </div>

        {/* Active Campaigns */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '12px', fontWeight: '600', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Active Campaigns:
          </span>
          <strong style={{ fontSize: '16px', fontWeight: '700', color: '#10b981' }}>
            {loadingCampaigns ? '—' : activeCampaigns}
          </strong>
        </div>

        {/* Total Recipients */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '12px', fontWeight: '600', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Total Recipients:
          </span>
          <strong style={{ fontSize: '16px', fontWeight: '700', color: '#8b5cf6' }}>
            {loadingCampaigns ? '—' : totalRecipients.toLocaleString()}
          </strong>
        </div>
      </div>

      {/* Recent Campaigns List - REAL DATA FROM BACKEND */}
      <div className="panel" style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <h3 style={{ margin: '0 0 12px 0', fontSize: '14px', fontWeight: '600', color: '#f1f5f9', flexShrink: 0 }}>
          Recent Campaigns {loadingCampaigns ? '(Loading...)' : `(${campaigns.length})`}
        </h3>
        <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
          {campaigns.length === 0 ? (
            <div style={{
              padding: '32px 16px',
              textAlign: 'center',
              color: '#94a3b8',
              fontSize: '14px'
            }}>
              {loadingCampaigns ? '⏳ Loading campaigns...' : '📭 No campaigns created yet. Create one above!'}
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead style={{ position: 'sticky', top: 0, backgroundColor: '#0f172a', borderBottom: '1px solid #334155', zIndex: 10 }}>
                <tr>
                  <th style={{ padding: '12px', textAlign: 'left', color: '#94a3b8', fontWeight: '600' }}>Title</th>
                  <th style={{ padding: '12px', textAlign: 'left', color: '#94a3b8', fontWeight: '600' }}>Status</th>
                  <th style={{ padding: '12px', textAlign: 'right', color: '#94a3b8', fontWeight: '600' }}>Recipients</th>
                  <th style={{ padding: '12px', textAlign: 'center', color: '#94a3b8', fontWeight: '600' }}>Language</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((campaign, idx) => {
                  // Extract language from templateName
                  const language = campaign.templateName?.includes('ar') ? 'ar' : 'en';
                  const recipientCount = campaign.totalCampaignsReceived || 0;

                  return (
                    <tr
                      key={campaign.sk}
                      style={{
                        borderBottom: '1px solid #334155',
                        backgroundColor: idx % 2 === 0 ? 'transparent' : 'rgba(59, 130, 246, 0.05)',
                        transition: 'background-color 0.2s ease-in-out'
                      }}
                    >
                      <td style={{ padding: '12px', color: '#cbd5e1' }}>
                        {campaign.title || 'Untitled Campaign'}
                      </td>
                      <td style={{ padding: '12px', color: '#cbd5e1' }}>
                        <span style={{
                          padding: '3px 8px',
                          borderRadius: '3px',
                          fontSize: '11px',
                          fontWeight: '600',
                          backgroundColor: campaign.status === 'ACTIVE' || campaign.status === 'RUNNING' ? 'rgba(16, 185, 129, 0.1)' :
                            campaign.status === 'SCHEDULED' ? 'rgba(59, 130, 246, 0.1)' :
                              campaign.status === 'COMPLETED' ? 'rgba(107, 114, 128, 0.1)' :
                                'rgba(251, 146, 60, 0.1)',
                          color: campaign.status === 'ACTIVE' || campaign.status === 'RUNNING' ? '#10b981' :
                            campaign.status === 'SCHEDULED' ? '#3b82f6' :
                              campaign.status === 'COMPLETED' ? '#6b7280' :
                                '#f97316'
                        }}>
                          {campaign.status || 'DRAFT'}
                        </span>
                      </td>
                      <td style={{ padding: '12px', textAlign: 'right', color: '#cbd5e1' }}>
                        {recipientCount > 0 ? recipientCount.toLocaleString() : '—'}
                      </td>
                      <td style={{ padding: '12px', textAlign: 'center', color: '#cbd5e1' }}>
                        {language === 'en' ? '🇬🇧' : '🇸🇦'}
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
  );
}
