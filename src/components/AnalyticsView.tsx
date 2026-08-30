import React, { useState, useEffect, useMemo } from 'react';
import { generateClient } from 'aws-amplify/data';
import type { Schema } from '../../amplify/data/resource';

const client = generateClient<Schema>();

interface AnalyticsViewProps { associationId: string; }

// ── Paginated list — tolerates missing createdAt on Lambda-written records ────
async function paginatedList(
  filter: Record<string, any>,
  label = ''
): Promise<any[]> {
  let items: any[] = [];
  let nextToken: string | null | undefined = undefined;
  do {
    const res: any = await client.models.PushNotSystem.list({
      filter,
      ...(nextToken ? { nextToken } : {}),
      authMode: 'userPool',
    });
    if (res.errors?.length) {
      const onlyTimestamp = res.errors.every((e: any) =>
        e.message?.includes('createdAt') || e.message?.includes('updatedAt')
      );
      if (!onlyTimestamp) console.error(`❌ [${label}] AppSync errors:`, res.errors);
      else console.warn(`⚠️ [${label}] ${res.errors.length} record(s) missing createdAt (Lambda-written)`);
    }
    items = items.concat((res.data ?? []).filter(Boolean));
    nextToken = res.nextToken;
  } while (nextToken);
  return items;
}

// ── Stat card ─────────────────────────────────────────────────────────────────
function StatCard({
  label, value, sub, color,
}: { label: string; value: string; sub: string; color: string }) {
  return (
    <div className="panel" style={{ minHeight: '120px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
      <div style={{ fontSize: '12px', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>
        {label}
      </div>
      <div style={{ fontSize: '32px', fontWeight: 700, color, marginBottom: '8px' }}>{value}</div>
      <div style={{ fontSize: '11px', color: '#64748b' }}>{sub}</div>
    </div>
  );
}

// ── Progress bar ──────────────────────────────────────────────────────────────
function Bar({ pct, color }: { pct: number; color: string }) {
  return (
    <div style={{ width: '100%', height: '6px', backgroundColor: '#1e293b', borderRadius: '3px', overflow: 'hidden' }}>
      <div style={{ width: `${Math.min(100, pct)}%`, height: '100%', backgroundColor: color, borderRadius: '3px', transition: 'width 0.4s ease' }} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

const AnalyticsView: React.FC<AnalyticsViewProps> = ({ associationId }) => {
  // ── Raw data ──────────────────────────────────────────────────────────────
  const [campaigns,  setCampaigns]  = useState<any[]>([]); // CAMP# records
  const [allLedgers, setAllLedgers] = useState<any[]>([]); // CAMPRUN#<id>#MEM# records
  const [loading,    setLoading]    = useState(true);

  // ── Interactive filter ────────────────────────────────────────────────────
  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(null);

  // ── Fetch ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!associationId) return;

    async function loadAnalytics() {
      setLoading(true);
      try {
        // Campaigns: pk=ASSOC#<sub>, sk beginsWith CAMP#
        const campItems = await paginatedList(
          { pk: { eq: associationId }, sk: { beginsWith: 'CAMP#' } },
          'campaigns'
        );
        setCampaigns(campItems);

        // All ledger records: pk=ASSOC#<sub>, sk beginsWith CAMPRUN#
        // These are the per-member delivery records written by processOutboundQueue.
        // sk format: CAMPRUN#<campIdRaw>#MEM#<phone>#<timestamp>
        const ledgerItems = await paginatedList(
          { pk: { eq: associationId }, sk: { beginsWith: 'CAMPRUN#' } },
          'ledgers'
        );

        // Keep only per-member ledger records (exclude CAMPRUN summary records
        // which have sk = CAMPRUN#<id> — no MEM# segment)
        const memberLedgers = ledgerItems.filter(
          (item: any) => typeof item.sk === 'string' && item.sk.includes('#MEM#')
        );

        setAllLedgers(memberLedgers);
        console.log(`✅ Analytics: ${campItems.length} campaigns, ${memberLedgers.length} ledger entries`);
      } catch (err) {
        console.error('❌ Analytics load failed:', err);
      } finally {
        setLoading(false);
      }
    }

    loadAnalytics();
  }, [associationId]); // re-fetches when tenant changes

  // ── Filtered ledger (campaign drill-down or global) ───────────────────────
  // selectedCampaignId = "1787957160986" (campIdRaw, no CAMP# prefix)
  // Ledger sk = CAMPRUN#<campIdRaw>#MEM#<phone>#<ts>
  // Filter: sk.startsWith(`CAMPRUN#${selectedCampaignId}#`)
  const filteredLedgers = useMemo(() => {
    if (!selectedCampaignId) return allLedgers;
    const prefix = `CAMPRUN#${selectedCampaignId}#`;
    return allLedgers.filter((l: any) => (l.sk as string).startsWith(prefix));
  }, [allLedgers, selectedCampaignId]);

  // ── Derived metrics ───────────────────────────────────────────────────────
  const metrics = useMemo(() => {
    const total     = filteredLedgers.length;
    const delivered = filteredLedgers.filter((l: any) =>
      l.deliveryStatus === 'DELIVERED' || l.deliveryStatus === 'READ'
    ).length;
    const read    = filteredLedgers.filter((l: any) => l.isRead   === true).length;
    const replied = filteredLedgers.filter((l: any) => l.hasReplied === true).length;
    const paid    = filteredLedgers.filter((l: any) => l.paymentStatus === 'PAID').length;
    const intentReceived = filteredLedgers.filter((l: any) => l.paymentStatus === 'INTENT_RECEIVED').length;

    const pct = (n: number) => (total > 0 ? Math.round((n / total) * 100) : 0);
    return { total, delivered, read, replied, paid, intentReceived,
             deliveryRate: pct(delivered), readRate: pct(read), replyRate: pct(replied) };
  }, [filteredLedgers]);

  // ── Per-campaign ledger counts (for campaign breakdown table) ─────────────
  const campaignStats = useMemo(() => {
    return campaigns.map((camp: any) => {
      const campIdRaw = (camp.sk as string).replace(/^CAMP#/, '');
      const prefix    = `CAMPRUN#${campIdRaw}#`;
      const ledgers   = allLedgers.filter((l: any) => (l.sk as string).startsWith(prefix));
      const total     = ledgers.length;
      const delivered = ledgers.filter((l: any) =>
        l.deliveryStatus === 'DELIVERED' || l.deliveryStatus === 'READ'
      ).length;
      const read      = ledgers.filter((l: any) => l.isRead === true).length;
      const replied   = ledgers.filter((l: any) => l.hasReplied === true).length;
      const pct = (n: number) => (total > 0 ? Math.round((n / total) * 100) : 0);
      return { camp, campIdRaw, total, deliveryRate: pct(delivered), readRate: pct(read), replyRate: pct(replied) };
    });
  }, [campaigns, allLedgers]);

  // ── Fundraising totals ────────────────────────────────────────────────────
  const totalTarget    = useMemo(() => campaigns.reduce((a, c) => a + (c?.targetAmount || 0), 0), [campaigns]);
  const totalCollected = useMemo(() => filteredLedgers.reduce((a, l) => a + (l?.paymentAmount || 0), 0), [filteredLedgers]);

  // ── Selected campaign display name ────────────────────────────────────────
  const selectedLabel = useMemo(() => {
    if (!selectedCampaignId) return null;
    const camp = campaigns.find((c: any) => (c.sk as string).replace(/^CAMP#/, '') === selectedCampaignId);
    return camp?.title || `CAMP#${selectedCampaignId}`;
  }, [selectedCampaignId, campaigns]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="view-single-col">

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '0 16px', flexShrink: 0 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '20px', fontWeight: 600, color: '#f1f5f9' }}>
            📊 Analytics Dashboard
          </h2>
          {selectedLabel && (
            <div style={{ marginTop: '4px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '12px', color: '#60a5fa' }}>
                Filtered: {selectedLabel}
              </span>
              <button onClick={() => setSelectedCampaignId(null)}
                style={{ fontSize: '11px', padding: '2px 8px', background: 'none',
                  border: '1px solid #334155', borderRadius: '4px', color: '#94a3b8', cursor: 'pointer' }}>
                ✕ Clear filter
              </button>
            </div>
          )}
        </div>
        <button
          onClick={() => { setCampaigns([]); setAllLedgers([]); setLoading(true);
            // re-trigger via associationId dependency by forcing a re-render
            setSelectedCampaignId(null);
            // re-fetch: flip loading flag, useEffect guards against empty associationId
            setTimeout(() => setLoading(false), 0);
          }}
          style={{ background: '#1e293b', color: '#94a3b8', border: '1px solid #334155',
            borderRadius: '6px', padding: '8px 16px', fontSize: '13px', fontWeight: 600,
            cursor: 'pointer' }}>
          🔄 Refresh
        </button>
      </div>

      {loading ? (
        <div className="panel" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ textAlign: 'center', color: '#94a3b8' }}>
            <div className="profile-gate-spinner" style={{ margin: '0 auto 12px' }} />
            <div style={{ fontSize: '14px' }}>Calculating metrics…</div>
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', gap: '16px', padding: '0 16px' }}>

          {/* ── KPI cards ── */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px', flexShrink: 0 }}>
            <StatCard label="Total Sent"    value={metrics.total.toLocaleString()}
              sub={selectedLabel ? `for ${selectedLabel}` : 'across all campaigns'}
              color="#3b82f6" />
            <StatCard label="Delivery Rate" value={`${metrics.deliveryRate}%`}
              sub={`${metrics.delivered} of ${metrics.total} delivered`}
              color="#10b981" />
            <StatCard label="Read Rate"     value={`${metrics.readRate}%`}
              sub={`${metrics.read} members opened`}
              color="#f59e0b" />
            <StatCard label="Reply Rate"    value={`${metrics.replyRate}%`}
              sub={`${metrics.replied} members engaged`}
              color="#8b5cf6" />
          </div>

          {/* ── Fundraising summary ── */}
          <div className="panel" style={{ flexShrink: 0 }}>
            <h3 style={{ margin: '0 0 12px', fontSize: '14px', fontWeight: 600, color: '#f1f5f9' }}>
              💰 Fundraising Summary
            </h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px' }}>
              {[
                { label: 'Total Collected', value: `$${totalCollected.toFixed(2)}`, color: '#10b981' },
                { label: 'Active Goal',     value: `$${totalTarget.toFixed(2)}`,    color: '#3b82f6' },
                { label: 'Paid',            value: metrics.paid.toString(),          color: '#10b981' },
                { label: 'Intent Received', value: metrics.intentReceived.toString(), color: '#60a5fa' },
              ].map(({ label, value, color }) => (
                <div key={label}>
                  <div style={{ fontSize: '12px', color: '#94a3b8', marginBottom: '4px' }}>{label}</div>
                  <div style={{ fontSize: '24px', fontWeight: 700, color }}>{value}</div>
                </div>
              ))}
            </div>
          </div>

          {/* ── Campaign breakdown ── */}
          <div className="panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              marginBottom: '12px', flexShrink: 0 }}>
              <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 600, color: '#f1f5f9' }}>
                🎯 Campaign Breakdown
              </h3>
              <span style={{ fontSize: '11px', color: '#475569' }}>
                Click a row to filter metrics above
              </span>
            </div>

            <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
              {campaignStats.length === 0 ? (
                <div style={{ padding: '32px', textAlign: 'center', color: '#64748b', fontSize: '13px' }}>
                  {loading ? '⏳ Loading…' : 'No campaigns found.'}
                </div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                  <thead style={{ position: 'sticky', top: 0, backgroundColor: '#0f172a', zIndex: 10 }}>
                    <tr style={{ borderBottom: '2px solid #334155' }}>
                      {['Campaign', 'Sent', 'Delivery', 'Read', 'Replies'].map(h => (
                        <th key={h} style={{ padding: '10px 10px', textAlign: h === 'Campaign' ? 'left' : 'right',
                          fontWeight: 600, color: '#94a3b8', fontSize: '11px',
                          textTransform: 'uppercase', letterSpacing: '0.4px' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {campaignStats.map(({ camp, campIdRaw, total, deliveryRate, readRate, replyRate }, idx) => {
                      const isSelected = selectedCampaignId === campIdRaw;
                      return (
                        <tr key={camp.sk}
                          onClick={() => setSelectedCampaignId(isSelected ? null : campIdRaw)}
                          style={{
                            borderBottom: '1px solid #1e293b',
                            cursor: 'pointer',
                            backgroundColor: isSelected
                              ? 'rgba(59,130,246,0.12)'
                              : idx % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)',
                            transition: 'background-color 0.15s',
                          }}
                          onMouseEnter={e => { if (!isSelected) e.currentTarget.style.backgroundColor = 'rgba(59,130,246,0.06)'; }}
                          onMouseLeave={e => { e.currentTarget.style.backgroundColor = isSelected ? 'rgba(59,130,246,0.12)' : idx % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)'; }}>

                          {/* Campaign title */}
                          <td style={{ padding: '11px 10px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                              {isSelected && <span style={{ color: '#3b82f6', fontSize: '10px' }}>▶</span>}
                              <span style={{ color: '#e2e8f0', fontWeight: 500 }}>
                                {camp.title || camp.sk}
                              </span>
                            </div>
                            <div style={{ fontSize: '11px', color: '#475569', fontFamily: 'monospace', marginTop: '2px' }}>
                              CAMP#{campIdRaw}
                            </div>
                          </td>

                          {/* Sent count */}
                          <td style={{ padding: '11px 10px', textAlign: 'right', color: '#cbd5e1', fontWeight: 600 }}>
                            {total > 0 ? total.toLocaleString() : <span style={{ color: '#334155' }}>—</span>}
                          </td>

                          {/* Delivery rate with progress bar */}
                          <td style={{ padding: '11px 10px', textAlign: 'right', minWidth: '90px' }}>
                            <div style={{ color: '#10b981', fontWeight: 600 }}>{deliveryRate}%</div>
                            <Bar pct={deliveryRate} color="#10b981" />
                          </td>

                          {/* Read rate */}
                          <td style={{ padding: '11px 10px', textAlign: 'right', minWidth: '80px' }}>
                            <div style={{ color: '#f59e0b', fontWeight: 600 }}>{readRate}%</div>
                            <Bar pct={readRate} color="#f59e0b" />
                          </td>

                          {/* Reply rate */}
                          <td style={{ padding: '11px 10px', textAlign: 'right', minWidth: '80px' }}>
                            <div style={{ color: '#8b5cf6', fontWeight: 600 }}>{replyRate}%</div>
                            <Bar pct={replyRate} color="#8b5cf6" />
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
