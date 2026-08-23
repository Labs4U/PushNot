import React, { useState, useEffect } from 'react';
import { generateClient } from 'aws-amplify/data';
import type { Schema } from '../../amplify/data/resource';

const client = generateClient<Schema>();
const CURRENT_ASSOCIATION_ID = 'ASSOC#101';

export const MessagesView: React.FC = () => {
  const [campaigns, setCampaigns] = useState<any[]>([]);
  const [campaignSearch, setCampaignSearch] = useState('');
  const [filteredCampaigns, setFilteredCampaigns] = useState<any[]>([]);
  const [selectedCampaign, setSelectedCampaign] = useState<any | null>(null);
  const [messageContent, setMessageContent] = useState('');
  const [targetAmount, setTargetAmount] = useState<number | ''>('');
  const [isNewCampaign, setIsNewCampaign] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error' | null; text: string }>({
    type: null,
    text: '',
  });

  // 1. Fetch campaigns for this association
  // 1. Fetch campaigns for this association using the SK prefix
  const fetchCampaigns = async () => {
    try {
      console.log("Fetching campaigns for association:", CURRENT_ASSOCIATION_ID);
      
      const { data, errors } = await client.models.PushNotSystem.list(
        {
          filter: {
            pk: { eq: CURRENT_ASSOCIATION_ID },
            sk: { beginsWith: 'CAMP#' },
          },
          authMode: 'apiKey',
        }
      );

      console.log("Campaigns fetched successfully:", data);

      if (errors && errors.length > 0) {
        console.warn("Errors returned from campaign fetch:", errors);
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

  // 2. Filter campaigns search
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
    setIsNewCampaign(false);
    setIsDropdownOpen(false); // Close dropdown on selection
  };

  const handleCreateNewToggle = () => {
    setIsNewCampaign(true);
    setSelectedCampaign(null);
    setCampaignSearch('');
    setMessageContent('');
    setTargetAmount('');
    setIsDropdownOpen(false);
  };

  const handleSubmit = async () => {
    if (!isNewCampaign && !selectedCampaign) {
      setFeedback({ type: 'error', text: 'Please select an existing campaign or create a new one.' });
      return;
    }

    setIsSubmitting(true);
    setFeedback({ type: null, text: '' });

    try {
      let activeCampaignSk = selectedCampaign?.sk;

      // 1. If creating a new campaign, write the record
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

      // 2. Trigger the broadcast mutation
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
      setMessageContent('');
      setCampaignSearch('');
      setSelectedCampaign(null);
      setIsNewCampaign(false);
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
    <div style={{ maxWidth: 700, margin: '0 auto', padding: '24px', fontFamily: 'sans-serif' }}>
      <h2>📣 Campaign Broadcast Dashboard</h2>

      {feedback.text && (
        <div
          style={{
            padding: '12px 16px',
            borderRadius: '6px',
            marginBottom: '16px',
            backgroundColor: feedback.type === 'success' ? '#e6f4ea' : '#fce8e6',
            color: feedback.type === 'success' ? '#137333' : '#c5221f',
          }}
        >
          {feedback.text}
        </div>
      )}

      <div style={{ marginBottom: '16px' }}>
        <button
          type="button"
          onClick={handleCreateNewToggle}
          style={{
            padding: '8px 14px',
            marginRight: '8px',
            background: isNewCampaign ? '#1a73e8' : '#f1f3f4',
            color: isNewCampaign ? '#fff' : '#202124',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
          }}
        >
          + Create New Campaign
        </button>
      </div>

      <div style={{ marginBottom: '16px', position: 'relative' }}>
        <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '6px' }}>
          {isNewCampaign ? 'New Campaign Title:' : 'Select / Search Existing Campaign:'}
        </label>
        <input
          type="text"
          placeholder={isNewCampaign ? 'e.g. Mosque Expansion 2026' : 'Click to select or search campaigns...'}
          value={campaignSearch}
          onChange={(e) => {
            setCampaignSearch(e.target.value);
            if (!isNewCampaign) setIsDropdownOpen(true);
          }}
          onFocus={() => {
            if (!isNewCampaign) setIsDropdownOpen(true);
          }}
          style={{ width: '100%', padding: '10px', boxSizing: 'border-box' }}
        />

        {/* 🟢 Improved Dropdown Visibility Logic */}
        {!isNewCampaign && isDropdownOpen && (
          <ul
            style={{
              listStyle: 'none',
              margin: 0,
              padding: '8px 0',
              border: '1px solid #ddd',
              borderRadius: '4px',
              maxHeight: '180px',
              overflowY: 'auto',
              position: 'absolute',
              background: '#fff',
              width: '100%',
              zIndex: 10,
              boxShadow: '0 4px 6px rgba(0,0,0,0.1)',
            }}
          >
            {filteredCampaigns.length === 0 ? (
              <li style={{ padding: '8px 12px', color: '#666' }}>No campaigns found in database.</li>
            ) : (
              filteredCampaigns.map((camp) => (
                <li
                  key={camp?.sk || Math.random()}
                  onClick={() => handleSelectCampaign(camp)}
                  style={{ padding: '10px 12px', cursor: 'pointer', borderBottom: '1px solid #f1f3f4' }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = '#fff')}
                >
                  <strong>{camp?.title || camp?.sk || 'Untitled'}</strong> ({camp?.sk || 'N/A'}) - <span style={{ color: '#1a73e8' }}>{camp?.status || 'DRAFT'}</span>
                </li>
              ))
            )}
          </ul>
        )}
      </div>

      {isNewCampaign && (
        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '6px' }}>
            Target Contribution Goal ($):
          </label>
          <input
            type="number"
            placeholder="5000"
            value={targetAmount}
            onChange={(e) => setTargetAmount(e.target.value ? Number(e.target.value) : '')}
            style={{ width: '100%', padding: '10px', boxSizing: 'border-box' }}
          />
        </div>
      )}

      <div style={{ marginBottom: '20px' }}>
        <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '6px' }}>
          Campaign Message / Outreach Content:
        </label>
        <textarea
          rows={5}
          placeholder="Enter message details or noble cause appeal..."
          value={messageContent}
          onChange={(e) => setMessageContent(e.target.value)}
          style={{ width: '100%', padding: '10px', boxSizing: 'border-box' }}
        />
      </div>

      <button
        onClick={handleSubmit}
        disabled={isSubmitting}
        style={{
          width: '100%',
          padding: '12px',
          background: isSubmitting ? '#9aa0a6' : '#1a73e8',
          color: '#fff',
          fontWeight: 'bold',
          border: 'none',
          borderRadius: '4px',
          cursor: isSubmitting ? 'not-allowed' : 'pointer',
        }}
      >
        {isSubmitting ? 'Dispatching...' : '🚀 Submit & Broadcast to WhatsApp'}
      </button>
    </div>
  );
};

export default MessagesView; // Note: Ensure export matches your file structure (export default MessagesView)