import React, { useState, useEffect } from 'react';
import { generateClient } from 'aws-amplify/data';
import type { Schema } from '../../amplify/data/resource';

const client = generateClient<Schema>();
const CURRENT_ASSOCIATION_ID = 'ASSOC#101';

const MessagesView: React.FC = () => {
  const [campaigns, setCampaigns] = useState<any[]>([]);
  const [campaignSearch, setCampaignSearch] = useState('');
  const [filteredCampaigns, setFilteredCampaigns] = useState<any[]>([]);
  const [selectedCampaign, setSelectedCampaign] = useState<any | null>(null);
  const [messageContent, setMessageContent] = useState('');
  const [targetAmount, setTargetAmount] = useState<number | ''>('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error' | null; text: string }>({
    type: null,
    text: '',
  });

  // Fetch campaigns for this association
  const fetchCampaigns = async () => {
    try {
      console.log('Fetching campaigns for association:', CURRENT_ASSOCIATION_ID);

      const { data, errors } = await client.models.PushNotSystem.list(
        {
          filter: {
            pk: { eq: CURRENT_ASSOCIATION_ID },
            sk: { beginsWith: 'CAMP#' },
          },
          authMode: 'apiKey',
        }
      );

      console.log('Campaigns fetched successfully:', data);

      if (errors && errors.length > 0) {
        console.warn('Errors returned from campaign fetch:', errors);
      }

      if (data) {
        setCampaigns(data);
        setFilteredCampaigns(data);
      }
    } catch (err) {
      console.error('Error fetching campaigns:', err);
    }
  };

  useEffect(() => {
    fetchCampaigns();
  }, []);

  // Filter campaigns based on search input
  useEffect(() => {
    if (!campaignSearch.trim()) {
      setFilteredCampaigns(campaigns);
    } else {
      const q = campaignSearch.toLowerCase();
      const filtered = campaigns.filter((c) => {
        const title = c?.title?.toLowerCase() || '';
        const sk = c?.sk?.toLowerCase() || '';
        return title.includes(q) || sk.includes(q);
      });
      setFilteredCampaigns(filtered);
    }
  }, [campaignSearch, campaigns]);

  const handleSelectCampaign = (camp: any) => {
    setSelectedCampaign(camp);
    setCampaignSearch(camp.title || camp.sk);
    setMessageContent(camp.description || '');
    setIsDropdownOpen(false);
  };

  const handleClearSelection = () => {
    setSelectedCampaign(null);
    setCampaignSearch('');
    setMessageContent('');
    setTargetAmount('');
    setIsDropdownOpen(false);
  };

  const handleSubmit = async () => {
    // Determine if creating new campaign or relaunching existing
    const isNewCampaign = !selectedCampaign && campaignSearch.trim();

    if (!isNewCampaign && !selectedCampaign) {
      setFeedback({ type: 'error', text: 'Please select an existing campaign or enter a new campaign name.' });
      return;
    }

    setIsSubmitting(true);
    setFeedback({ type: null, text: '' });

    try {
      let activeCampaignSk = selectedCampaign?.sk;

      // If creating a new campaign, write the record
      if (isNewCampaign) {
        const generatedCampId = `CAMP#${Date.now().toString().slice(-6)}`;
        activeCampaignSk = generatedCampId;

        const { errors: createErrors } = await client.models.PushNotSystem.create(
          {
            pk: CURRENT_ASSOCIATION_ID,
            sk: generatedCampId,
            entityType: 'CAMPAIGN',
            gsi1pk: CURRENT_ASSOCIATION_ID,
            gsi1sk: 'STATUS#RUNNING',
            title: campaignSearch.trim() || 'Untitled Campaign',
            description: messageContent.trim(),
            type: 'FUNDRAISER',
            templateName: 'campaign_msg',
            status: 'RUNNING',
            targetAmount: targetAmount ? Number(targetAmount) : 0,
          },
          { authMode: 'apiKey' }
        );

        if (createErrors && createErrors.length > 0) {
          throw new Error(createErrors[0].message);
        }
      }

      // Trigger the broadcast mutation
      const response = await client.mutations.triggerCampaignBroadcast(
        {
          associationId: CURRENT_ASSOCIATION_ID,
          campaignRunId: activeCampaignSk,
        },
        { authMode: 'apiKey' }
      );

      if (response.errors && response.errors.length > 0) {
        throw new Error(response.errors[0].message);
      }

      const responseData = response.data ? JSON.parse(response.data as string) : {};

      setFeedback({
        type: 'success',
        text: `Success! Dispatched campaign ${activeCampaignSk}. Queued ${responseData.queuedCount || 0} messages.`,
      });

      // Reset form & reload campaign list
      handleClearSelection();
      await fetchCampaigns();
    } catch (error: any) {
      console.error('Broadcast dispatch failed:', error);
      setFeedback({
        type: 'error',
        text: error.message || 'An unexpected error occurred during dispatch.',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="view-single-col">
      {/* Feedback Toast */}
      {feedback.text && (
        <div
          style={{
            padding: '12px 16px',
            borderRadius: '6px',
            backgroundColor: feedback.type === 'success' ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)',
            borderLeft: `3px solid ${feedback.type === 'success' ? '#10b981' : '#ef4444'}`,
            color: feedback.type === 'success' ? '#86efac' : '#fca5a5',
            fontSize: '14px',
            fontWeight: 500,
            flexShrink: 0,
          }}
        >
          {feedback.text}
        </div>
      )}

      {/* Main Content Grid: 2-Col on desktop, 1-Col on tablet/mobile */}
      <div className="grid-2-col" style={{ flex: 1, overflow: 'hidden', padding: '16px', gap: '16px' }}>
        {/* LEFT PANE: Campaign Selection & Metadata */}
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
          <div className="panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <h3 style={{ margin: '0 0 16px 0', fontSize: '16px', fontWeight: 600, color: '#f1f5f9' }}>
              📋 Campaign Selection
            </h3>

            {/* Campaign Search Input */}
            <div className="campaign-search-wrapper" style={{ flexShrink: 0, marginBottom: '16px' }}>
              <label>Campaign Identifier / Title</label>
              <div className="campaign-search-input-container" style={{ position: 'relative', overflow: 'visible' }}>
                <input
                  type="text"
                  placeholder="Search existing or type new campaign name..."
                  value={campaignSearch}
                  onChange={(e) => {
                    setCampaignSearch(e.target.value);
                    setIsDropdownOpen(true);
                  }}
                  onFocus={() => setIsDropdownOpen(true)}
                  onBlur={() => setTimeout(() => setIsDropdownOpen(false), 150)}
                  style={{ paddingRight: selectedCampaign ? '32px' : '12px' }}
                />

                {/* Clear Button */}
                {selectedCampaign && (
                  <button
                    onClick={handleClearSelection}
                    style={{
                      position: 'absolute',
                      right: '8px',
                      top: '50%',
                      transform: 'translateY(-50%)',
                      background: 'none',
                      border: 'none',
                      color: '#94a3b8',
                      cursor: 'pointer',
                      fontSize: '16px',
                      padding: '0 4px',
                    }}
                  >
                    ✕
                  </button>
                )}

                {/* Campaign Suggestions Dropdown */}
                {isDropdownOpen && (
                  <div className="campaign-suggestions-dropdown">
                    {filteredCampaigns.length === 0 ? (
                      <div className="campaign-suggestion-item" style={{ color: '#94a3b8' }}>
                        No existing campaigns found.
                      </div>
                    ) : (
                      filteredCampaigns.map((camp) => (
                        <div
                          key={camp?.sk || Math.random()}
                          className="campaign-suggestion-item"
                          onClick={() => handleSelectCampaign(camp)}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <strong>{camp?.title || camp?.sk || 'Untitled'}</strong>
                            <span style={{ fontSize: '11px', color: '#64748b' }}>
                              {camp?.status || 'DRAFT'}
                            </span>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Selected Campaign Badge */}
            {selectedCampaign && (
              <div className="campaign-selected-badge existing" style={{ marginBottom: '16px' }}>
                <div>
                  <strong>Relaunch:</strong> {selectedCampaign.title || selectedCampaign.sk}
                </div>
              </div>
            )}

            {/* Target Amount (New Campaign Only) */}
            {!selectedCampaign && campaignSearch && (
              <div style={{ marginBottom: '16px' }}>
                <label>Target Contribution Goal ($)</label>
                <input
                  type="number"
                  placeholder="e.g. 5000"
                  value={targetAmount}
                  onChange={(e) => setTargetAmount(e.target.value ? Number(e.target.value) : '')}
                  min="0"
                  step="100"
                />
              </div>
            )}

            {/* Campaign Metadata Display */}
            {selectedCampaign && (
              <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid #334155' }}>
                <div style={{ marginBottom: '12px' }}>
                  <div style={{ fontSize: '12px', color: '#94a3b8', fontWeight: 600, marginBottom: '4px' }}>
                    Target Goal
                  </div>
                  <div style={{ fontSize: '18px', fontWeight: 600, color: '#3b82f6' }}>
                    ${selectedCampaign.targetAmount || 0}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: '12px', color: '#94a3b8', fontWeight: 600, marginBottom: '4px' }}>
                    Status
                  </div>
                  <div
                    style={{
                      display: 'inline-block',
                      padding: '4px 8px',
                      borderRadius: '4px',
                      fontSize: '12px',
                      backgroundColor: selectedCampaign.status === 'RUNNING' ? 'rgba(16, 185, 129, 0.1)' : 'rgba(100, 116, 139, 0.1)',
                      color: selectedCampaign.status === 'RUNNING' ? '#86efac' : '#cbd5e1',
                      fontWeight: 600,
                    }}
                  >
                    {selectedCampaign.status || 'DRAFT'}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* RIGHT PANE: Message Content & Submission */}
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
          <div className="panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <h3 style={{ margin: '0 0 16px 0', fontSize: '16px', fontWeight: 600, color: '#f1f5f9' }}>
              ✍️ Message Content
            </h3>

            <label style={{ marginBottom: '8px' }}>Campaign Message / Outreach Content</label>
            <textarea
              placeholder="Enter message details or noble cause appeal..."
              value={messageContent}
              onChange={(e) => setMessageContent(e.target.value)}
              style={{
                flex: 1,
                minHeight: '120px',
                resize: 'none',
                marginBottom: '16px',
                padding: '12px',
              }}
            />

            {/* Submit Button */}
            <button
              onClick={handleSubmit}
              disabled={isSubmitting || (!selectedCampaign && !campaignSearch.trim())}
              className="btn-submit"
              style={{
                flexShrink: 0,
                padding: '12px 16px',
                fontSize: '15px',
              }}
            >
              {isSubmitting ? '⏳ Dispatching...' : '🚀 Submit & Broadcast to WhatsApp'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default MessagesView;
