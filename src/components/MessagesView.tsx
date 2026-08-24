import React, { useState, useEffect, useMemo } from 'react';
import { generateClient } from 'aws-amplify/data';
import type { Schema } from '../../amplify/data/resource';

const client = generateClient<Schema>();
const CURRENT_ASSOCIATION_ID = 'ASSOC#101';

// Inline SVG Info Icon
const InfoIcon: React.FC<{ tooltip: string }> = ({ tooltip }) => {
  const [showTooltip, setShowTooltip] = useState(false);

  return (
    <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style={{
          cursor: 'pointer',
          color: '#3b82f6',
          marginLeft: '6px',
          transition: 'opacity 0.2s ease-in-out',
          opacity: showTooltip ? 1 : 0.8,
        }}
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
      >
        <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" fill="none" />
        <text
          x="8"
          y="10.5"
          textAnchor="middle"
          fill="currentColor"
          fontSize="10"
          fontWeight="bold"
          fontFamily="system-ui, -apple-system, sans-serif"
        >
          i
        </text>
      </svg>

      {/* Tooltip */}
      {showTooltip && (
        <div
          style={{
            position: 'absolute',
            bottom: '100%',
            left: '-80px',
            marginBottom: '8px',
            width: '200px',
            padding: '8px 12px',
            backgroundColor: '#334155',
            border: '1px solid #475569',
            borderRadius: '6px',
            fontSize: '12px',
            color: '#e2e8f0',
            lineHeight: '1.4',
            zIndex: 1000,
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
            whiteSpace: 'normal',
          }}
        >
          {tooltip}
          {/* Tooltip arrow */}
          <div
            style={{
              position: 'absolute',
              top: '100%',
              left: '50%',
              transform: 'translateX(-50%)',
              width: '0',
              height: '0',
              borderLeft: '6px solid transparent',
              borderRight: '6px solid transparent',
              borderTop: '6px solid #334155',
            }}
          />
        </div>
      )}
    </div>
  );
};

// ==================== AGGRESSIVE DynamoDB JSON EXTRACTORS ====================

/**
 * Extracts numbers from both standard floats and raw DynamoDB { N: "..." } objects
 * Handles: 42.9, "42.9", { N: "42.9" }, null, undefined
 */
const extractNumber = (val: any): number => {
  if (val == null || val === '') return 0;

  // Handle raw DynamoDB JSON format: { N: "42.9" }
  if (typeof val === 'object' && val.N !== undefined) {
    return parseFloat(val.N);
  }

  // Handle standard formats: "42.9" or 42.9
  const parsed = parseFloat(String(val));
  return isNaN(parsed) ? 0 : parsed;
};

/**
 * Extracts strings from both standard strings and raw DynamoDB { S: "..." } objects
 * Handles: "MALE", { S: "MALE" }, null, undefined
 */
const extractString = (val: any): string => {
  if (val == null) return '';

  // Handle raw DynamoDB JSON format: { S: "MALE" }
  if (typeof val === 'object' && val.S !== undefined) {
    return String(val.S);
  }

  // Handle standard string format
  return String(val);
};

// ==================== MAIN COMPONENT ====================

const MessagesView: React.FC = () => {
  // Campaign state
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

  // Member data & filtering
  const [allMembers, setAllMembers] = useState<any[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(true);

  // Member Classification & Targeting Filters
  const [minEngagementRate, setMinEngagementRate] = useState(0);
  const [minConversionRate, setMinConversionRate] = useState(0);
  const [targetRegion, setTargetRegion] = useState('All Regions');
  const [targetGenders, setTargetGenders] = useState<string[]>(['MALE', 'FEMALE']);

  // ==================== RESILIENT MEMBER FETCH ====================
  useEffect(() => {
    async function fetchMembersOptimized() {
      setLoadingMembers(true);
      try {
        console.log('🔄 Fetching all members with broad list strategy...');

        // Broad fetch to guarantee data retrieval now that __typename exists
        const { data, errors } = await client.models.PushNotSystem.list({
          authMode: 'apiKey',
        });

        console.log('👥 Raw backend response:', {
          totalDataLength: data?.length || 0,
          errorsCount: errors?.length || 0,
        });

        if (errors && errors.length > 0) {
          console.error('❌ Backend errors:', errors);
        }

        // Filter for members of this specific association in-memory
        // Tenant isolation happens here: pk MUST match CURRENT_ASSOCIATION_ID AND sk MUST start with MEM#
        const validMembers = (data || [])
          .filter((item: any) => item != null)
          .filter((item: any) => {
            return (
              item.pk === CURRENT_ASSOCIATION_ID &&
              item.sk?.startsWith('MEM#')
            );
          });

        console.log('✅ Valid MEMBER records for this association:', validMembers.length);

        // Log sample member structure for debugging
        if (validMembers.length > 0) {
          const sample = validMembers[0];
          console.log('📋 Sample member structure:', {
            pk: `${sample.pk} (type: ${typeof sample.pk})`,
            sk: `${sample.sk} (type: ${typeof sample.sk})`,
            name: `${sample.name} (type: ${typeof sample.name})`,
            engagementRatePercent: `${sample.engagementRatePercent} (type: ${typeof sample.engagementRatePercent}, raw: ${JSON.stringify(sample.engagementRatePercent)})`,
            conversionRatePercent: `${sample.conversionRatePercent} (type: ${typeof sample.conversionRatePercent}, raw: ${JSON.stringify(sample.conversionRatePercent)})`,
            gender: `${sample.gender} (type: ${typeof sample.gender}, raw: ${JSON.stringify(sample.gender)})`,
            address: `${sample.address} (type: ${typeof sample.address}, raw: ${JSON.stringify(sample.address)})`,
          });
          
          // Log extracted values to verify extractors work
          console.log('🔍 Extracted sample values:', {
            engagement: extractNumber(sample.engagementRatePercent),
            conversion: extractNumber(sample.conversionRatePercent),
            gender: extractString(sample.gender).toUpperCase(),
            region: extractString(sample.address).trim(),
          });
        }

        setAllMembers(validMembers);
      } catch (error) {
        console.error('❌ Exception during member fetch:', error);
        setAllMembers([]);
      } finally {
        setLoadingMembers(false);
      }
    }

    fetchMembersOptimized();
  }, []);

  // ==================== GENDER CHECKBOX HANDLERS ====================
  const handleToggleGender = (gender: string) => {
    setTargetGenders((prev) => {
      if (prev.includes(gender)) {
        return prev.filter((g) => g !== gender);
      } else {
        return [...prev, gender];
      }
    });
  };

  // ==================== OPTIMIZED REACTIVE AUDIENCE CALCULATION ====================
  const estimatedAudienceSize = useMemo(() => {
    if (!allMembers || allMembers.length === 0) {
      console.log('⚠️ No members available for filtering');
      return 0;
    }

    const filtered = allMembers.filter((member) => {
  if (!member) return false;
  
  const name = extractString(member.name) || extractString(member.phone) || 'Unknown';
  const memberRegion = extractString(member.address).trim();
  const memberGender = extractString(member.gender).toUpperCase();
  const engagement = extractNumber(member.engagementRatePercent);
  const conversion = extractNumber(member.conversionRatePercent);

  // 1. Region Check
  if (targetRegion && targetRegion !== 'All Regions') {
    if (memberRegion !== targetRegion.trim()) return false; 
  }

  // 2. Engagement Check
  if (engagement < minEngagementRate) {
    console.log(`❌ Dropped ${name}: Engagement (${engagement}) < ${minEngagementRate}`);
    return false;
  }

  // 3. Conversion Check
  if (conversion < minConversionRate) {
    console.log(`❌ Dropped ${name}: Conversion (${conversion}) < ${minConversionRate}`);
    return false;
  }

  // 4. Gender Check
  if (targetGenders && targetGenders.length > 0) {
    if (!memberGender) {
      console.log(`❌ Dropped ${name}: Missing gender in database.`);
      return false;
    }
    if (!targetGenders.includes(memberGender)) {
      console.log(`❌ Dropped ${name}: Gender (${memberGender}) not in target list [${targetGenders}].`);
      return false;
    }
  }

  console.log(`✅ Kept ${name}! Meets all criteria (Eng: ${engagement}, Conv: ${conversion}, Gen: ${memberGender}).`);
  return true; 
});

    console.log('🎯 Filtering result:', {
      totalMembers: allMembers.length,
      filteredMembers: filtered.length,
      filters: {
        minEngagementRate,
        minConversionRate,
        targetRegion,
        targetGenders,
      },
    });

    return filtered.length;
  }, [allMembers, minEngagementRate, minConversionRate, targetRegion, targetGenders]);

  // ==================== FETCH CAMPAIGNS ====================
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
    const isNewCampaign = !selectedCampaign && campaignSearch.trim();

    if (!isNewCampaign && !selectedCampaign) {
      setFeedback({ type: 'error', text: 'Please select an existing campaign or enter a new campaign name.' });
      return;
    }

    setIsSubmitting(true);
    setFeedback({ type: null, text: '' });

    try {
      let activeCampaignSk = selectedCampaign?.sk;

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

      console.log('📤 Broadcasting with targeting:', {
        minEngagementRate,
        minConversionRate,
        targetRegion,
        targetGenders,
        estimatedAudienceSize,
      });

      const response = await client.mutations.triggerCampaignBroadcast(
        {
          associationId: CURRENT_ASSOCIATION_ID,
          campaignRunId: activeCampaignSk,
          minEngagementRate,
          minConversionRate,
          targetRegion: targetRegion !== 'All Regions' ? targetRegion : undefined,
          targetGenders: targetGenders.length > 0 ? targetGenders : undefined,
        },
        { authMode: 'apiKey' }
      );

      if (response.errors && response.errors.length > 0) {
        throw new Error(response.errors[0].message);
      }

      const responseData = response.data ? JSON.parse(response.data as string) : {};

      setFeedback({
        type: 'success',
        text: `Success! Dispatched campaign ${activeCampaignSk} to ${estimatedAudienceSize} members. Queued ${responseData.queuedCount || 0} messages.`,
      });

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
        {/* LEFT PANE: Campaign Selection & Member Targeting Filters */}
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
          <div className="panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
            <h3 style={{ margin: '0 0 16px 0', fontSize: '16px', fontWeight: 600, color: '#f1f5f9', flexShrink: 0 }}>
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
              <div className="campaign-selected-badge existing" style={{ marginBottom: '16px', flexShrink: 0 }}>
                <div>
                  <strong>Relaunch:</strong> {selectedCampaign.title || selectedCampaign.sk}
                </div>
              </div>
            )}

            {/* Target Amount (New Campaign Only) */}
            {!selectedCampaign && campaignSearch && (
              <div style={{ marginBottom: '16px', flexShrink: 0 }}>
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
              <div style={{ marginBottom: '16px', paddingBottom: '16px', borderBottom: '1px solid #334155', flexShrink: 0 }}>
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

            {/* ===== 🎯 AUDIENCE TARGETING & FILTERS SECTION ===== */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px', flexShrink: 0 }}>
              <h4 style={{ margin: 0, fontSize: '13px', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                🎯 Audience Targeting & Filters
              </h4>
              <InfoIcon tooltip="Filter your association members based on their historical read rates, contribution history, and demographic data. Only members meeting these criteria will receive the broadcast." />
            </div>

            {/* Member Count Loading Status */}
            {loadingMembers && (
              <div style={{ marginBottom: '12px', flexShrink: 0, fontSize: '12px', color: '#94a3b8' }}>
                ⏳ Loading {allMembers.length > 0 ? allMembers.length : ''} members...
              </div>
            )}

            {/* Minimum Engagement Rate (%) */}
            <div style={{ marginBottom: '12px', flexShrink: 0 }}>
              <label style={{ fontSize: '12px', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Min. Engagement Rate
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={minEngagementRate}
                  onChange={(e) => setMinEngagementRate(Math.max(0, Math.min(100, Number(e.target.value))))}
                  style={{
                    flex: 1,
                    backgroundColor: '#0f172a',
                    border: '1px solid #334155',
                    borderRadius: '6px',
                    color: '#e2e8f0',
                    padding: '8px 12px',
                    fontSize: '13px',
                  }}
                />
                <span style={{ color: '#cbd5e1', fontWeight: 600, fontSize: '13px', minWidth: '24px' }}>%</span>
              </div>
            </div>

            {/* Minimum Conversion Rate (%) */}
            <div style={{ marginBottom: '12px', flexShrink: 0 }}>
              <label style={{ fontSize: '12px', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Min. Conversion Rate
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={minConversionRate}
                  onChange={(e) => setMinConversionRate(Math.max(0, Math.min(100, Number(e.target.value))))}
                  style={{
                    flex: 1,
                    backgroundColor: '#0f172a',
                    border: '1px solid #334155',
                    borderRadius: '6px',
                    color: '#e2e8f0',
                    padding: '8px 12px',
                    fontSize: '13px',
                  }}
                />
                <span style={{ color: '#cbd5e1', fontWeight: 600, fontSize: '13px', minWidth: '24px' }}>%</span>
              </div>
            </div>

            {/* Region / Cluster Dropdown - FIXED VALUES */}
            <div style={{ marginBottom: '12px', flexShrink: 0 }}>
              <label style={{ fontSize: '12px', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Region / Cluster
              </label>
              <select
                value={targetRegion}
                onChange={(e) => setTargetRegion(e.target.value)}
                style={{
                  width: '100%',
                  backgroundColor: '#0f172a',
                  border: '1px solid #334155',
                  borderRadius: '6px',
                  color: '#e2e8f0',
                  padding: '8px 12px',
                  fontSize: '13px',
                  cursor: 'pointer',
                  maxHeight: '200px',
                  overflow: 'auto',
                }}
              >
                <option value="All Regions">All Regions</option>
                <option value="A'ali">A'ali</option>
                <option value="Manama">Manama</option>
                <option value="Muharraq">Muharraq</option>
                <option value="Riffa">Riffa</option>
                <option value="Isa Town">Isa Town</option>
                <option value="Hamad Town">Hamad Town</option>
                <option value="Sitra">Sitra</option>
                <option value="Budaiya">Budaiya</option>
              </select>
            </div>

            {/* Gender Checkboxes */}
            <div style={{ marginBottom: '12px', flexShrink: 0 }}>
              <label style={{ fontSize: '12px', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.5px', display: 'block', marginBottom: '8px' }}>
                Gender
              </label>
              <div style={{ display: 'flex', gap: '16px' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', margin: 0, color: '#e2e8f0', fontSize: '13px', fontWeight: 400 }}>
                  <input
                    type="checkbox"
                    checked={targetGenders.includes('MALE')}
                    onChange={() => handleToggleGender('MALE')}
                    style={{ cursor: 'pointer' }}
                  />
                  Male
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', margin: 0, color: '#e2e8f0', fontSize: '13px', fontWeight: 400 }}>
                  <input
                    type="checkbox"
                    checked={targetGenders.includes('FEMALE')}
                    onChange={() => handleToggleGender('FEMALE')}
                    style={{ cursor: 'pointer' }}
                  />
                  Female
                </label>
              </div>
            </div>
          </div>
        </div>

        {/* RIGHT PANE: Message Content & Submission */}
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
          <div className="panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <h3 style={{ margin: '0 0 16px 0', fontSize: '16px', fontWeight: 600, color: '#f1f5f9', flexShrink: 0 }}>
              ✍️ Message Content
            </h3>

            <label style={{ marginBottom: '8px', flexShrink: 0 }}>Campaign Message / Outreach Content</label>
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

            {/* On-Screen Debug Counter (Temporary) */}
            <div style={{ fontSize: '11px', color: '#64748b', marginBottom: '8px' }}>
              Debug: Loaded {allMembers.length} members from DB
            </div>

            {/* Estimated Target Audience Summary - REAL-TIME */}
            <div
              style={{
                padding: '12px 16px',
                marginBottom: '16px',
                borderRadius: '6px',
                backgroundColor: 'rgba(139, 92, 246, 0.1)',
                border: '1px solid #8b5cf6',
                color: '#d8b4fe',
                fontSize: '13px',
                fontWeight: 600,
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
              }}
            >
              <span>📊</span>
              <span>
                {loadingMembers
                  ? 'Loading member data...'
                  : `Estimated Target Audience: ${estimatedAudienceSize.toLocaleString()} Members`}
              </span>
            </div>

            {/* Submit Button */}
            <button
              onClick={handleSubmit}
              disabled={isSubmitting || (!selectedCampaign && !campaignSearch.trim()) || loadingMembers}
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
