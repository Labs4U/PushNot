import { useState } from 'react';
import { generateClient } from 'aws-amplify/data';
import type { Schema } from '../../amplify/data/resource';

const client = generateClient<Schema>();

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

  const templateMap: { [key: string]: string } = {
    'en': 'campaign_msg',
    'ar': 'campaign_msg_ar'
  };

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
      const currentAssociationId = 'ASSOC#101';

      // Create campaign in PushNotSystem
      const { errors } = await client.models.PushNotSystem.create({
        pk: currentAssociationId,
        sk: campaignId,
        entityType: 'CAMPAIGN',
        gsi2pk: currentAssociationId,
        gsi2sk: new Date().toISOString(),
        title: title,
        type: 'OUTREACH',
        templateName: templateMap[language],
        status: 'SCHEDULED',
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
      {/* Campaign Creation Form */}
      <div className="panel" style={{ flex: '0 0 auto', maxHeight: '500px', overflow: 'auto' }}>
        <h2 style={{ margin: '0 0 24px 0', fontSize: '18px', fontWeight: '700', color: '#f1f5f9' }}>
          Create New Campaign
        </h2>

        <form onSubmit={handleCreateCampaign} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
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
              rows={4}
              placeholder="Enter the message content that will be sent via WhatsApp..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={isSubmitting}
              style={{ width: '100%', padding: '8px 12px', fontFamily: 'inherit' }}
            />
          </div>

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
          >
            {isSubmitting ? 'Creating Campaign...' : 'Create & Schedule Campaign'}
          </button>
        </form>
      </div>

      {/* Campaign Statistics Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '16px', flex: 1, minHeight: 0 }}>
        <div className="panel">
          <div style={{ color: '#94a3b8', fontSize: '12px', marginBottom: '8px', textTransform: 'uppercase' }}>
            Total Campaigns
          </div>
          <div style={{ fontSize: '32px', fontWeight: '700', color: '#3b82f6' }}>12</div>
        </div>

        <div className="panel">
          <div style={{ color: '#94a3b8', fontSize: '12px', marginBottom: '8px', textTransform: 'uppercase' }}>
            Active Campaigns
          </div>
          <div style={{ fontSize: '32px', fontWeight: '700', color: '#10b981' }}>3</div>
        </div>

        <div className="panel">
          <div style={{ color: '#94a3b8', fontSize: '12px', marginBottom: '8px', textTransform: 'uppercase' }}>
            Total Recipients
          </div>
          <div style={{ fontSize: '32px', fontWeight: '700', color: '#8b5cf6' }}>285,400</div>
        </div>
      </div>

      {/* Recent Campaigns List */}
      <div className="panel" style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <h3 style={{ margin: '0 0 16px 0', fontSize: '14px', fontWeight: '600', color: '#f1f5f9', flexShrink: 0 }}>
          Recent Campaigns
        </h3>
        <div style={{ flex: 1, overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead style={{ position: 'sticky', top: 0, backgroundColor: '#0f172a', borderBottom: '1px solid #334155' }}>
              <tr>
                <th style={{ padding: '12px', textAlign: 'left', color: '#94a3b8', fontWeight: '600' }}>Title</th>
                <th style={{ padding: '12px', textAlign: 'left', color: '#94a3b8', fontWeight: '600' }}>Status</th>
                <th style={{ padding: '12px', textAlign: 'right', color: '#94a3b8', fontWeight: '600' }}>Recipients</th>
                <th style={{ padding: '12px', textAlign: 'center', color: '#94a3b8', fontWeight: '600' }}>Language</th>
              </tr>
            </thead>
            <tbody>
              {[
                { id: 1, title: 'Back to School', status: 'Active', recipients: 45000, language: 'en' },
                { id: 2, title: 'Hajj Trip', status: 'Scheduled', recipients: 32500, language: 'ar' },
                { id: 3, title: 'Year End Sale', status: 'Completed', recipients: 128900, language: 'en' },
                { id: 4, title: 'Spring Promo', status: 'Draft', recipients: 0, language: 'en' },
                { id: 5, title: 'Summer Deals', status: 'Active', recipients: 79000, language: 'ar' },
              ].map((campaign, idx) => (
                <tr
                  key={campaign.id}
                  style={{
                    borderBottom: '1px solid #334155',
                    backgroundColor: idx % 2 === 0 ? 'transparent' : 'rgba(59, 130, 246, 0.05)'
                  }}
                >
                  <td style={{ padding: '12px', color: '#cbd5e1' }}>{campaign.title}</td>
                  <td style={{ padding: '12px', color: '#cbd5e1' }}>
                    <span style={{
                      padding: '3px 8px',
                      borderRadius: '3px',
                      fontSize: '11px',
                      fontWeight: '600',
                      backgroundColor: campaign.status === 'Active' ? 'rgba(16, 185, 129, 0.1)' :
                        campaign.status === 'Scheduled' ? 'rgba(59, 130, 246, 0.1)' :
                          campaign.status === 'Completed' ? 'rgba(107, 114, 128, 0.1)' :
                            'rgba(251, 146, 60, 0.1)',
                      color: campaign.status === 'Active' ? '#10b981' :
                        campaign.status === 'Scheduled' ? '#3b82f6' :
                          campaign.status === 'Completed' ? '#6b7280' :
                            '#f97316'
                    }}>
                      {campaign.status}
                    </span>
                  </td>
                  <td style={{ padding: '12px', textAlign: 'right', color: '#cbd5e1' }}>
                    {campaign.recipients.toLocaleString()}
                  </td>
                  <td style={{ padding: '12px', textAlign: 'center', color: '#cbd5e1' }}>
                    {campaign.language === 'en' ? '🇬🇧' : '🇸🇦'}
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
