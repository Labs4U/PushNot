import { useState, useEffect, useRef } from 'react';
import { generateClient } from 'aws-amplify/data';
import type { Schema } from '../../amplify/data/resource';
import ChatAssistant from './ChatAssistant';

const client = generateClient<Schema>();

interface CampaignSuggestion {
  id: string;
  label: string;
  isNew: boolean;
}

export default function MessagesView() {
  const [campaignSearch, setCampaignSearch] = useState('');
  const [campaignSuggestions, setCampaignSuggestions] = useState<CampaignSuggestion[]>([]);
  const [selectedCampaign, setSelectedCampaign] = useState<CampaignSuggestion | null>(null);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const suggestionsRef = useRef<HTMLDivElement>(null);

  const [message, setMessage] = useState('');
  const [scheduleType, setScheduleType] = useState<'single' | 'redundant'>('single');
  const [searchQuery, setSearchQuery] = useState('');
  const [showChat, setShowChat] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error' | null; text: string }>({ type: null, text: '' });

  // Mock historical campaigns
  const mockHistoricalCampaigns: CampaignSuggestion[] = [
    { id: 'CAMPRUN#A#1692374400', label: '📅 Campaign A (Back to School)', isNew: false },
    { id: 'CAMPRUN#B#1692374500', label: '🕌 Campaign B (Hajj Trip)', isNew: false },
    { id: 'CAMPRUN#C#1692374600', label: '🎉 Campaign C (Year End Sale)', isNew: false },
    { id: 'CAMPRUN#D#1692374700', label: '🎓 Campaign D (Spring Semester)', isNew: false },
    { id: 'CAMPRUN#E#1692374800', label: '🏖️ Campaign E (Summer Deals)', isNew: false },
  ];

  // Handle campaign search and suggestions
  useEffect(() => {
    if (!campaignSearch.trim()) {
      setCampaignSuggestions([]);
      setShowSuggestions(false);
      return;
    }

    const searchTerm = campaignSearch.toLowerCase();
    
    // Filter historical campaigns
    const filtered = mockHistoricalCampaigns.filter(campaign =>
      campaign.label.toLowerCase().includes(searchTerm) ||
      campaign.id.toLowerCase().includes(searchTerm)
    );

    // Always include option to create new campaign
    const suggestions: CampaignSuggestion[] = [
      ...filtered,
      {
        id: `CAMPRUN#${Date.now()}`,
        label: `✨ New Campaign: "${campaignSearch}"`,
        isNew: true
      }
    ];

    setCampaignSuggestions(suggestions);
    setShowSuggestions(true);
  }, [campaignSearch]);

  // Close suggestions when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (suggestionsRef.current && !suggestionsRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSelectCampaign = (suggestion: CampaignSuggestion) => {
    setSelectedCampaign(suggestion);
    setCampaignSearch(suggestion.label);
    setShowSuggestions(false);
  };

  const handleSubmit = async () => {
    if (!selectedCampaign) {
      setFeedback({ type: 'error', text: 'Please select or create a campaign first.' });
      return;
    }
    if (!message.trim()) {
      setFeedback({ type: 'error', text: 'Message content cannot be empty.' });
      return;
    }

    setIsSubmitting(true);
    setFeedback({ type: null, text: '' });

    try {
      const activeCampaignId = selectedCampaign.id;
      const currentAssociationId = 'ASSOC#101';

      // If it's a new campaign, create the record
      if (selectedCampaign.isNew) {
        const { errors: createErrors } = await client.models.PushNotSystem.create({
          pk: currentAssociationId,
          sk: `${activeCampaignId}#METADATA`,
          entityType: 'CAMPAIGN',
          gsi2pk: currentAssociationId,
          gsi2sk: new Date().toISOString(),
          title: selectedCampaign.label.replace(/^✨ New Campaign: "/, '').replace(/"$/, ''),
          type: 'ANNOUNCEMENT',
          templateName: 'standard_alert',
          status: 'DRAFT',
          createdAt: new Date().toISOString(),
        });

        if (createErrors && createErrors.length > 0) {
          console.warn('Campaign creation warning:', createErrors);
        }
      }

      // Trigger the broadcast mutation
      const { errors } = await client.mutations.triggerCampaignBroadcast({
        associationId: currentAssociationId,
        campaignRunId: activeCampaignId,
      });

      if (errors && errors.length > 0) {
        throw new Error(errors[0].message);
      }

      setFeedback({ 
        type: 'success', 
        text: `Success! Campaign has been queued for dispatch.` 
      });
      setMessage('');
      setCampaignSearch('');
      setSelectedCampaign(null);

    } catch (error: any) {
      console.error('Broadcast dispatch failed:', error);
      setFeedback({ 
        type: 'error', 
        text: error.message || 'An unexpected error occurred while dispatching.' 
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="grid-2-col">
      {/* Left Column - Scrollable Container */}
      <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', gap: '16px' }}>
        {/* Campaign Search Panel - ALLOWS DROPDOWN OVERFLOW */}
        <div className="campaign-search-wrapper" ref={suggestionsRef}>
          <label>Campaign</label>
          <div className="campaign-search-input-container">
            <input 
              type="text" 
              placeholder="Search or create a campaign..." 
              value={campaignSearch}
              onChange={(e) => setCampaignSearch(e.target.value)}
              onFocus={() => campaignSuggestions.length > 0 && setShowSuggestions(true)}
              disabled={isSubmitting}
            />
            
            {/* Dropdown Suggestions - Floats Above All */}
            {showSuggestions && campaignSuggestions.length > 0 && (
              <div className="campaign-suggestions-dropdown">
                {campaignSuggestions.map((suggestion) => (
                  <div
                    key={suggestion.id}
                    className={`campaign-suggestion-item ${suggestion.isNew ? 'new' : ''}`}
                    onClick={() => handleSelectCampaign(suggestion)}
                  >
                    {suggestion.label}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Selected Campaign Badge */}
          {selectedCampaign && (
            <div className={`campaign-selected-badge ${selectedCampaign.isNew ? 'new' : 'existing'}`}>
              <span>{selectedCampaign.label}</span>
              <button
                onClick={() => {
                  setSelectedCampaign(null);
                  setCampaignSearch('');
                }}
              >
                ✕
              </button>
            </div>
          )}
        </div>

        {/* Message Composition Panel */}
        <div className="panel message-box">
          <label>Message Content</label>
          <textarea 
            rows={5} 
            value={message} 
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Draft your campaign message here..."
            disabled={isSubmitting}
          />
          
          {feedback.type && (
            <div style={{ 
              marginTop: '12px', 
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

          <button 
            className="btn-submit" 
            onClick={handleSubmit}
            disabled={isSubmitting || !selectedCampaign}
          >
            {isSubmitting ? 'Queueing...' : 'Submit Campaign'}
          </button>
        </div>

        {/* Schedule & Targets Panel */}
        <div className="panel" style={{ flex: '0 0 auto', maxHeight: '300px', overflow: 'y auto' }}>
          <div className="controls-row">
            <label style={{ margin: 0, width: '80px' }}>Schedule:</label>
            <input type="date" disabled={isSubmitting} />
            <select 
              value={scheduleType} 
              onChange={(e) => setScheduleType(e.target.value as any)}
              disabled={isSubmitting}
            >
              <option value="single">Single</option>
              <option value="redundant">Redundant</option>
            </select>
          </div>
          
          <div className="targets-section">
            <div>
              <label>Target Audience</label>
              <div className="checkbox-list">
                <label><input type="checkbox" disabled={isSubmitting} /> Target Group 1</label>
                <label><input type="checkbox" disabled={isSubmitting} /> Target Group 2</label>
                <label><input type="checkbox" disabled={isSubmitting} /> Target Group 3</label>
              </div>
            </div>
            <div className="chat-assistant-toggle">
              <input 
                type="checkbox" 
                id="chatAssist" 
                checked={showChat}
                onChange={(e) => setShowChat(e.target.checked)}
                disabled={isSubmitting} 
              />
              <label htmlFor="chatAssist">💬 AI Draft Assistant</label>
            </div>
          </div>
        </div>

        {/* Chat Assistant Panel (Flexible) */}
        {showChat && (
          <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
            <ChatAssistant onDraftAccepted={(draft) => setMessage(draft)} />
          </div>
        )}

        {/* Recipient List Panel */}
        <div className="panel" style={{ flex: showChat ? '0 0 200px' : 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <label>Recipients</label>
          <input 
            type="text" 
            placeholder="Search phone numbers..." 
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            disabled={isSubmitting}
            style={{ marginBottom: '8px', flexShrink: 0 }}
          />
          <div className="phone-list">
            <div className="phone-list-item">+1-91XXXXXXX (Active)</div>
            <div className="phone-list-item">+33-XXXXXXX (Active)</div>
            <div className="phone-list-item">+35-XXXXXXX (Active)</div>
            <div className="phone-list-item">+973-XXXXXX (Inactive)</div>
            <div className="phone-list-item">+212-XXXXXXX (Active)</div>
          </div>
        </div>
      </div>

      {/* Right Column - Empty (reserved for future use or quick stats) */}
      <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div className="panel" style={{ flex: 1, justifyContent: 'center', alignItems: 'center', textAlign: 'center' }}>
          <div style={{ color: '#64748b', fontSize: '14px' }}>
            <div style={{ fontSize: '32px', marginBottom: '8px' }}>📊</div>
            <div>Campaign quick stats and details will appear here</div>
          </div>
        </div>
      </div>
    </div>
  );
}
